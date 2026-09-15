/**
 * Provider display preference tests for pi-usage.
 * Run with: npm test
 *
 * Covers pi-usage-61d (hide unconfigured/error-state providers),
 * pi-usage-isl (visible/hidden provider selection), and pi-usage-3tf
 * (provider ordering) across the footer status, inline report, and config.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DISPLAY_PREFS } from "./src/types.ts";
import type { ProviderDisplayPrefs, UsageSnapshot } from "./src/types.ts";
import { providerNameList, readProviderDisplayPrefs } from "./src/config.ts";
import {
	assembleWidgetBody,
	buildStartupUsageMessage,
	buildUsageWidget,
	canonicalProviderName,
	displayOrderIndex,
	PI_WIDGET_LINE_CAP,
	providerDisplays,
	sortByProviderOrder,
	updateFooterStatus,
} from "./src/render.ts";
import type { UsageContext } from "./src/types.ts";

function prefs(overrides: Partial<ProviderDisplayPrefs>): ProviderDisplayPrefs {
	return { ...DEFAULT_DISPLAY_PREFS, ...overrides };
}

const errorGo = {
	provider: "opencode-go",
	label: "OpenCode Go",
	shortLabel: "Go",
	available: false,
	status: "error" as const,
	errorMessage: "boom",
};

const clinepass = {
	provider: "clinepass",
	label: "ClinePass",
	shortLabel: "ClinePass",
	available: true,
	status: "available" as const,
	rolling: { usedPercent: 10, remainingPercent: 90 },
	weekly: { usedPercent: 20, remainingPercent: 80 },
	monthly: { usedPercent: 30, remainingPercent: 70 },
};

const snapshot: UsageSnapshot = { subscriptions: [errorGo, clinepass] };

function footerStatuses(snap: UsageSnapshot, display: ProviderDisplayPrefs): Array<string | undefined> {
	const statuses: Array<string | undefined> = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWidget: () => {},
			setStatus: (_id: string, status: string | undefined) => { statuses.push(status); },
			notify: () => {},
		},
	} as unknown as UsageContext;
	updateFooterStatus(ctx, snap, display);
	return statuses;
}

// ───────── Matching helpers ─────────

describe("canonicalProviderName", () => {
	it("resolves aliases, trims, and lowercases", () => {
		assert.equal(canonicalProviderName("codex"), "openai-codex");
		assert.equal(canonicalProviderName("Claude"), "anthropic");
		assert.equal(canonicalProviderName("COPILOT"), "github-copilot");
		assert.equal(canonicalProviderName(" Go "), "opencode-go");
		assert.equal(canonicalProviderName("zen"), "opencode");
		assert.equal(canonicalProviderName("kimi"), "kimi-coding");
		assert.equal(canonicalProviderName("clinepass"), "clinepass");
		assert.equal(canonicalProviderName("openrouter"), "openrouter");
		assert.equal(canonicalProviderName("some-future-provider"), "some-future-provider");
	});

	it("matches labels and short labels through providerDisplays", () => {
		const display = prefs({ hiddenProviders: ["zen"] });
		assert.equal(providerDisplays(display, ["opencode", "OpenCode Zen", "Zen"], "available"), false);
		assert.equal(providerDisplays(display, ["clinepass", "ClinePass", "ClinePass"], "available"), true);
	});
});

describe("providerNameList", () => {
	it("normalizes arrays and comma-separated strings", () => {
		assert.deepEqual(providerNameList([" Codex ", "codex", "", 42, "Claude"]), ["codex", "claude"]);
		assert.deepEqual(providerNameList("go, zen,go"), ["go", "zen"]);
		assert.deepEqual(providerNameList(undefined), []);
	});
});

// ───────── pi-usage-61d: hide unconfigured ─────────

describe("hideUnconfiguredProviders", () => {
	it("keeps default behavior without the flag", () => {
		assert.equal(providerDisplays(DEFAULT_DISPLAY_PREFS, ["opencode-go", "Go"], "error"), true);
		const report = buildStartupUsageMessage(snapshot, false);
		assert.match(report, /OpenCode Go/);
		assert.match(report, /ClinePass/);
	});

	it("hides error-state entries from report and footer", () => {
		const display = prefs({ hideUnconfiguredProviders: true });
		assert.equal(providerDisplays(display, ["opencode-go", "Go"], "error"), false);
		assert.equal(providerDisplays(display, ["opencode-go", "Go"], "no_key"), false);
		const report = buildStartupUsageMessage(snapshot, false, display);
		assert.doesNotMatch(report, /OpenCode Go/);
		assert.match(report, /ClinePass/);
		const statuses = footerStatuses(snapshot, display);
		assert.ok(statuses.some((status) => status?.includes("ClinePass")));
		assert.ok(statuses.every((status) => !status?.includes("Go:")));
	});

	it("keeps available and rate-limited providers with the flag on", () => {
		const display = prefs({ hideUnconfiguredProviders: true });
		assert.equal(providerDisplays(display, ["clinepass"], "available"), true);
		assert.equal(providerDisplays(display, ["clinepass"], "rate_limited"), true);
		assert.equal(providerDisplays(display, ["clinepass"], "credits_error"), true);
	});

	it("hides empty OpenRouter accounting with the flag on", () => {
		const display = prefs({ hideUnconfiguredProviders: true });
		const report = buildStartupUsageMessage({ subscriptions: [], openrouter: { error: "denied" } }, false, display);
		assert.doesNotMatch(report, /OpenRouter/);
		const kept = buildStartupUsageMessage(
			{ subscriptions: [], openrouter: { dailySpend: 1.5 } },
			false,
			display,
		);
		assert.match(kept, /OpenRouter/);
	});
});

// ───────── pi-usage-isl: visible/hidden selection ─────────

describe("visibleProviders and hiddenProviders", () => {
	it("restricts footer and report to the allowlist", () => {
		const display = prefs({ visibleProviders: ["clinepass"] });
		const report = buildStartupUsageMessage(snapshot, false, display);
		assert.match(report, /ClinePass/);
		assert.doesNotMatch(report, /OpenCode Go/);
		const statuses = footerStatuses(snapshot, display);
		assert.ok(statuses.some((status) => status?.includes("ClinePass")));
		assert.ok(statuses.every((status) => !status?.includes("Go:")));
	});

	it("removes denylisted providers from footer and report", () => {
		const display = prefs({ hiddenProviders: ["go"] });
		const report = buildStartupUsageMessage(snapshot, false, display);
		assert.doesNotMatch(report, /OpenCode Go/);
		assert.match(report, /ClinePass/);
	});

	it("applies the allowlist before the denylist and ignores unknown names", () => {
		const display = prefs({ visibleProviders: ["clinepass", "nope"], hiddenProviders: ["clinepass"] });
		const report = buildStartupUsageMessage(snapshot, false, display);
		assert.doesNotMatch(report, /ClinePass/);
		const statuses = footerStatuses(snapshot, display);
		assert.ok(statuses.every((status) => status === undefined || !status.includes("ClinePass")));
	});
});

// ───────── pi-usage-3tf: ordering ─────────

describe("providerOrder", () => {
	it("orders footer chunks with unlisted providers keeping relative order", () => {
		const items = [
			{ candidates: ["openai-codex"], value: "codex" },
			{ candidates: ["anthropic"], value: "claude" },
			{ candidates: ["clinepass"], value: "clinepass" },
		];
		assert.deepEqual(sortByProviderOrder(prefs({ providerOrder: ["clinepass", "codex"] }), items), ["clinepass", "codex", "claude"]);
		assert.equal(displayOrderIndex(prefs({ providerOrder: ["clinepass"] }), ["unknown-id"]), Number.MAX_SAFE_INTEGER);
	});

	it("reorders report sections and footer chunks end to end", () => {
		const display = prefs({ providerOrder: ["clinepass", "opencode-go"] });
		const report = buildStartupUsageMessage(
			{ subscriptions: [clinepass] },
			false,
			display,
		);
		assert.match(report, /ClinePass/);
		const statuses = footerStatuses(
			{ subscriptions: [errorGo, clinepass] },
			prefs({ providerOrder: ["clinepass", "go"] }),
		);
		const status = statuses.find((value) => value !== undefined) ?? "";
		assert.ok(status.indexOf("ClinePass") !== -1 && status.indexOf("Go:") !== -1);
		assert.ok(status.indexOf("ClinePass") < status.indexOf("Go:"));
	});
});

// ───────── pi-usage-1se: compact widget and overflow ─────────

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("compactWidget", () => {
	it("renders one labeled line per provider plus title", () => {
		const lines = buildUsageWidget(snapshot, theme, false, prefs({ compactWidget: true }));
		assert.equal(lines.length, 3);
		assert.match(lines[0], /Usage Limits/);
		assert.match(lines[1], /OpenCode Go/);
		assert.match(lines[2], /ClinePass: rolling 10%, week 20%\S*, month 30%/);
	});

	it("labels Codex windows and separates OpenRouter figures", () => {
		const lines = buildUsageWidget({
			subscriptions: [],
			codex: {
				planType: "plus",
				activeLimit: "normal",
				rateLimited: false,
				primaryUsedPercent: 0,
				primaryWindowMinutes: 300,
				secondaryUsedPercent: 0,
				secondaryWindowMinutes: 10080,
			} as UsageSnapshot["codex"],
			openrouter: { dailySpend: 0, creditRemaining: 0 },
		}, theme, false, prefs({ compactWidget: true }));
		assert.match(lines[1], /Codex.*: 5hr 0%, week 0%/);
		assert.match(lines[2], /OpenRouter: \$0\.00\/d, \$0\.00 left/);
	});

	it("respects filtering and ordering in compact mode", () => {
		const lines = buildUsageWidget(
			snapshot,
			theme,
			false,
			prefs({ compactWidget: true, hiddenProviders: ["go"], providerOrder: ["clinepass"] }),
		);
		assert.equal(lines.length, 2);
		assert.match(lines[1], /ClinePass/);
	});

	it("folds many compact providers into an overflow summary within the cap", () => {
		const subscriptions = Array.from({ length: 12 }, (_, index) => ({
			provider: `prov-${index}`,
			label: `Prov ${index}`,
			shortLabel: `P${index}`,
			available: true,
			status: "available" as const,
			rolling: { usedPercent: index + 1, remainingPercent: 99 - index },
		}));
		const lines = buildUsageWidget({ subscriptions }, theme, false, prefs({ compactWidget: true }));
		assert.ok(lines.length <= PI_WIDGET_LINE_CAP);
		const overflow = lines.at(-1) ?? "";
		assert.match(overflow, /\+\d+ more:/);
		assert.match(overflow, /Prov 11/);
	});
});

describe("assembleWidgetBody", () => {
	const plain = (_color: string, text: string) => text;

	it("passes short bodies through unchanged", () => {
		assert.deepEqual(
			assembleWidgetBody("title", [["a", "b"], ["c"]], ["sa", "sc"], 10, plain),
			["title", "a", "b", "c"],
		);
	});

	it("keeps fitting blocks and folds the rest into one trailing line", () => {
		const blocks = [["a1", "a2", "a3"], ["b1", "b2", "b3"], ["c1"]];
		const lines = assembleWidgetBody("title", blocks, ["sa", "sb", "sc"], 6, plain);
		// The b-block is cut but the later one-line c-block still fits the leftover room.
		assert.deepEqual(lines, ["title", "a1", "a2", "a3", "c1", "… +1 more: sb"]);
		assert.ok(lines.length <= 6);
	});

	it("summarizes everything when even the first block overflows", () => {
		const lines = assembleWidgetBody("title", [["a1", "a2", "a3", "a4", "a5"]], ["sa"], 3, plain);
		assert.deepEqual(lines, ["title", "… +1 more: sa"]);
	});
});

describe("full-mode widget overflow", () => {
	it("stays within the pi cap and names the cut providers", () => {
		const codex = {
			planType: "plus",
			activeLimit: "normal",
			rateLimited: false,
			primaryUsedPercent: 10,
			secondaryUsedPercent: 20,
		};
		const anthropic = {
			authType: "oauth",
			status: "available" as const,
			fiveHour: { utilizationPercent: 30 },
			weekly: { utilizationPercent: 5 },
		};
		const wide: UsageSnapshot = {
			codex: codex as UsageSnapshot["codex"],
			anthropic: anthropic as UsageSnapshot["anthropic"],
			subscriptions: [errorGo, clinepass],
		};
		const lines = buildUsageWidget(wide, theme, false, prefs({}));
		assert.ok(lines.length <= PI_WIDGET_LINE_CAP);
		assert.match(lines.at(-1) ?? "", /\+\d+ more:/);
	});

	it("leaves under-cap widgets byte-identical to before", () => {
		const lines = buildUsageWidget({ subscriptions: [clinepass] }, theme, false, prefs({}));
		assert.ok(lines.length <= PI_WIDGET_LINE_CAP);
		assert.ok(!lines.some((line) => line.includes("more:")));
		assert.match(lines.join("\n"), /rolling/);
	});
});

// ───────── Config file reading ─────────

describe("readProviderDisplayPrefs", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	let tempDir = "";
	afterEach(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	function useConfigFile(config: Record<string, unknown>): void {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-display-"));
		fs.writeFileSync(path.join(tempDir, "pi-usage.json"), JSON.stringify(config));
		process.env.PI_CODING_AGENT_DIR = tempDir;
	}

	it("returns defaults when no config exists", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-display-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		assert.deepEqual(readProviderDisplayPrefs(), DEFAULT_DISPLAY_PREFS);
	});

	it("reads global display keys", () => {
		useConfigFile({
			hiddenProviders: ["Go"],
			visibleProviders: "clinepass, codex",
			providerOrder: ["clinepass"],
			hideUnconfiguredProviders: true,
			compactWidget: true,
		});
		assert.deepEqual(readProviderDisplayPrefs(), {
			hiddenProviders: ["go"],
			visibleProviders: ["clinepass", "codex"],
			providerOrder: ["clinepass"],
			hideUnconfiguredProviders: true,
			compactWidget: true,
			quotaDisplay: "used",
			showStatusLine: true,
		});
	});

	it("reads quotaDisplay and ignores invalid values", () => {
		useConfigFile({ quotaDisplay: "Remaining" });
		assert.equal(readProviderDisplayPrefs().quotaDisplay, "remaining");
		useConfigFile({ quotaDisplay: "bogus" });
		assert.equal(readProviderDisplayPrefs().quotaDisplay, "used");
	});

	it("lets a trusted project config override per key", () => {
		useConfigFile({ hiddenProviders: ["go"], providerOrder: ["codex"] });
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-project-"));
		try {
			fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, ".pi", "pi-usage.json"),
				JSON.stringify({ hiddenProviders: ["zen"] }),
			);
			const ctx = { cwd: projectDir, isProjectTrusted: () => true } as unknown as UsageContext;
			const result = readProviderDisplayPrefs(ctx);
			assert.deepEqual(result.hiddenProviders, ["zen"]);
			assert.deepEqual(result.providerOrder, ["codex"]);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
