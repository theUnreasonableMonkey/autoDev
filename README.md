# AutoDev

Automated development orchestrator — works GitHub issues end-to-end using AI coding tools.

AutoDev takes a queue of GitHub issues, implements them using Claude Agent SDK, runs independent code review (Codex or Claude), handles questions via a three-tier escalation system, and produces PRs — all with crash recovery and rate limit handling.

## How It Works

```
GitHub Issues → AutoDev → PRs
     ↑                     ↓
  (filtered by         (one per issue,
   label/milestone)     auto-created)
```

For each issue in the queue:

1. **Prepare** — Pull main, create feature branch
2. **Implement** — Claude Agent SDK writes the code
3. **Review** — Independent reviewer (Codex or Claude) checks the work
4. **Fix** — Claude addresses P1/P2 findings (up to 3 iterations)
5. **Ship** — Commit, push, create PR

Questions during implementation are handled automatically:
- **Tier 1**: Pre-loaded context (answers from issue description/conventions)
- **Tier 2**: AI delegate (Claude Haiku answers using project context)
- **Tier 3**: Telegram escalation (sends you a message with inline buttons)

## Prerequisites

- Node.js 20+
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- Telegram bot token from [@BotFather](https://t.me/botfather)
- Anthropic API key
- OpenAI API key (if using Codex reviewer)

## Quick Start

```bash
# Clone and install
git clone https://github.com/theUnreasonableMonkey/autoDev.git
cd autoDev
npm install

# Set up secrets
cp .env.example .env
# Edit .env with your API keys and Telegram bot token

# Configure for your repo
cp autodev.config.yaml my-project.yaml
# Edit my-project.yaml with your repo, labels, and Telegram chat ID

# Preview what would be processed
npm run dev -- start --dry-run --config my-project.yaml

# Run for real
npm run dev -- start --config my-project.yaml
```

## Configuration

See `autodev.config.yaml` for the full example. Key settings:

```yaml
repo: owner/repo-name
issues:
  filter:
    labels: ["autodev"]        # Required label(s) to filter issues
    milestone: "v2.0"          # Optional milestone filter
  max_questions_per_issue: 5   # Max Telegram escalations before skipping

reviewer:
  type: codex                  # "codex" or "claude"
  max_iterations: 3            # Review/fix cycles before escalation

telegram:
  chat_id: "YOUR_CHAT_ID"
  escalation_timeout_minutes: 240
```

Secrets go in `.env` (never in the config file):

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...           # Only needed for Codex reviewer
TELEGRAM_BOT_TOKEN=123456:ABC...
```

## Commands

```bash
autodev start [--config path] [--resume] [--dry-run]
autodev status    # Show current progress
autodev reset     # Clear saved state
```

## Rate Limits & Crash Recovery

- Rate limits are detected automatically (Claude, Codex, GitHub, Telegram)
- State is persisted after every transition to `state.json`
- Ctrl+C saves state gracefully
- Resume with `autodev start --resume`

## Architecture

```
src/
├── index.ts              # CLI entry point (commander)
├── orchestrator.ts       # Wires everything together
├── config/               # Zod schema + YAML config loader
├── machine/              # XState v5 state machine + persistence
├── executors/            # Claude dev executor, pluggable reviewers
├── questions/            # Three-tier question handling
├── github/               # Issue fetching, git ops, PR creation
├── telegram/             # grammY bot + Promise-based bridge
└── utils/                # Logger, rate limit detection
```

## License

MIT
