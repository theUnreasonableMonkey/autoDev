# AutoDev — Project Conventions

## What This Is
AutoDev is a TypeScript CLI that automates the issue-to-PR development lifecycle using AI coding tools (Claude Agent SDK, Codex SDK). It orchestrates work via an XState v5 state machine with crash recovery, rate limit handling, and Telegram-based human escalation.

## Tech Stack
- **Language:** TypeScript (strict mode, ES modules)
- **Runtime:** Node.js 20+
- **Key deps:** xstate v5, @anthropic-ai/claude-agent-sdk, @openai/codex-sdk, grammy, zod, execa, commander, pino

## Code Conventions
- ES modules (`import`/`export`, not `require`)
- Strict TypeScript — no `any` types
- Use `interface` for object shapes, `type` for unions/intersections
- Prefer `const` over `let`; never use `var`
- Error handling: explicit error types, no bare `catch(e)`
- File naming: kebab-case (e.g., `git-ops.ts`, `ai-delegate.ts`)
- One export per file when the export is substantial (classes, machine definitions)

## Directory Structure
```
src/
├── index.ts              # CLI entry point
├── config/               # Zod schema + YAML config loader
├── machine/              # XState state machine, context types, persistence
├── executors/            # Claude dev executor, pluggable reviewers
├── questions/            # Three-tier question handling
├── github/               # Issue fetching, git ops, PR creation
├── telegram/             # grammY bot + Promise-based bridge
└── utils/                # Logger, rate limit detection
```

## Git Rules
- Never commit to `main` directly — always use feature branches
- Branch naming: `feat/`, `fix/`, `chore/`, `docs/` prefixes
- Open PRs against `main` when work is complete
- Secrets go in `.env` (gitignored), never in config files

## Testing
- Test framework: vitest
- Run tests: `npm test`
- Test files go in `tests/` directory

## Running
- Dev: `npm run dev -- start --dry-run`
- Build: `npm run build`
- Production: `npm start -- start --config path/to/config.yaml`
