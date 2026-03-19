import { createActor } from "xstate";
import type { AutoDevConfig } from "./config/schema.js";
import type { AppSecrets } from "./config/loader.js";
import { createWorkflowMachine } from "./machine/workflow.js";
import { persistSnapshot, loadSnapshot } from "./machine/persistence.js";
import { fetchIssues } from "./github/issues.js";
import { pullMain, createBranch, verifyCleanWorkDir } from "./github/git-ops.js";
import { ClaudeDevExecutor } from "./executors/claude-dev.js";
import { ClaudeReviewer } from "./executors/claude-reviewer.js";
import { CodexReviewer } from "./executors/codex-reviewer.js";
import { ThreeTierQuestionHandler } from "./questions/handler.js";
import { createBot, startBot, stopBot } from "./telegram/bot.js";
import { TelegramBridge } from "./telegram/bridge.js";
import type { Snapshot } from "xstate";
import type { Logger } from "pino";

export interface OrchestratorOptions {
  config: AutoDevConfig;
  secrets: AppSecrets;
  logger: Logger;
  resume?: boolean;
}

export async function runOrchestrator(options: OrchestratorOptions): Promise<void> {
  const { config, secrets, logger } = options;

  // Set up Telegram bot and bridge
  const bot = createBot(secrets.telegramBotToken);
  const bridge = new TelegramBridge(
    bot,
    config.telegram.chat_id,
    config.telegram.escalation_timeout_minutes,
    config.telegram.reminder_interval_minutes,
  );
  await startBot(bot);

  // Set up question handler
  const questionHandler = new ThreeTierQuestionHandler(
    bridge,
    secrets.anthropicApiKey,
    logger,
    config.issues.max_questions_per_issue,
  );

  // Set up executor
  const executor = new ClaudeDevExecutor(config);
  executor.setQuestionHandler(questionHandler);

  // Create reviewer (used by the state machine actors)
  const reviewer =
    config.reviewer.type === "codex" ? new CodexReviewer() : new ClaudeReviewer();
  // Reviewer reference kept for state machine actor wiring
  void reviewer;

  // Create the state machine with real actors
  const machine = createWorkflowMachine(config).provide({
    actors: {
      fetchIssues: {
        // @ts-expect-error -- XState actor override
        invoke: async () => {
          logger.info("Fetching issues from GitHub...");
          return fetchIssues(config);
        },
      },
      prepareIssue: {
        // @ts-expect-error -- XState actor override
        invoke: async ({ input }: { input: { issue: { number: number; title: string } } }) => {
          const { issue } = input;
          logger.info({ issue: issue.number }, "Preparing issue");
          await pullMain();
          await verifyCleanWorkDir();
          const branchName = await createBranch(config.git.branch_prefix, issue.number, issue.title);
          logger.info({ branch: branchName }, "Branch created");
          return { branchName };
        },
      },
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

  // Persist on every state change
  actor.subscribe((snapshot) => {
    persistSnapshot(snapshot as unknown as Snapshot<unknown>);
    logger.debug({ state: snapshot.value }, "State transition");
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutdown requested");
    const persisted = actor.getPersistedSnapshot();
    persistSnapshot(persisted as unknown as Snapshot<unknown>);
    bridge.cleanup();
    stopBot(bot);
    logger.info("State saved. Run with --resume to continue.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for completion
  actor.start();

  if (!options.resume) {
    actor.send({ type: "START" });
  }

  // Subscribe to final state
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

        // Send summary via Telegram
        const summary = [
          "✅ *AutoDev Run Complete*",
          "",
          `Completed: ${ctx.completedIssues.length} issue(s)`,
          ...ctx.completedIssues.map(
            (i) => `  • #${i.number} — ${i.title} → [PR](${i.prUrl})`,
          ),
          "",
          `Skipped: ${ctx.skippedIssues.length} issue(s)`,
          ...ctx.skippedIssues.map(
            (i) => `  • #${i.number} — ${i.title} (${i.reason})`,
          ),
        ].join("\n");

        bridge
          .notify(summary)
          .catch(() => logger.warn("Failed to send completion summary to Telegram"));

        bridge.cleanup();
        stopBot(bot);
        resolve();
      }
    });
  });
}
