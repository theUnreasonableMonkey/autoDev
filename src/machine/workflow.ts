import { setup, assign, fromPromise } from "xstate";
import type {
  WorkflowContext,
  WorkflowEvent,
  GitHubIssue,
} from "./context.js";
import { createInitialContext } from "./context.js";
import type { AutoDevConfig } from "../config/schema.js";

// Stub actors — replaced with real implementations via .provide()
const fetchIssuesActor = fromPromise(
  async (_: { input: { config: AutoDevConfig } }): Promise<GitHubIssue[]> => {
    throw new Error("fetchIssues not yet implemented");
  },
);

const prepareIssueActor = fromPromise(
  async (
    _: { input: { issue: GitHubIssue; config: AutoDevConfig; issueIndex: number } },
  ): Promise<{ branchName: string }> => {
    throw new Error("prepareIssue not yet implemented");
  },
);

const workOnIssueActor = fromPromise(
  async (
    _: { input: { issue: GitHubIssue; config: AutoDevConfig; sessionId: string | null } },
  ): Promise<{ sessionId: string }> => {
    throw new Error("workOnIssue not yet implemented");
  },
);

const commitAndPushActor = fromPromise(
  async (
    _: { input: { issue: GitHubIssue; config: AutoDevConfig } },
  ): Promise<void> => {
    throw new Error("commitAndPush not yet implemented");
  },
);

const createPrActor = fromPromise(
  async (
    _: { input: { issue: GitHubIssue; config: AutoDevConfig } },
  ): Promise<{ prUrl: string; prNumber: number }> => {
    throw new Error("createPr not yet implemented");
  },
);

const mergePrActor = fromPromise(
  async (
    _: { input: { prUrl: string; config: AutoDevConfig } },
  ): Promise<void> => {
    throw new Error("mergePr not yet implemented");
  },
);

export function createWorkflowMachine(config: AutoDevConfig) {
  return setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as WorkflowEvent,
    },
    actors: {
      fetchIssues: fetchIssuesActor,
      prepareIssue: prepareIssueActor,
      workOnIssue: workOnIssueActor,
      commitAndPush: commitAndPushActor,
      createPr: createPrActor,
      mergePr: mergePrActor,
    },
    delays: {
      rateLimitBackoff: ({ context }) => {
        const base = 30_000;
        const backoff = Math.min(base * Math.pow(2, context.retryCount), 300_000);
        const jitter = Math.random() * 5_000;
        return backoff + jitter;
      },
    },
  }).createMachine({
    id: "autodev",
    initial: "idle",
    context: createInitialContext(""),

    // FLOW: idle → fetchingQueue → preparingIssue → working
    //       → committing → creatingPr → mergingPr → advancingQueue → next or complete

    states: {
      idle: {
        on: {
          START: { target: "fetchingQueue" },
        },
      },

      fetchingQueue: {
        invoke: {
          src: "fetchIssues",
          input: () => ({ config }),
          onDone: [
            {
              guard: ({ event }) => event.output.length === 0,
              target: "complete",
              actions: assign({ issues: [] }),
            },
            {
              target: "preparingIssue",
              actions: assign({
                issues: ({ event }) => event.output,
                currentIssueIndex: 0,
                currentIssue: ({ event }) => event.output[0] ?? null,
              }),
            },
          ],
          onError: {
            target: "escalating",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      preparingIssue: {
        invoke: {
          src: "prepareIssue",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            config,
            issueIndex: context.currentIssueIndex,
          }),
          onDone: {
            target: "working",
            actions: assign({
              branchName: ({ event }) => event.output.branchName,
              questionCount: 0,
              sessionId: null,
              prUrl: null,
              prNumber: null,
            }),
          },
          onError: {
            target: "skippingIssue",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      working: {
        invoke: {
          src: "workOnIssue",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            config,
            sessionId: context.sessionId,
          }),
          onDone: {
            target: "committing",
            actions: assign({
              sessionId: ({ event }) => event.output.sessionId,
            }),
          },
          onError: {
            target: "rateLimited",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      committing: {
        invoke: {
          src: "commitAndPush",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            config,
          }),
          onDone: {
            target: "creatingPr",
          },
          onError: {
            target: "escalating",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      creatingPr: {
        invoke: {
          src: "createPr",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            config,
          }),
          onDone: {
            target: "mergingPr",
            actions: assign({
              prUrl: ({ event }) => event.output.prUrl,
              prNumber: ({ event }) => event.output.prNumber,
            }),
          },
          onError: {
            target: "escalating",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      mergingPr: {
        invoke: {
          src: "mergePr",
          input: ({ context }) => ({
            prUrl: context.prUrl!,
            config,
          }),
          onDone: {
            target: "advancingQueue",
            actions: assign({
              completedIssues: ({ context }) => [
                ...context.completedIssues,
                {
                  number: context.currentIssue!.number,
                  title: context.currentIssue!.title,
                  prUrl: context.prUrl!,
                  reviewIterations: 0,
                  questionsAsked: context.questionCount,
                },
              ],
            }),
          },
          onError: {
            target: "escalating",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      advancingQueue: {
        always: [
          {
            guard: ({ context }) =>
              context.currentIssueIndex + 1 < context.issues.length,
            target: "preparingIssue",
            actions: assign({
              currentIssueIndex: ({ context }) => context.currentIssueIndex + 1,
              currentIssue: ({ context }) =>
                context.issues[context.currentIssueIndex + 1] ?? null,
            }),
          },
          {
            target: "complete",
          },
        ],
      },

      skippingIssue: {
        entry: assign({
          skippedIssues: ({ context }) => [
            ...context.skippedIssues,
            {
              number: context.currentIssue?.number ?? 0,
              title: context.currentIssue?.title ?? "Unknown",
              reason: context.lastError ?? "Unknown reason",
            },
          ],
        }),
        always: [
          {
            guard: ({ context }) =>
              context.currentIssueIndex + 1 < context.issues.length,
            target: "preparingIssue",
            actions: assign({
              currentIssueIndex: ({ context }) => context.currentIssueIndex + 1,
              currentIssue: ({ context }) =>
                context.issues[context.currentIssueIndex + 1] ?? null,
            }),
          },
          {
            target: "complete",
          },
        ],
      },

      escalating: {
        entry: ({ context }) => {
          console.error(
            `[AutoDev] Error on issue #${context.currentIssue?.number ?? "?"}: ${context.lastError}`,
          );
        },
        after: {
          10000: {
            target: "skippingIssue",
            actions: assign({
              lastError: ({ context }) =>
                context.lastError ?? "Auto-skipped after error",
            }),
          },
        },
        on: {
          HUMAN_PROCEED: { target: "mergingPr" },
          HUMAN_SKIP: {
            target: "skippingIssue",
            actions: assign({
              lastError: ({ event }) => event.reason,
            }),
          },
        },
      },

      rateLimited: {
        entry: assign({
          retryCount: ({ context }) => context.retryCount + 1,
          lastRateLimitAt: () => Date.now(),
        }),
        after: {
          rateLimitBackoff: {
            target: "working",
            actions: assign({ retryCount: 0 }),
          },
        },
      },

      complete: {
        type: "final",
      },
    },
  });
}
