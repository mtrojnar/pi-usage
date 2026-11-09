# Changelog

## [0.2.1] - 2026-11-09

### Fixed

- Support Pi 1.5.0 while retaining compatibility with Pi 0.85.0.
- Honor effective provider and model authentication, including gateway headers, custom endpoints, and shared OpenCode Go/Zen credentials, without mixing credentials or crossing their bound origins.
- Prevent stale OAuth metadata from misclassifying Anthropic API keys or selecting the wrong Codex account.
- Clear cached Codex usage after logout and prevent late refreshes from restoring it.
- Follow Pi's agent-directory resolution and correct authentication setup documentation, including the legacy-only Codex monitoring limitation.

### Added

- Packaged changelog for Pi 1.5.0 extension update notices.

## [0.2.0] - 2026-09-07

### Added

- OpenRouter daily spending, key-budget usage and resets, and optional account-credit reporting through read-only endpoints.

### Fixed

- Validate usage endpoint payloads and isolate provider failures so malformed or stalled responses cannot hide completed checks.
- Scope expired-window refreshes to affected providers and protect newer passive updates from in-flight refresh results.
