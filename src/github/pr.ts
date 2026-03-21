import { execa } from "execa";
import type { GitHubIssue } from "../machine/context.js";
import type { AutoDevConfig } from "../config/schema.js";

export async function createPullRequest(
  issue: GitHubIssue,
  config: AutoDevConfig,
  cwd: string,
): Promise<{ prUrl: string; prNumber: number }> {
  const title = `feat: #${issue.number} — ${issue.title}`;

  const body = config.git.pr_template
    .replace("{summary}", `Implements issue #${issue.number}: ${issue.title}`)
    .replace("{issue_number}", String(issue.number));

  try {
    const result = await execa("gh", [
      "pr",
      "create",
      "--repo",
      config.repo,
      "--base",
      "main",
      "--title",
      title,
      "--body",
      body,
    ], { cwd });

    return extractPrInfo(result.stdout, result.stderr, config.repo);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Handle "PR already exists"
    if (errMsg.includes("already exists")) {
      const urlMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+/);
      if (urlMatch) {
        return extractPrInfoFromUrl(urlMatch[0]);
      }
      return await findExistingPr(config, cwd);
    }

    throw err;
  }
}

export async function mergePullRequest(
  prUrl: string,
  cwd: string,
): Promise<void> {
  // Wait a moment for GitHub to calculate mergeability
  await sleep(3000);

  // Retry merge up to 3 times with increasing delays
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Check if PR is already merged
      const { stdout } = await execa("gh", [
        "pr",
        "view",
        prUrl,
        "--json",
        "state",
      ], { cwd });
      const state = JSON.parse(stdout) as { state: string };
      if (state.state === "MERGED") {
        // Already merged (Claude may have done it during implementation)
        return;
      }
      if (state.state === "CLOSED") {
        throw new Error("PR was closed without merging");
      }

      await execa("gh", [
        "pr",
        "merge",
        prUrl,
        "--squash",
        "--delete-branch",
      ], { cwd });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If already merged, that's fine
      if (msg.includes("already been merged") || msg.includes("MERGED")) {
        return;
      }

      if (attempt < 3) {
        await sleep(5000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function extractPrInfo(
  stdout: string,
  stderr: string,
  repo: string,
): { prUrl: string; prNumber: number } {
  const output = stdout.trim() || stderr.trim();
  const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
  const prUrl = urlMatch ? urlMatch[0] : `https://github.com/${repo}/pulls`;
  const numberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = numberMatch?.[1] ? parseInt(numberMatch[1], 10) : 0;
  return { prUrl, prNumber };
}

function extractPrInfoFromUrl(url: string): { prUrl: string; prNumber: number } {
  const numberMatch = url.match(/\/pull\/(\d+)/);
  const prNumber = numberMatch?.[1] ? parseInt(numberMatch[1], 10) : 0;
  return { prUrl: url, prNumber };
}

async function findExistingPr(
  config: AutoDevConfig,
  cwd: string,
): Promise<{ prUrl: string; prNumber: number }> {
  const { stdout } = await execa("gh", [
    "pr",
    "list",
    "--repo",
    config.repo,
    "--head",
    "HEAD",
    "--json",
    "number,url",
    "--limit",
    "1",
  ], { cwd });

  const prs = JSON.parse(stdout) as Array<{ number: number; url: string }>;
  if (prs.length > 0 && prs[0]) {
    return { prUrl: prs[0].url, prNumber: prs[0].number };
  }

  throw new Error("PR already exists but could not find it");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
