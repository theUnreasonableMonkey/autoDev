import { execa } from "execa";
import type { DevExecutor, TaskInput, TaskOutput } from "./types.js";

export class ClaudeDevExecutor implements DevExecutor {
  private repoDir: string;

  constructor(_config: unknown, repoDir: string) {
    this.repoDir = repoDir;
  }

  setQuestionHandler(_handler: unknown): void {
    // Not used in CLI mode
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
          ANTHROPIC_API_KEY: undefined,
        },
      },
    );

    // Stream output to terminal so user sees progress
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
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

    return { sessionId: `cli-${Date.now()}` };
  }

  private buildPrompt(input: TaskInput): string {
    const { issue } = input;
    return [
      "IMPORTANT: You are an automated coding agent. Do NOT ask questions. Do NOT wait for input. Just implement the code.",
      "",
      `Implement GitHub issue #${issue.number}: ${issue.title}`,
      "",
      "Issue description:",
      issue.body || "(No description provided — implement based on the title)",
      "",
      "Requirements:",
      "1. Read the existing codebase first to understand the project structure, patterns, and conventions.",
      "2. Write ALL the code needed to implement this issue. Create new files, modify existing files — whatever is needed.",
      "3. If the project has no code yet, scaffold the necessary project structure (package.json, source files, etc).",
      "4. Make sure the code is complete and functional — not stubs or placeholders.",
      "5. If a test framework exists, write tests. If not, skip tests.",
      "",
      "CRITICAL RULES:",
      "- Do NOT run git commit, git push, or create pull requests. AutoDev handles git operations.",
      "- Do NOT ask the user any questions. Make reasonable decisions and proceed.",
      "- Do NOT just describe what you would do — actually write the code using the Write and Edit tools.",
      "- If you encounter ambiguity, make the simplest reasonable choice and implement it.",
    ].join("\n");
  }
}
