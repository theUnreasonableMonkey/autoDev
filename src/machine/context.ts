export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface ReviewFinding {
  severity: "P1" | "P2" | "P3";
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
}

export interface CompletedIssue {
  number: number;
  title: string;
  prUrl: string;
  reviewIterations: number;
  questionsAsked: number;
}

export interface SkippedIssue {
  number: number;
  title: string;
  reason: string;
}

export interface WorkflowContext {
  // Queue
  issues: GitHubIssue[];
  currentIssueIndex: number;
  currentIssue: GitHubIssue | null;

  // Current issue state
  branchName: string | null;
  sessionId: string | null;
  reviewIteration: number;
  reviewFindings: ReviewFinding[];
  questionCount: number;

  // Rate limiting
  retryCount: number;
  lastRateLimitAt: number | null;

  // Run metadata
  runId: string;
  startedAt: number;
  completedIssues: CompletedIssue[];
  skippedIssues: SkippedIssue[];

  // Error tracking
  lastError: string | null;
}

export type WorkflowEvent =
  | { type: "START" }
  | { type: "ISSUES_FETCHED"; issues: GitHubIssue[] }
  | { type: "NO_ISSUES" }
  | { type: "ISSUE_PREPARED"; branchName: string }
  | { type: "ISSUE_CLOSED_EXTERNALLY" }
  | { type: "WORK_COMPLETE"; sessionId: string }
  | { type: "QUESTION_ANSWERED" }
  | { type: "REVIEW_COMPLETE"; result: ReviewResult }
  | { type: "FIX_COMPLETE" }
  | { type: "COMMIT_COMPLETE" }
  | { type: "PR_CREATED"; prUrl: string }
  | { type: "RATE_LIMITED"; retryAfterMs?: number }
  | { type: "RATE_LIMIT_RESOLVED" }
  | { type: "HUMAN_PROCEED" }
  | { type: "HUMAN_SKIP"; reason: string }
  | { type: "ESCALATION_TIMEOUT" }
  | { type: "ERROR"; message: string };

export function createInitialContext(runId: string): WorkflowContext {
  return {
    issues: [],
    currentIssueIndex: 0,
    currentIssue: null,
    branchName: null,
    sessionId: null,
    reviewIteration: 0,
    reviewFindings: [],
    questionCount: 0,
    retryCount: 0,
    lastRateLimitAt: null,
    runId,
    startedAt: Date.now(),
    completedIssues: [],
    skippedIssues: [],
    lastError: null,
  };
}
