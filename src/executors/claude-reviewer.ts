import type { Reviewer, IssueContext } from "./types.js";
import type { ReviewResult, ReviewFinding } from "../machine/context.js";

const REVIEWER_SYSTEM_PROMPT = `You are an independent code reviewer. Review the provided git diff for quality, bugs, and security issues.

You MUST respond with ONLY a JSON object matching this schema:
{
  "findings": [
    {
      "severity": "P1" | "P2" | "P3",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "Description of the issue",
      "suggestion": "How to fix it"
    }
  ],
  "summary": "Brief summary of the review"
}

Severity guide:
- P1 (Critical): Bugs, security vulnerabilities, data loss risks, broken functionality
- P2 (Important): Missing error handling, performance issues, missing tests for key paths
- P3 (Suggestion): Style improvements, minor refactors, documentation gaps

If the code looks good, return: {"findings": [], "summary": "Code looks good. No issues found."}`;

export class ClaudeReviewer implements Reviewer {
  async review(context: IssueContext): Promise<ReviewResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const prompt = this.buildPrompt(context);
    let resultText = "";

    for await (const message of query({
      prompt,
      options: {
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: 3,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (typeof message === "object" && message !== null && "result" in message) {
        resultText = String((message as Record<string, unknown>)["result"]);
      }
    }

    return this.parseReviewResult(resultText);
  }

  private buildPrompt(context: IssueContext): string {
    const lines = [
      `Review the following code changes for issue #${context.issue.number}: ${context.issue.title}`,
      "",
      "## Issue Description",
      context.issue.body,
      "",
      "## Git Diff",
      "```diff",
      context.diff,
      "```",
    ];

    if (context.previousFindings.length > 0) {
      lines.push(
        "",
        `## Previous Review Findings (iteration ${context.iterationNumber})`,
        "Check if these were addressed:",
        ...context.previousFindings.map(
          (f) => `- [${f.severity}] ${f.file}: ${f.description}`,
        ),
      );
    }

    return lines.join("\n");
  }

  private parseReviewResult(text: string): ReviewResult {
    // Try direct JSON parse
    try {
      return this.validateResult(JSON.parse(text));
    } catch {
      // Continue to fallback parsing
    }

    // Strip markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch?.[1]) {
      try {
        return this.validateResult(JSON.parse(fenceMatch[1]));
      } catch {
        // Continue to fallback
      }
    }

    // Extract JSON block from text
    const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      try {
        return this.validateResult(JSON.parse(jsonMatch[0]));
      } catch {
        // Fall through to unstructured fallback
      }
    }

    // Unstructured fallback — treat entire response as a P3 suggestion
    return {
      findings: [
        {
          severity: "P3",
          file: "unknown",
          description: `Reviewer returned unstructured response: ${text.slice(0, 500)}`,
        },
      ],
      summary: "Review returned unstructured response — could not parse findings.",
    };
  }

  private validateResult(data: unknown): ReviewResult {
    const obj = data as Record<string, unknown>;
    if (!Array.isArray(obj["findings"])) {
      throw new Error("Missing findings array");
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
