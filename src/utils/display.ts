import type { GitHubIssue, ReviewFinding } from "../machine/context.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

function timestamp(): string {
  return `${DIM}[${new Date().toLocaleTimeString()}]${RESET}`;
}

export function banner(): void {
  console.log(`
${BOLD}${CYAN}╔══════════════════════════════════════╗
║          AutoDev Orchestrator        ║
╚══════════════════════════════════════╝${RESET}
`);
}

export function configLoaded(repo: string, repoDir: string, reviewer: string): void {
  console.log(`${timestamp()} ${BOLD}Configuration${RESET}`);
  console.log(`   Repo:      ${repo}`);
  console.log(`   Directory: ${repoDir}`);
  console.log(`   Reviewer:  ${reviewer}`);
  console.log();
}

export function telegramStatus(connected: boolean, reason?: string): void {
  if (connected) {
    console.log(`${timestamp()} ${GREEN}Telegram connected${RESET} — escalation enabled`);
  } else {
    console.log(`${timestamp()} ${YELLOW}Telegram unavailable${RESET} — ${reason ?? "unknown"}`);
    console.log(`   Questions will be answered by AI delegate or auto-selected`);
  }
  console.log();
}

export function issueQueueLoaded(issues: GitHubIssue[]): void {
  console.log(`${timestamp()} ${BOLD}Issue Queue${RESET} — ${issues.length} issue(s) found`);
  for (const issue of issues) {
    console.log(`   ${DIM}#${issue.number}${RESET} ${issue.title}`);
  }
  console.log();
}

export function issueStart(issue: GitHubIssue, index: number, total: number): void {
  console.log(
    `${timestamp()} ${BOLD}${BLUE}━━━ Issue #${issue.number} (${index + 1}/${total}) ━━━${RESET}`,
  );
  console.log(`   ${issue.title}`);
}

export function step(label: string, detail?: string): void {
  const detailStr = detail ? ` ${DIM}— ${detail}${RESET}` : "";
  console.log(`${timestamp()}   ${CYAN}▸${RESET} ${label}${detailStr}`);
}

export function stepDone(label: string, detail?: string): void {
  const detailStr = detail ? ` ${DIM}— ${detail}${RESET}` : "";
  console.log(`${timestamp()}   ${GREEN}✓${RESET} ${label}${detailStr}`);
}

export function stepError(label: string, detail?: string): void {
  const detailStr = detail ? ` ${DIM}— ${detail}${RESET}` : "";
  console.log(`${timestamp()}   ${RED}✗${RESET} ${label}${detailStr}`);
}

export function reviewResult(
  findings: ReviewFinding[],
  iteration: number,
  maxIterations: number,
): void {
  const p1 = findings.filter((f) => f.severity === "P1").length;
  const p2 = findings.filter((f) => f.severity === "P2").length;
  const p3 = findings.filter((f) => f.severity === "P3").length;

  if (p1 === 0 && p2 === 0) {
    console.log(
      `${timestamp()}   ${GREEN}✓${RESET} Review clean — no P1/P2 issues${p3 > 0 ? ` (${p3} suggestions)` : ""}`,
    );
  } else {
    console.log(
      `${timestamp()}   ${YELLOW}!${RESET} Review found issues: ${RED}${p1} critical${RESET}, ${YELLOW}${p2} important${RESET}, ${DIM}${p3} suggestions${RESET} (iteration ${iteration}/${maxIterations})`,
    );
    for (const f of findings.filter((f) => f.severity === "P1" || f.severity === "P2")) {
      const color = f.severity === "P1" ? RED : YELLOW;
      console.log(`     ${color}[${f.severity}]${RESET} ${f.file}: ${f.description}`);
    }
  }
}

export function issueComplete(issueNumber: number, prUrl: string): void {
  console.log(
    `${timestamp()}   ${GREEN}${BOLD}✓ Issue #${issueNumber} complete${RESET} — ${DIM}${prUrl}${RESET}`,
  );
  console.log();
}

export function issueSkipped(issueNumber: number, reason: string): void {
  console.log(
    `${timestamp()}   ${YELLOW}⊘ Issue #${issueNumber} skipped${RESET} — ${reason.slice(0, 120)}`,
  );
  console.log();
}

export function rateLimited(retryInMs: number): void {
  const seconds = Math.round(retryInMs / 1000);
  console.log(
    `${timestamp()}   ${YELLOW}⏸ Rate limited${RESET} — waiting ${seconds}s before retrying`,
  );
}

export function questionHandled(tier: number, question: string, answer: string): void {
  const tierLabel = tier === 1 ? "context" : tier === 2 ? "AI delegate" : "Telegram";
  console.log(
    `${timestamp()}   ${MAGENTA}?${RESET} Question answered via ${tierLabel}: "${question.slice(0, 60)}${question.length > 60 ? "..." : ""}" → ${BOLD}${answer}${RESET}`,
  );
}

export function runSummary(
  completed: Array<{ number: number; title: string; prUrl: string }>,
  skipped: Array<{ number: number; title: string; reason: string }>,
  runtimeMs: number,
): void {
  const minutes = Math.floor(runtimeMs / 60000);
  const seconds = Math.round((runtimeMs % 60000) / 1000);

  console.log();
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════╗`);
  console.log(`║           Run Complete               ║`);
  console.log(`╚══════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`   Runtime: ${minutes}m ${seconds}s`);
  console.log();

  if (completed.length > 0) {
    console.log(`   ${GREEN}${BOLD}Completed: ${completed.length} issue(s)${RESET}`);
    for (const i of completed) {
      console.log(`     ${GREEN}✓${RESET} #${i.number} — ${i.title}`);
      console.log(`       ${DIM}${i.prUrl}${RESET}`);
    }
  }

  if (skipped.length > 0) {
    console.log();
    console.log(`   ${YELLOW}${BOLD}Skipped: ${skipped.length} issue(s)${RESET}`);
    for (const i of skipped) {
      console.log(`     ${YELLOW}⊘${RESET} #${i.number} — ${i.title}`);
      console.log(`       ${DIM}${i.reason.slice(0, 100)}${RESET}`);
    }
  }

  if (completed.length === 0 && skipped.length === 0) {
    console.log(`   No issues processed.`);
  }

  console.log();
}
