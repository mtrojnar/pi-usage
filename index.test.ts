/**
 * Unit tests for pi-usage core parsing and formatting helpers.
 * Run with: node --test index.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampPercent,
	dedupe,
	footerResetDuration,
	footerUsageColor,
	formatDuration,
	formatResetTime,
	isGlobalGoLimit,
	isPerModelUnavailable,
	parseBoolValue,
	parseEnvInt,
	parseHeaderBool,
	parseHeaderNumber,
	progressBar,
	resolveConfigValue,
	resolveModelEndpoint,
	truncate,
	usageColor,
	windowMinutes,
	windowResetAfterSeconds,
	windowResetAt,
	windowUsedPercent,
} from "./index.ts";

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
		const future = Math.round(Date.now() / 1000) + 3600;
		const result = footerResetDuration(future, undefined);
		assert.match(result ?? "", /^[0-9.]+h$/);
	});

	it("returns formatted duration from resetAfterSeconds", () => {
		assert.equal(footerResetDuration(undefined, 60), "1m");
		assert.equal(footerResetDuration(undefined, 3600), "1h");
	});

	it("returns undefined with no args", () => {
		assert.equal(footerResetDuration(undefined, undefined), undefined);
	});

	it("prefers resetAt over resetAfterSeconds", () => {
		const future = Math.round(Date.now() / 1000) + 7200;
		const result = footerResetDuration(future, 60);
		assert.match(result ?? "", /^[0-9.]+h$/);
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
	it("returns true for status 400", () => {
		assert.equal(isPerModelUnavailable(400, "bad request"), true);
	});

	it("returns true for status 404", () => {
		assert.equal(isPerModelUnavailable(404, "not found"), true);
	});

	it("returns true for status 422", () => {
		assert.equal(isPerModelUnavailable(422, "unprocessable"), true);
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
		const future = Math.round(Date.now() / 1000) + 3600;
		const result = formatResetTime(future);
		assert.match(result, /^[0-9.]+h$/);
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
