# pi-usage

Usage limit checker extension for [pi coding agent](https://github.com/badlogic/pi-mono) — shows **Codex** and **OpenCode Go** usage limits at startup so you know your limits before you start coding.

## What It Does

When pi starts up, **pi-usage** automatically:

1. **Codex** — Makes a minimal API request to the Codex backend and reads the `x-codex-*` rate limit headers to show your:
   - **5hr window** usage percentage (primary limit)
   - **Weekly window** usage percentage (secondary limit)
   - Reset times for both windows
   - Plan type, active limit, and credits info

2. **OpenCode Go** — Probes available Go models to check:
   - Whether Go models are **available** or **rate limited**
   - Which specific model is working
   - Error details if credits are exhausted
   - How many documented Go models were checked before a result was found

Results are displayed as a **widget above the editor** with progress bars and color-coded status, plus a **footer status line** and a **notification** at startup.

## Installation

### Via pi install (recommended)

```bash
pi install git:github.com/timm-u/pi-usage
```

### Manual

Clone or copy into your extensions directory:

```bash
# Global
git clone https://github.com/timm-u/pi-usage ~/.pi/agent/extensions/pi-usage

# Then install dependencies
cd ~/.pi/agent/extensions/pi-usage && npm install
```

Or add to your `settings.json`:

```json
{
  "packages": ["git:github.com/timm-u/pi-usage"]
}
```

## Setup

### Codex

No additional setup needed — pi-usage reads the same OAuth token that the `openai-codex` provider uses (stored in `~/.pi/agent/auth.json` from `/login`) and refreshes it when expired.

If you haven't set up Codex yet, run `/login` in pi and select the Codex provider.

### OpenCode Go

Current pi releases include OpenCode Go as a built-in provider (`opencode-go`), so the old `pi-opencode` extension is not required.

Configure OpenCode Go the same way pi does: set the `OPENCODE_API_KEY` environment variable, or store a key in `~/.pi/agent/auth.json` under `opencode-go`:

```bash
export OPENCODE_API_KEY="your-key-here"
```

```json
{
  "opencode-go": { "type": "api_key", "key": "your-key-here" }
}
```

`pi-usage` checks `~/.pi/agent/auth.json` first (`opencode-go`, then `opencode`) and falls back to `OPENCODE_API_KEY`.

## Usage

### Automatic

Usage limits are checked automatically on startup and every 30 minutes.

### Manual refresh

Type `/usage` in pi to refresh the display on demand.

## Example Display

```
⚡ Usage Limits
────────────────────────────────────────
Codex (plus) [premium]
  5hr   ██████████░░░░░░░░░░ 49% resets in 5m
  week  ████████████░░░░░░░░ 62% resets in 3.8d
────────────────────────────────────────
✓ OpenCode Go — available
  working: glm-5.1
```

When limits are running high, the progress bars and percentages turn **yellow** (>70%) or **red** (>90%).

## How It Works

### Codex Rate Limits

The Codex backend returns rate limit information via HTTP response headers on every API request:

| Header | Description |
|--------|-------------|
| `x-codex-primary-used-percent` | 5hr window usage % |
| `x-codex-secondary-used-percent` | Weekly window usage % |
| `x-codex-primary-window-minutes` | Primary window duration |
| `x-codex-secondary-window-minutes` | Secondary window duration |
| `x-codex-primary-reset-at` | Primary reset timestamp |
| `x-codex-secondary-reset-at` | Secondary reset timestamp |
| `x-codex-plan-type` | Plan type (plus, etc.) |
| `x-codex-active-limit` | Active limit tier |
| `x-codex-credits-*` | Credit balance info |

pi-usage makes a **minimal streaming request** (model: `gpt-5.4-mini`, instruction: "ok", input: "hi") to capture these headers. This costs virtually nothing (~5 tokens) but provides the most accurate usage data.

### OpenCode Go

OpenCode Go does not currently expose a usage/balance API. pi-usage probes models by making minimal requests (`max_tokens: 1`) and checking for:
- **200 OK** → model is available
- **429** → rate limited
- **401/403** → credits error or auth issue

It builds the probe list from OpenCode's documented Go models, then adds any extra `opencode-go` models from pi's installed registry. It tries cheaper models first and stops at the first success or definitive global quota/auth error.

OpenCode Go's published limits are dollar-based (`$12` per 5 hours, `$30` per week, `$60` per month). There is no public API for the current remaining balance; OpenCode documents that current usage is tracked in the console. This extension therefore reports availability/limit blocking, not an exact percentage remaining for Go.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_USAGE_REFRESH_MIN` | `30` | Auto-refresh interval in minutes |

## License

MIT
