import type { GitHubIssue } from "../machine/context.js";

/**
 * Tier 1: Check if the question can be answered from pre-loaded context.
 * Returns an answer string if found, null otherwise.
 */
export function checkContext(
  question: string,
  options: Array<{ label: string; description: string }>,
  _issue: GitHubIssue,
): string | null {
  const q = question.toLowerCase();

  // Common patterns that can be auto-answered from context
  if (q.includes("which testing framework") || q.includes("test framework")) {
    const vitestOption = options.find((o) => o.label.toLowerCase().includes("vitest"));
    if (vitestOption) return vitestOption.label;
  }

  if (q.includes("commit") && q.includes("convention")) {
    const conventionalOption = options.find(
      (o) =>
        o.label.toLowerCase().includes("conventional") ||
        o.description.toLowerCase().includes("conventional"),
    );
    if (conventionalOption) return conventionalOption.label;
  }

  // If the question has only one reasonable option (often in yes/no scenarios)
  if (options.length === 2) {
    const yesOption = options.find(
      (o) =>
        o.label.toLowerCase() === "yes" ||
        o.label.toLowerCase() === "proceed" ||
        o.label.toLowerCase() === "continue",
    );
    if (yesOption && (q.includes("should i proceed") || q.includes("should i continue"))) {
      return yesOption.label;
    }
  }

  return null;
}
