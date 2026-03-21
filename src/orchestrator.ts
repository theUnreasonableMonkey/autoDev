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
} from "./github/git-ops.js";
import { createPullRequest, mergePullRequest } from "./github/pr.js";
import { ClaudeDevExecutor } from "./executors/claude-dev.js";
import * as display from "./utils/display.js";
import type { GitHubIssue } from "./machine/context.js";
import type { AutoDevConfig as Config } from "./config/schema.js";
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
  const { config, repoDir } = options;

  display.banner();
  display.configLoaded(config.repo, repoDir, config.reviewer.type);

  // Dev executor
  const executor = new ClaudeDevExecutor(config, repoDir);

  // Track progress
  let totalIssues = 0;
  let currentIssueIdx = 0;

  // Wire state machine
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
        async ({ input }: { input: { issue: GitHubIssue; config: Config; issueIndex: number } }) => {
          const { issue } = input;
          currentIssueIdx = input.issueIndex;
          display.issueStart(issue, currentIssueIdx, totalIssues);
          display.step("Checking working directory");
          await verifyCleanWorkDir(repoDir);
          display.step("Pulling latest main");
          await pullMain(repoDir);
          display.step("Creating feature branch");
          const branchName = await createBranch(
            config.git.branch_prefix, issue.number, issue.title, repoDir,
          );
          display.stepDone("Branch ready", branchName);
          return { branchName };
        },
      ),

      workOnIssue: fromPromise(
        async ({ input }: {
          input: { issue: GitHubIssue; config: Config; sessionId: string | null };
        }) => {
          display.step("Claude is implementing the issue", "this may take a few minutes");
          const startTime = Date.now();
          const result = await executor.execute({
            issue: input.issue, config: input.config, sessionId: input.sessionId,
          });
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          display.stepDone("Implementation complete", `${elapsed}s`);
          return result;
        },
      ),

      commitAndPush: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: Config } }) => {
          display.step("Committing and pushing changes");
          const message = `feat: implement #${input.issue.number} — ${input.issue.title}`;
          await commitAndPush(message, input.config.git.commit_co_author, repoDir);
          display.stepDone("Pushed to remote");
        },
      ),

      createPr: fromPromise(
        async ({ input }: { input: { issue: GitHubIssue; config: Config } }) => {
          display.step("Creating pull request");
          const { prUrl, prNumber } = await createPullRequest(input.issue, input.config, repoDir);
          display.stepDone("PR created", `#${prNumber} — ${prUrl}`);
          return { prUrl, prNumber };
        },
      ),

      mergePr: fromPromise(
        async ({ input }: { input: { prUrl: string; config: Config } }) => {
          display.step("Merging PR");
          await mergePullRequest(input.prUrl, repoDir);
          display.stepDone("PR merged and branch deleted");
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

  // Persist + display
  actor.subscribe((snapshot) => {
    persistSnapshot(snapshot as unknown as Snapshot<unknown>);
    const ctx = snapshot.context;
    if (ctx.currentIssueIndex !== currentIssueIdx) {
      currentIssueIdx = ctx.currentIssueIndex;
    }
    if (snapshot.value === "advancingQueue" && ctx.completedIssues.length > 0) {
      const last = ctx.completedIssues[ctx.completedIssues.length - 1];
      if (last) display.issueComplete(last.number, last.prUrl);
    }
    if (snapshot.value === "skippingIssue" && ctx.skippedIssues.length > 0) {
      const last = ctx.skippedIssues[ctx.skippedIssues.length - 1];
      if (last) display.issueSkipped(last.number, last.reason);
    }
    if (snapshot.value === "rateLimited") {
      display.rateLimited(30000);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutdown requested. Saving state...");
    const persisted = actor.getPersistedSnapshot();
    persistSnapshot(persisted as unknown as Snapshot<unknown>);
    console.log("State saved. Run with --resume to continue.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  actor.start();
  if (!options.resume) actor.send({ type: "START" });

  // Wait for completion
  return new Promise<void>((resolve) => {
    actor.subscribe((snapshot) => {
      if (snapshot.status === "done") {
        const ctx = snapshot.context;
        display.runSummary(ctx.completedIssues, ctx.skippedIssues, Date.now() - ctx.startedAt);
        resolve();
      }
    });
  });
}
