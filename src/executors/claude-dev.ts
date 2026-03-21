import { execa } from "execa";
import type { DevExecutor, TaskInput, TaskOutput } from "./types.js";

export class ClaudeDevExecutor implements DevExecutor {
  private repoDir: string;

  constructor(_config: unknown, repoDir: string) {
    this.repoDir = repoDir;
  }

  setQuestionHandler(_handler: unknown): void {
    // Question handling is built into Claude Code CLI via --dangerously-skip-permissions
  }

  async execute(input: TaskInput): Promise<TaskOutput> {
    const prompt = this.buildPrompt(input);

    // Spawn Claude Code CLI as a subprocess
    const child = execa(
      "claude",
      [
        "-p",
        "--dangerously-skip-permissions",
        prompt,
      ],
      {
        cwd: this.repoDir,
        timeout: 600_000, // 10 minute timeout per issue
        reject: false,
        stdin: "ignore",
        env: {
          ...process.env,
          // Remove API key so CLI uses OAuth (Max Pro subscription) instead
          ANTHROPIC_API_KEY: undefined,
        },
      },
    );

    // Stream output to terminal so user sees progress
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        // Indent and prefix each line for visual clarity
        for (const line of text.split("\n")) {
          if (line.trim()) {
            process.stdout.write(`     ${line}\n`);
          }
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) {
            process.stderr.write(`     ${line}\n`);
          }
        }
      });
    }

    const result = await child;

    if (result.exitCode !== 0 && result.exitCode !== null) {
      const errMsg = result.stderr?.slice(0, 500) || result.stdout?.slice(0, 500) || "Unknown error";
      throw new Error(`Claude CLI exited with code ${result.exitCode}: ${errMsg}`);
    }

    // Session ID not available in CLI mode — use a placeholder
    return { sessionId: `cli-${Date.now()}` };
  }

  private buildPrompt(input: TaskInput): string {
    const { issue } = input;
    return [
      `You are working in the repository at ${this.repoDir}.`,
      `Implement GitHub issue #${issue.number}: ${issue.title}`,
      "",
      "## Issue Description",
      issue.body,
      "",
      "## Instructions",
      "- Read existing code and understand the project structure before making changes",
      "- Implement the changes described in the issue completely",
      "- Follow existing code patterns and conventions",
      "- Write tests for new functionality if a test framework is set up",
      "- Make sure the code compiles/runs without errors",
      "- Do NOT commit or push — just write the code",
    ].join("\n");
  }
}
