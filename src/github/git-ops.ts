import { execa } from "execa";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function pullMain(): Promise<void> {
  await execa("git", ["checkout", "main"]);
  await execa("git", ["pull", "origin", "main"]);
}

export async function createBranch(
  prefix: string,
  issueNumber: number,
  title: string,
): Promise<string> {
  const slug = slugify(title);
  const branchName = `${prefix}/${issueNumber}-${slug}`;

  // Check if branch already exists
  try {
    await execa("git", ["rev-parse", "--verify", branchName]);
    // Branch exists — check out and reuse it
    await execa("git", ["checkout", branchName]);
    return branchName;
  } catch {
    // Branch doesn't exist — create it
    await execa("git", ["checkout", "-b", branchName]);
    return branchName;
  }
}

export async function verifyCleanWorkDir(): Promise<void> {
  const { stdout } = await execa("git", ["status", "--porcelain"]);
  if (stdout.trim().length > 0) {
    // Stash dirty changes with a descriptive message
    await execa("git", ["stash", "push", "-m", "autodev: stashed dirty working directory"]);
  }
}

export async function commitAndPush(
  message: string,
  coAuthor: string,
): Promise<void> {
  await execa("git", ["add", "-A"]);

  // Check if there are staged changes
  try {
    await execa("git", ["diff", "--cached", "--quiet"]);
    // No changes to commit
    return;
  } catch {
    // There are changes — commit them
  }

  const fullMessage = `${message}\n\nCo-Authored-By: ${coAuthor}`;
  await execa("git", ["commit", "-m", fullMessage]);
  await execa("git", ["push", "-u", "origin", "HEAD"]);
}

export async function getCurrentDiff(): Promise<string> {
  const { stdout } = await execa("git", ["diff", "main...HEAD"]);
  return stdout;
}

export async function getCurrentBranch(): Promise<string> {
  const { stdout } = await execa("git", ["branch", "--show-current"]);
  return stdout.trim();
}
