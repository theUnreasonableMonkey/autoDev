# AutoDev: Automated Development Orchestrator

**Date:** 2026-03-19
**Status:** Brainstorm complete
**Author:** John + Claude

---

## What We're Building

An **outer-loop orchestrator** that automates the repetitive development cycle of working GitHub issues end-to-end using AI coding tools. It takes a set of GitHub issues (filtered by label/milestone), works them sequentially through the full dev lifecycle, and produces PRs — with minimal human intervention.

### The Problem

John's current workflow for each issue involves ~6 manual steps that are largely identical:
1. Start work on an issue (`/slfg` or `/workflows:work`)
2. Answer questions from Claude (often repetitive or context-dependent)
3. Run independent review (`/workflows:review`)
4. Respond to reviewer with standard follow-up instructions
5. Iterate review 2-3 times
6. Commit, push, create PR, merge, pull main, start next issue

This is 15-30 minutes of manual shepherding per issue, mostly waiting and copy-pasting the same instructions. Over a backlog of 20+ issues, that's hours of babysitting.

### The Solution

A TypeScript application ("AutoDev") that:
- Reads a queue of issues from GitHub (label/milestone-based)
- Spawns Claude Code via the Agent SDK to work each issue
- Runs independent code review using a configurable reviewer (Codex SDK or Claude in reviewer mode)
- Handles questions via a three-tier system: pre-loaded context → AI delegate → Telegram escalation
- Automatically commits, pushes, and creates PRs
- Detects rate limits and pauses/resumes gracefully
- Persists state for crash recovery

---

## Why This Approach

### SDK-Native over CLI Scraping

Research revealed that both Claude Code and Codex have proper programmatic SDKs with structured JSON I/O, session management, and callback-based question handling. This eliminates the need for fragile terminal scraping (node-pty + ANSI parsing) that Gemini originally suggested.

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`):
- `query()` async generator with typed messages
- `canUseTool` callback intercepts `AskUserQuestion` for structured question handling
- Session resume via `session_id`
- Subagent support, MCP integration, hook lifecycle

**Codex SDK** (`@openai/codex-sdk`):
- `codex exec` for non-interactive execution
- TypeScript SDK with thread-based sessions
- MCP server mode for agent orchestration
- Structured JSON output with schema validation

### XState for Workflow Control

The issue lifecycle is a state machine with well-defined transitions and failure modes. XState v5 provides:
- Explicit state definitions (no implicit fall-through)
- Built-in persistence/rehydration for crash recovery
- Actor model for subprocess management
- Visual debugging via Stately.ai

### Pluggable Reviewer

Making the reviewer configurable (Codex vs Claude) ensures:
- Independent perspective (different model = different bugs caught)
- No vendor lock-in on either side
- Can add new reviewers later (Gemini, Aider) without rewriting

---

## Key Decisions

1. **SDK-native integration** — Use Claude Agent SDK and Codex SDK for structured programmatic control. No terminal scraping.

2. **Three-tier question handling:**
   - **Tier 1 (Prevent):** Pre-load rich context per issue (description, related files, conventions) to minimize questions
   - **Tier 2 (Delegate):** Route questions to a separate Claude API call with project context to answer autonomously
   - **Tier 3 (Escalate):** Send unanswerable questions to John via Telegram bot with multiple-choice options for quick reply

3. **Pluggable reviewer** — Configurable per-project. Default options: Codex SDK or Claude in reviewer mode. Interface-based so new reviewers can be added.

4. **GitHub Issues as queue** — Filter by label and/or milestone. Issue order determined by issue number (ascending). No local sequence file needed.

5. **Fully automated git flow** — After work + review cycle completes: commit to feature branch, push, create PR via `gh`. John reviews/merges PRs asynchronously.

6. **One repo at a time** — Scoped to a single repo per run. Point it at a different repo for the next run.

7. **Local-first, server-ready** — Runs on John's dev machine initially. Architected with clean separation (no hardcoded paths, configurable credentials) so it can move to a VPS later.

8. **XState state machine** — Manages the issue lifecycle with explicit states, persistence to disk after each transition, and crash recovery via checkpoint rehydration.

9. **Rate limit handling** — Detect rate limit signals from SDK streaming events (`system/api_retry` in Claude, HTTP 429 in Codex). Pause, persist state, wait for reset, resume from checkpoint.

10. **Telegram for human escalation** — Use Telegram Bot API for bidirectional messaging. Questions sent as polls/buttons for quick one-tap answers from phone.

11. **Review exit condition** — Stop reviewing when: (a) a review iteration returns no P1/P2 issues ("clean review"), or (b) 3 iterations are reached. If critical issues persist after 3 iterations, escalate to John via Telegram rather than creating a bad PR.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│              AutoDev Orchestrator                │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │         XState Workflow Engine             │  │
│  │                                           │  │
│  │  IDLE → FETCH_ISSUE → WORKING → REVIEW   │  │
│  │  → FIX → REVIEW → (repeat up to 3x)     │  │
│  │  → COMMIT → PUSH → CREATE_PR → NEXT      │  │
│  │                                           │  │
│  │  Error states: RATE_LIMITED, CRASHED,     │  │
│  │  WAITING_FOR_HUMAN                        │  │
│  └─────────────┬─────────────────────────────┘  │
│                │                                 │
│  ┌─────────────┴─────────────────────────────┐  │
│  │         Executor Layer (pluggable)        │  │
│  │                                           │  │
│  │  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ Claude Agent  │  │ Reviewer         │  │  │
│  │  │ SDK (dev)     │  │ (Codex/Claude)   │  │  │
│  │  └──────────────┘  └──────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │         Question Handler                  │  │
│  │                                           │  │
│  │  canUseTool("AskUserQuestion") →          │  │
│  │    1. Check pre-loaded context            │  │
│  │    2. Ask AI delegate                     │  │
│  │    3. Escalate via Telegram               │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────────┐  ┌────────────────────────┐  │
│  │ State Store  │  │ GitHub Integration     │  │
│  │ (JSON file)  │  │ (gh CLI / API)         │  │
│  └──────────────┘  └────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │         Telegram Bot                      │  │
│  │  - Send questions with inline buttons     │  │
│  │  - Receive answers via webhook/polling    │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Issue Lifecycle (State Machine)

```
IDLE
  → FETCH_ISSUE (read next issue from GitHub queue)
    → WORKING (Claude Agent SDK: implement the issue)
      → [question?] → QUESTION_HANDLER → (answer) → WORKING
      → [rate limit?] → RATE_LIMITED → (wait) → WORKING
      → [done] → REVIEWING
    → REVIEWING (Codex/Claude: independent review, iteration 1-3)
      → FIXING (Claude Agent SDK: apply review feedback — "complete P1/P2, triage rest")
        → REVIEWING (next iteration)
      → [clean review OR max 3 iterations] → COMMITTING
      → [critical issues persist after max iterations] → WAITING_FOR_HUMAN
    → COMMITTING (git add, commit, push)
      → CREATING_PR (gh pr create)
        → FETCH_ISSUE (next issue)
    → [all issues done] → COMPLETE

Error/special states:
  RATE_LIMITED → persist state → sleep → resume from last checkpoint
  CRASHED → reload state from disk → resume from last checkpoint
  WAITING_FOR_HUMAN → Telegram notification sent → block until reply
```

---

## Assumptions

- Issues in the queue are independent (no dependency ordering between them)
- `gh` CLI is authenticated and available in the runtime environment
- Claude Agent SDK's `canUseTool` callback can block the agent loop while awaiting an external response (Telegram reply)

## Open Questions

*None — all key decisions resolved during brainstorming.*

---

## Resolved Questions

1. **How to handle questions?** → Three-tier: prevent (rich context), delegate (AI), escalate (Telegram)
2. **Where to run?** → Local-first, architected for future server migration
3. **SDK vs CLI scraping?** → SDK-native. Research showed both Claude and Codex have proper programmatic APIs
4. **Which reviewer?** → Pluggable. Support both Codex and Claude, configurable per-project
5. **How to manage the queue?** → GitHub Issues filtered by label/milestone
6. **What happens after review?** → Auto commit, push, create PR
7. **Multi-repo?** → One repo at a time (YAGNI)
8. **Notification method?** → Telegram bot with inline buttons for quick replies

---

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Node.js) |
| Dev executor | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| Reviewer | Codex SDK (`@openai/codex-sdk`) and/or Claude (configurable) |
| Workflow engine | XState v5 |
| Git operations | `gh` CLI via `execa` |
| Notifications | Telegram Bot API |
| State persistence | JSON file (state.json) |
| Config | YAML or JSON config file per repo |

---

## Next Steps

Run `/workflows:plan` to create an implementation plan with detailed tasks, file structure, and issue breakdown.
