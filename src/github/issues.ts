import { execa } from "execa";
import type { GitHubIssue } from "../machine/context.js";
import type { AutoDevConfig } from "../config/schema.js";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
  state: string;
}

export async function fetchIssues(config: AutoDevConfig): Promise<GitHubIssue[]> {
  const labelArgs = config.issues.filter.labels.flatMap((l) => ["--label", l]);
  const milestoneArgs = config.issues.filter.milestone
    ? ["--milestone", config.issues.filter.milestone]
    : [];

  const { stdout } = await execa("gh", [
    "issue",
    "list",
    "--repo",
    config.repo,
    "--state",
    "open",
    "--json",
    "number,title,body,labels,url,state",
    "--limit",
    "100",
    ...labelArgs,
    ...milestoneArgs,
  ]);

  const raw = JSON.parse(stdout) as GhIssue[];

  // Sort by issue number ascending
  const sorted = raw.sort((a, b) => a.number - b.number);

  return sorted.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
  }));
}

export async function isIssueOpen(repo: string, issueNumber: number): Promise<boolean> {
  try {
    const { stdout } = await execa("gh", [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    const data = JSON.parse(stdout) as { state: string };
    return data.state === "OPEN";
  } catch {
    return false;
  }
}
