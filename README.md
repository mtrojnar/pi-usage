# pi-usage

Usage limit checker extension for [pi coding agent](https://github.com/badlogic/pi-mono) — shows **Codex**, **Anthropic Claude**, **GitHub Copilot**, **OpenCode Go/Zen**, and other compatible subscription limits at startup so you know your limits before you start coding. Persistent widget is opt-in.

## Repository and Credits

This repository is the maintained fork at [mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage). It was forked from [timm-u/pi-usage](https://github.com/timm-u/pi-usage), created by [timm-u](https://github.com/timm-u).

[Michał Trojnara](https://github.com/mtrojnar) maintains this fork. Copyright remains with `timm-u` for original work and with Michał Trojnara for fork changes.

## Major Changes from timm-u/pi-usage

Compared with [timm-u/pi-usage](https://github.com/timm-u/pi-usage), this fork at [mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage):

### Security Changes

- Private OpenCode Go quota config enforcement on POSIX systems (`0600`) before reading browser auth cookies.
- Codex OAuth lookup through pi `AuthStorage` with a time-bounded token refresh, so an expired token still shows usage without risking unbounded startup I/O.
- Bounded response-body reads to reduce hang and memory-exhaustion risk.

### Functional Changes

- `PI_CODING_AGENT_DIR` support instead of assuming `~/.pi/agent`.
- `limited` status in the footer and startup notification when Codex reports `rate_limited`.
- Color-coded footer usage/reset chunks for Codex, Anthropic, GitHub Copilot, OpenCode Go/Zen, and compatible subscription providers, with labels dimmed.
- Configurable persistent widget display; default startup report includes enable instructions.
- Safer config/model handling for falsy environment values and missing OpenCode Go model cost data.
- Cancellation of unused response bodies to avoid stalled probe connections.

## What It Does

When pi starts up, **pi-usage** automatically:

1. **Codex** — Calls the ChatGPT usage endpoint first, then falls back to a minimal Codex backend request only if that usage endpoint fails. It shows your:
   - **5hr window** usage percentage (primary limit)
   - **Weekly window** usage percentage (secondary limit)
   - Reset times for both windows
   - Plan type, active limit, and credits info

2. **Anthropic Claude** — For Claude Pro/Max it calls Anthropic's free subscription usage endpoint (same OAuth token pi uses); no model request is made. It shows:
   - **5-hour window** utilization percentage
   - **Weekly (7-day) window** utilization percentage
   - Reset times for both windows
   - Whether Claude is **available** or **rate limited**
   - (API-key auth has no subscription usage endpoint, so it only reports availability via a minimal probe)

3. **GitHub Copilot** — Uses the same GitHub Copilot OAuth token that pi uses. It shows:
   - Whether Copilot models are **available** or **rate limited**
   - Generic request rate-limit percentages when GitHub exposes `x-ratelimit-*` headers
   - Premium-request quota percentages if GitHub exposes Copilot quota headers in the future
   - Which low-cost Copilot model was checked

4. **OpenCode Go** — Checks the dashboard quota first, then probes Go models only if dashboard scraping is not configured or fails. It shows:
   - **Rolling, weekly, and monthly usage percentages** from the OpenCode Go dashboard, when configured
   - Reset times for all dashboard quota windows
   - Whether Go models are **available** or **rate limited**
   - Which specific model is working
   - Error details if credits are exhausted
   - How many documented Go models were checked before a result was found

5. **OpenCode Zen and compatible subscriptions** — Uses a shared lightweight probe engine for OpenAI-compatible and Anthropic-compatible subscription providers. It currently supports OpenCode Zen (`opencode`), Kimi Coding, Z.AI, Z.AI Coding CN, and Xiaomi Token Plan regions when their API keys are configured. It shows:
   - Whether a provider's models are **available** or **rate limited**
   - Which low-cost model was checked
   - Rolling, weekly, and monthly quota percentages if future/provider headers expose them
   - Error details for quota/auth/model failures

By default, results are displayed as a startup **Usage Limits** report with a help line showing how to enable the persistent widget. Only configured providers are shown; unconfigured ones are omitted. The footer status line stays updated with compact, color-coded usage/reset summaries (`17%/4.9h`, etc.) while labels remain dimmed. When the widget is enabled, results are displayed as a **widget above the editor** with progress bars and color-coded status instead.

## Installation

### Via pi install from npm (recommended)

```bash
pi install npm:@mtrojnar/pi-usage
```

Or add to your `settings.json`:

```json
{
  "packages": ["npm:@mtrojnar/pi-usage"]
}
```

### Via pi install from GitHub

```bash
pi install git:github.com/mtrojnar/pi-usage
```

### Manual

Clone or copy into your extensions directory:

```bash
# Global
git clone https://github.com/mtrojnar/pi-usage ~/.pi/agent/extensions/pi-usage

# Then install dependencies
cd ~/.pi/agent/extensions/pi-usage && npm install
```

## Setup

### Codex

No additional setup needed — pi-usage reads the OAuth access token that the `openai-codex` provider uses (stored in `$PI_CODING_AGENT_DIR/auth.json`, or `~/.pi/agent/auth.json` by default, from `/login`). If the token is expired, pi-usage asks pi to refresh it (time-bounded so a stuck refresh can't hang the check).

If you haven't set up Codex yet, run `/login` in pi and select the Codex provider.

### Anthropic Claude Pro/Max

No additional setup needed if you already use pi's Anthropic subscription login. `pi-usage` reads the current Anthropic OAuth access token stored in `$PI_CODING_AGENT_DIR/auth.json` under `anthropic`. If the token is expired, pi-usage skips the Anthropic check until pi refreshes auth during normal model use.

If you haven't set up Anthropic yet, run `/login` in pi and select the Anthropic / Claude Pro/Max provider.

`pi-usage` also recognizes `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`. For Claude Pro/Max (OAuth), the proactive check reads Anthropic's free subscription usage endpoint — it makes **no model request** and does not draw from your usage. For plain API keys (no subscription usage endpoint), it falls back to a minimal 1-token availability probe that may incur a tiny normal API cost.

### GitHub Copilot

No additional setup needed if you already use pi's GitHub Copilot login. `pi-usage` reads the current Copilot token stored in `$PI_CODING_AGENT_DIR/auth.json` under `github-copilot`, including account-specific model availability when pi has it. If the token is expired, pi-usage skips the Copilot check until pi refreshes auth during normal model use.

If you haven't set up Copilot yet, run `/login` in pi and select the GitHub Copilot provider.

`pi-usage` also recognizes `COPILOT_GITHUB_TOKEN` and `GITHUB_COPILOT_TOKEN`. The proactive Copilot check makes a minimal 1-token request to a low-cost available Copilot model.

### OpenCode Go

Current pi releases include OpenCode Go as a built-in provider (`opencode-go`), so the old `pi-opencode` extension is not required.

Configure OpenCode Go the same way pi does: set the `OPENCODE_API_KEY` environment variable, or store a key in `$PI_CODING_AGENT_DIR/auth.json` (`~/.pi/agent/auth.json` by default) under `opencode-go`:

```bash
export OPENCODE_API_KEY="your-key-here"
```

```json
{
  "opencode-go": { "type": "api_key", "key": "your-key-here" }
}
```

`pi-usage` checks `$PI_CODING_AGENT_DIR/auth.json` first (`opencode-go`, then `opencode`; default `~/.pi/agent/auth.json`) and falls back to `OPENCODE_API_KEY`.

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

The config file contains a browser auth cookie. On POSIX systems, pi-usage rejects files accessible by group or others:

```bash
chmod 600 ~/.config/opencode/opencode-quota/opencode-go.json
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

The cookie is sensitive. Prefer environment variables or a `0600` local config file; do not commit it.

### OpenCode Zen and compatible subscription providers

OpenCode Zen (`opencode`) uses the same `OPENCODE_API_KEY` as OpenCode Go. If you store the key in `$PI_CODING_AGENT_DIR/auth.json` under `opencode`, pi-usage uses that first; it can also reuse an `opencode-go` stored key.

Additional OpenAI/Anthropic-compatible subscription probes are enabled only when their keys are configured. Unconfigured providers are simply omitted from both the startup report and the widget (no "not configured" rows):

| Provider | pi provider id | Env var |
|----------|----------------|---------|
| OpenCode Zen | `opencode` | `OPENCODE_API_KEY` |
| Kimi Coding | `kimi-coding` | `KIMI_API_KEY` |
| Z.AI | `zai` | `ZAI_API_KEY` |
| Z.AI Coding CN | `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` |
| Xiaomi Token Plan AMS | `xiaomi-token-plan-ams` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi Token Plan CN | `xiaomi-token-plan-cn` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi Token Plan SGP | `xiaomi-token-plan-sgp` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

These checks make minimal 1-token model requests and are skipped on auto-refresh when recent passive response data is available.

## Usage

### Automatic

Usage limits are checked automatically on startup and every 30 minutes. pi-usage also listens for normal provider response headers and updates cached Codex/Anthropic/Copilot/OpenCode Go/OpenCode Zen/compatible-provider status passively when headers expose usage or rate-limit details. Because Codex WebSocket responses do not expose those headers, pi-usage checks a 5-minute activity window: refresh Codex usage when Codex data flowed during the window, or after six consecutive clean windows (30 minutes by default) while idle. Cached reset countdowns in the widget and footer are re-rendered every 60 seconds without extra API calls.

By default, startup shows a one-time **Usage Limits** report plus compact footer status. Footer labels (`⚡`, `Codex`, `Claude`, `Copilot`, `Go`, `Zen`, separators) are dimmed; usage/reset chunks are color-coded by percentage. Enable the persistent widget above the editor in `~/.pi/agent/pi-usage.json`:

```json
{
  "showWidget": true
}
```

Project-local override is also supported in `.pi/pi-usage.json` after the project is trusted.

For a one-off run:

```bash
pi --usage-widget
```

If you enabled it in config and want a one-off run without the widget:

```bash
pi --no-usage-widget
```

### Manual refresh

Type `/usage` in pi to refresh the display on demand. Manual refresh still performs the full usage check even when proactive checks are disabled.

## Example Display

```
⚡ Usage Limits
────────────────────────────────────────
Codex (plus) [premium]
  5hr   ██████████░░░░░░░░░░ 49% resets in 5m
  week  ████████████░░░░░░░░ 62% resets in 3.8d
────────────────────────────────────────
✓ Anthropic (Claude Pro/Max) — available
  5hr   ███████░░░░░░░░░░░░░ 36% resets in 2h
  week  █░░░░░░░░░░░░░░░░░░░  3% resets in 6.1d
────────────────────────────────────────
✓ GitHub Copilot — available
  requests ██░░░░░░░░░░░░░░░░░░ 10% used / 90% left resets in 1h
  working: gpt-5-mini
────────────────────────────────────────
✓ OpenCode Go — available
  rolling ████░░░░░░░░░░░░░░░░ 20% used / 80% left resets in 3.2h
  week    ████████░░░░░░░░░░░░ 40% used / 60% left resets in 4.8d
  month   ████████████░░░░░░░░ 60% used / 40% left resets in 12.4d
  working: glm-5.1
────────────────────────────────────────
✓ OpenCode Zen — available
  working: big-pickle
```

Footer status is compact, for example:

```
⚡ Codex:17%/4.9h,42%/3.8d │ Claude:36%/2h,3%/6.1d │ Copilot:10%r/1h │ Go:20%r/3.2h,40%w/4.8d,60%m/12.4d │ Zen:✓
```

Claude footer chunks are the 5-hour then weekly window (no suffix, like Codex). Copilot footer suffixes are `p` (premium requests) and `r` (generic requests). OpenCode Go and compatible-provider footer suffixes are `r` (rolling), `w` (week), and `m` (month). Widget progress bars and percentages turn **yellow** (>70%) or **red** (>90%). Footer chunks use: dim (`0–50%`), accent (`51–80%`), warning (`81–99%`), error (`100%`).

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

During normal Codex model use, pi-usage passively reads the same `x-codex-*` headers from pi's `after_provider_response` extension event and updates cached values immediately. `429` responses with `retry-after` are also reflected as rate-limited status. When Codex uses WebSocket transport, response headers are unavailable, so pi-usage performs a lightweight ChatGPT usage-endpoint refresh on dirty 5-minute windows, or after six clean windows by default.

### Anthropic Claude

For Claude Pro/Max (OAuth), pi-usage calls Anthropic's subscription usage endpoint `https://api.anthropic.com/api/oauth/usage` with the same OAuth token pi stores for `anthropic`. This returns the plan's 5-hour and 7-day utilization and reset times **without making a model request** (so it does not draw from your usage):

```json
{
  "five_hour": { "utilization": 37, "resets_at": "2026-07-08T13:00:00+00:00" },
  "seven_day": { "utilization": 4,  "resets_at": "2026-07-14T23:00:00+00:00" }
}
```

If that endpoint is unavailable, pi-usage falls back to a minimal `max_tokens: 1` probe and reads the unified rate-limit response headers instead. During normal Claude use, these same headers are read passively from pi's `after_provider_response` event, so the display updates live:

| Header | Description |
|--------|-------------|
| `anthropic-ratelimit-unified-5h-utilization` | 5-hour window utilization (0..1 fraction) |
| `anthropic-ratelimit-unified-5h-reset` | 5-hour window reset timestamp |
| `anthropic-ratelimit-unified-7d-utilization` | 7-day window utilization (0..1 fraction) |
| `anthropic-ratelimit-unified-7d-reset` | 7-day window reset timestamp |
| `anthropic-ratelimit-unified-status` | Overall status (`rejected` ⇒ rate limited) |
| `retry-after` | Retry delay for `429` rate-limit responses |

For plain API-key auth there is no subscription usage endpoint or unified header, so pi-usage only reports availability via a minimal probe (preferring the currently selected `anthropic` model when one is set).

### GitHub Copilot

GitHub Copilot does not currently expose a stable public quota-percentage API to pi-usage. pi-usage uses the current Copilot token for provider `github-copilot`, account-specific model availability from pi auth when present, and a minimal 1-token probe. When the model you have selected in pi is a `github-copilot` model (and your account allows it), pi-usage probes that model first; otherwise it uses a low-cost available model.

It parses generic GitHub/Copilot response headers when available:

| Header | Description |
|--------|-------------|
| `x-ratelimit-*` | Generic request limit, remaining requests, used requests, reset time, and resource |
| `x-copilot-premium-requests-*` | Future/potential premium-request usage percentage and reset time |
| `retry-after` | Retry delay for `429` rate-limit responses |

During normal Copilot model use, successful responses passively mark Copilot as available, `429`/quota responses mark it as limited, and exposed quota headers update the footer/widget cache.

### OpenCode Go

OpenCode Go does not currently expose a public usage/balance API. pi-usage scrapes the authenticated dashboard page at `https://opencode.ai/workspace/<workspaceId>/go` and parses the embedded `rollingUsage`, `weeklyUsage`, and `monthlyUsage` quota data when `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` are configured.

If the dashboard scrape is not configured or fails, pi-usage falls back to probing models with minimal requests (`max_tokens: 1`) and checking for:
- **200 OK** → model is available
- **429** or quota/limit errors → rate limited
- **402** or credit/balance errors → credits exhausted

It builds the probe list from OpenCode's documented Go models, then adds any extra `opencode-go` models from pi's installed registry. It probes the preferred cheap model (`qwen3.5-plus`) first, only tries another model when the response clearly says that model is unavailable, and stops on rate-limit, auth/quota, or ambiguous errors.

During normal OpenCode Go model use, successful responses passively mark the current model as available, and `429` responses mark it as rate limited. If future OpenCode Go responses expose quota headers such as `x-opencode-go-rolling-used-percent`, those are parsed and used too. Dashboard scraping remains necessary for rolling/weekly/monthly quota percentages when those headers are absent.

### OpenCode Zen and compatible subscription probes

OpenCode Zen and the additional compatible providers share a generic probe engine extracted from the OpenCode Go model-probing logic. The engine:

- Reads API keys from pi `auth.json` first, then provider-specific environment variables.
- Builds a low-cost model list from documented fallbacks plus pi's installed model registry.
- Supports OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatible endpoints.
- Prefers the model you currently have selected in pi when it belongs to the provider being checked, so reported limits match that model; otherwise it starts from the cheapest known model.
- Sends a minimal 1-token request, stops on the first working model, and only tries another model when the error clearly says the model is unavailable.
- Parses future/provider quota headers shaped like `x-<provider>-rolling-used-percent`, `x-<provider>-weekly-used-percent`, and `x-<provider>-monthly-reset-after-seconds`.

During normal model use, successful compatible-provider responses passively mark that provider as available, and `429`/quota responses mark it as limited.

## Configuration

Widget display uses pi-style extension config files:

- Global: `~/.pi/agent/pi-usage.json`
- Project: `.pi/pi-usage.json` (only after project trust)

```json
{ "showWidget": true }
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_USAGE_REFRESH_MIN` | `30` | Network usage-check interval in minutes; recent passive header updates defer matching auto checks |
| `PI_USAGE_UI_REFRESH_SEC` | `60` | Cached widget/footer re-render interval in seconds |
| `PI_USAGE_PROACTIVE` | `true` | Run startup and periodic network checks; set `false` for passive headers plus manual `/usage` only |
| `PI_USAGE_CODEX_RESPONSE_REFRESH` | same as `PI_USAGE_PROACTIVE` | Refresh Codex usage endpoint while Codex responses transfer data; useful because WebSocket transport has no usage headers |
| `PI_USAGE_CODEX_RESPONSE_REFRESH_SEC` | `300` | Codex activity-window length; dirty windows refresh usage, six clean windows produce idle refresh by default |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi agent directory used for `auth.json` and `pi-usage.json` lookup |
| `ANTHROPIC_OAUTH_TOKEN` | unset | Optional Anthropic OAuth token override for Claude Pro/Max checks |
| `ANTHROPIC_API_KEY` | unset | Optional Anthropic API key fallback for rate-limit checks |
| `COPILOT_GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` | unset | Optional GitHub Copilot API token override for Copilot checks |
| `OPENCODE_API_KEY` | unset | OpenCode API key used for OpenCode Go and OpenCode Zen model availability probes |
| `KIMI_API_KEY` | unset | Kimi Coding API key for compatible subscription probing |
| `ZAI_API_KEY` | unset | Z.AI API key for compatible subscription probing |
| `ZAI_CODING_CN_API_KEY` | unset | Z.AI Coding CN API key for compatible subscription probing |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | unset | Xiaomi Token Plan AMS API key for compatible subscription probing |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | unset | Xiaomi Token Plan CN API key for compatible subscription probing |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | unset | Xiaomi Token Plan SGP API key for compatible subscription probing |
| `OPENCODE_GO_WORKSPACE_ID` | unset | Workspace id from the OpenCode Go dashboard URL |
| `OPENCODE_GO_AUTH_COOKIE` | unset | Browser `auth` cookie value for `opencode.ai`, used for dashboard quota scraping |
| `OPENCODE_GO_QUOTA_CONFIG` | unset | Optional explicit path to an `opencode-go.json` quota config file |

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 timm-u  
Copyright (c) 2026 Michał Trojnara
