import type { GitHubIssue, ReviewFinding, ReviewResult } from "../machine/context.js";
import type { AutoDevConfig } from "../config/schema.js";

export interface TaskInput {
  issue: GitHubIssue;
  config: AutoDevConfig;
  sessionId: string | null;
}

export interface TaskOutput {
  sessionId: string;
}

export type ExecutorEvent =
  | { type: "message"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "question"; question: string; options: string[] }
  | { type: "complete"; sessionId: string }
  | { type: "error"; message: string };

export interface DevExecutor {
  execute(input: TaskInput): Promise<TaskOutput>;
}

export interface IssueContext {
  issue: GitHubIssue;
  diff: string;
  previousFindings: ReviewFinding[];
  iterationNumber: number;
}

export interface Reviewer {
  review(context: IssueContext): Promise<ReviewResult>;
}

export interface QuestionHandler {
  handle(
    question: string,
    options: Array<{ label: string; description: string }>,
    issueContext: GitHubIssue,
  ): Promise<string>;
}
