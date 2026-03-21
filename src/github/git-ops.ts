import { execa } from "execa";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function git(args: string[], cwd: string) {
  return execa("git", args, { cwd });
}

export async function pullMain(cwd: string): Promise<void> {
  await git(["checkout", "main"], cwd);
  await git(["pull", "origin", "main"], cwd);
}

export async function createBranch(
  prefix: string,
  issueNumber: number,
  title: string,
  cwd: string,
): Promise<string> {
  const slug = slugify(title);
  const branchName = `${prefix}/${issueNumber}-${slug}`;

  // Check if branch already exists
  try {
    await git(["rev-parse", "--verify", branchName], cwd);
    // Branch exists — check out and reuse it
    await git(["checkout", branchName], cwd);
    return branchName;
  } catch {
    // Branch doesn't exist — create it
    await git(["checkout", "-b", branchName], cwd);
    return branchName;
  }
}

export async function verifyCleanWorkDir(cwd: string): Promise<void> {
  const { stdout } = await git(["status", "--porcelain"], cwd);
  if (stdout.trim().length > 0) {
    // Stash everything including untracked files
    await git(["stash", "push", "--include-untracked", "-m", "autodev: stashed dirty working directory"], cwd);
  }
}

export async function commitAndPush(
  message: string,
  coAuthor: string,
  cwd: string,
): Promise<void> {
  await git(["add", "-A"], cwd);

  // Check if there are staged changes
  try {
    await git(["diff", "--cached", "--quiet"], cwd);
    // No changes to commit — this is an error, implementation didn't produce code
    throw new Error("No changes to commit — Claude did not produce any code changes");
  } catch (err) {
    // If it's our own error, re-throw it
    if (err instanceof Error && err.message.includes("No changes to commit")) throw err;
    // Otherwise, git diff --cached --quiet exits non-zero when there ARE changes — that's good
  }

  const fullMessage = `${message}\n\nCo-Authored-By: ${coAuthor}`;
  await git(["commit", "-m", fullMessage], cwd);
  await git(["push", "-u", "origin", "HEAD"], cwd);
}

export async function getCurrentDiff(cwd: string): Promise<string> {
  const { stdout } = await git(["diff", "main...HEAD"], cwd);
  return stdout;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(["branch", "--show-current"], cwd);
  return stdout.trim();
}
