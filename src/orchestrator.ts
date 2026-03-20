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
import * as display from "./utils/display.js";
import type { GitHubIssue, ReviewResult } from "./machine/context.js";
import type { Reviewer } from "./executors/types.js";
import type { Snapshot } from "xstate";
import type { Logger } from "pino";

export interface OrchestratorOptions {
  config: AutoDevConfig;
  secrets: AppSecrets;
  logger: Logger;
  repoDir: string;
  verbose?: boolean;
  resume?: boolean;
}

export async function runOrchestrator(options: OrchestratorOptions): Promise<void> {
  const { config, secrets, logger, repoDir, verbose } = options;

  display.banner();
  display.configLoaded(config.repo, repoDir, config.reviewer.type);

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
    display.telegramStatus(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    display.telegramStatus(false, msg);
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

  // Set up executor
  const executor = new ClaudeDevExecutor(config, repoDir);
  executor.setQuestionHandler(questionHandler);

  // Create reviewer
  const reviewer: Reviewer =
    config.reviewer.type === "codex" ? new CodexReviewer() : new ClaudeReviewer();

  // Track issue progress for display
  let totalIssues = 0;
  let currentIssueIdx = 0;

  // Create the state machine with real actors
  const machine = createWorkflowMachine(config).provide({
    actors: {
      fetchIssues: fromPromise(async () => {
        display.step("Fetching issues from GitHub");
        const issues = await fetchIssues(config);
        totalIssues = issues.length;
        display.issueQueueLoaded(issues);
        return issues;
      }),

      prepareIssue: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: AutoDevConfig } }) => {
          const { issue } = input;
          display.issueStart(issue, currentIssueIdx, totalIssues);

          display.step("Pulling latest main");
          await pullMain(repoDir);

          display.step("Checking working directory");
          await verifyCleanWorkDir(repoDir);

          display.step("Creating feature branch");
          const branchName = await createBranch(
            config.git.branch_prefix,
            issue.number,
            issue.title,
            repoDir,
          );
          display.stepDone("Branch ready", branchName);
          return { branchName };
        },
      ),

      workOnIssue: fromPromise(
        async ({
          input,
        }: {
          input: { issue: GitHubIssue; config: AutoDevConfig; sessionId: string | null };
        }) => {
          display.step("Claude is implementing the issue", "this may take a few minutes");
          const startTime = Date.now();
          const result = await executor.execute({
            issue: input.issue,
            config: input.config,
            sessionId: input.sessionId,
          });
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          display.stepDone("Implementation complete", `${elapsed}s`);
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
          const iteration = input.previousFindings.length > 0 ? 2 : 1;
          display.step(
            `Running code review`,
            `iteration ${iteration}/${config.reviewer.max_iterations}`,
          );
          const diff = await getCurrentDiff(repoDir);

          if (verbose) {
            const diffLines = diff.split("\n").length;
            display.step("Diff size", `${diffLines} lines`);
          }

          const result = await reviewer.review({
            issue: input.issue,
            diff,
            previousFindings: input.previousFindings,
            iterationNumber: iteration,
          });
          display.reviewResult(result.findings, iteration, config.reviewer.max_iterations);
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
          const p1p2 = input.findings.filter(
            (f) => f.severity === "P1" || f.severity === "P2",
          );
          display.step("Claude is fixing review findings", `${p1p2.length} issue(s)`);
          const findingsText = p1p2
            .map((f) => `[${f.severity}] ${f.file}: ${f.description}`)
            .join("\n");
          await executor.execute({
            issue: {
              ...input.issue,
              body: `Fix these review findings:\n${findingsText}\n\nComplete the P1 and P2 fixes and triage any remaining issues.`,
            },
            config: input.config,
            sessionId: input.sessionId,
          });
          display.stepDone("Fixes applied");
        },
      ),

      commitAndPush: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: AutoDevConfig } }) => {
          display.step("Committing changes");
          const message = `feat: implement #${input.issue.number} — ${input.issue.title}`;
          await commitAndPush(message, input.config.git.commit_co_author, repoDir);
          display.stepDone("Committed and pushed to remote");
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
          display.step("Creating pull request");
          const prUrl = await createPullRequest(input.issue, input.config, input.reviewFindings);
          display.stepDone("PR created and merged");
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
      display.step("Resuming from saved state");
      actor = createActor(machine, { snapshot: snapshot as Snapshot<unknown> });
    } else {
      display.step("No saved state found, starting fresh");
      actor = createActor(machine);
    }
  } else {
    actor = createActor(machine);
  }

  // Persist on every state change
  actor.subscribe((snapshot) => {
    persistSnapshot(snapshot as unknown as Snapshot<unknown>);

    // Track issue advancement for display
    const ctx = snapshot.context;
    if (ctx.currentIssueIndex !== currentIssueIdx) {
      currentIssueIdx = ctx.currentIssueIndex;
    }

    // Show completed/skipped issues
    if (snapshot.value === "advancingQueue" || snapshot.value === "skippingIssue") {
      if (ctx.completedIssues.length > 0) {
        const last = ctx.completedIssues[ctx.completedIssues.length - 1];
        if (last) {
          display.issueComplete(last.number, last.prUrl);
        }
      }
    }

    if (snapshot.value === "skippingIssue") {
      if (ctx.skippedIssues.length > 0) {
        const last = ctx.skippedIssues[ctx.skippedIssues.length - 1];
        if (last) {
          display.issueSkipped(last.number, last.reason);
        }
      }
    }

    if (snapshot.value === "rateLimited") {
      display.rateLimited(30000);
    }

    if (verbose) {
      logger.debug({ state: snapshot.value }, "State transition");
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutdown requested. Saving state...");
    const persisted = actor.getPersistedSnapshot();
    persistSnapshot(persisted as unknown as Snapshot<unknown>);
    if (bridge) bridge.cleanup();
    if (bot) stopBot(bot);
    console.log("State saved. Run with --resume to continue.");
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

        display.runSummary(
          ctx.completedIssues,
          ctx.skippedIssues,
          Date.now() - ctx.startedAt,
        );

        // Send summary via Telegram
        if (bridge) {
          const text = [
            "AutoDev Run Complete",
            `Completed: ${ctx.completedIssues.length}`,
            `Skipped: ${ctx.skippedIssues.length}`,
          ].join("\n");
          bridge
            .notify(text)
            .catch(() => {});
          bridge.cleanup();
        }
        if (bot) stopBot(bot);
        resolve();
      }
    });
  });
}
