import { execa } from "execa";
import type { Reviewer, IssueContext } from "./types.js";
import type { ReviewResult, ReviewFinding } from "../machine/context.js";

const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["P1", "P2", "P3"] },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "file", "description"],
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
});

export class CodexReviewer implements Reviewer {
  async review(context: IssueContext): Promise<ReviewResult> {
    const prompt = this.buildPrompt(context);

    try {
      const { stdout } = await execa(
        "codex",
        [
          "exec",
          prompt,
          "--json",
          "--output-schema",
          REVIEW_SCHEMA,
          "--sandbox",
          "read-only",
          "--full-auto",
        ],
        { timeout: 300_000 }, // 5 minute timeout
      );

      return this.parseOutput(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // If Codex is not installed or fails, return a fallback
      return {
        findings: [
          {
            severity: "P3",
            file: "unknown",
            description: `Codex reviewer failed: ${message.slice(0, 200)}`,
          },
        ],
        summary: `Codex review failed: ${message.slice(0, 100)}`,
      };
    }
  }

  private buildPrompt(context: IssueContext): string {
    const lines = [
      `Review the code changes for issue #${context.issue.number}: ${context.issue.title}.`,
      "",
      "Issue description:",
      context.issue.body,
      "",
      "Classify findings as P1 (critical bugs/security), P2 (important), or P3 (suggestions).",
    ];

    if (context.previousFindings.length > 0) {
      lines.push(
        "",
        "Previous review findings to check if addressed:",
        ...context.previousFindings.map(
          (f) => `- [${f.severity}] ${f.file}: ${f.description}`,
        ),
      );
    }

    return lines.join("\n");
  }

  private parseOutput(stdout: string): ReviewResult {
    // Try parsing NDJSON — last line should be the final result
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
        // Look for the structured output field
        const output = parsed["structured_output"] ?? parsed;
        if (output && typeof output === "object" && "findings" in (output as object)) {
          return this.validateResult(output);
        }
      } catch {
        continue;
      }
    }

    return {
      findings: [],
      summary: "Codex returned no structured findings.",
    };
  }

  private validateResult(data: unknown): ReviewResult {
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
}
