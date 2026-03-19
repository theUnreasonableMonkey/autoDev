import { setup, assign, fromPromise } from "xstate";
import type {
  WorkflowContext,
  WorkflowEvent,
  GitHubIssue,
  ReviewResult,
} from "./context.js";
import { createInitialContext } from "./context.js";
import type { AutoDevConfig } from "../config/schema.js";

// Stub actors — replaced with real implementations in later phases
const fetchIssuesActor = fromPromise(
  async (_: { input: { config: AutoDevConfig } }): Promise<GitHubIssue[]> => {
    throw new Error("fetchIssues not yet implemented");
  },
);

const prepareIssueActor = fromPromise(
  async (
    _: { input: { issue: GitHubIssue; config: AutoDevConfig } },
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

const reviewCodeActor = fromPromise(
  async (
    _: {
      input: {
        issue: GitHubIssue;
        config: AutoDevConfig;
        previousFindings: ReviewResult["findings"];
      };
    },
  ): Promise<ReviewResult> => {
    throw new Error("reviewCode not yet implemented");
  },
);

const fixIssuesActor = fromPromise(
  async (
    _: {
      input: {
        issue: GitHubIssue;
        findings: ReviewResult["findings"];
        sessionId: string;
        config: AutoDevConfig;
      };
    },
  ): Promise<void> => {
    throw new Error("fixIssues not yet implemented");
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
    _: {
      input: {
        issue: GitHubIssue;
        config: AutoDevConfig;
        reviewFindings: ReviewResult["findings"];
      };
    },
  ): Promise<{ prUrl: string }> => {
    throw new Error("createPr not yet implemented");
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
      reviewCode: reviewCodeActor,
      fixIssues: fixIssuesActor,
      commitAndPush: commitAndPushActor,
      createPr: createPrActor,
    },
    guards: {
      hasMoreIssues: ({ context }) => {
        return context.currentIssueIndex < context.issues.length;
      },
      isCleanReview: ({ context }) => {
        return !context.reviewFindings.some(
          (f) => f.severity === "P1" || f.severity === "P2",
        );
      },
      hasReviewRetriesLeft: ({ context }) => {
        return context.reviewIteration < config.reviewer.max_iterations;
      },
      hasCriticalIssues: ({ context }) => {
        return context.reviewFindings.some((f) => f.severity === "P1");
      },
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
            target: "rateLimited",
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
          }),
          onDone: {
            target: "working",
            actions: assign({
              branchName: ({ event }) => event.output.branchName,
              reviewIteration: 0,
              reviewFindings: [],
              questionCount: 0,
              sessionId: null,
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
            target: "reviewing",
            actions: assign({
              sessionId: ({ event }) => event.output.sessionId,
            }),
          },
          onError: [
            {
              target: "rateLimited",
              actions: assign({
                lastError: ({ event }) =>
                  event.error instanceof Error ? event.error.message : String(event.error),
              }),
            },
          ],
        },
      },

      reviewing: {
        invoke: {
          src: "reviewCode",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            config,
            previousFindings: context.reviewFindings,
          }),
          onDone: [
            {
              // Clean review — no P1/P2 findings
              guard: ({ event }) =>
                !event.output.findings.some(
                  (f: { severity: string }) => f.severity === "P1" || f.severity === "P2",
                ),
              target: "committing",
              actions: assign({
                reviewFindings: ({ event }) => event.output.findings,
                reviewIteration: ({ context }) => context.reviewIteration + 1,
              }),
            },
            {
              // Has fixable issues and retries left
              guard: "hasReviewRetriesLeft",
              target: "fixing",
              actions: assign({
                reviewFindings: ({ event }) => event.output.findings,
                reviewIteration: ({ context }) => context.reviewIteration + 1,
              }),
            },
            {
              // Max iterations reached — check for critical issues
              guard: ({ event }) =>
                event.output.findings.some(
                  (f: { severity: string }) => f.severity === "P1",
                ),
              target: "escalating",
              actions: assign({
                reviewFindings: ({ event }) => event.output.findings,
                reviewIteration: ({ context }) => context.reviewIteration + 1,
              }),
            },
            {
              // Max iterations, no P1s — commit anyway (P2s only)
              target: "committing",
              actions: assign({
                reviewFindings: ({ event }) => event.output.findings,
                reviewIteration: ({ context }) => context.reviewIteration + 1,
              }),
            },
          ],
          onError: {
            target: "rateLimited",
            actions: assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
            }),
          },
        },
      },

      fixing: {
        invoke: {
          src: "fixIssues",
          input: ({ context }) => ({
            issue: context.currentIssue!,
            findings: context.reviewFindings.filter(
              (f) => f.severity === "P1" || f.severity === "P2",
            ),
            sessionId: context.sessionId!,
            config,
          }),
          onDone: {
            target: "reviewing",
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
            reviewFindings: context.reviewFindings,
          }),
          onDone: {
            target: "advancingQueue",
            actions: assign({
              completedIssues: ({ context, event }) => [
                ...context.completedIssues,
                {
                  number: context.currentIssue!.number,
                  title: context.currentIssue!.title,
                  prUrl: event.output.prUrl,
                  reviewIterations: context.reviewIteration,
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
            `[AutoDev] Escalating issue #${context.currentIssue?.number ?? "?"}: ${context.lastError}`,
          );
        },
        after: {
          // Auto-skip after 10 seconds if no human responds (covers no-Telegram case)
          10000: {
            target: "skippingIssue",
            actions: assign({
              lastError: ({ context }) =>
                context.lastError ?? "Escalation timed out — no human response",
            }),
          },
        },
        on: {
          HUMAN_PROCEED: { target: "committing" },
          HUMAN_SKIP: {
            target: "skippingIssue",
            actions: assign({
              lastError: ({ event }) => event.reason,
            }),
          },
          ESCALATION_TIMEOUT: {
            target: "skippingIssue",
            actions: assign({
              lastError: () => "Escalation timed out — no human response",
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
        on: {
          RATE_LIMIT_RESOLVED: {
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
