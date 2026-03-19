import type { DevExecutor, TaskInput, TaskOutput, QuestionHandler } from "./types.js";
import type { AutoDevConfig } from "../config/schema.js";

export class ClaudeDevExecutor implements DevExecutor {
  private questionHandler: QuestionHandler | null = null;
  private config: AutoDevConfig;

  constructor(config: AutoDevConfig) {
    this.config = config;
  }

  setQuestionHandler(handler: QuestionHandler): void {
    this.questionHandler = handler;
  }

  async execute(input: TaskInput): Promise<TaskOutput> {
    // Dynamic import to avoid requiring the SDK at module load time
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const prompt = this.buildPrompt(input);
    let sessionId = input.sessionId ?? "";

    const options: Record<string, unknown> = {
      allowedTools: this.config.executor.allowed_tools,
      cwd: this.config.executor.working_directory,
      permissionMode: "bypassPermissions",
    };

    if (input.sessionId) {
      (options as Record<string, unknown>)["resume"] = input.sessionId;
    }

    // Set up canUseTool callback for question handling
    if (this.questionHandler) {
      const handler = this.questionHandler;
      const issue = input.issue;
      (options as Record<string, unknown>)["canUseTool"] = async (
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => {
        if (toolName === "AskUserQuestion") {
          const questions = toolInput["questions"] as Array<{
            question: string;
            options: Array<{ label: string; description: string }>;
          }>;
          if (questions && questions.length > 0) {
            const q = questions[0]!;
            const answer = await handler.handle(q.question, q.options, issue);
            return {
              behavior: "allow",
              updatedInput: {
                ...toolInput,
                answers: { [q.question]: answer },
              },
            };
          }
        }
        return { behavior: "allow", updatedInput: toolInput };
      };
    }

    for await (const message of query({ prompt, options })) {
      // Capture session ID from init message
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as Record<string, unknown>)["type"] === "system" &&
        "subtype" in message &&
        (message as Record<string, unknown>)["subtype"] === "init"
      ) {
        const sid = (message as Record<string, unknown>)["session_id"];
        if (typeof sid === "string") {
          sessionId = sid;
        }
      }

      // Capture result
      if (typeof message === "object" && message !== null && "result" in message) {
        // Work complete
        break;
      }
    }

    return { sessionId };
  }

  private buildPrompt(input: TaskInput): string {
    const { issue } = input;
    const lines = [
      `Work on GitHub issue #${issue.number}: ${issue.title}`,
      "",
      "## Issue Description",
      issue.body,
      "",
      "## Instructions",
      "- Implement the changes described in the issue",
      "- Follow existing code patterns and conventions",
      "- Write tests for new functionality",
      "- Make sure all tests pass before finishing",
    ];

    if (input.sessionId) {
      lines.unshift("Continue the previous session. Pick up where you left off.");
    }

    return lines.join("\n");
  }
}
