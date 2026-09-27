/**
 * Quota display mode tests for pi-usage.
 * Run with: npm test
 *
 * Covers pi-usage-acz: "used" mode renders exactly as before (consumed
 * share, "/ N% left" complements); "remaining" mode flips every percentage
 * to the still-available share with "left"/"used" wording, while status
 * colors still derive from actual consumption.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildStartupUsageMessage,
	buildUsageWidget,
	displayPercent,
	renderSubscriptionWindows,
	updateFooterStatus,
} from "./src/render.ts";
import { DEFAULT_DISPLAY_PREFS, type ProviderDisplayPrefs, type UsageSnapshot } from "./src/types.ts";
import type { UsageContext } from "./src/types.ts";
import { normalizeUsageConfigValue, usageConfigKeyKind, usageConfigOptions } from "./src/usage-config.ts";

const fmt = (_color: string, text: string) => text;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const usage = {
	provider: "clinepass",
	label: "ClinePass",
	shortLabel: "ClinePass",
	available: true,
	status: "available" as const,
	rolling: { usedPercent: 42, remainingPercent: 58 },
	weekly: { usedPercent: 90, remainingPercent: 10, resetAt: 1_800_001_200 },
	monthly: { usedPercent: 18, remainingPercent: 82 },
};

const snapshot: UsageSnapshot = { subscriptions: [usage] };

function prefs(overrides: Partial<ProviderDisplayPrefs>): ProviderDisplayPrefs {
	return { ...DEFAULT_DISPLAY_PREFS, ...overrides };
}

function footerText(display: ProviderDisplayPrefs): string {
	const statuses: Array<string | undefined> = [];
	const ctx = {
		hasUI: true,
		ui: { theme, setWidget: () => {}, setStatus: (_id: string, status: string | undefined) => { statuses.push(status); }, notify: () => {} },
	} as unknown as UsageContext;
	updateFooterStatus(ctx, snapshot, display);
	return statuses.join("\n");
}

describe("displayPercent", () => {
	it("passes consumption through in used mode", () => {
		assert.equal(displayPercent(42.4, 58, "used"), 42);
	});

	it("prefers authoritative remaining data, else derives 100 - used", () => {
		assert.equal(displayPercent(42, 58, "remaining"), 58);
		assert.equal(displayPercent(42, undefined, "remaining"), 58);
	});
});

describe("quotaDisplay in the full report", () => {
	it("renders used shares with left complements by default", () => {
		const lines = renderSubscriptionWindows(usage, fmt, false).join("\n");
		assert.match(lines, /42% used/);
		assert.match(lines, /\/ 58% left/);
		assert.match(lines, /90% used/);
	});

	it("flips to remaining shares with used complements in remaining mode", () => {
		const lines = renderSubscriptionWindows(usage, fmt, false, "remaining").join("\n");
		assert.match(lines, /58% left/);
		assert.match(lines, /\/ 42% used/);
		assert.match(lines, /10% left/);
		assert.doesNotMatch(lines, /42% used \//);
		assert.doesNotMatch(lines, /90% used \//);
	});

	it("keeps reset countdowns and expired markers in both modes", () => {
		const remaining = renderSubscriptionWindows(usage, fmt, false, "remaining").join("\n");
		assert.match(remaining, /resets in/);
	});
});

describe("quotaDisplay in compact and footer surfaces", () => {
	it("flips compact widget lines to remaining shares", () => {
		const widget = buildUsageWidget(snapshot, theme as never, false, prefs({ compactWidget: true, quotaDisplay: "remaining" })).join("\n");
		assert.match(widget, /rolling 58% left/);
		assert.match(widget, /month 82% left/);
	});

	it("keeps used shares in compact widget lines by default", () => {
		const widget = buildUsageWidget(snapshot, theme as never, false, prefs({ compactWidget: true })).join("\n");
		assert.match(widget, /rolling 42%/);
		assert.doesNotMatch(widget, /left/);
	});

	it("flips footer numbers while keeping window suffixes", () => {
		const usedFooter = footerText(prefs({}));
		assert.match(usedFooter, /42%r/);
		const remainingFooter = footerText(prefs({ quotaDisplay: "remaining" }));
		assert.match(remainingFooter, /58%r/);
		assert.match(remainingFooter, /82%m/);
	});

	it("flows through the startup report", () => {
		const report = buildStartupUsageMessage(snapshot, false, prefs({ quotaDisplay: "remaining" }));
		assert.match(report, /58% left/);
	});
});

describe("showStatusLine", () => {
	it("clears the footer status instead of writing it", () => {
		const calls: Array<{ key: string; status: string | undefined }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				theme,
				setWidget: () => {},
				setStatus: (key: string, status: string | undefined) => { calls.push({ key, status }); },
				notify: () => {},
			},
		} as unknown as UsageContext;
		updateFooterStatus(ctx, snapshot, prefs({ showStatusLine: false }));
		assert.deepEqual(calls, [{ key: "pi-usage", status: undefined }]);
	});

	it("writes the footer status by default", () => {
		assert.match(footerText(prefs({})), /ClinePass/);
	});
});

describe("quotaDisplay setting", () => {
	it("is an option key with used/remaining choices", () => {
		assert.equal(usageConfigKeyKind("quotadisplay"), "option");
		assert.deepEqual(usageConfigOptions("quotadisplay"), ["used", "remaining"]);
		assert.equal(usageConfigOptions("showwidget"), undefined);
	});

	it("validates case-insensitively and rejects anything else", () => {
		assert.deepEqual(normalizeUsageConfigValue("quotadisplay", "Remaining"), { value: "remaining" });
		assert.deepEqual(normalizeUsageConfigValue("quotadisplay", "USED"), { value: "used" });
		assert.ok("error" in normalizeUsageConfigValue("quotadisplay", "left"));
	});
});
