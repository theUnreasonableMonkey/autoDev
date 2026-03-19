---
title: "feat: AutoDev — Automated Development Orchestrator"
type: feat
status: active
date: 2026-03-19
origin: docs/brainstorms/2026-03-19-autodev-orchestrator-brainstorm.md
---

# feat: AutoDev — Automated Development Orchestrator

## Overview

AutoDev is a TypeScript CLI application that automates the full issue-to-PR development lifecycle. It takes a queue of GitHub issues, works them sequentially using Claude Agent SDK for implementation and a pluggable reviewer (Codex SDK or Claude) for code review, handles questions via a three-tier escalation system (context → AI delegate → Telegram), and produces PRs — all with crash recovery, rate limit handling, and minimal human intervention.

(see brainstorm: `docs/brainstorms/2026-03-19-autodev-orchestrator-brainstorm.md`)

## Problem Statement / Motivation

John's current workflow for each issue involves ~6 manual steps (start work, answer questions, run review, respond with standard instructions, iterate 2-3x, commit/push/PR). This is 15-30 minutes of manual shepherding per issue. Over a backlog of 20+ issues, that's hours of babysitting work that is largely identical and automatable.

## Proposed Solution

A Node.js CLI (`autodev`) that orchestrates the entire lifecycle as an XState v5 state machine. Each state invokes the appropriate SDK or CLI tool, persists state after every transition for crash recovery, and escalates to the user via Telegram only when genuinely needed.

### Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript (Node.js 20+) | SDK ecosystem alignment, type safety |
| Dev executor | `@anthropic-ai/claude-agent-sdk` | Structured JSON I/O, `canUseTool` callbacks, session resume |
| Reviewer | `@openai/codex-sdk` and/or Claude (configurable) | Pluggable interface, different model = different bugs caught |
| Workflow engine | `xstate` v5 | Persistence/rehydration, actor model, guards, delayed transitions |
| Subprocess mgmt | `execa` | Clean API for non-interactive CLI commands (`gh`, `git`) |
| Telegram | `grammy` + `@grammyjs/conversations` | TypeScript-first, inline keyboards, long polling for local dev |
| Config | `zod` (validation) + YAML files | Schema validation at startup, human-readable config |
| Logging | `pino` | Structured JSON logging, fast, low overhead |
| CLI framework | `commander` | Lightweight, well-known |
| Package manager | `npm` | Simplicity |

---

## Technical Approach

### Architecture

```
autodev CLI
├── src/
│   ├── index.ts                  # CLI entry point (commander)
│   ├── config/
│   │   ├── schema.ts             # Zod config schema
│   │   └── loader.ts             # Load + validate YAML config
│   ├── machine/
│   │   ├── workflow.ts           # XState v5 state machine definition
│   │   ├── context.ts            # Machine context type definitions
│   │   └── persistence.ts        # Snapshot save/restore to JSON file
│   ├── executors/
│   │   ├── types.ts              # Executor & Reviewer interfaces
│   │   ├── claude-dev.ts         # Claude Agent SDK dev executor
│   │   ├── claude-reviewer.ts    # Claude as reviewer (separate session)
│   │   └── codex-reviewer.ts     # Codex SDK reviewer
│   ├── questions/
│   │   ├── handler.ts            # Three-tier question routing logic
│   │   ├── context-checker.ts    # Tier 1: pre-loaded context lookup
│   │   ├── ai-delegate.ts        # Tier 2: Claude API call
│   │   └── telegram.ts           # Tier 3: Telegram escalation
│   ├── github/
│   │   ├── issues.ts             # Fetch & filter issues via gh CLI
│   │   ├── git-ops.ts            # Branch, commit, push operations
│   │   └── pr.ts                 # PR creation via gh CLI
│   ├── telegram/
│   │   ├── bot.ts                # grammY bot setup + inline keyboards
│   │   └── bridge.ts             # Promise-based send-question-await-reply
│   └── utils/
│       ├── logger.ts             # Pino logger setup
│       └── rate-limit.ts         # Rate limit detection + backoff logic
├── autodev.config.yaml           # Example config (gitignored in target repos)
├── package.json
├── tsconfig.json
└── .env.example                  # Template for secrets (API keys, bot token)
```

### State Machine Design

The core of AutoDev is an XState v5 state machine with these states:

```
IDLE
  │
  ├─[START]─→ FETCHING_QUEUE (fetch all matching issues from GitHub)
  │             │
  │             ├─[issues found]─→ PREPARING_ISSUE
  │             │                    │
  │             │                    ├─ Pull main, create feature branch
  │             │                    ├─ Verify clean working directory
  │             │                    └─→ WORKING
  │             │                         │
  │             │                         ├─[question]─→ HANDLING_QUESTION ─→ WORKING
  │             │                         ├─[rate limit]─→ RATE_LIMITED ─→ WORKING
  │             │                         └─[done]─→ REVIEWING
  │             │                                      │
  │             │                                      ├─[clean review]─→ COMMITTING
  │             │                                      ├─[fixable issues]─→ FIXING ─→ REVIEWING
  │             │                                      └─[critical + max iters]─→ ESCALATING
  │             │                                                                    │
  │             │                                                                    ├─[human: proceed]─→ COMMITTING
  │             │                                                                    ├─[human: skip]─→ SKIPPING_ISSUE
  │             │                                                                    └─[timeout]─→ SKIPPING_ISSUE
  │             │
  │             ├─[zero issues]─→ COMPLETE (notify, exit)
  │             │
  │             COMMITTING ─→ CREATING_PR ─→ PREPARING_ISSUE (next issue)
  │             │
  │             SKIPPING_ISSUE ─→ PREPARING_ISSUE (next issue) or COMPLETE
  │             │
  │             └─[all done]─→ COMPLETE
  │
  RATE_LIMITED ─→ persist state ─→ wait (dynamic backoff) ─→ resume
  CRASHED ─→ restore from state.json ─→ resume from last checkpoint
```

**Key additions from SpecFlow analysis:**
- `PREPARING_ISSUE` state: pulls main, verifies clean workspace, creates branch, handles branch conflicts
- `SKIPPING_ISSUE` state: allows skipping issues (Telegram timeout, externally closed, too many questions)
- `FETCHING_QUEUE` fetches once but re-checks issue status (`open`) before starting each issue
- Graceful shutdown: SIGINT/SIGTERM handler finishes current checkpoint, persists state, cleans up subprocesses

### Machine Context

```typescript
interface WorkflowContext {
  // Queue
  issues: GitHubIssue[];          // Full issue queue
  currentIssueIndex: number;      // Index into issues array
  currentIssue: GitHubIssue | null;

  // Current issue state
  branchName: string | null;
  sessionId: string | null;       // Claude Agent SDK session ID
  reviewIteration: number;        // 0-3
  reviewFindings: ReviewFinding[];
  questionCount: number;          // Tier-3 questions asked for this issue

  // Rate limiting
  retryCount: number;
  lastRateLimitAt: number | null;

  // Run metadata
  runId: string;                  // Unique ID for this run
  startedAt: number;
  completedIssues: CompletedIssue[];  // For summary report
  skippedIssues: SkippedIssue[];
}
```

### Persistence Strategy

After every state transition, persist the machine snapshot:

```typescript
actor.subscribe((snapshot) => {
  const persisted = actor.getPersistedSnapshot();
  // Atomic write: write to temp file, then rename
  fs.writeFileSync('state.json.tmp', JSON.stringify(persisted));
  fs.renameSync('state.json.tmp', 'state.json');
});
```

On restart with `--resume`:
```typescript
const snapshot = JSON.parse(fs.readFileSync('state.json', 'utf-8'));
const actor = createActor(workflowMachine, { snapshot }).start();
```

### Config Schema

```yaml
# autodev.config.yaml
repo: owner/repo-name                    # GitHub repo
issues:
  filter:
    labels: ["autodev"]                   # Required label(s)
    milestone: "v2.0"                     # Optional milestone filter
  max_questions_per_issue: 5              # Tier-3 escalation cap before skip

reviewer:
  type: "codex"                           # "codex" | "claude"
  max_iterations: 3                       # Review/fix cycles before escalate

git:
  branch_prefix: "autodev"               # Branch: autodev/42-short-slug
  commit_co_author: "AutoDev Bot <autodev@local>"
  pr_template: |
    ## Summary
    {summary}

    Closes #{issue_number}

    ---
    *Generated by AutoDev*

telegram:
  chat_id: "123456789"                   # Your Telegram user/chat ID
  escalation_timeout_minutes: 240        # 4 hours before auto-skip
  reminder_interval_minutes: 60          # Remind every hour

logging:
  level: "info"                          # "debug" | "info" | "warn" | "error"
  dir: "./logs"                          # Log directory

executor:
  allowed_tools:                         # Tool allowlist for Claude Agent SDK
    - "Read"
    - "Edit"
    - "Write"
    - "Bash"
    - "Glob"
    - "Grep"
  working_directory: "."                 # Constrain to repo root
```

Secrets via environment variables (never in config):
```bash
# .env
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC...
```

### Reviewer Output Contract

All reviewers must produce structured output conforming to this schema:

```typescript
interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
}

interface ReviewFinding {
  severity: "P1" | "P2" | "P3";   // P1=critical, P2=important, P3=suggestion
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}
```

- **Clean review** = zero P1 and P2 findings (P3s are logged but don't block)
- **Critical issues persist** = P1 findings remain after max iterations
- Reviewers are prompted with a system prompt that requires this JSON format
- The reviewer receives: the git diff, the issue description, and previous review findings (for iteration context)

### Question Handler — Three Tiers

**Tier 1 (Prevent):** Before spawning the Claude session, construct a rich prompt that includes:
- Full issue body and comments
- Relevant file contents (mentioned in the issue)
- Project CLAUDE.md conventions
- Previous similar issue resolutions

**Tier 2 (AI Delegate):** When `canUseTool("AskUserQuestion")` fires:
- Extract the question and options
- Send to a separate Claude API call (`claude-3-haiku` for speed/cost) with project context
- If the delegate returns a high-confidence answer, use it
- Log every delegated answer for audit

**Tier 3 (Telegram Escalation):** If the delegate cannot answer:
- Send question + options as Telegram inline keyboard buttons
- Block via Promise (store resolver in a Map keyed by question ID)
- On button tap, resolve the Promise, continue the agent session
- Timeout after `escalation_timeout_minutes` → skip the question (return a default or skip the issue)

**`canUseTool` blocking verification:** The Claude Agent SDK's `canUseTool` returns a Promise. The SDK `await`s this Promise before continuing. This means the callback can take as long as needed — it naturally blocks the agent loop. Verified via SDK source: the tool execution loop is `const approval = await canUseTool(...)`. No internal timeout. However, the Anthropic API session may time out if idle too long, so the session should be resumed via `session_id` if the wait exceeds 10 minutes.

### Rate Limit Handling

Four rate limit surfaces, each handled:

| Surface | Detection | Response |
|---------|-----------|----------|
| Claude API | `system/api_retry` event in stream with `error: "rate_limit"` | Respect `retry_delay_ms`, pause, persist state |
| Codex API | HTTP 429 / SDK error | Exponential backoff: 30s, 60s, 120s, 300s max |
| GitHub API | `gh` exit code + stderr parsing | Wait 60s, retry. After 3 failures, escalate |
| Telegram API | grammY built-in retry (auto-handles 429) | No custom handling needed |

For Claude Max Pro usage limits (not API rate limits — account-level daily/weekly caps):
- Detect via SDK error messages or stream termination patterns
- Persist full state to `state.json`
- Log the event
- Enter `RATE_LIMITED` state with a long delay (check every 15 minutes)
- Send Telegram notification: "Usage limit hit. Paused. Will auto-resume when limit resets."

### Logging & Observability

- **Per-run log:** `logs/run-{runId}.log` — all orchestrator events in NDJSON format
- **Per-issue log:** `logs/issues/issue-{number}.log` — SDK interactions, review findings, questions
- **Completion summary:** Sent via Telegram + written to `logs/run-{runId}-summary.json`

Summary includes: issues processed, PRs created, issues skipped (with reasons), total questions asked, total review iterations, runtime, cost estimate.

### Graceful Shutdown

```typescript
process.on('SIGINT', async () => {
  logger.info('Shutdown requested. Finishing current checkpoint...');
  // 1. Persist current state
  const persisted = actor.getPersistedSnapshot();
  fs.writeFileSync('state.json', JSON.stringify(persisted));
  // 2. Stop the Telegram bot
  bot.stop();
  // 3. Log summary so far
  logPartialSummary(actor.getSnapshot().context);
  process.exit(0);
});
```

### Security

- **Tool allowlist:** Claude Agent SDK sessions use `allowedTools` from config (not `--dangerously-skip-permissions` in production mode)
- **Working directory constraint:** Set `cwd` on all subprocess calls to the repo root
- **Secrets in env vars only:** Config file contains no secrets; `.env` is gitignored
- **Audit log:** Every tool invocation and AI delegate answer is logged with timestamp and context
- **No `git clean` or destructive operations:** The orchestrator never runs `git clean -f`, `git reset --hard`, or `rm -rf`

---

## System-Wide Impact

### Interaction Graph

```
autodev start
  → XState actor created → subscribe(persist snapshot)
  → FETCHING_QUEUE
    → execa("gh issue list ...") → parse JSON → store in context
  → PREPARING_ISSUE
    → execa("git pull origin main") → execa("git checkout -b ...") → verify clean dir
  → WORKING
    → Claude Agent SDK query() → streams messages → canUseTool fires on questions
      → Question Handler → [Tier 1/2/3] → answer returned → SDK continues
    → SDK session completes → transition to REVIEWING
  → REVIEWING
    → Codex SDK exec() or Claude query() → parse ReviewResult JSON
    → Guard: hasP1P2? → FIXING or COMMITTING
  → FIXING
    → Claude Agent SDK query(resume: sessionId) → "Fix these issues: ..."
    → Increment reviewIteration → transition to REVIEWING
  → COMMITTING
    → execa("git add -A") → execa("git commit -m ...") → execa("git push -u ...")
  → CREATING_PR
    → execa("gh pr create ...") → log PR URL → transition to next issue
```

### Error Propagation

- SDK errors (rate limit, crash) → caught by XState `invoke.onError` → transition to `RATE_LIMITED` or `ESCALATING`
- `gh` CLI errors → caught by execa → logged → retry once → if persistent, escalate via Telegram
- Telegram send failures → grammY auto-retry → if persistent after 3 attempts, log and continue without notification
- State file corruption → detected on load (JSON.parse failure) → start fresh with warning

### State Lifecycle Risks

- **Partial commit:** `git add` succeeds but `git commit` fails → working directory has staged changes → `PREPARING_ISSUE` runs `git checkout main` which resets staging → safe
- **Branch exists on retry:** `PREPARING_ISSUE` checks if branch exists → if from same run (detected via `autodev/` prefix + issue number), reuse it; if different, append `-retry-{n}`
- **Orphaned Claude sessions:** On crash, Claude Agent SDK sessions are not cleaned up server-side, but `session_id` persistence allows resuming rather than creating new sessions

### API Surface Parity

Not applicable — AutoDev is a CLI tool, not a service. The only interface is the `autodev` CLI.

### Integration Test Scenarios

1. **Full happy path:** Queue with 2 issues → both get implemented, reviewed (clean on first pass), committed, PRs created → completion summary sent
2. **Rate limit mid-work:** Issue implementation triggers rate limit → state persisted → process killed → restarted with `--resume` → resumes from WORKING state → completes
3. **Telegram escalation round-trip:** Claude asks question → Tier 1 and 2 fail → Telegram message sent → simulated button press → answer received → Claude continues
4. **Review iteration loop:** First review has P1 findings → fix → second review clean → commit
5. **Critical review escalation:** Three review iterations all have P1 → Telegram escalation → human says "skip" → issue skipped, next issue starts

---

## Acceptance Criteria

### Functional Requirements

- [ ] `autodev start` fetches issues from GitHub matching configured label/milestone filters
- [ ] Issues are processed sequentially in ascending issue number order
- [ ] Each issue: creates branch from latest main, implements via Claude Agent SDK, reviews via configured reviewer
- [ ] Review/fix cycle runs up to N iterations (configurable, default 3)
- [ ] Clean review (no P1/P2) or max iterations reached → commit, push, create PR with issue linkage
- [ ] Critical issues after max iterations → Telegram escalation with proceed/skip options
- [ ] Questions handled via three tiers: context → AI delegate → Telegram
- [ ] Rate limits detected and handled with backoff + state persistence
- [ ] Process can be stopped (`Ctrl+C`) and resumed (`autodev start --resume`)
- [ ] Completion summary sent via Telegram
- [ ] Zero issues matching filter → notify and exit cleanly

### Non-Functional Requirements

- [ ] State persisted after every transition (atomic writes)
- [ ] Secrets sourced from environment variables only
- [ ] Claude Agent SDK sessions use tool allowlist (no unrestricted permissions)
- [ ] Structured JSON logging (per-run and per-issue)
- [ ] Config validated at startup via Zod schema (fail fast on bad config)

### Quality Gates

- [ ] Unit tests for: state machine transitions, question handler routing, config validation, review finding parsing
- [ ] Integration test for: full happy path with mocked SDKs
- [ ] All TypeScript strict mode, no `any` types
- [ ] ESLint + Prettier configured

---

## Implementation Phases

### Phase 1: Foundation (Issues 1-4)

**Goal:** Project scaffolding, config system, state machine skeleton, and CLI entry point. After this phase, `autodev start` runs and prints "would process N issues" in dry-run mode.

**Tasks:**

#### Issue 1: Project scaffolding
- Initialize git repo, `npm init`, install TypeScript, ESLint, Prettier
- Create `tsconfig.json` (strict mode, ES2022 target, NodeNext module)
- Create directory structure (`src/`, `logs/`, `docs/`)
- Create `.gitignore` (node_modules, .env, logs/, state.json, *.tmp)
- Create `.env.example` with required environment variable names
- Create `CLAUDE.md` with project conventions
- **Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `CLAUDE.md`, `src/index.ts`

#### Issue 2: Config system
- Define Zod schema for `autodev.config.yaml` (`src/config/schema.ts`)
- Config loader: find config in CWD or specified path, parse YAML, validate with Zod (`src/config/loader.ts`)
- Environment variable loading for secrets (dotenv)
- Fail fast with clear error messages on invalid config
- Create example config file (`autodev.config.yaml`)
- **Files:** `src/config/schema.ts`, `src/config/loader.ts`, `autodev.config.yaml`
- **Dependencies:** `zod`, `yaml`, `dotenv`

#### Issue 3: XState state machine skeleton
- Define machine context types (`src/machine/context.ts`)
- Create state machine with all states, transitions, and guards — but with stub invocations (`src/machine/workflow.ts`)
- Implement persistence module: atomic write to `state.json`, restore from snapshot (`src/machine/persistence.ts`)
- Verify persistence round-trip works (save → restore → machine resumes in correct state)
- **Files:** `src/machine/workflow.ts`, `src/machine/context.ts`, `src/machine/persistence.ts`
- **Dependencies:** `xstate`

#### Issue 4: CLI entry point + GitHub issue fetching
- CLI with `commander`: `autodev start [--config path] [--resume] [--dry-run]`
- GitHub issue fetching via `gh issue list --json --label ... --milestone ...` (`src/github/issues.ts`)
- Dry-run mode: fetch issues, print list, exit
- Wire CLI → config loader → state machine → fetch issues → print/exit
- **Files:** `src/index.ts`, `src/github/issues.ts`
- **Dependencies:** `commander`, `execa`

**Success criteria:** `autodev start --dry-run` prints the list of matching issues with numbers and titles.

---

### Phase 2: Core Execution Loop (Issues 5-7)

**Goal:** Claude Agent SDK integration for implementing issues and the git workflow (branch, commit, push, PR). After this phase, AutoDev can work a single issue end-to-end (without review or question handling).

**Tasks:**

#### Issue 5: Git operations module
- `pullMain()`: `git checkout main && git pull origin main`
- `createBranch(issueNumber, slug)`: create `autodev/{number}-{slug}`, handle existing branch (reuse if autodev branch, append suffix otherwise)
- `verifyCleanWorkDir()`: check `git status --porcelain`, stash if dirty (with warning log)
- `commitAndPush(message)`: `git add -A && git commit -m "..." && git push -u origin HEAD`
- **Files:** `src/github/git-ops.ts`
- **Dependencies:** `execa`

#### Issue 6: Claude Agent SDK dev executor
- Implement executor interface (`src/executors/types.ts`): `execute(task: TaskInput): AsyncGenerator<ExecutorEvent>`
- Claude dev executor (`src/executors/claude-dev.ts`): wraps `query()` from Claude Agent SDK
- Constructs rich prompt from issue body, comments, and CLAUDE.md conventions
- Configurable `allowedTools` from config
- Captures `session_id` for resume capability
- Handles `canUseTool` callback (initially: auto-approve all allowed tools, log questions for later)
- **Files:** `src/executors/types.ts`, `src/executors/claude-dev.ts`
- **Dependencies:** `@anthropic-ai/claude-agent-sdk`

#### Issue 7: PR creation + basic end-to-end flow
- PR creation via `gh pr create` with configured template (`src/github/pr.ts`)
- PR body includes: summary, `Closes #{issue_number}`, review findings addressed
- Wire the full loop: PREPARING_ISSUE → WORKING → COMMITTING → CREATING_PR → next issue
- Test with a real repo and a simple issue
- **Files:** `src/github/pr.ts`

**Success criteria:** AutoDev processes a single issue: branches, implements via Claude, commits, pushes, creates PR.

---

### Phase 3: Review Loop (Issues 8-10)

**Goal:** Pluggable reviewer with Codex and Claude implementations, review/fix iteration cycle, and review exit conditions.

**Tasks:**

#### Issue 8: Reviewer interface + Claude reviewer
- Reviewer interface (`src/executors/types.ts`): `review(diff: string, issueContext: IssueContext): Promise<ReviewResult>`
- Claude reviewer implementation (`src/executors/claude-reviewer.ts`): separate Claude session with reviewer system prompt
- System prompt requires structured JSON output matching `ReviewResult` schema
- Reviewer receives: git diff, issue description, previous findings (for iteration context)
- Multi-layer response parsing: try JSON → strip markdown fences → extract JSON block → fallback to unstructured
- **Files:** `src/executors/claude-reviewer.ts`, update `src/executors/types.ts`

#### Issue 9: Codex reviewer
- Codex reviewer implementation (`src/executors/codex-reviewer.ts`): uses Codex SDK or `codex exec`
- Same structured output contract as Claude reviewer
- `--json` flag + `--output-schema` for structured output
- Read-only sandbox mode (`--sandbox read-only`)
- **Files:** `src/executors/codex-reviewer.ts`
- **Dependencies:** `@openai/codex-sdk`

#### Issue 10: Review/fix cycle in state machine
- Wire REVIEWING → FIXING → REVIEWING loop in XState machine
- FIXING state: resumes Claude session via `session_id`, sends "Fix these P1/P2 issues: {findings}. Complete the P1 and P2 fixes and triage any remaining issues."
- Guards: `isCleanReview` (no P1/P2), `hasRetriesLeft` (iteration < max), `hasCriticalIssues` (P1 after max)
- Review iteration counter in context, reset per issue
- **Files:** update `src/machine/workflow.ts`

**Success criteria:** Full work → review → fix → review cycle runs. Clean reviews exit early. Max iterations trigger escalation path.

---

### Phase 4: Question Handling (Issues 11-13)

**Goal:** Three-tier question handling system. After this phase, questions during implementation are handled automatically or escalated to Telegram.

**Tasks:**

#### Issue 11: Telegram bot + bridge
- grammY bot setup with long polling (`src/telegram/bot.ts`)
- Promise-based bridge (`src/telegram/bridge.ts`): `askQuestion(chatId, question, options): Promise<string>`
  - Sends message with InlineKeyboard buttons
  - Stores Promise resolver in a `Map<questionId, resolver>`
  - `callbackQuery` handler resolves the matching Promise
  - Timeout after configured minutes → resolve with `"__TIMEOUT__"`
  - Reminder messages at configured interval
- Bot runs as a background actor alongside the state machine
- **Files:** `src/telegram/bot.ts`, `src/telegram/bridge.ts`
- **Dependencies:** `grammy`

#### Issue 12: Question handler (three-tier routing)
- Tier 1 — Context checker (`src/questions/context-checker.ts`): checks if the question can be answered from pre-loaded issue context, CLAUDE.md, or repo conventions
- Tier 2 — AI delegate (`src/questions/ai-delegate.ts`): sends question + project context to Claude API (haiku for speed/cost), returns answer if confidence is high
- Tier 3 — Telegram escalation (`src/questions/telegram.ts`): uses the bridge to send question with inline buttons
- Router (`src/questions/handler.ts`): orchestrates the three tiers in sequence
- All delegated answers logged for audit
- Max questions per issue (configurable, default 5) — exceeding triggers issue skip
- **Files:** `src/questions/handler.ts`, `src/questions/context-checker.ts`, `src/questions/ai-delegate.ts`, `src/questions/telegram.ts`

#### Issue 13: Wire question handler into Claude executor
- Hook `canUseTool("AskUserQuestion")` callback in the Claude dev executor
- Extract structured question from the callback input
- Route through question handler
- Return the answer via `updatedInput.answers`
- If handler returns timeout/skip → return a "skip this question" response or pause the session
- **Files:** update `src/executors/claude-dev.ts`

**Success criteria:** During implementation, questions are intercepted. Tier 1/2 answer automatically. Tier 3 sends Telegram message, receives reply, and continues.

---

### Phase 5: Resilience (Issues 14-16)

**Goal:** Rate limit handling, crash recovery, and graceful shutdown. After this phase, AutoDev is production-reliable for unattended runs.

**Tasks:**

#### Issue 14: Rate limit detection + backoff
- Rate limit detector (`src/utils/rate-limit.ts`): identify rate limits from Claude stream events, Codex errors, `gh` CLI failures
- Exponential backoff with jitter: 30s → 60s → 120s → 300s max
- Claude Max Pro usage limits: detect, enter RATE_LIMITED with 15-minute check interval
- Telegram notification on rate limit: "Usage limit hit. Paused. Will auto-resume."
- Wire into XState: `RATE_LIMITED` state with `after` delayed transition using dynamic backoff
- **Files:** `src/utils/rate-limit.ts`, update `src/machine/workflow.ts`

#### Issue 15: Crash recovery
- On startup with `--resume`: load `state.json`, validate, restore actor from snapshot
- Handle corrupted state file: log warning, offer fresh start
- Session resume: use persisted `session_id` to resume Claude sessions instead of starting new ones
- Verify: kill process mid-WORKING, restart with `--resume`, confirm it picks up where it left off
- **Files:** update `src/index.ts`, `src/machine/persistence.ts`

#### Issue 16: Graceful shutdown + logging
- SIGINT/SIGTERM handler: persist state, stop Telegram bot, log partial summary
- Structured logging with pino: per-run log file + per-issue log file
- Log every state transition, SDK invocation, question handled, review finding
- Completion summary: issues processed, PRs created, skipped, questions asked, runtime, review iterations
- Send summary via Telegram on completion
- `autodev status` command: read `state.json` and print current progress
- **Files:** `src/utils/logger.ts`, update `src/index.ts`

**Success criteria:** Process survives rate limits (pauses, resumes). Process survives crash (restores, continues). Ctrl+C exits cleanly with state preserved.

---

### Phase 6: Polish (Issues 17-19)

**Goal:** Quality of life improvements, testing, and documentation.

**Tasks:**

#### Issue 17: Dry-run + status commands
- `autodev start --dry-run`: fetch issues, print what would be processed, validate config, exit
- `autodev status`: read state.json, print current issue, progress, last activity
- `autodev reset`: delete state.json (with confirmation)
- **Files:** update `src/index.ts`

#### Issue 18: Test suite
- Unit tests: state machine transitions (mock executors), config validation, question routing, review finding parsing, git ops (mock execa)
- Integration test: full happy path with mocked Claude/Codex SDKs
- Test framework: vitest (fast, TypeScript-native)
- **Files:** `tests/` directory
- **Dependencies:** `vitest`

#### Issue 19: Documentation + README
- README with: what it does, quickstart, config reference, architecture overview
- CLAUDE.md with project conventions for when AutoDev is used to develop itself
- **Files:** `README.md`, update `CLAUDE.md`

**Success criteria:** Tests pass. README is complete. A new user can set up and run AutoDev from the README alone.

---

## Alternative Approaches Considered

1. **CLI subprocess via node-pty** (Gemini's original suggestion) — Rejected. Terminal scraping is fragile (ANSI escape codes, buffering, platform differences). Both Claude and Codex have proper SDKs with structured JSON I/O. (see brainstorm)

2. **Hybrid SDK + CLI fallback** — Rejected for now (YAGNI). SDKs are the primary path. If an SDK breaks, we fix the integration rather than maintaining two code paths. (see brainstorm)

3. **Multi-repo support** — Deferred. One repo at a time is sufficient for current needs. The architecture doesn't preclude adding multi-repo later. (see brainstorm)

4. **Local sequence file instead of GitHub Issues** — Rejected. GitHub Issues are the source of truth. Maintaining a separate sequence file adds sync overhead. (see brainstorm)

---

## Dependencies & Prerequisites

- Node.js 20+ installed
- `gh` CLI installed and authenticated (`gh auth login`)
- Telegram bot created via @BotFather (token in `.env`)
- Anthropic API key (for Claude Agent SDK)
- OpenAI API key (for Codex SDK, if using Codex reviewer)
- A GitHub repo with issues labeled for AutoDev processing

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Claude Agent SDK breaking change (sub-1.0) | Medium | High | Pin version, test before upgrading, executor interface isolates SDK details |
| Codex SDK breaking change | Medium | Medium | Same isolation via executor interface |
| `canUseTool` cannot block long enough for Telegram | Low | High | Verified: SDK `await`s the Promise. If session times out, resume via `session_id` |
| Claude produces incorrect implementation | Medium | Medium | Independent reviewer catches issues; review exit condition escalates persistent problems |
| Rate limit handling misses a surface | Medium | Low | Comprehensive detection for all 4 surfaces; fallback: persist state, user can resume manually |
| State file corruption on crash | Low | Medium | Atomic writes (temp file + rename); backup previous state |

---

## Future Considerations

- **Multi-repo orchestration:** Run against multiple repos in sequence or parallel
- **Web dashboard:** Real-time view of progress, logs, and control (pause/skip/resume)
- **Claude Code skill:** Package AutoDev as a Claude Code skill for in-CLI usage
- **Issue dependency ordering:** Topological sort based on issue references
- **Cost tracking:** Track API usage per issue for budget management
- **Parallel issue processing:** Work multiple independent issues concurrently (requires git worktrees)

---

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-19-autodev-orchestrator-brainstorm.md](../brainstorms/2026-03-19-autodev-orchestrator-brainstorm.md) — Key decisions carried forward: SDK-native integration, three-tier question handling, pluggable reviewer, XState state machine, Telegram escalation, one repo at a time.

### External References

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK — Handle User Input](https://platform.claude.com/docs/en/agent-sdk/user-input)
- [Codex CLI Non-Interactive Mode](https://developers.openai.com/codex/noninteractive)
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [XState v5 Documentation](https://stately.ai/docs/machines)
- [XState v5 Persistence](https://stately.ai/docs/persistence)
- [grammY Documentation](https://grammy.dev/)
- [grammY Conversations Plugin](https://grammy.dev/plugins/conversations)
- [grammY Inline Keyboards](https://grammy.dev/plugins/keyboard)

### Institutional Learnings Applied

- State machine methods should avoid hidden side effects — use explicit parameters (from cautious-potato multi-agent review)
- Use `Promise.all()` for parallel operations, `Semaphore` pattern for rate limiting (from ARCHER ingestion pipeline)
- Multi-layer fallback parsers for external API responses (from ARCHER ingestion pipeline)
- Isolated error handling per concurrent step — graceful degradation (from ARCHER ingestion pipeline)
- Pre-commit hooks to catch issues early (from bidready CI pipeline)
