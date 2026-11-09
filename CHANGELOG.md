# Changelog

## [Unreleased]

### Fixed

- Clear cached Codex usage when authentication is no longer available, including scheduled refreshes, without overwriting newer passive updates.
- Preserve header-only provider authentication, additional request headers, and case-insensitive header removals while retaining same-origin checks and redirect rejection.
- Resolve model-specific probe authentication through Pi's model runtime, preserving configured routing headers and endpoints instead of relying on catalog model headers. Configured models take precedence over documented fallbacks.
- Classify Anthropic authentication from the effective token rather than stale OAuth metadata in `auth.json`.
- Preserve explicitly shared OpenCode Go/Zen credentials during model-auth resolution, rechecking the source provider and origin without masking model-auth errors or reviving withdrawn keys. Explicit model `Authorization`, `x-api-key`, or `api-key` headers take precedence over borrowing credentials, avoiding mixed authentication schemes.
- Bind Codex account selection to effective headers or JWT claims; use stored account metadata only for the exact active token, and reject account reuse after unrelated model-token overrides.
- Resolve the agent configuration directory with Pi's public `getAgentDir()` helper.
- Correct OAuth-refresh and Copilot environment-variable documentation, and clarify that the newer `openai` ChatGPT login is not monitored.

### Changed

- Target Pi 1.5.0 for development and allow host-provided Pi 1.x peer dependencies; remove the obsolete development dependency on `pi-server`.
- Test Pi 0.85.0 and 1.5.0 on Node.js 22.19 and 24 in CI, with current unsubscribe-returning event mocks.
- Include this changelog in the npm package for Pi 1.5.0's extension update notices.
- Cover model-header resolution, stale credential metadata, and origin protections with real `ModelRuntime` integration tests.

## [0.2.0] - 2026-09-07

### Added

- OpenRouter daily spending, key-budget usage and resets, and optional account-credit reporting through read-only endpoints.

### Fixed

- Validate usage endpoint payloads and isolate provider failures so malformed or stalled responses cannot hide completed checks.
- Scope expired-window refreshes to affected providers and protect newer passive updates from in-flight refresh results.
