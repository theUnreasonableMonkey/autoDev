import { describe, it, expect } from "vitest";
import { checkContext } from "../src/questions/context-checker.js";
import type { GitHubIssue } from "../src/machine/context.js";

const testIssue: GitHubIssue = {
  number: 1,
  title: "Test",
  body: "Test body",
  labels: [],
  url: "https://example.com",
};

describe("context-checker", () => {
  it("answers testing framework questions with vitest", () => {
    const answer = checkContext(
      "Which testing framework should we use?",
      [
        { label: "Jest", description: "Popular testing framework" },
        { label: "Vitest", description: "Fast Vite-native test runner" },
      ],
      testIssue,
    );
    expect(answer).toBe("Vitest");
  });

  it("answers proceed questions with yes", () => {
    const answer = checkContext(
      "Should I proceed with the implementation?",
      [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" },
      ],
      testIssue,
    );
    expect(answer).toBe("Yes");
  });

  it("returns null for unknown questions", () => {
    const answer = checkContext(
      "What color should the button be?",
      [
        { label: "Red", description: "Red button" },
        { label: "Blue", description: "Blue button" },
      ],
      testIssue,
    );
    expect(answer).toBeNull();
  });
});
