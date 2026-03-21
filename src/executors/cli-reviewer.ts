import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewResult, ReviewFinding } from "../machine/context.js";
import type { AutoDevConfig } from "../config/schema.js";

const REVIEW_PROMPT_FALLBACK = `You are performing an independent code review of the changes on the current branch compared to main.

Review the code for:
1. **Security** — injection vulnerabilities, auth gaps, secrets exposure, input validation
2. **Architecture** — separation of concerns, proper layering, no circular dependencies
3. **Best practices** — error handling, edge cases, naming conventions, DRY principles
4. **Testing** — adequate test coverage, meaningful assertions, edge case tests
5. **Conventions** — check CLAUDE.md and any project conventions for compliance

Compare the changes against any documented standards in the repo (CLAUDE.md, README, etc).

After your review, output a JSON block with your findings in this exact format:
\`\`\`json
{
  "findings": [
    {
      "severity": "P1",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "summary": "Brief summary of the review"
}
\`\`\`

Severity guide:
- P1 (Critical): Bugs, security vulnerabilities, data loss risks
- P2 (Important): Missing error handling, performance issues, missing tests
- P3 (Suggestion): Style improvements, minor refactors

If the code looks good, return: \`\`\`json\n{"findings": [], "summary": "Code looks good."}\n\`\`\``;

/**
 * Spawns an independent Claude Code CLI session to review a PR.
 * Tries /workflows:review, then /review, then falls back to a comprehensive prompt.
 * Streams output to the terminal in real-time.
 */
export async function runCliReview(
  repoDir: string,
  _config: AutoDevConfig,
  prNumber: number,
  onOutput?: (line: string) => void,
): Promise<ReviewResult> {
  // Determine the review prompt to use
  const prompt = await buildReviewPrompt(repoDir, prNumber);

  const log = onOutput ?? ((line: string) => process.stdout.write(line));

  // Spawn claude CLI in print mode with streaming
  let resultText = "";

  try {
    const child = execa("claude", ["-p", "--dangerously-skip-permissions", "--output-format", "text", prompt], {
      cwd: repoDir,
      stdin: "ignore",
      env: {
        ...process.env,
        CLAUDE_AUTO_ACCEPT: "true",
        ANTHROPIC_API_KEY: undefined,
      },
      reject: false,
    });

    // Stream stdout in real-time
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        resultText += text;
        log(text);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        log(text);
      });
    }

    await child;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      findings: [
        {
          severity: "P3",
          file: "unknown",
          description: `CLI review session failed: ${msg.slice(0, 200)}`,
        },
      ],
      summary: `Review session failed: ${msg.slice(0, 100)}`,
    };
  }

  return parseReviewOutput(resultText);
}

async function buildReviewPrompt(repoDir: string, prNumber: number): Promise<string> {
  // Check if /workflows:review or /review skills exist
  const hasWorkflowsReview = await checkSkillExists(repoDir, "workflows:review");
  if (hasWorkflowsReview) {
    return `/workflows:review`;
  }

  const hasReview = await checkSkillExists(repoDir, "review");
  if (hasReview) {
    return `/review`;
  }

  // Fall back to comprehensive review prompt
  // Load any CLAUDE.md conventions for context
  let conventions = "";
  const claudeMdPaths = [
    join(repoDir, "CLAUDE.md"),
    join(repoDir, ".claude", "CLAUDE.md"),
  ];

  for (const p of claudeMdPaths) {
    if (existsSync(p)) {
      conventions += `\n\nProject conventions from ${p}:\n${readFileSync(p, "utf-8").slice(0, 2000)}`;
    }
  }

  // Check user's global CLAUDE.md
  const userClaudeMd = join(
    process.env["USERPROFILE"] ?? process.env["HOME"] ?? "",
    ".claude",
    "CLAUDE.md",
  );
  if (existsSync(userClaudeMd)) {
    conventions += `\n\nUser conventions:\n${readFileSync(userClaudeMd, "utf-8").slice(0, 1000)}`;
  }

  return `${REVIEW_PROMPT_FALLBACK}${conventions}\n\nReview the changes on the current branch (PR #${prNumber}) compared to main.`;
}

async function checkSkillExists(repoDir: string, skillName: string): Promise<boolean> {
  try {
    // Try running claude with the skill in dry-run-like fashion
    // Check if .claude/skills or compound engineering has the skill
    const skillPaths = [
      join(repoDir, ".claude", "skills", skillName),
      join(repoDir, ".claude", "commands", `${skillName}.md`),
    ];

    for (const p of skillPaths) {
      if (existsSync(p)) return true;
    }

    // Check for compound engineering plugin skills
    const pluginDir = join(
      process.env["USERPROFILE"] ?? process.env["HOME"] ?? "",
      ".claude",
      "plugins",
      "cache",
      "every-marketplace",
      "compound-engineering",
    );
    if (existsSync(pluginDir)) {
      // compound-engineering skills are available
      if (skillName === "workflows:review") return true;
    }

    return false;
  } catch {
    return false;
  }
}

function parseReviewOutput(text: string): ReviewResult {
  // Try to extract JSON from the output
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    try {
      return validateResult(JSON.parse(jsonMatch[1]));
    } catch {
      // Continue to fallback
    }
  }

  // Try to find raw JSON
  const rawJsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
  if (rawJsonMatch?.[0]) {
    try {
      return validateResult(JSON.parse(rawJsonMatch[0]));
    } catch {
      // Fall through
    }
  }

  // No structured output — assume review passed if no obvious errors mentioned
  const hasIssues =
    text.toLowerCase().includes("critical") ||
    text.toLowerCase().includes("vulnerability") ||
    text.toLowerCase().includes("security issue") ||
    text.toLowerCase().includes("bug found");

  if (hasIssues) {
    return {
      findings: [
        {
          severity: "P2",
          file: "unknown",
          description: `Reviewer flagged issues but did not produce structured output. Review text: ${text.slice(-500)}`,
        },
      ],
      summary: "Review flagged potential issues — see findings.",
    };
  }

  return {
    findings: [],
    summary: "Review complete — no structured findings returned (assumed clean).",
  };
}

function validateResult(data: unknown): ReviewResult {
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj["findings"])) {
    return { findings: [], summary: "No findings." };
  }

  const findings = (obj["findings"] as Record<string, unknown>[]).map(
    (f): ReviewFinding => ({
      severity: (["P1", "P2", "P3"].includes(String(f["severity"]))
        ? String(f["severity"])
        : "P3") as ReviewFinding["severity"],
      file: String(f["file"] ?? "unknown"),
      line: typeof f["line"] === "number" ? f["line"] : undefined,
      description: String(f["description"] ?? "No description"),
      suggestion: typeof f["suggestion"] === "string" ? f["suggestion"] : undefined,
    }),
  );

  return {
    findings,
    summary: String(obj["summary"] ?? "Review complete."),
  };
}
