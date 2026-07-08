/**
 * Unit tests for pi-usage core parsing and formatting helpers.
 * Run with: node --test index.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import {
	clampPercent,
	formatDuration,
	formatResetTime,
	parseHeaderBool,
	parseHeaderNumber,
	progressBar,
	statusIcon,
	truncate,
	usageColor,
} from "./src/format.ts";
import {
	configPathCandidates,
	dedupe,
	extractAccountId,
	getOpenCodeGoQuotaConfig,
	parseBoolValue,
	parseEnvBool,
	parseEnvInt,
	readJsonObject,
	resolveConfigValue,
	validatePrivateConfigFile,
	widgetSettingFromConfig,
} from "./src/config.ts";
import {
	parseCodexUsageHeaders,
	windowMinutes,
	windowResetAfterSeconds,
	windowResetAt,
	windowUsedPercent,
} from "./src/codex.ts";
import {
	cancelResponseBody,
	readResponseText,
} from "./src/http.ts";
import {
	codexUsageHasData,
	anthropicUsageHasData,
	copilotUsageHasData,
	footerResetDuration,
	footerUsageColor,
	goUsageHasData,
	buildStartupUsageMessage,
	buildUsageWidget,
	renderAnthropicWindows,
	renderCodexWindows,
	renderCopilotWindows,
	renderGoWindows,
} from "./src/render.ts";
import {
	isAnthropicModelUnavailable,
	parseAnthropicResetAt,
	parseAnthropicUsageHeaders,
} from "./src/anthropic.ts";
import {
	getCopilotBaseUrl,
	isCopilotModelUnavailable,
	isCopilotQuotaMessage,
	normalizeCopilotDomain,
	parseCopilotResetAt,
	parseCopilotUsageHeaders,
} from "./src/copilot.ts";
import {
	isGlobalGoLimit,
	isPerModelUnavailable,
	parseOpenCodeGoDashboardUsage,
	parseOpenCodeGoUsageHeaders,
	parseOpenCodeGoUsageWindow,
	resolveModelEndpoint,
} from "./src/opencode-go.ts";
import type {
	AnthropicUsage,
	CopilotUsage,
	OpenCodeGoUsage,
} from "./src/types.ts";

// ───────── parseEnvInt ─────────

describe("parseEnvInt", () => {
	it("returns fallback when env var is missing", () => {
		assert.equal(parseEnvInt("MISSING_VAR_X12345", 30), 30);
	});

	it("returns parsed positive integer", () => {
		process.env.TEST_PARSE_INT = "42";
		assert.equal(parseEnvInt("TEST_PARSE_INT", 10), 42);
		delete process.env.TEST_PARSE_INT;
	});

	it("returns fallback for zero", () => {
		process.env.TEST_PARSE_INT = "0";
		assert.equal(parseEnvInt("TEST_PARSE_INT", 30), 30);
		delete process.env.TEST_PARSE_INT;
	});

	it("returns fallback for negative", () => {
		process.env.TEST_PARSE_INT = "-5";
		assert.equal(parseEnvInt("TEST_PARSE_INT", 30), 30);
		delete process.env.TEST_PARSE_INT;
	});

	it("returns fallback for NaN", () => {
		process.env.TEST_PARSE_INT = "abc";
		assert.equal(parseEnvInt("TEST_PARSE_INT", 30), 30);
		delete process.env.TEST_PARSE_INT;
	});
});

// ───────── parseEnvBool ─────────

describe("parseEnvBool", () => {
	afterEach(() => {
		delete process.env.TEST_PARSE_BOOL;
	});

	it("returns fallback when env var is missing", () => {
		assert.equal(parseEnvBool("TEST_PARSE_BOOL", true), true);
		assert.equal(parseEnvBool("TEST_PARSE_BOOL", false), false);
	});

	it("returns parsed boolean", () => {
		process.env.TEST_PARSE_BOOL = "false";
		assert.equal(parseEnvBool("TEST_PARSE_BOOL", true), false);
		process.env.TEST_PARSE_BOOL = "yes";
		assert.equal(parseEnvBool("TEST_PARSE_BOOL", false), true);
	});

	it("returns fallback for unrecognized value", () => {
		process.env.TEST_PARSE_BOOL = "maybe";
		assert.equal(parseEnvBool("TEST_PARSE_BOOL", true), true);
	});
});

// ───────── parseBoolValue ─────────

describe("parseBoolValue", () => {
	it("returns undefined for undefined", () => {
		assert.equal(parseBoolValue(undefined), undefined);
	});

	it("parses truthy values", () => {
		assert.equal(parseBoolValue("1"), true);
		assert.equal(parseBoolValue("true"), true);
		assert.equal(parseBoolValue("yes"), true);
		assert.equal(parseBoolValue("on"), true);
	});

	it("parses falsy values", () => {
		assert.equal(parseBoolValue("0"), false);
		assert.equal(parseBoolValue("false"), false);
		assert.equal(parseBoolValue("no"), false);
		assert.equal(parseBoolValue("off"), false);
	});

	it("handles case-insensitive", () => {
		assert.equal(parseBoolValue("TRUE"), true);
		assert.equal(parseBoolValue("YeS"), true);
		assert.equal(parseBoolValue("FALSE"), false);
	});

	it("handles whitespace", () => {
		assert.equal(parseBoolValue(" true "), true);
		assert.equal(parseBoolValue("false "), false);
	});

	it("returns undefined for unrecognized", () => {
		assert.equal(parseBoolValue("maybe"), undefined);
		assert.equal(parseBoolValue(""), undefined);
	});
});

// ───────── truncate ─────────

describe("truncate", () => {
	it("returns text unchanged when within limit", () => {
		assert.equal(truncate("hello", 10), "hello");
	});

	it("truncates with ellipsis when over limit", () => {
		assert.equal(truncate("hello world", 5), "hello…");
	});

	it("handles empty string", () => {
		assert.equal(truncate("", 5), "");
	});

	it("handles exact length", () => {
		assert.equal(truncate("hello", 5), "hello");
	});
});

// ───────── formatDuration ─────────

describe("formatDuration", () => {
	it("returns 'now' for <= 0", () => {
		assert.equal(formatDuration(0), "now");
		assert.equal(formatDuration(-1), "now");
	});

	it("returns seconds for < 60", () => {
		assert.equal(formatDuration(30), "30s");
		assert.equal(formatDuration(1), "1s");
		assert.equal(formatDuration(59), "59s");
	});

	it("returns minutes for < 3600", () => {
		assert.equal(formatDuration(60), "1m");
		assert.equal(formatDuration(300), "5m");
		assert.equal(formatDuration(3599), "60m");
	});

	it("returns hours for < 86400", () => {
		assert.equal(formatDuration(3600), "1h");
		assert.equal(formatDuration(5400), "1.5h");
		assert.equal(formatDuration(86399), "24h");
	});

	it("returns days for >= 86400", () => {
		assert.equal(formatDuration(86400), "1d");
		assert.equal(formatDuration(432000), "5d");
		assert.equal(formatDuration(864000), "10d");
	});
});

// ───────── progressBar ─────────

describe("progressBar", () => {
	it("returns empty bar for 0%", () => {
		assert.equal(progressBar(0), "░".repeat(20));
	});

	it("returns full bar for 100%", () => {
		assert.equal(progressBar(100), "█".repeat(20));
	});

	it("returns full bar for >100%", () => {
		assert.equal(progressBar(150), "█".repeat(20));
	});

	it("clamps negative to 0%", () => {
		assert.equal(progressBar(-10), "░".repeat(20));
	});

	it("uses custom width", () => {
		assert.equal(progressBar(50, 10), "█████░░░░░");
	});

	it("returns correct proportion", () => {
		assert.equal(progressBar(25, 20), "█████░░░░░░░░░░░░░░░");
		assert.equal(progressBar(75, 20), "███████████████░░░░░");
	});
});

// ───────── parseHeaderNumber ─────────

describe("parseHeaderNumber", () => {
	it("returns fallback for undefined", () => {
		assert.equal(parseHeaderNumber(undefined, 42), 42);
	});

	it("returns fallback for empty string", () => {
		assert.equal(parseHeaderNumber("", 42), 42);
	});

	it("parses valid number string", () => {
		assert.equal(parseHeaderNumber("123", 42), 123);
	});

	it("returns fallback for NaN", () => {
		assert.equal(parseHeaderNumber("abc", 42), 42);
	});

	it("parses zero", () => {
		assert.equal(parseHeaderNumber("0", 42), 0);
	});

	it("parses float", () => {
		assert.equal(parseHeaderNumber("3.14", 0), 3.14);
	});
});

// ───────── parseHeaderBool ─────────

describe("parseHeaderBool", () => {
	it("returns false for undefined", () => {
		assert.equal(parseHeaderBool(undefined), false);
	});

	it("returns true for 'true'", () => {
		assert.equal(parseHeaderBool("true"), true);
	});

	it("handles case-insensitive", () => {
		assert.equal(parseHeaderBool("True"), true);
		assert.equal(parseHeaderBool("TRUE"), true);
	});

	it("returns false for 'false'", () => {
		assert.equal(parseHeaderBool("false"), false);
	});

	it("returns false for other values", () => {
		assert.equal(parseHeaderBool("yes"), false);
		assert.equal(parseHeaderBool("1"), false);
	});
});

// ───────── clampPercent ─────────

describe("clampPercent", () => {
	it("returns 0 for negative", () => {
		assert.equal(clampPercent(-5), 0);
	});

	it("returns 100 for over max", () => {
		assert.equal(clampPercent(150), 100);
	});

	it("returns value in range", () => {
		assert.equal(clampPercent(50), 50);
		assert.equal(clampPercent(0), 0);
		assert.equal(clampPercent(100), 100);
	});

	it("returns 0 for non-finite values", () => {
		assert.equal(clampPercent(NaN), 0);
		assert.equal(clampPercent(Infinity), 0);
		assert.equal(clampPercent(-Infinity), 0);
	});
});

// ───────── dedupe ─────────

describe("dedupe", () => {
	it("removes duplicates while preserving order", () => {
		assert.deepEqual(dedupe(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
	});

	it("filters empty strings", () => {
		assert.deepEqual(dedupe(["a", "", "b", ""]), ["a", "b"]);
	});

	it("returns empty for empty input", () => {
		assert.deepEqual(dedupe([]), []);
	});

	it("handles no duplicates", () => {
		assert.deepEqual(dedupe(["a", "b", "c"]), ["a", "b", "c"]);
	});
});

// ───────── usageColor ─────────

describe("usageColor", () => {
	it("returns success for < 70%", () => {
		assert.equal(usageColor(0), "success");
		assert.equal(usageColor(50), "success");
		assert.equal(usageColor(69), "success");
	});

	it("returns warning for 70-89%", () => {
		assert.equal(usageColor(70), "warning");
		assert.equal(usageColor(80), "warning");
		assert.equal(usageColor(89), "warning");
	});

	it("returns error for >= 90%", () => {
		assert.equal(usageColor(90), "error");
		assert.equal(usageColor(100), "error");
		assert.equal(usageColor(200), "error");
	});
});

// ───────── footerUsageColor ─────────

describe("footerUsageColor", () => {
	it("returns dim for 0-50%", () => {
		assert.equal(footerUsageColor(0), "dim");
		assert.equal(footerUsageColor(25), "dim");
		assert.equal(footerUsageColor(50), "dim");
	});

	it("returns accent for 51-80%", () => {
		assert.equal(footerUsageColor(51), "accent");
		assert.equal(footerUsageColor(65), "accent");
		assert.equal(footerUsageColor(80), "accent");
	});

	it("returns warning for 81-99%", () => {
		assert.equal(footerUsageColor(81), "warning");
		assert.equal(footerUsageColor(90), "warning");
		assert.equal(footerUsageColor(99), "warning");
	});

	it("returns error for 100%", () => {
		assert.equal(footerUsageColor(100), "error");
	});
});

// ───────── footerResetDuration ─────────

describe("footerResetDuration", () => {
	it("returns formatted reset time from resetAt", () => {
		// Use a timestamp far enough ahead that sub-second drift won't matter
		const future = Math.floor(Date.now() / 1000) + 9000;
		const result = footerResetDuration(future, undefined);
		assert.equal(result, "2.5h");
	});

	it("returns formatted duration from resetAfterSeconds", () => {
		assert.equal(footerResetDuration(undefined, 60), "1m");
		assert.equal(footerResetDuration(undefined, 3600), "1h");
	});

	it("returns undefined with no args", () => {
		assert.equal(footerResetDuration(undefined, undefined), undefined);
	});

	it("prefers resetAt over resetAfterSeconds", () => {
		const future = Math.floor(Date.now() / 1000) + 12600;
		const result = footerResetDuration(future, 60);
		assert.equal(result, "3.5h");
	});

	it("returns undefined for resetAt=0", () => {
		assert.equal(footerResetDuration(0, undefined), undefined);
	});
});

// ───────── resolveModelEndpoint ─────────

describe("resolveModelEndpoint", () => {
	it("appends /v1/messages for anthropic-messages without suffix", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com", "anthropic-messages"),
			"https://api.example.com/v1/messages",
		);
	});

	it("keeps existing /messages for anthropic-messages", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com/messages", "anthropic-messages"),
			"https://api.example.com/messages",
		);
	});

	it("appends /v1/chat/completions for openai-completions without suffix", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com", "openai-completions"),
			"https://api.example.com/v1/chat/completions",
		);
	});

	it("keeps existing /chat/completions for openai-completions", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com/chat/completions", "openai-completions"),
			"https://api.example.com/chat/completions",
		);
	});

	it("appends /chat/completions when already /v1", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com/v1", "openai-completions"),
			"https://api.example.com/v1/chat/completions",
		);
	});

	it("normalizes trailing slash", () => {
		assert.equal(
			resolveModelEndpoint("https://api.example.com/v1/", "openai-completions"),
			"https://api.example.com/v1/chat/completions",
		);
	});
});

// ───────── resolveConfigValue ─────────

describe("resolveConfigValue", () => {
	it("returns env var value when set", () => {
		process.env.TEST_RESOLVE = "env-value";
		assert.equal(resolveConfigValue("TEST_RESOLVE"), "env-value");
		delete process.env.TEST_RESOLVE;
	});

	it("returns literal string when env var not set", () => {
		assert.equal(resolveConfigValue("literal-key"), "literal-key");
	});

	it("returns empty string when env var is empty", () => {
		process.env.TEST_RESOLVE = "";
		assert.equal(resolveConfigValue("TEST_RESOLVE"), "");
		delete process.env.TEST_RESOLVE;
	});
});

// ───────── isPerModelUnavailable ─────────

describe("isPerModelUnavailable", () => {
	it("returns false for ambiguous status-only errors", () => {
		assert.equal(isPerModelUnavailable(400, "bad request"), false);
		assert.equal(isPerModelUnavailable(404, "not found"), false);
		assert.equal(isPerModelUnavailable(422, "unprocessable"), false);
	});

	it("returns true for model disabled", () => {
		assert.equal(isPerModelUnavailable(500, "model disabled for this API key"), true);
	});

	it("returns true for model not found", () => {
		assert.equal(isPerModelUnavailable(500, "model was not found"), true);
	});

	it("returns true for model unsupported", () => {
		assert.equal(isPerModelUnavailable(500, "Model unsupported"), true);
	});

	it("returns false for other errors", () => {
		assert.equal(isPerModelUnavailable(500, "internal server error"), false);
		assert.equal(isPerModelUnavailable(503, "service unavailable"), false);
	});
});

// ───────── isGlobalGoLimit ─────────

describe("isGlobalGoLimit", () => {
	it("returns false for provider errors", () => {
		assert.equal(isGlobalGoLimit("error from provider: timeout"), false);
	});

	it("returns true for insufficient credits", () => {
		assert.equal(isGlobalGoLimit("insufficient credits"), true);
		assert.equal(isGlobalGoLimit("Insufficient balance"), true);
	});

	it("returns true for credits exhausted", () => {
		assert.equal(isGlobalGoLimit("credits exhausted"), true);
	});

	it("returns true for quota limit messages", () => {
		assert.equal(isGlobalGoLimit("OpenCode quota exceeded"), true);
		assert.equal(isGlobalGoLimit("go limit reached"), true);
	});

	it("returns true for subscription quota", () => {
		assert.equal(isGlobalGoLimit("subscription quota exceeded"), true);
	});

	it("returns false for unrelated messages", () => {
		assert.equal(isGlobalGoLimit("rate limit per model"), false);
	});
});

// ───────── passive header parsing ─────────

describe("parseCodexUsageHeaders", () => {
	it("parses Codex quota headers", () => {
		const usage = parseCodexUsageHeaders({
			"x-codex-plan-type": "plus",
			"x-codex-active-limit": "normal",
			"x-codex-primary-used-percent": "42",
			"x-codex-secondary-used-percent": "55",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-primary-reset-after-seconds": "120",
			"x-codex-secondary-reset-at": "2000000000",
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-balance": "$5.00",
		});

		assert.ok(usage);
		assert.equal(usage.planType, "plus");
		assert.equal(usage.primaryUsedPercent, 42);
		assert.equal(usage.secondaryUsedPercent, 55);
		assert.equal(usage.primaryResetAfterSeconds, 120);
		assert.equal(usage.secondaryResetAt, 2000000000);
		assert.equal(usage.creditsHasCredits, true);
		assert.equal(usage.creditsBalance, "$5.00");
		assert.equal(usage.source, "headers");
	});

	it("parses Codex 429 retry-after without x-codex headers", () => {
		const usage = parseCodexUsageHeaders({ "retry-after": "30" }, 429);
		assert.ok(usage);
		assert.equal(usage.activeLimit, "rate_limited");
		assert.equal(usage.primaryUsedPercent, 100);
		assert.equal(usage.primaryResetAfterSeconds, 30);
	});

	it("returns undefined when no relevant headers", () => {
		assert.equal(parseCodexUsageHeaders({ server: "test" }, 200), undefined);
	});
});

describe("parseAnthropicUsageHeaders", () => {
	it("parses Anthropic rate-limit headers", () => {
		const resetIso = new Date(Date.now() + 60_000).toISOString();
		const usage = parseAnthropicUsageHeaders({
			"anthropic-ratelimit-requests-limit": "100",
			"anthropic-ratelimit-requests-remaining": "75",
			"anthropic-ratelimit-requests-reset": resetIso,
			"anthropic-ratelimit-tokens-limit": "1000",
			"anthropic-ratelimit-tokens-remaining": "500",
		}, 200, "claude-haiku-4-5");

		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.workingModel, "claude-haiku-4-5");
		assert.equal(usage.requests?.usedPercent, 25);
		assert.equal(usage.requests?.remainingPercent, 75);
		assert.ok((usage.requests?.resetAfterSeconds ?? 0) > 0);
		assert.equal(usage.tokens?.usedPercent, 50);
		assert.equal(usage.source, "headers");
	});

	it("infers Anthropic rate limit from 429 retry-after", () => {
		const usage = parseAnthropicUsageHeaders({ "retry-after": "30" }, 429, "claude-sonnet-4-5");
		assert.ok(usage);
		assert.equal(usage.status, "rate_limited");
		assert.equal(usage.rateLimitedModel, "claude-sonnet-4-5");
		assert.equal(usage.retryAfterSeconds, 30);
		assert.match(usage.errorMessage ?? "", /30s/);
	});

	it("preserves previous Anthropic quota on successful availability headers", () => {
		const usage = parseAnthropicUsageHeaders({}, 200, "claude-haiku-4-5", {
			available: false,
			status: "rate_limited",
			requests: { usedPercent: 90, remainingPercent: 10 },
			retryAfterSeconds: 30,
		});
		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.requests?.usedPercent, 90);
		assert.equal(usage.retryAfterSeconds, undefined);
	});

	it("returns undefined when no Anthropic signal is present", () => {
		assert.equal(parseAnthropicUsageHeaders({ server: "test" }, 200), undefined);
	});
});

describe("parseAnthropicResetAt", () => {
	it("parses RFC3339 reset timestamps", () => {
		const result = parseAnthropicResetAt("2030-01-01T00:00:00.000Z");
		assert.equal(result, 1893456000);
	});

	it("parses unix seconds", () => {
		assert.equal(parseAnthropicResetAt("2000000000"), 2000000000);
	});

	it("returns zero for invalid values", () => {
		assert.equal(parseAnthropicResetAt("not-a-date"), 0);
	});
});

describe("isAnthropicModelUnavailable", () => {
	it("matches unavailable model messages", () => {
		assert.equal(isAnthropicModelUnavailable("model claude-x not found"), true);
		assert.equal(isAnthropicModelUnavailable("unsupported model"), true);
	});

	it("does not match rate-limit messages", () => {
		assert.equal(isAnthropicModelUnavailable("rate limit exceeded"), false);
	});
});

describe("parseCopilotUsageHeaders", () => {
	it("parses generic Copilot rate-limit headers", () => {
		const reset = Math.round(Date.now() / 1000) + 60;
		const usage = parseCopilotUsageHeaders({
			"x-ratelimit-limit": "100",
			"x-ratelimit-remaining": "80",
			"x-ratelimit-used": "20",
			"x-ratelimit-reset": String(reset),
			"x-ratelimit-resource": "copilot",
		}, 200, "gpt-5-mini");

		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.workingModel, "gpt-5-mini");
		assert.equal(usage.requests?.usedPercent, 20);
		assert.equal(usage.requests?.remainingPercent, 80);
		assert.equal(usage.requests?.resource, "copilot");
		assert.ok((usage.requests?.resetAfterSeconds ?? 0) > 0);
	});

	it("parses future Copilot premium request headers", () => {
		const usage = parseCopilotUsageHeaders({
			"x-copilot-premium-requests-used-percent": "40",
			"x-copilot-premium-requests-remaining-percent": "60",
			"x-copilot-premium-requests-reset-after-seconds": "120",
		}, 200, "gpt-5-mini");

		assert.ok(usage);
		assert.equal(usage.premiumRequests?.usedPercent, 40);
		assert.equal(usage.premiumRequests?.remainingPercent, 60);
		assert.equal(usage.premiumRequests?.resetAfterSeconds, 120);
	});

	it("infers Copilot rate limit from 429 retry-after", () => {
		const usage = parseCopilotUsageHeaders({ "retry-after": "45" }, 429, "gpt-5-mini");
		assert.ok(usage);
		assert.equal(usage.status, "rate_limited");
		assert.equal(usage.rateLimitedModel, "gpt-5-mini");
		assert.equal(usage.retryAfterSeconds, 45);
		assert.match(usage.errorMessage ?? "", /45s/);
	});

	it("preserves previous Copilot quota on successful availability headers", () => {
		const usage = parseCopilotUsageHeaders({}, 200, "gpt-5-mini", {
			available: false,
			status: "rate_limited",
			premiumRequests: { usedPercent: 70, remainingPercent: 30 },
			retryAfterSeconds: 30,
		});
		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.premiumRequests?.usedPercent, 70);
		assert.equal(usage.retryAfterSeconds, undefined);
	});

	it("returns undefined when no Copilot signal is present", () => {
		assert.equal(parseCopilotUsageHeaders({ server: "test" }, 200), undefined);
	});
});

describe("parseCopilotResetAt", () => {
	it("parses unix seconds", () => {
		assert.equal(parseCopilotResetAt("2000000000"), 2000000000);
	});

	it("parses unix milliseconds", () => {
		assert.equal(parseCopilotResetAt("2000000000000"), 2000000000);
	});

	it("parses date strings", () => {
		assert.equal(parseCopilotResetAt("2030-01-01T00:00:00.000Z"), 1893456000);
	});
});

describe("Copilot helpers", () => {
	it("normalizes enterprise domains", () => {
		assert.equal(normalizeCopilotDomain("https://company.ghe.com/path"), "company.ghe.com");
		assert.equal(normalizeCopilotDomain("company.ghe.com"), "company.ghe.com");
	});

	it("extracts base URL from Copilot token proxy endpoint", () => {
		assert.equal(getCopilotBaseUrl("tid=x;proxy-ep=proxy.enterprise.githubcopilot.com;exp=1"), "https://api.enterprise.githubcopilot.com");
	});

	it("falls back to enterprise base URL", () => {
		assert.equal(getCopilotBaseUrl("token", "company.ghe.com"), "https://copilot-api.company.ghe.com");
	});

	it("matches unavailable and quota messages", () => {
		assert.equal(isCopilotModelUnavailable("model gpt-x not found"), true);
		assert.equal(isCopilotQuotaMessage("premium requests quota exceeded"), true);
		assert.equal(isCopilotQuotaMessage("model not found"), false);
	});
});

describe("parseOpenCodeGoUsageHeaders", () => {
	it("parses passive Go quota headers", () => {
		const usage = parseOpenCodeGoUsageHeaders({
			"x-opencode-go-status": "available",
			"x-opencode-go-model": "glm-5.1",
			"x-opencode-go-rolling-used-percent": "25",
			"x-opencode-go-weekly-used-percent": "50",
			"x-opencode-go-monthly-reset-after-seconds": "3600",
		}, 200);

		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.workingModel, "glm-5.1");
		assert.equal(usage.rollingUsedPercent, 25);
		assert.equal(usage.rollingRemainingPercent, 75);
		assert.equal(usage.weeklyUsedPercent, 50);
		assert.equal(usage.monthlyResetAfterSeconds, 3600);
		assert.equal(usage.quotaSource, "response headers");
	});

	it("infers rate limited Go status from 429", () => {
		const usage = parseOpenCodeGoUsageHeaders({ "retry-after": "15" }, 429, "glm-5.1");
		assert.ok(usage);
		assert.equal(usage.status, "rate_limited");
		assert.equal(usage.rateLimitedModel, "glm-5.1");
		assert.match(usage.errorMessage ?? "", /15s/);
	});

	it("preserves previous Go quota when only model availability is known", () => {
		const usage = parseOpenCodeGoUsageHeaders({}, 200, "glm-5.1", {
			available: false,
			status: "rate_limited",
			rollingUsedPercent: 20,
			rollingRemainingPercent: 80,
		});
		assert.ok(usage);
		assert.equal(usage.status, "available");
		assert.equal(usage.workingModel, "glm-5.1");
		assert.equal(usage.rollingUsedPercent, 20);
		assert.equal(usage.errorMessage, undefined);
	});
});

// ───────── window helpers ─────────

describe("windowUsedPercent", () => {
	it("returns clamped percent from window", () => {
		assert.equal(windowUsedPercent({ used_percent: 50 }), 50);
	});

	it("returns 0 for null/undefined", () => {
		assert.equal(windowUsedPercent(null), 0);
		assert.equal(windowUsedPercent(undefined), 0);
	});

	it("clamps out-of-range", () => {
		assert.equal(windowUsedPercent({ used_percent: 150 }), 100);
		assert.equal(windowUsedPercent({ used_percent: -10 }), 0);
	});
});

describe("windowMinutes", () => {
	it("converts seconds to minutes", () => {
		assert.equal(windowMinutes({ limit_window_seconds: 300 }, 100), 5);
	});

	it("returns fallback for null/undefined", () => {
		assert.equal(windowMinutes(null, 100), 100);
		assert.equal(windowMinutes(undefined, 100), 100);
	});

	it("returns fallback for zero seconds", () => {
		assert.equal(windowMinutes({ limit_window_seconds: 0 }, 42), 42);
	});
});

describe("windowResetAfterSeconds", () => {
	it("returns rounded reset_after_seconds", () => {
		assert.equal(windowResetAfterSeconds({ reset_after_seconds: 3600.7 }), 3601);
	});

	it("returns 0 for null/undefined", () => {
		assert.equal(windowResetAfterSeconds(null), 0);
		assert.equal(windowResetAfterSeconds(undefined), 0);
	});

	it("returns 0 for zero/negative", () => {
		assert.equal(windowResetAfterSeconds({ reset_after_seconds: 0 }), 0);
		assert.equal(windowResetAfterSeconds({ reset_after_seconds: -5 }), 0);
	});
});

describe("windowResetAt", () => {
	it("returns reset_at when present", () => {
		assert.equal(windowResetAt({ reset_at: 1000 }), 1000);
	});

	it("computes from reset_after when reset_at missing", () => {
		const before = Math.round(Date.now() / 1000);
		const result = windowResetAt({ reset_after_seconds: 3600 });
		const after = Math.round(Date.now() / 1000);
		assert.ok(result! >= before + 3600 && result! <= after + 3600);
	});

	it("returns 0 when both missing", () => {
		assert.equal(windowResetAt(null), 0);
		assert.equal(windowResetAt(undefined), 0);
	});
});

// ───────── formatResetTime ─────────

describe("formatResetTime", () => {
	it("returns 'now' for past timestamp", () => {
		const past = Math.round(Date.now() / 1000) - 10;
		assert.equal(formatResetTime(past), "now");
	});

	it("returns duration for future timestamp", () => {
		const future = Math.floor(Date.now() / 1000) + 9000;
		const result = formatResetTime(future);
		assert.equal(result, "2.5h");
	});
});

// ───────── Integration: progressBar + clampPercent ─────────

describe("progressBar integration", () => {
	it("produces correct fill for edge percents", () => {
		const bar = (p: number) => progressBar(p, 10);
		assert.equal(bar(0), "░".repeat(10));
		assert.equal(bar(10), "█".repeat(1) + "░".repeat(9));
		assert.equal(bar(50), "█".repeat(5) + "░".repeat(5));
		assert.equal(bar(100), "█".repeat(10));
	});
});

// ───────── statusIcon ─────────

describe("statusIcon", () => {
	it("returns check for available", () => {
		assert.equal(statusIcon("available"), "✓");
	});

	it("returns hourglass for rate_limited", () => {
		assert.equal(statusIcon("rate_limited"), "⏳");
	});

	it("returns cross for credits_error", () => {
		assert.equal(statusIcon("credits_error"), "✗");
	});

	it("returns warning for error", () => {
		assert.equal(statusIcon("error"), "⚠");
	});

	it("returns em-dash for no_key", () => {
		assert.equal(statusIcon("no_key"), "—");
	});
});

// ───────── codexUsageHasData ─────────

describe("codexUsageHasData", () => {
	it("returns true for normal usage", () => {
		assert.equal(codexUsageHasData({ activeLimit: "normal", error: undefined } as any), true);
	});

	it("returns false for undefined", () => {
		assert.equal(codexUsageHasData(undefined), false);
	});

	it("returns false when error is set", () => {
		assert.equal(codexUsageHasData({ activeLimit: "normal", error: "some error" } as any), false);
	});

	it("returns false when activeLimit is error", () => {
		assert.equal(codexUsageHasData({ activeLimit: "error", error: undefined } as any), false);
	});
});

// ───────── anthropicUsageHasData ─────────

describe("anthropicUsageHasData", () => {
	it("returns true for available status", () => {
		assert.equal(anthropicUsageHasData({ status: "available" } as any), true);
	});

	it("returns true for rate_limited", () => {
		assert.equal(anthropicUsageHasData({ status: "rate_limited" } as any), true);
	});

	it("returns false for undefined", () => {
		assert.equal(anthropicUsageHasData(undefined), false);
	});

	it("returns false for no_key", () => {
		assert.equal(anthropicUsageHasData({ status: "no_key" } as any), false);
	});
});

// ───────── copilotUsageHasData ─────────

describe("copilotUsageHasData", () => {
	it("returns true for available status", () => {
		assert.equal(copilotUsageHasData({ status: "available" } as any), true);
	});

	it("returns true for rate_limited", () => {
		assert.equal(copilotUsageHasData({ status: "rate_limited" } as any), true);
	});

	it("returns false for undefined", () => {
		assert.equal(copilotUsageHasData(undefined), false);
	});

	it("returns false for no_key", () => {
		assert.equal(copilotUsageHasData({ status: "no_key" } as any), false);
	});
});

// ───────── goUsageHasData ─────────

describe("goUsageHasData", () => {
	it("returns true for available status", () => {
		assert.equal(goUsageHasData({ status: "available" } as any), true);
	});

	it("returns true for rate_limited", () => {
		assert.equal(goUsageHasData({ status: "rate_limited" } as any), true);
	});

	it("returns false for undefined", () => {
		assert.equal(goUsageHasData(undefined), false);
	});

	it("returns false for no_key", () => {
		assert.equal(goUsageHasData({ status: "no_key" } as any), false);
	});
});

// ───────── extractAccountId ─────────

describe("extractAccountId", () => {
	it("extracts account ID from valid JWT", () => {
		const payload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acc_123" },
		})).toString("base64url");
		const token = `header.${payload}.signature`;
		assert.equal(extractAccountId(token), "acc_123");
	});

	it("returns undefined for non-3-part token", () => {
		assert.equal(extractAccountId("invalid.token"), undefined);
	});

	it("returns undefined for malformed payload", () => {
		const token = "header.invalid-base64!.signature";
		assert.equal(extractAccountId(token), undefined);
	});

	it("returns undefined for missing account ID", () => {
		const payload = Buffer.from(JSON.stringify({})).toString("base64url");
		const token = `header.${payload}.signature`;
		assert.equal(extractAccountId(token), undefined);
	});
});

// ───────── readResponseText ─────────

describe("readResponseText", () => {
	it("returns empty string for null body", async () => {
		const response = new Response(null);
		assert.equal(await readResponseText(response), "");
	});

	it("reads text body correctly", async () => {
		const response = new Response("hello world");
		assert.equal(await readResponseText(response), "hello world");
	});

	it("reads empty body", async () => {
		const response = new Response("");
		assert.equal(await readResponseText(response), "");
	});

	it("reads multi-chunk body", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode("chunk1"));
				controller.enqueue(encoder.encode("chunk2"));
				controller.close();
			},
		});
		const response = new Response(stream);
		assert.equal(await readResponseText(response), "chunk1chunk2");
	});

	it("handles large body close to size limit", async () => {
		const data = "x".repeat(512_000);
		const response = new Response(data);
		const text = await readResponseText(response);
		assert.equal(text.length, 512_000);
	});

	it("rejects when body exceeds size limit", async () => {
		const data = "x".repeat(512_001);
		const response = new Response(data);
		await assert.rejects(
			readResponseText(response),
			/Response body exceeded/,
		);
	});

	it("reads JSON body", async () => {
		const response = new Response(JSON.stringify({ key: "value" }));
		assert.equal(await readResponseText(response), '{"key":"value"}');
	});
});

// ───────── cancelResponseBody ─────────

describe("cancelResponseBody", () => {
	it("handles null body gracefully", async () => {
		const response = new Response(null);
		await cancelResponseBody(response);
	});

	it("cancels body stream", async () => {
		const response = new Response("test");
		await cancelResponseBody(response);
	});
});

// ───────── renderCodexWindows ─────────

describe("renderCodexWindows", () => {
	const identity = (_color: string, text: string) => text;

	it("renders code review and credits when present", () => {
		const future = Math.floor(Date.now() / 1000) + 3600;
		const result = renderCodexWindows(
			{
				planType: "plus",
				activeLimit: "normal",
				primaryUsedPercent: 42,
				secondaryUsedPercent: 60,
				codeReviewUsedPercent: 10,
				primaryWindowMinutes: 300,
				secondaryWindowMinutes: 10080,
				codeReviewWindowMinutes: 1440,
				primaryResetAfterSeconds: 0,
				secondaryResetAfterSeconds: 0,
				primaryResetAt: 0,
				secondaryResetAt: 0,
				codeReviewResetAt: undefined,
				codeReviewResetAfterSeconds: 86400,
				primaryOverSecondaryLimitPercent: 10,
				creditsHasCredits: true,
				creditsBalance: "$5.00",
				creditsUnlimited: false,
				source: "usage_api",
			},
			identity as any,
			false,
		);
		const joined = result.join("\n");
		assert.match(joined, /Codex/);
		assert.match(joined, /plus/);
		assert.match(joined, /review/);
		assert.match(joined, /credits/);
		assert.match(joined, /\$5\.00/);
		assert.match(joined, /10%/);
		assert.match(joined, /42%/);
		assert.match(joined, /60%/);
	});

	it("shows plan type when non-unknown", () => {
		const result = renderCodexWindows(
			{
				planType: "enterprise",
				activeLimit: "normal",
				primaryUsedPercent: 10,
				secondaryUsedPercent: 20,
				primaryWindowMinutes: 300,
				secondaryWindowMinutes: 10080,
				primaryResetAfterSeconds: 0,
				secondaryResetAfterSeconds: 0,
				primaryResetAt: 0,
				secondaryResetAt: 0,
				primaryOverSecondaryLimitPercent: 0,
				creditsHasCredits: false,
				creditsBalance: "",
				creditsUnlimited: false,
				source: "usage_api",
			},
			identity as any,
			false,
		);
		assert.match(result.join("\n"), /enterprise/);
	});

	it("renders error state", () => {
		const result = renderCodexWindows(
			{
				planType: "unknown",
				activeLimit: "error",
				primaryUsedPercent: 0,
				secondaryUsedPercent: 0,
				primaryWindowMinutes: 300,
				secondaryWindowMinutes: 10080,
				primaryResetAfterSeconds: 0,
				secondaryResetAfterSeconds: 0,
				primaryResetAt: 0,
				secondaryResetAt: 0,
				primaryOverSecondaryLimitPercent: 0,
				creditsHasCredits: false,
				creditsBalance: "",
				creditsUnlimited: false,
				source: "probe",
				error: "API connection failed",
			},
			identity as any,
			false,
		);
		assert.match(result.join("\n"), /✗ Codex/);
		assert.match(result.join("\n"), /API connection failed/);
	});

	it("shows rate_limited label", () => {
		const result = renderCodexWindows(
			{
				planType: "unknown",
				activeLimit: "rate_limited",
				primaryUsedPercent: 100,
				secondaryUsedPercent: 50,
				primaryWindowMinutes: 300,
				secondaryWindowMinutes: 10080,
				primaryResetAfterSeconds: 0,
				secondaryResetAfterSeconds: 0,
				primaryResetAt: Math.floor(Date.now() / 1000) + 300,
				secondaryResetAt: 0,
				primaryOverSecondaryLimitPercent: 0,
				creditsHasCredits: false,
				creditsBalance: "",
				creditsUnlimited: false,
				source: "probe",
				error: "Rate limited (429)",
			},
			identity as any,
			false,
		);
		assert.match(result.join("\n"), /rate_limited/);
	});
});

// ───────── renderAnthropicWindows ─────────

describe("renderAnthropicWindows", () => {
	const identity = (_color: string, text: string) => text;

	it("renders rate-limit windows", () => {
		const anthropic: AnthropicUsage = {
			available: true,
			status: "available",
			authType: "oauth",
			workingModel: "claude-haiku-4-5",
			requests: { usedPercent: 25, remainingPercent: 75, resetAfterSeconds: 60 },
			tokens: { usedPercent: 50, remainingPercent: 50, resetAfterSeconds: 120 },
		};
		const result = renderAnthropicWindows(anthropic, identity as any, false);
		const joined = result.join("\n");
		assert.match(joined, /Anthropic/);
		assert.match(joined, /Claude Pro\/Max/);
		assert.match(joined, /requests/);
		assert.match(joined, /tokens/);
		assert.match(joined, /25%/);
		assert.match(joined, /50%/);
		assert.match(joined, /claude-haiku-4-5/);
	});

	it("renders retry-only rate limit", () => {
		const anthropic: AnthropicUsage = {
			available: false,
			status: "rate_limited",
			authType: "oauth",
			rateLimitedModel: "claude-sonnet-4-5",
			retryAfterSeconds: 30,
			errorMessage: "Rate limited",
		};
		const result = renderAnthropicWindows(anthropic, identity as any, false).join("\n");
		assert.match(result, /rate limited/);
		assert.match(result, /retry: 30s/);
		assert.match(result, /claude-sonnet-4-5/);
	});

	it("renders with color when useColor=true", () => {
		const anthropic: AnthropicUsage = {
			available: true,
			status: "available",
			requests: { usedPercent: 50, remainingPercent: 50 },
		};
		const colorFmt = (_c: string, text: string) => `[${_c}:${text}]`;
		const result = renderAnthropicWindows(anthropic, colorFmt as any, true).join("\n");
		assert.match(result, /\[success/);
	});
});

// ───────── renderCopilotWindows ─────────

describe("renderCopilotWindows", () => {
	const identity = (_color: string, text: string) => text;

	it("renders Copilot quota windows", () => {
		const copilot: CopilotUsage = {
			available: true,
			status: "available",
			workingModel: "gpt-5-mini",
			premiumRequests: { usedPercent: 40, remainingPercent: 60, resetAfterSeconds: 120 },
			requests: { usedPercent: 10, remainingPercent: 90, resetAfterSeconds: 60 },
			availableModels: 12,
		};
		const result = renderCopilotWindows(copilot, identity as any, false).join("\n");
		assert.match(result, /GitHub Copilot/);
		assert.match(result, /premium/);
		assert.match(result, /requests/);
		assert.match(result, /40%/);
		assert.match(result, /gpt-5-mini/);
		assert.match(result, /12 account models/);
	});

	it("renders retry-only rate limit", () => {
		const copilot: CopilotUsage = {
			available: false,
			status: "rate_limited",
			rateLimitedModel: "gpt-5-mini",
			retryAfterSeconds: 45,
			errorMessage: "Rate limited",
		};
		const result = renderCopilotWindows(copilot, identity as any, false).join("\n");
		assert.match(result, /rate limited/);
		assert.match(result, /retry: 45s/);
		assert.match(result, /gpt-5-mini/);
	});

	it("renders with color when useColor=true", () => {
		const copilot: CopilotUsage = {
			available: true,
			status: "available",
			requests: { usedPercent: 50, remainingPercent: 50 },
		};
		const colorFmt = (_c: string, text: string) => `[${_c}:${text}]`;
		const result = renderCopilotWindows(copilot, colorFmt as any, true).join("\n");
		assert.match(result, /\[success/);
	});
});

// ───────── renderGoWindows ─────────

describe("renderGoWindows", () => {
	const identity = (_color: string, text: string) => text;

	it("renders quota data windows", () => {
		const go: OpenCodeGoUsage = {
			available: true,
			status: "available",
			rollingUsedPercent: 20,
			rollingRemainingPercent: 80,
			rollingResetAfterSeconds: 11520,
			rollingResetAt: 0,
			weeklyUsedPercent: 40,
			weeklyRemainingPercent: 60,
			weeklyResetAfterSeconds: 0,
			weeklyResetAt: Math.floor(Date.now() / 1000) + 604800,
			monthlyUsedPercent: 60,
			monthlyRemainingPercent: 40,
			monthlyResetAfterSeconds: 0,
			monthlyResetAt: Math.floor(Date.now() / 1000) + 2592000,
			quotaConfigured: true,
			quotaSource: "/path/to/config",
		};
		const result = renderGoWindows(go, identity as any, false);
		const joined = result.join("\n");
		assert.match(joined, /OpenCode Go/);
		assert.match(joined, /20%/);
		assert.match(joined, /40%/);
		assert.match(joined, /60%/);
		assert.match(joined, /rolling/);
		assert.match(joined, /week/);
		assert.match(joined, /month/);
	});

	it("renders no_key status", () => {
		const go: OpenCodeGoUsage = {
			available: false,
			status: "no_key",
		};
		const result = renderGoWindows(go, identity as any, false);
		assert.match(result.join("\n"), /no key/);
	});

	it("renders rate_limited with error message", () => {
		const go: OpenCodeGoUsage = {
			available: false,
			status: "rate_limited",
			rateLimitedModel: "qwen3.5-plus",
			errorMessage: "Rate limit exceeded",
			checkedModels: 3,
			totalModels: 10,
		};
		const result = renderGoWindows(go, identity as any, false);
		const joined = result.join("\n");
		assert.match(joined, /rate limited/);
		assert.match(joined, /qwen3\.5-plus/);
		assert.match(joined, /Rate limit exceeded/);
		assert.match(joined, /3\/10/);
	});

	it("renders quotaError line", () => {
		const go: OpenCodeGoUsage = {
			available: true,
			status: "available",
			quotaError: "Dashboard parse error",
			workingModel: "glm-5.1",
		};
		const result = renderGoWindows(go, identity as any, false);
		const joined = result.join("\n");
		assert.match(joined, /Dashboard parse error/);
		assert.match(joined, /glm-5\.1/);
	});

	it("renders with color when useColor=true", () => {
		const go: OpenCodeGoUsage = {
			available: true,
			status: "available",
			rollingUsedPercent: 50,
			rollingRemainingPercent: 50,
			rollingResetAfterSeconds: 3600,
		};
		const colorFmt = (_c: string, text: string) => `[${_c}:${text}]`;
		const result = renderGoWindows(go, colorFmt as any, true);
		const joined = result.join("\n");
		assert.match(joined, /\[success/);
	});
});

// ───────── buildUsageWidget ─────────

describe("buildUsageWidget", () => {
	const mockTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;

	it("renders loading state", () => {
		const result = buildUsageWidget(undefined, undefined, mockTheme, true);
		assert.match(result.text, /Checking usage limits/);
	});

	it("renders with both services configured", () => {
		const codex: any = {
			planType: "plus",
			activeLimit: "normal",
			primaryUsedPercent: 30,
			secondaryUsedPercent: 40,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			source: "usage_api",
		};
		const go: OpenCodeGoUsage = {
			available: true,
			status: "available",
		};
		const result = buildUsageWidget(codex, go, mockTheme, false);
		assert.match(result.text, /Usage Limits/);
		assert.match(result.text, /Codex/);
		assert.match(result.text, /OpenCode Go/);
	});

	it("shows 'not configured' when services missing", () => {
		const result = buildUsageWidget(undefined, undefined, mockTheme, false);
		assert.match(result.text, /not configured/);
		assert.match(result.text, /Codex/);
		assert.match(result.text, /OpenCode Go/);
	});

	it("shows partial services", () => {
		const codex: any = {
			planType: "unknown",
			activeLimit: "normal",
			primaryUsedPercent: 50,
			secondaryUsedPercent: 50,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			source: "usage_api",
		};
		const result = buildUsageWidget(codex, undefined, mockTheme, false);
		assert.match(result.text, /Codex/);
		assert.match(result.text, /OpenCode Go.*not configured/);
	});
});

// ───────── buildStartupUsageMessage ─────────

describe("buildStartupUsageMessage", () => {
	it("includes help when requested", () => {
		const result = buildStartupUsageMessage(undefined, undefined, true);
		assert.match(result, /showWidget/);
	});

	it("omits help when not requested", () => {
		const result = buildStartupUsageMessage(undefined, undefined, false);
		assert.doesNotMatch(result, /showWidget/);
	});

	it("renders both services", () => {
		const codex: any = {
			planType: "plus",
			activeLimit: "normal",
			primaryUsedPercent: 30,
			secondaryUsedPercent: 40,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			source: "usage_api",
		};
		const go: OpenCodeGoUsage = {
			available: true,
			status: "available",
		};
		const result = buildStartupUsageMessage(codex, go, false);
		assert.match(result, /Usage Limits/);
		assert.match(result, /Codex/);
		assert.match(result, /OpenCode Go/);
	});

	it("shows not configured for missing services", () => {
		const result = buildStartupUsageMessage(undefined, undefined, false);
		assert.match(result, /Codex.*not configured/);
		assert.match(result, /OpenCode Go.*not configured/);
	});
});

// ───────── configPathCandidates ─────────

describe("configPathCandidates", () => {
	afterEach(() => {
		delete process.env.OPENCODE_GO_QUOTA_CONFIG;
		delete process.env.XDG_CONFIG_HOME;
	});

	it("includes explicit env var path", () => {
		process.env.OPENCODE_GO_QUOTA_CONFIG = "/custom/path/opencode-go.json";
		const result = configPathCandidates("opencode-go.json");
		assert.ok(result.includes("/custom/path/opencode-go.json"));
	});

	it("includes XDG_CONFIG_HOME path", () => {
		process.env.XDG_CONFIG_HOME = "/xdg/config";
		const result = configPathCandidates("opencode-go.json");
		assert.ok(result.includes("/xdg/config/opencode/opencode-go.json"));
	});

	it("includes ~/.config path", () => {
		const result = configPathCandidates("opencode-go.json");
		const home = process.env.HOME || "/home/user";
		assert.ok(result.some(p => p.includes("/.config/opencode/opencode-go.json")));
	});

	it("deduplicates paths", () => {
		process.env.OPENCODE_GO_QUOTA_CONFIG = "/some/dup.json";
		process.env.XDG_CONFIG_HOME = "/some";
		const result = configPathCandidates("dup.json");
		const dups = result.filter(p => p === "/some/dup.json");
		assert.equal(dups.length, 1);
	});

	it("returns non-empty list", () => {
		const result = configPathCandidates("test.json");
		assert.ok(result.length > 0);
	});
});

// ───────── getOpenCodeGoQuotaConfig ─────────

describe("getOpenCodeGoQuotaConfig", () => {
	afterEach(() => {
		delete process.env.OPENCODE_GO_WORKSPACE_ID;
		delete process.env.OPENCODE_GO_AUTH_COOKIE;
	});

	it("returns config from env vars", () => {
		process.env.OPENCODE_GO_WORKSPACE_ID = "ws-123";
		process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value";
		const result = getOpenCodeGoQuotaConfig();
		assert.equal(result.config?.workspaceId, "ws-123");
		assert.equal(result.config?.authCookie, "cookie-value");
		assert.equal(result.config?.source, "env");
	});

	it("returns error when only one env var set", () => {
		process.env.OPENCODE_GO_WORKSPACE_ID = "ws-123";
		const result = getOpenCodeGoQuotaConfig();
		assert.ok(result.error!.includes("both"));
	});

	it("returns empty state when no config found", () => {
		const result = getOpenCodeGoQuotaConfig();
		assert.equal(result.config, undefined);
		assert.equal(result.error, undefined);
	});
});

// ───────── validatePrivateConfigFile ─────────

describe("validatePrivateConfigFile", () => {
	it("throws ENOENT for non-existent file", () => {
		assert.throws(() => validatePrivateConfigFile("/nonexistent/path.json"), /ENOENT/);
	});

	it("returns undefined for valid file", () => {
		const tmpFile = `/tmp/pi-usage-test-${Date.now()}.json`;
		fs.writeFileSync(tmpFile, JSON.stringify({}), { mode: 0o600 });
		const result = validatePrivateConfigFile(tmpFile);
		assert.equal(result, undefined);
		fs.unlinkSync(tmpFile);
	});
});

// ───────── readJsonObject ─────────

describe("readJsonObject", () => {
	it("returns undefined for non-existent file", () => {
		assert.equal(readJsonObject("/nonexistent/file.json"), undefined);
	});

	it("returns undefined for invalid JSON", () => {
		const tmpFile = `/tmp/pi-usage-test-${Date.now()}.json`;
		fs.writeFileSync(tmpFile, "not json");
		assert.equal(readJsonObject(tmpFile), undefined);
		fs.unlinkSync(tmpFile);
	});

	it("returns undefined for array JSON", () => {
		const tmpFile = `/tmp/pi-usage-test-${Date.now()}.json`;
		fs.writeFileSync(tmpFile, JSON.stringify([1, 2, 3]));
		assert.equal(readJsonObject(tmpFile), undefined);
		fs.unlinkSync(tmpFile);
	});

	it("parses valid JSON object", () => {
		const tmpFile = `/tmp/pi-usage-test-${Date.now()}.json`;
		fs.writeFileSync(tmpFile, JSON.stringify({ key: "value" }));
		const result = readJsonObject(tmpFile);
		assert.deepEqual(result, { key: "value" });
		fs.unlinkSync(tmpFile);
	});
});

// ───────── widgetSettingFromConfig ─────────

describe("widgetSettingFromConfig", () => {
	it("returns undefined for undefined config", () => {
		assert.equal(widgetSettingFromConfig(undefined), undefined);
	});

	it("reads showWidget boolean", () => {
		assert.equal(widgetSettingFromConfig({ showWidget: true }), true);
		assert.equal(widgetSettingFromConfig({ showWidget: false }), false);
	});

	it("reads showWidget string", () => {
		assert.equal(widgetSettingFromConfig({ showWidget: "true" }), true);
		assert.equal(widgetSettingFromConfig({ showWidget: "false" }), false);
	});

	it("falls back to widget field", () => {
		assert.equal(widgetSettingFromConfig({ widget: true }), true);
	});

	it("prefers showWidget over widget", () => {
		assert.equal(widgetSettingFromConfig({ showWidget: true, widget: false }), true);
		assert.equal(widgetSettingFromConfig({ showWidget: false, widget: true }), false);
	});
});

// ───────── parseOpenCodeGoUsageWindow ─────────

describe("parseOpenCodeGoUsageWindow", () => {
	it("parses rolling usage from HTML", () => {
		const html = "<script>rollingUsage:\$R[42]={usagePercent:35.5,resetInSec:7200}</script>";
		const result = parseOpenCodeGoUsageWindow(html, "rolling");
		assert.ok(result !== undefined);
		assert.equal(result!.usedPercent, 35.5);
		assert.equal(result!.remainingPercent, 64.5);
	});

	it("parses weekly usage", () => {
		const html = "<script>weeklyUsage:\$R[0]={usagePercent:80,resetInSec:604800}</script>";
		const result = parseOpenCodeGoUsageWindow(html, "weekly");
		assert.ok(result !== undefined);
		assert.equal(result!.usedPercent, 80);
	});

	it("parses monthly usage", () => {
		const html = "<script>monthlyUsage:\$R[1]={usagePercent:50,resetInSec:2592000}</script>";
		const result = parseOpenCodeGoUsageWindow(html, "monthly");
		assert.ok(result !== undefined);
		assert.equal(result!.usedPercent, 50);
	});

	it("returns undefined for missing window", () => {
		const html = "<script>otherData: true</script>";
		assert.equal(parseOpenCodeGoUsageWindow(html, "rolling"), undefined);
	});

	it("returns undefined for missing usagePercent", () => {
		const html = "<script>rollingUsage:\$R[0]={resetInSec:3600}</script>";
		assert.equal(parseOpenCodeGoUsageWindow(html, "rolling"), undefined);
	});

	it("clamps usage percent", () => {
		const html = "<script>rollingUsage:\$R[0]={usagePercent:150,resetInSec:3600}</script>";
		const result = parseOpenCodeGoUsageWindow(html, "rolling");
		assert.ok(result !== undefined);
		assert.equal(result!.usedPercent, 100);
	});

	it("handles missing resetInSec with zero", () => {
		const html = "<script>rollingUsage:\$R[0]={usagePercent:30}</script>";
		const result = parseOpenCodeGoUsageWindow(html, "rolling");
		assert.ok(result !== undefined);
		assert.equal(result!.usedPercent, 30);
		assert.equal(result!.resetAfterSeconds, 0);
	});
});

// ───────── parseOpenCodeGoDashboardUsage ─────────

describe("parseOpenCodeGoDashboardUsage", () => {
	it("parses all three windows from full dashboard", () => {
		const html = [
			"<html><body><script>",
			"var data = {};",
			"rollingUsage:\$R[0]={usagePercent:20,resetInSec:3600}",
			"weeklyUsage:\$R[0]={usagePercent:50,resetInSec:604800}",
			"monthlyUsage:\$R[0]={usagePercent:75,resetInSec:2592000}",
			"</script></body></html>",
		].join("\n");
		const result = parseOpenCodeGoDashboardUsage(html);
		assert.equal((result as any).error, undefined);
		assert.equal(result.rollingUsedPercent, 20);
		assert.equal(result.weeklyUsedPercent, 50);
		assert.equal(result.monthlyUsedPercent, 75);
	});

	it("parses partial data (only weekly and monthly)", () => {
		const html = [
			"<script>",
			"weeklyUsage:\$R[0]={usagePercent:30,resetInSec:604800}",
			"monthlyUsage:\$R[0]={usagePercent:60,resetInSec:2592000}",
			"</script>",
		].join("\n");
		const result = parseOpenCodeGoDashboardUsage(html);
		assert.equal(result.rollingUsedPercent, undefined);
		assert.equal(result.weeklyUsedPercent, 30);
		assert.equal(result.monthlyUsedPercent, 60);
	});

	it("returns error for unrecognized structure", () => {
		const html = "<html><body>Not a dashboard page</body></html>";
		const result = parseOpenCodeGoDashboardUsage(html);
		assert.ok(result.error!.includes("not recognized"));
		assert.equal((result as any).rollingUsedPercent, undefined);
	});
});
