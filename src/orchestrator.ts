import { createActor, fromPromise } from "xstate";
import type { AutoDevConfig } from "./config/schema.js";
import type { AppSecrets } from "./config/loader.js";
import { createWorkflowMachine } from "./machine/workflow.js";
import { persistSnapshot, loadSnapshot } from "./machine/persistence.js";
import { fetchIssues } from "./github/issues.js";
import {
  pullMain,
  createBranch,
  verifyCleanWorkDir,
  commitAndPush,
  getCurrentDiff,
} from "./github/git-ops.js";
import { createPullRequest } from "./github/pr.js";
import { ClaudeDevExecutor } from "./executors/claude-dev.js";
import { ClaudeReviewer } from "./executors/claude-reviewer.js";
import { CodexReviewer } from "./executors/codex-reviewer.js";
import { ThreeTierQuestionHandler } from "./questions/handler.js";
import { createBot, startBot, stopBot } from "./telegram/bot.js";
import { TelegramBridge } from "./telegram/bridge.js";
import type { GitHubIssue, ReviewResult } from "./machine/context.js";
import type { Reviewer } from "./executors/types.js";
import type { Snapshot } from "xstate";
import type { Logger } from "pino";

export interface OrchestratorOptions {
  config: AutoDevConfig;
  secrets: AppSecrets;
  logger: Logger;
  repoDir: string;
  resume?: boolean;
}

export async function runOrchestrator(options: OrchestratorOptions): Promise<void> {
  const { config, secrets, logger, repoDir } = options;

  logger.info({ repoDir }, "Target repo directory");

  // Set up Telegram bot and bridge (graceful failure)
  let bot: ReturnType<typeof createBot> | null = null;
  let bridge: TelegramBridge | null = null;

  try {
    if (!secrets.telegramBotToken) throw new Error("No bot token configured");
    bot = createBot(secrets.telegramBotToken);
    bridge = new TelegramBridge(
      bot,
      config.telegram.chat_id,
      config.telegram.escalation_timeout_minutes,
      config.telegram.reminder_interval_minutes,
    );
    await startBot(bot);
    logger.info("Telegram bot connected");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Telegram bot failed to start: ${msg}`);
    logger.warn("Continuing without Telegram — Tier 3 escalation disabled");
    bot = null;
    bridge = null;
  }

  // Set up question handler
  const questionHandler = new ThreeTierQuestionHandler(
    bridge,
    secrets.anthropicApiKey,
    logger,
    config.issues.max_questions_per_issue,
  );

  // Set up executor — cwd is the target repo
  const executor = new ClaudeDevExecutor(config, repoDir);
  executor.setQuestionHandler(questionHandler);

  // Create reviewer
  const reviewer: Reviewer =
    config.reviewer.type === "codex" ? new CodexReviewer() : new ClaudeReviewer();

  // Create the state machine with real actors via fromPromise
  const machine = createWorkflowMachine(config).provide({
    actors: {
      fetchIssues: fromPromise(async () => {
        logger.info("Fetching issues from GitHub...");
        const issues = await fetchIssues(config);
        logger.info(`Found ${issues.length} issue(s)`);
        return issues;
      }),

      prepareIssue: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: AutoDevConfig } }) => {
          const { issue } = input;
          logger.info({ issue: issue.number, title: issue.title }, "Preparing issue");
          await pullMain(repoDir);
          await verifyCleanWorkDir(repoDir);
          const branchName = await createBranch(
            config.git.branch_prefix,
            issue.number,
            issue.title,
            repoDir,
          );
          logger.info({ branch: branchName }, "Branch created");
          return { branchName };
        },
      ),

      workOnIssue: fromPromise(
        async ({
          input,
        }: {
          input: { issue: GitHubIssue; config: AutoDevConfig; sessionId: string | null };
        }) => {
          logger.info({ issue: input.issue.number }, "Working on issue...");
          const result = await executor.execute({
            issue: input.issue,
            config: input.config,
            sessionId: input.sessionId,
          });
          logger.info({ issue: input.issue.number, sessionId: result.sessionId }, "Work complete");
          return result;
        },
      ),

      reviewCode: fromPromise(
        async ({
          input,
        }: {
          input: {
            issue: GitHubIssue;
            config: AutoDevConfig;
            previousFindings: ReviewResult["findings"];
          };
        }) => {
          logger.info({ issue: input.issue.number }, "Running code review...");
          const diff = await getCurrentDiff(repoDir);
          const result = await reviewer.review({
            issue: input.issue,
            diff,
            previousFindings: input.previousFindings,
            iterationNumber: input.previousFindings.length > 0 ? 2 : 1,
          });
          const p1Count = result.findings.filter((f) => f.severity === "P1").length;
          const p2Count = result.findings.filter((f) => f.severity === "P2").length;
          logger.info(
            { issue: input.issue.number, p1: p1Count, p2: p2Count, total: result.findings.length },
            "Review complete",
          );
          return result;
        },
      ),

      fixIssues: fromPromise(
        async ({
          input,
        }: {
          input: {
            issue: GitHubIssue;
            findings: ReviewResult["findings"];
            sessionId: string;
            config: AutoDevConfig;
          };
        }) => {
          const findingsText = input.findings
            .map((f) => `[${f.severity}] ${f.file}: ${f.description}`)
            .join("\n");
          logger.info({ issue: input.issue.number }, "Fixing review findings...");
          await executor.execute({
            issue: {
              ...input.issue,
              body: `Fix these review findings:\n${findingsText}\n\nComplete the P1 and P2 fixes and triage any remaining issues.`,
            },
            config: input.config,
            sessionId: input.sessionId,
          });
          logger.info({ issue: input.issue.number }, "Fixes applied");
        },
      ),

      commitAndPush: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: AutoDevConfig } }) => {
          const message = `feat: implement #${input.issue.number} — ${input.issue.title}`;
          logger.info({ issue: input.issue.number }, "Committing and pushing...");
          await commitAndPush(message, input.config.git.commit_co_author, repoDir);
          logger.info({ issue: input.issue.number }, "Pushed to remote");
        },
      ),

      createPr: fromPromise(
        async ({
          input,
        }: {
          input: {
            issue: GitHubIssue;
            config: AutoDevConfig;
            reviewFindings: ReviewResult["findings"];
          };
        }) => {
          logger.info({ issue: input.issue.number }, "Creating PR...");
          const prUrl = await createPullRequest(input.issue, input.config, input.reviewFindings);
          logger.info({ issue: input.issue.number, prUrl }, "PR created");
          return { prUrl };
        },
      ),
    },
  });

  // Restore or create actor
  let actor;
  if (options.resume) {
    const snapshot = loadSnapshot();
    if (snapshot) {
      logger.info("Resuming from saved state");
      actor = createActor(machine, { snapshot: snapshot as Snapshot<unknown> });
    } else {
      logger.warn("No saved state found, starting fresh");
      actor = createActor(machine);
    }
  } else {
    actor = createActor(machine);
  }

  // Persist on every state change and log transitions
  actor.subscribe((snapshot) => {
    persistSnapshot(snapshot as unknown as Snapshot<unknown>);
    logger.info({ state: snapshot.value }, "State transition");
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutdown requested");
    const persisted = actor.getPersistedSnapshot();
    persistSnapshot(persisted as unknown as Snapshot<unknown>);
    if (bridge) bridge.cleanup();
    if (bot) stopBot(bot);
    logger.info("State saved. Run with --resume to continue.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the machine
  actor.start();

  if (!options.resume) {
    actor.send({ type: "START" });
  }

  // Wait for completion
  return new Promise<void>((resolve) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === "done") {
        const ctx = snapshot.context;
        logger.info(
          {
            completed: ctx.completedIssues.length,
            skipped: ctx.skippedIssues.length,
            runtime: Date.now() - ctx.startedAt,
          },
          "All issues processed",
        );

        const summary = [
          "AutoDev Run Complete",
          "",
          `Completed: ${ctx.completedIssues.length} issue(s)`,
          ...ctx.completedIssues.map(
            (i) => `  - #${i.number} — ${i.title} → ${i.prUrl}`,
          ),
          "",
          `Skipped: ${ctx.skippedIssues.length} issue(s)`,
          ...ctx.skippedIssues.map(
            (i) => `  - #${i.number} — ${i.title} (${i.reason})`,
          ),
        ].join("\n");

        console.log("\n" + summary);

        if (bridge) {
          bridge
            .notify(summary)
            .catch(() => logger.warn("Failed to send completion summary to Telegram"));
          bridge.cleanup();
        }
        if (bot) stopBot(bot);
        resolve();
      }
    });
  });
}
