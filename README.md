# pi-usage

Usage limit checker extension for [pi coding agent](https://github.com/badlogic/pi-mono) — shows **Codex** and **OpenCode Go** usage limits at startup so you know your limits before you start coding.

## What It Does

When pi starts up, **pi-usage** automatically:

1. **Codex** — Calls the ChatGPT usage endpoint first, then falls back to a minimal Codex backend request only if that usage endpoint fails. It shows your:
   - **5hr window** usage percentage (primary limit)
   - **Weekly window** usage percentage (secondary limit)
   - Reset times for both windows
   - Plan type, active limit, and credits info

2. **OpenCode Go** — Checks the dashboard quota first, then probes Go models only if dashboard scraping is not configured or fails. It shows:
   - **Rolling, weekly, and monthly usage percentages** from the OpenCode Go dashboard, when configured
   - Reset times for all dashboard quota windows
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

For the rolling, weekly, and monthly usage percentages, pi-usage can also read the OpenCode Go dashboard. This needs your OpenCode workspace id and the `auth` cookie from your browser session:

```bash
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie-value"
```

You can also store the same values in an OpenCode quota config file:

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie-value"
}
```

Config file locations checked:

- `OPENCODE_GO_QUOTA_CONFIG`, if set
- `$XDG_CONFIG_HOME/opencode/opencode-quota/opencode-go.json`
- `~/.config/opencode/opencode-quota/opencode-go.json`
- Windows: `%APPDATA%\opencode\opencode-quota\opencode-go.json`
- Windows: `%LOCALAPPDATA%\opencode\opencode-quota\opencode-go.json`
- macOS: `~/Library/Application Support/opencode/opencode-quota/opencode-go.json`

To find the values:

- `workspaceId` is the id in `https://opencode.ai/workspace/<workspaceId>/go`
- `authCookie` is the value of the `auth` cookie for `opencode.ai` in your browser devtools

The cookie is sensitive. Prefer environment variables or the local config file; do not commit it.

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
  rolling ████░░░░░░░░░░░░░░░░ 20% used / 80% left resets 3.2h
  week    ████████░░░░░░░░░░░░ 40% used / 60% left resets 4.8d
  month   ████████████░░░░░░░░ 60% used / 40% left resets 12.4d
  working: glm-5.1
```

When limits are running high, the progress bars and percentages turn **yellow** (>70%) or **red** (>90%).

## How It Works

### Codex Rate Limits

pi-usage first calls `https://chatgpt.com/backend-api/wham/usage` with the same OAuth token that pi stores for Codex/OpenAI auth. This returns the plan type, 5-hour window, weekly window, reset times, and credits without making a model request.

If that endpoint fails, pi-usage falls back to the older Codex backend header probe. The fallback response returns rate limit information via HTTP response headers:

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

The fallback makes a **minimal streaming request** (model: `gpt-5.4-mini`, instruction: "ok", input: "hi") to capture these headers. It should only run when the usage endpoint is unavailable.

### OpenCode Go

OpenCode Go does not currently expose a public usage/balance API. pi-usage scrapes the authenticated dashboard page at `https://opencode.ai/workspace/<workspaceId>/go` and parses the embedded `rollingUsage`, `weeklyUsage`, and `monthlyUsage` quota data when `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` are configured.

If the dashboard scrape is not configured or fails, pi-usage falls back to probing models with minimal requests (`max_tokens: 1`) and checking for:
- **200 OK** → model is available
- **429** → rate limited
- **401/403** → credits error or auth issue

It builds the probe list from OpenCode's documented Go models, then adds any extra `opencode-go` models from pi's installed registry. It tries cheaper models first and stops at the first success or definitive global quota/auth error.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_USAGE_REFRESH_MIN` | `30` | Auto-refresh interval in minutes |
| `OPENCODE_API_KEY` | unset | OpenCode API key used for model availability probes |
| `OPENCODE_GO_WORKSPACE_ID` | unset | Workspace id from the OpenCode Go dashboard URL |
| `OPENCODE_GO_AUTH_COOKIE` | unset | Browser `auth` cookie value for `opencode.ai`, used for dashboard quota scraping |
| `OPENCODE_GO_QUOTA_CONFIG` | unset | Optional explicit path to an `opencode-go.json` quota config file |

## License

MIT
