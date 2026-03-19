import { describe, it, expect } from "vitest";
import { configSchema } from "../src/config/schema.js";

describe("configSchema", () => {
  const validConfig = {
    repo: "owner/repo",
    issues: {
      filter: { labels: ["autodev"] },
    },
    reviewer: { type: "codex" },
    git: {
      branch_prefix: "autodev",
      commit_co_author: "Bot <bot@local>",
      pr_template: "## Summary\n{summary}",
    },
    telegram: { chat_id: "123456" },
  };

  it("accepts a valid minimal config", () => {
    const result = configSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues.max_questions_per_issue).toBe(5);
      expect(result.data.reviewer.max_iterations).toBe(3);
      expect(result.data.logging.level).toBe("info");
      expect(result.data.executor.allowed_tools).toContain("Read");
    }
  });

  it("rejects missing repo", () => {
    const { repo: _, ...noRepo } = validConfig;
    const result = configSchema.safeParse(noRepo);
    expect(result.success).toBe(false);
  });

  it("rejects invalid repo format", () => {
    const result = configSchema.safeParse({ ...validConfig, repo: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects empty labels array", () => {
    const result = configSchema.safeParse({
      ...validConfig,
      issues: { filter: { labels: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid reviewer type", () => {
    const result = configSchema.safeParse({
      ...validConfig,
      reviewer: { type: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("applies defaults for optional sections", () => {
    const result = configSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logging.dir).toBe("./logs");
      expect(result.data.executor.working_directory).toBe(".");
    }
  });
});
