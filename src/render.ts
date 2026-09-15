import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	AnthropicUsage,
	CodexUsage,
	CopilotUsage,
	GoModelStatus,
	OpenCodeGoUsage,
	OpenRouterUsage,
	ProviderDisplayPrefs,
	QuotaDisplay,
	SubscriptionUsage,
	UsageContext,
	UsageSnapshot,
} from "./types.ts";
import { DEFAULT_DISPLAY_PREFS } from "./types.ts";
import { USAGE_WIDGET_HELP } from "./config.ts";
import { canonicalProviderName } from "./usage-config.ts";

export { canonicalProviderName };
import {
	clampPercent,
	formatDuration,
	formatResetTime,
	progressBar,
	quotaWindowIsExpired,
	statusIcon,
	truncate,
	usageColor,
} from "./format.ts";

type Fmt = (color: ThemeColor, text: string) => string;

const DIVIDER = "─".repeat(40);

// ───────── Status Labels ─────────

const STATUS_COLOR: Record<GoModelStatus, ThemeColor> = {
	available: "success",
	rate_limited: "warning",
	credits_error: "error",
	error: "warning",
	no_key: "dim",
};

const GO_STATUS_TEXT: Record<GoModelStatus, string> = {
	available: "available",
	rate_limited: "rate limited",
	credits_error: "credits exhausted",
	error: "error",
	no_key: "no key",
};

const ANTHROPIC_STATUS_TEXT: Record<GoModelStatus, string> = {
	...GO_STATUS_TEXT,
	no_key: "no auth",
};

const COPILOT_STATUS_TEXT: Record<GoModelStatus, string> = {
	...GO_STATUS_TEXT,
	credits_error: "quota exhausted",
	no_key: "no auth",
};

// ───────── Shared Line Builders ─────────

export function resetDuration(resetAt?: number, resetAfterSeconds?: number): string | undefined {
	if (resetAt !== undefined && resetAt > 0) return formatResetTime(resetAt);
	if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) return formatDuration(resetAfterSeconds);
	return undefined;
}

/** Consistent " resets in <duration>" / " resets now" suffix from a reset timestamp or countdown. */
function resetPhrase(resetAt?: number, resetAfterSeconds?: number): string {
	const duration = resetDuration(resetAt, resetAfterSeconds);
	if (!duration) return "";
	return duration === "now" ? " resets now" : ` resets in ${duration}`;
}

interface UsageWindowLine {
	label: string;
	usedPercent?: number;
	remainingPercent?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
}

/**
 * Displayed percentage for a window: consumed share in "used" mode,
 * still-available share in "remaining" mode (authoritative remaining data
 * wins, otherwise derived as 100 - used).
 */
export function displayPercent(usedPercent: number, remainingPercent: number | undefined, mode: QuotaDisplay): number {
	if (mode === "remaining") {
		return Math.round(clampPercent(remainingPercent ?? 100 - usedPercent));
	}
	return Math.round(clampPercent(usedPercent));
}

/** One "  label ████░░ 42%[ used][ / 58% left][ resets in 2h]" line per window with data. */
function windowLines(
	windows: UsageWindowLine[],
	pad: number,
	fmt: Fmt,
	useColor: boolean,
	percentSuffix = "",
	mode: QuotaDisplay = "used",
): string[] {
	const lines: string[] = [];
	for (const window of windows) {
		if (window.usedPercent === undefined) continue;
		const expired = quotaWindowIsExpired(window);
		const used = Math.round(clampPercent(window.usedPercent));
		const remaining = displayPercent(window.usedPercent, window.remainingPercent, "remaining");
		const percent = expired
			? `--${percentSuffix}`
			: mode === "remaining"
				? `${remaining}% left`
				: `${window.usedPercent.toFixed(0)}%${percentSuffix}`;
		const complement = expired
			? ""
			: mode === "remaining"
				? ` / ${used}% used`
				: window.remainingPercent !== undefined ? ` / ${window.remainingPercent.toFixed(0)}% left` : "";
		const reset = expired ? " stale" : resetPhrase(window.resetAt, window.resetAfterSeconds);
		const bar = progressBar(expired ? 0 : mode === "remaining" ? remaining : window.usedPercent);
		if (useColor) {
			const color = expired ? "dim" : usageColor(window.usedPercent);
			lines.push(`  ${window.label.padEnd(pad)} ${fmt(color, bar)} ${fmt(color, percent)}${fmt("dim", complement + reset)}`);
		} else {
			lines.push(`  ${window.label.padEnd(pad)} ${bar} ${percent}${complement}${reset}`);
		}
	}
	return lines;
}

/** Section divider plus a "title subtitle" heading line. */
function sectionLines(fmt: Fmt, title: string, titleColor: ThemeColor, subtitle: string): string[] {
	return [fmt("dim", DIVIDER), `${fmt(titleColor, title)} ${fmt("dim", subtitle)}`];
}

interface ProbeDetails {
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	availableModels?: number;
	retryAfterSeconds?: number;
	retryResetAt?: number;
	errorMessage?: string;
	error?: string;
}

/** Trailing detail lines shared by the probe-based providers. */
function detailLines(usage: ProbeDetails, modelNoun: string, hasWindowData: boolean, fmt: Fmt): string[] {
	const lines: string[] = [];
	const limited = usage.status === "rate_limited" || usage.status === "credits_error";
	const retryDuration = resetDuration(usage.retryResetAt, usage.retryAfterSeconds);
	if (limited && retryDuration && !hasWindowData) {
		lines.push(`  ${fmt("warning", `retry: ${retryDuration}`)}`);
	}
	if (usage.workingModel) lines.push(`  ${fmt("dim", `working: ${usage.workingModel}`)}`);
	if (usage.checkedModels && usage.totalModels) {
		lines.push(`  ${fmt("dim", `checked: ${usage.checkedModels}/${usage.totalModels} ${modelNoun} models`)}`);
	}
	if (usage.availableModels) lines.push(`  ${fmt("dim", `available: ${usage.availableModels} account models`)}`);
	if (usage.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${usage.rateLimitedModel}`)}`);
	const error = usage.errorMessage || usage.error;
	if (error) lines.push(`  ${fmt("dim", truncate(error, 80))}`);
	return lines;
}

// ───────── Rendering: Codex Windows ─────────

/** Label Codex windows by duration because weekly-only plans can put the week in the primary slot. */
export function codexWindowLabel(windowMinutes: number, fallback: "5hr" | "week"): string {
	if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return fallback;
	if (windowMinutes === 5 * 60) return "5hr";
	if (windowMinutes === 7 * 24 * 60) return "week";
	if (windowMinutes >= 24 * 60 && windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)}d`;
	if (windowMinutes >= 60) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

/** Plan/limit/rate-limit suffix bits shared by the full and compact Codex renderers. */
function codexTitleBits(codex: CodexUsage): { plan: string; limit: string; limited: string } {
	return {
		plan: codex.planType !== "unknown" ? ` (${codex.planType})` : "",
		limit: codex.activeLimit !== "unknown" && codex.activeLimit !== "normal"
			? ` [${codex.activeLimit}]`
			: "",
		limited: codex.rateLimited ? " [rate_limited]" : "",
	};
}

export function renderCodexWindows(codex: CodexUsage, fmt: Fmt, useColor: boolean, mode: QuotaDisplay = "used"): string[] {
	if (codex.error && !codex.rateLimited) {
		return sectionLines(fmt, "✗ Codex", "error", `— ${truncate(codex.error, 120)}`);
	}

	const bits = codexTitleBits(codex);
	const planLabel = bits.plan;
	const limitLabel = bits.limit;
	const rateLimitLabel = bits.limited;
	const primaryLabel = codexWindowLabel(codex.primaryWindowMinutes, "5hr");
	const secondaryLabel = codexWindowLabel(codex.secondaryWindowMinutes, "week");
	const windows: UsageWindowLine[] = [
		{ label: primaryLabel, usedPercent: codex.primaryUsedPercent, resetAt: codex.primaryResetAt, resetAfterSeconds: codex.primaryResetAfterSeconds },
		{ label: secondaryLabel, usedPercent: codex.secondaryUsedPercent, resetAt: codex.secondaryResetAt, resetAfterSeconds: codex.secondaryResetAfterSeconds },
		{ label: "review", usedPercent: codex.codeReviewUsedPercent, resetAt: codex.codeReviewResetAt, resetAfterSeconds: codex.codeReviewResetAfterSeconds },
	];

	const lines = [
		fmt("dim", DIVIDER),
		`${fmt("accent", "Codex")}${fmt("dim", planLabel + limitLabel + rateLimitLabel)}`,
		...windowLines(windows, 6, fmt, useColor, "", mode),
	];

	const retryDuration = resetDuration(codex.primaryResetAt, codex.primaryResetAfterSeconds);
	if (codex.rateLimited && codex.primaryUsedPercent === undefined && retryDuration) {
		lines.push(`  ${fmt("warning", `retry: ${retryDuration}`)}`);
	}
	if (codex.creditsHasCredits && codex.creditsBalance) {
		lines.push(`  ${fmt("dim", `credits: ${codex.creditsBalance}`)}`);
	}
	if (codex.primaryOverSecondaryLimitPercent > 0) {
		lines.push(`  ${fmt("warning", `⚠ ${primaryLabel} exceeds ${secondaryLabel} allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
	}

	return lines;
}

// ───────── Rendering: Anthropic Windows ─────────

export function renderAnthropicWindows(anthropic: AnthropicUsage, fmt: Fmt, useColor: boolean, mode: QuotaDisplay = "used"): string[] {
	const authLabel = anthropic.authType === "oauth"
		? "Claude Pro/Max"
		: anthropic.authType === "api_key"
			? "API"
			: "Claude";

	return [
		...sectionLines(
			fmt,
			`${statusIcon(anthropic.status)} Anthropic`,
			STATUS_COLOR[anthropic.status],
			`(${authLabel}) — ${ANTHROPIC_STATUS_TEXT[anthropic.status]}`,
		),
		...windowLines([
			{ label: "5hr", usedPercent: anthropic.fiveHour?.utilizationPercent, resetAt: anthropic.fiveHour?.resetAt, resetAfterSeconds: anthropic.fiveHour?.resetAfterSeconds },
			{ label: "week", usedPercent: anthropic.weekly?.utilizationPercent, resetAt: anthropic.weekly?.resetAt, resetAfterSeconds: anthropic.weekly?.resetAfterSeconds },
		], 6, fmt, useColor, "", mode),
		...detailLines(anthropic, "Anthropic", Boolean(anthropic.fiveHour || anthropic.weekly), fmt),
	];
}

// ───────── Rendering: GitHub Copilot Windows ─────────

export function renderCopilotWindows(copilot: CopilotUsage, fmt: Fmt, useColor: boolean, mode: QuotaDisplay = "used"): string[] {
	const windows: UsageWindowLine[] = [
		{ label: "premium", ...copilot.premiumRequests },
		{ label: "requests", ...copilot.requests },
	];

	return [
		...sectionLines(
			fmt,
			`${statusIcon(copilot.status)} GitHub Copilot`,
			STATUS_COLOR[copilot.status],
			`— ${COPILOT_STATUS_TEXT[copilot.status]}`,
		),
		...windowLines(windows, 8, fmt, useColor, " used", mode),
		...detailLines(copilot, "Copilot", windows.some((window) => window.usedPercent !== undefined), fmt),
	];
}

// ───────── Rendering: Generic Subscription Providers ─────────

export function renderSubscriptionWindows(subscription: SubscriptionUsage, fmt: Fmt, useColor: boolean, mode: QuotaDisplay = "used"): string[] {
	const windows: UsageWindowLine[] = [
		{ label: "rolling", ...subscription.rolling },
		{ label: "week", ...subscription.weekly },
		{ label: "month", ...subscription.monthly },
	];

	return [
		...sectionLines(
			fmt,
			`${statusIcon(subscription.status)} ${subscription.label}`,
			STATUS_COLOR[subscription.status],
			`— ${GO_STATUS_TEXT[subscription.status]}`,
		),
		...windowLines(windows, 7, fmt, useColor, " used", mode),
		...detailLines(subscription, subscription.shortLabel, windows.some((window) => window.usedPercent !== undefined), fmt),
	];
}

// ───────── Rendering: Go Windows ─────────

export function renderGoWindows(go: OpenCodeGoUsage, fmt: Fmt, useColor: boolean, mode: QuotaDisplay = "used"): string[] {
	const lines = renderSubscriptionWindows(go, fmt, useColor, mode);
	if (go.quotaError) lines.push(`  ${fmt("dim", `quota: ${truncate(go.quotaError, 80)}`)}`);
	return lines;
}

// ───────── OpenRouter Accounting ─────────

export function formatMoney(value: number): string {
	if (value !== 0 && Math.abs(value) < 0.01) return value < 0 ? "-<$0.01" : "<$0.01";
	return value < 0 ? `-$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`;
}

function budgetPercent(budget: NonNullable<OpenRouterUsage["budget"]>): number | undefined {
	if (budget.used === undefined) return undefined;
	return budget.limit === 0 ? 100 : clampPercent(budget.used / budget.limit * 100);
}

function budgetText(budget: NonNullable<OpenRouterUsage["budget"]>): string {
	const used = quotaWindowIsExpired(budget) || budget.used === undefined ? "--" : formatMoney(budget.used);
	return `${used}/${formatMoney(budget.limit).replace(/\.00$/, "")}`;
}

export function renderOpenRouter(usage: OpenRouterUsage, fmt: Fmt): string[] {
	const lines = sectionLines(fmt, "OpenRouter", "accent", "");
	if (usage.dailySpend !== undefined) {
		const daily = quotaWindowIsExpired({ resetAt: usage.dailyResetAt }) ? "--" : formatMoney(usage.dailySpend);
		lines.push(`  ${fmt("dim", `today: ${daily}`)}`);
	}
	if (usage.budget) {
		const budget = usage.budget;
		const expired = quotaWindowIsExpired(budget);
		const percent = budgetPercent(budget);
		const bar = percent !== undefined && !expired ? `${progressBar(percent)} ` : "";
		const reset = expired ? " stale" : resetPhrase(budget.resetAt);
		lines.push(`  key: ${fmt(expired || percent === undefined ? "dim" : usageColor(percent), bar + budgetText(budget))}${fmt("dim", reset)}`);
	}
	if (usage.creditRemaining !== undefined) lines.push(`  ${fmt(usage.creditRemaining <= 0 ? "error" : "dim", `credit: ${formatMoney(usage.creditRemaining)} left`)}`);
	if (usage.error) lines.push(`  ${fmt("warning", truncate(usage.error, 120))}`);
	return lines;
}

export function openRouterFooter(usage: OpenRouterUsage, fmt: Fmt, separator = ","): string {
	const parts: string[] = [];
	if (usage.dailySpend !== undefined) {
		parts.push(fmt("dim", `${quotaWindowIsExpired({ resetAt: usage.dailyResetAt }) ? "--" : formatMoney(usage.dailySpend)}/d`));
	}
	if (usage.budget) {
		const expired = quotaWindowIsExpired(usage.budget);
		const percent = budgetPercent(usage.budget);
		const reset = expired ? undefined : resetDuration(usage.budget.resetAt);
		parts.push(fmt(expired || percent === undefined ? "dim" : footerUsageColor(percent), budgetText(usage.budget) + (reset ? `/${reset}` : "")));
	}
	if (usage.creditRemaining !== undefined) parts.push(fmt(usage.creditRemaining <= 0 ? "error" : "dim", `${formatMoney(usage.creditRemaining)} left`));
	if (usage.error) parts.push(fmt("warning", "error"));
	return parts.join(fmt("dim", separator));
}

// ───────── Provider Display Filtering and Ordering ─────────

function displayMatches(patterns: string[], candidates: string[]): boolean {
	const canonical = candidates.map(canonicalProviderName);
	return patterns.some((pattern) => canonical.includes(canonicalProviderName(pattern)));
}

/** Index of the first matching providerOrder entry, or Infinity when unordered. */
export function displayOrderIndex(prefs: ProviderDisplayPrefs, candidates: string[]): number {
	const canonical = candidates.map(canonicalProviderName);
	for (let index = 0; index < prefs.providerOrder.length; index += 1) {
		if (canonical.includes(canonicalProviderName(prefs.providerOrder[index]))) return index;
	}
	return Number.MAX_SAFE_INTEGER;
}

/**
 * Whether a provider section/chunk displays under the given preferences.
 * Candidates are the provider ID, label, and short label (aliases accepted).
 */
export function providerDisplays(
	prefs: ProviderDisplayPrefs,
	candidates: string[],
	status: GoModelStatus | "unconfigured",
): boolean {
	if (prefs.hideUnconfiguredProviders && (status === "no_key" || status === "error" || status === "unconfigured")) return false;
	if (prefs.visibleProviders.length > 0 && !displayMatches(prefs.visibleProviders, candidates)) return false;
	if (displayMatches(prefs.hiddenProviders, candidates)) return false;
	return true;
}

/** Stable sort of display items: ordered providers first, the rest keep their relative order. */
export function sortByProviderOrder<T>(prefs: ProviderDisplayPrefs, items: Array<{ candidates: string[]; value: T }>): T[] {
	return items
		.map((item, position) => ({ item, position, order: displayOrderIndex(prefs, item.candidates) }))
		.sort((a, b) => a.order - b.order || a.position - b.position)
		.map((entry) => entry.item.value);
}

function subscriptionCandidates(subscription: { provider: string; label: string; shortLabel: string }): string[] {
	return [subscription.provider, subscription.label, subscription.shortLabel];
}

/** OpenRouter accounting with no figures at all (only an error or nothing). */
function openRouterIsEmpty(usage: OpenRouterUsage): boolean {
	return usage.dailySpend === undefined && usage.budget === undefined && usage.creditRemaining === undefined;
}

// ───────── Roomy Compact Summaries ─────────

interface RoomyWindow extends FooterWindow {
	/** Displayed window name, e.g. "rolling", "week", "5hr", "premium". */
	label: string;
	/** Optional qualifier after the percent, e.g. " used" for Copilot quotas. */
	percentSuffix?: string;
}

/**
 * One-line window summaries with named windows for the compact widget:
 * `rolling 12%/3h, week 4%/2d`. Unlike the footer terse format, windows are
 * labeled and separated with spaces because widget lines are not
 * width-constrained.
 */
function roomySummary(faux: Pick<Theme, "fg">, windows: RoomyWindow[], mode: QuotaDisplay = "used"): string[] {
	const fmt = faux.fg;
	return windows
		.filter((window): window is RoomyWindow & { usedPercent: number } => window.usedPercent !== undefined)
		.map((window) => {
			if (quotaWindowIsExpired(window)) return fmt("dim", `${window.label} --`);
			const reset = resetDuration(window.resetAt, window.resetAfterSeconds);
			const shown = mode === "remaining"
				? `${displayPercent(window.usedPercent, window.remainingPercent, mode)}% left`
				: `${Math.round(clampPercent(window.usedPercent))}%${window.percentSuffix ?? ""}`;
			return fmt(footerUsageColor(window.usedPercent), reset ? `${window.label} ${shown}/${reset}` : `${window.label} ${shown}`);
		});
}

/** Roomy equivalent of footerSummary: labeled windows, or a retry hint / status icon fallback. */
function roomyLine(
	faux: Pick<Theme, "fg">,
	status: GoModelStatus,
	windows: RoomyWindow[],
	retryAfterSeconds?: number,
	retryResetAt?: number,
	mode: QuotaDisplay = "used",
): string {
	const parts = roomySummary(faux, windows, mode);
	if (parts.length > 0) return parts.join(faux.fg("dim", ", "));
	const retryDuration = resetDuration(retryResetAt, retryAfterSeconds);
	if ((status === "rate_limited" || status === "credits_error") && retryDuration) {
		return faux.fg("warning", `retry in ${retryDuration}`);
	}
	return faux.fg("dim", statusIcon(status));
}

// ───────── Provider Views (full detail + one-line compact per provider) ─────────

interface ProviderView {
	candidates: string[];
	status: GoModelStatus | "unconfigured";
	hasData: boolean;
	full: string[];
	compact: string;
}

/** One view per snapshot provider, unfiltered and in default order. */
function providerViews(snapshot: UsageSnapshot, fmt: Fmt, useColor: boolean, display: ProviderDisplayPrefs = DEFAULT_DISPLAY_PREFS): ProviderView[] {
	const faux = { fg: fmt };
	const mode = display.quotaDisplay;
	const views: ProviderView[] = [];
	const { codex, anthropic, copilot, go, subscriptions, openrouter } = snapshot;

	if (codex) {
		const hasError = Boolean(codex.error) && !codex.rateLimited;
		const status = codex.rateLimited ? "rate_limited" : hasError ? "error" : "available";
		let compact: string;
		if (hasError) {
			compact = `${fmt("error", "✗ Codex")}${fmt("dim", ` — ${truncate(codex.error ?? "error", 60)}`)}`;
		} else {
			const bits = codexTitleBits(codex);
			const summary = roomyLine(faux, codex.rateLimited ? "rate_limited" : "available", [
				{ label: codexWindowLabel(codex.primaryWindowMinutes, "5hr"), usedPercent: codex.primaryUsedPercent, resetAt: codex.primaryResetAt, resetAfterSeconds: codex.primaryResetAfterSeconds },
				{ label: codexWindowLabel(codex.secondaryWindowMinutes, "week"), usedPercent: codex.secondaryUsedPercent, resetAt: codex.secondaryResetAt, resetAfterSeconds: codex.secondaryResetAfterSeconds },
			], codex.primaryResetAfterSeconds, codex.primaryResetAt, mode);
			compact = `${fmt("accent", "Codex")}${fmt("dim", bits.plan + bits.limit + bits.limited)}: ${summary}`;
		}
		views.push({
			candidates: ["openai-codex", "Codex"],
			status,
			hasData: true,
			full: renderCodexWindows(codex, fmt, useColor, mode),
			compact,
		});
	}
	if (anthropic) {
		views.push({
			candidates: ["anthropic", "Anthropic", "Claude"],
			status: anthropic.status,
			hasData: usageHasData(anthropic),
			full: renderAnthropicWindows(anthropic, fmt, useColor, mode),
			compact: `${fmt(STATUS_COLOR[anthropic.status], `${statusIcon(anthropic.status)} Anthropic`)}: ${roomyLine(faux, anthropic.status, [
				{ label: "5hr", usedPercent: anthropic.fiveHour?.utilizationPercent, resetAt: anthropic.fiveHour?.resetAt, resetAfterSeconds: anthropic.fiveHour?.resetAfterSeconds },
				{ label: "week", usedPercent: anthropic.weekly?.utilizationPercent, resetAt: anthropic.weekly?.resetAt, resetAfterSeconds: anthropic.weekly?.resetAfterSeconds },
			], anthropic.retryAfterSeconds, anthropic.retryResetAt, mode)}`,
		});
	}
	if (copilot) {
		views.push({
			candidates: ["github-copilot", "GitHub Copilot", "Copilot"],
			status: copilot.status,
			hasData: usageHasData(copilot),
			full: renderCopilotWindows(copilot, fmt, useColor, mode),
			compact: `${fmt(STATUS_COLOR[copilot.status], `${statusIcon(copilot.status)} Copilot`)}: ${roomyLine(faux, copilot.status, [
				{ label: "premium", percentSuffix: " used", ...copilot.premiumRequests },
				{ label: "requests", percentSuffix: " used", ...copilot.requests },
			], copilot.retryAfterSeconds, copilot.retryResetAt, mode)}`,
		});
	}
	if (go) {
		views.push({
			candidates: ["opencode-go", "OpenCode Go", "Go"],
			status: go.status,
			hasData: usageHasData(go),
			full: renderGoWindows(go, fmt, useColor, mode),
			compact: `${fmt(STATUS_COLOR[go.status], `${statusIcon(go.status)} ${go.label}`)}: ${roomyLine(faux, go.status, [
				{ label: "rolling", ...go.rolling },
				{ label: "week", ...go.weekly },
				{ label: "month", ...go.monthly },
			], go.retryAfterSeconds, go.retryResetAt, mode)}`,
		});
	}
	if (openrouter) {
		const empty = openRouterIsEmpty(openrouter);
		views.push({
			candidates: ["openrouter", "OpenRouter"],
			status: !empty ? "available" : openrouter.error ? "error" : "unconfigured",
			hasData: true,
			full: renderOpenRouter(openrouter, fmt),
			compact: `${fmt("accent", "OpenRouter")}: ${openRouterFooter(openrouter, fmt, ", ")}`,
		});
	}
	for (const subscription of subscriptions) {
		views.push({
			candidates: subscriptionCandidates(subscription),
			status: subscription.status,
			hasData: usageHasData(subscription),
			full: renderSubscriptionWindows(subscription, fmt, useColor, mode),
			compact: `${fmt(STATUS_COLOR[subscription.status], `${statusIcon(subscription.status)} ${subscription.label}`)}: ${roomyLine(faux, subscription.status, [
				{ label: "rolling", ...subscription.rolling },
				{ label: "week", ...subscription.weekly },
				{ label: "month", ...subscription.monthly },
			], subscription.retryAfterSeconds, subscription.retryResetAt, mode)}`,
		});
	}
	return views;
}

/** Filtered and ordered views for the requested surface. */
function visibleViews(snapshot: UsageSnapshot, fmt: Fmt, useColor: boolean, display: ProviderDisplayPrefs): ProviderView[] {
	const views = providerViews(snapshot, fmt, useColor, display)
		.filter((view) => view.hasData && providerDisplays(display, view.candidates, view.status));
	return sortByProviderOrder(display, views.map((view) => ({ candidates: view.candidates, value: view })));
}

// ───────── Report Builder ─────────

interface UsageReportOptions {
	fmt: Fmt;
	bold: (text: string) => string;
	useColor: boolean;
	helpLine?: string;
	display?: ProviderDisplayPrefs;
}

function buildUsageReportLines(snapshot: UsageSnapshot, opts: UsageReportOptions): string[] {
	const { fmt, bold, useColor, helpLine, display = DEFAULT_DISPLAY_PREFS } = opts;
	const lines: string[] = [];

	lines.push(bold(fmt("accent", "⚡ Usage Limits")));

	for (const view of visibleViews(snapshot, fmt, useColor, display)) {
		lines.push(...view.full);
	}

	if (helpLine) {
		lines.push(fmt("dim", DIVIDER));
		lines.push(helpLine);
	}

	return lines;
}

// ───────── Widget ─────────

/**
 * Hard cap pi core applies to array widgets (InteractiveMode.MAX_WIDGET_LINES):
 * extra lines are replaced with "... (widget truncated)". Kept in sync manually.
 */
export const PI_WIDGET_LINE_CAP = 10;

/**
 * Assemble a widget body that never exceeds the pi line cap. When the blocks
 * do not fit, full blocks that fit are kept and the remaining providers are
 * folded into one trailing "… +N more:" summary line built from their
 * compact one-liners, so no provider silently disappears into pi truncation.
 */
export function assembleWidgetBody(title: string, blocks: string[][], summaries: string[], cap: number, fmt: Fmt): string[] {
	const total = 1 + blocks.reduce((count, block) => count + block.length, 0);
	if (total <= cap) return [title, ...blocks.flat()];
	const lines = [title];
	let used = 1;
	const rest: string[] = [];
	blocks.forEach((block, index) => {
		if (block.length > 0 && used + block.length <= cap - 1) {
			lines.push(...block);
		used += block.length;
		} else {
			rest.push(summaries[index]);
		}
	});
	if (rest.length > 0) {
		lines.push(`${fmt("dim", `… +${rest.length} more:`)} ${rest.join(fmt("dim", " │ "))}`);
	}
	return lines;
}

export function buildUsageWidget(snapshot: UsageSnapshot, theme: Theme, loading: boolean, display: ProviderDisplayPrefs = DEFAULT_DISPLAY_PREFS): string[] {
	const fmt = (color: ThemeColor, text: string) => theme.fg(color, text);
	const views = visibleViews(snapshot, fmt, true, display);
	const blocks = views.map((view) => display.compactWidget ? [view.compact] : view.full);
	const summaries = views.map((view) => view.compact);
	const title = theme.bold(fmt("accent", "⚡ Usage Limits"));
	const reserve = loading ? 2 : 0;
	const lines = assembleWidgetBody(title, blocks, summaries, PI_WIDGET_LINE_CAP - reserve, fmt);
	if (loading) {
		lines.push(theme.fg("dim", DIVIDER));
		lines.push(theme.fg("muted", "⚡ Checking usage limits..."));
	}
	return lines;
}

// ───────── Startup Message ─────────

export function buildStartupUsageMessage(snapshot: UsageSnapshot, includeHelp: boolean, display: ProviderDisplayPrefs = DEFAULT_DISPLAY_PREFS): string {
	const lines = buildUsageReportLines(snapshot, {
		fmt: (_color, text) => text,
		bold: (text) => text,
		useColor: false,
		helpLine: includeHelp ? USAGE_WIDGET_HELP : undefined,
		display,
	});

	return lines.join("\n");
}

// ───────── Status Line ─────────

export function footerUsageColor(usedPercent: number): "dim" | "accent" | "warning" | "error" {
	const rounded = Math.round(clampPercent(usedPercent));
	if (rounded >= 100) return "error";
	if (rounded >= 81) return "warning";
	if (rounded >= 51) return "accent";
	return "dim";
}

interface FooterWindow {
	usedPercent?: number;
	remainingPercent?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
	suffix?: string;
}

/** Compact "42%w/2h" summary for one usage window. */
function footerWindowSummary(window: FooterWindow & { usedPercent: number }, theme: Pick<Theme, "fg">, mode: QuotaDisplay = "used"): string {
	if (quotaWindowIsExpired(window)) return theme.fg("dim", `--${window.suffix ?? ""}`);
	const reset = resetDuration(window.resetAt, window.resetAfterSeconds);
	const shown = `${displayPercent(window.usedPercent, window.remainingPercent, mode)}%${window.suffix ?? ""}`;
	return theme.fg(footerUsageColor(window.usedPercent), reset ? `${shown}/${reset}` : shown);
}

function footerQuotaParts(theme: Pick<Theme, "fg">, windows: FooterWindow[], mode: QuotaDisplay = "used"): string[] {
	return windows
		.filter((window): window is FooterWindow & { usedPercent: number } => window.usedPercent !== undefined)
		.map((window) => footerWindowSummary(window, theme, mode));
}

/** Join window summaries; fall back to a retry hint or a bare status icon. */
function footerSummary(
	theme: Pick<Theme, "fg">,
	windows: FooterWindow[],
	status: GoModelStatus,
	retryAfterSeconds?: number,
	retryResetAt?: number,
	mode: QuotaDisplay = "used",
): string {
	const parts = footerQuotaParts(theme, windows, mode);
	if (parts.length > 0) return parts.join(theme.fg("dim", ","));
	const retryDuration = resetDuration(retryResetAt, retryAfterSeconds);
	if ((status === "rate_limited" || status === "credits_error") && retryDuration) {
		return theme.fg("warning", `limited/${retryDuration}`);
	}
	return theme.fg("dim", statusIcon(status));
}

export function updateFooterStatus(ctx: UsageContext, snapshot: UsageSnapshot, display: ProviderDisplayPrefs = DEFAULT_DISPLAY_PREFS): void {
	if (!ctx.hasUI) return;
	if (!display.showStatusLine) {
		ctx.ui.setStatus("pi-usage", undefined);
		return;
	}

	const { codex, anthropic, copilot, go, subscriptions } = snapshot;
	const theme = ctx.ui.theme;
	const dim = (text: string) => theme.fg("dim", text);
	const mode = display.quotaDisplay;

	interface FooterChunk { candidates: string[]; status: GoModelStatus | "unconfigured"; label: string; limited: boolean; summary: string }
	const chunks: FooterChunk[] = [];
	const addChunk = (candidates: string[], status: GoModelStatus | "unconfigured", label: string, limited: boolean, summary: string) => {
		chunks.push({ candidates, status, label, limited, summary });
	};

	if (codexUsageHasData(codex)) {
		const limited = codex.rateLimited;
		const quotaParts = footerQuotaParts(theme, [
			{ usedPercent: codex.primaryUsedPercent, resetAt: codex.primaryResetAt, resetAfterSeconds: codex.primaryResetAfterSeconds },
			{ usedPercent: codex.secondaryUsedPercent, resetAt: codex.secondaryResetAt, resetAfterSeconds: codex.secondaryResetAfterSeconds },
		], mode);
		const retryDuration = resetDuration(codex.primaryResetAt, codex.primaryResetAfterSeconds);
		if (limited && codex.primaryUsedPercent === undefined && retryDuration) {
			quotaParts.unshift(theme.fg("warning", `⏳/${retryDuration}`));
		}
		const fallback = limited ? "⏳" : "✓";
		const summary = quotaParts.length > 0
			? quotaParts.join(dim(","))
			: theme.fg(limited ? "warning" : "dim", fallback);
		addChunk(["openai-codex", "Codex"], limited ? "rate_limited" : "available", "Codex", limited, summary);
	}
	if (usageHasData(anthropic)) {
		addChunk(["anthropic", "Anthropic", "Claude"], anthropic.status, "Claude", anthropic.status === "rate_limited", footerSummary(theme, [
			{ usedPercent: anthropic.fiveHour?.utilizationPercent, resetAt: anthropic.fiveHour?.resetAt, resetAfterSeconds: anthropic.fiveHour?.resetAfterSeconds },
			{ usedPercent: anthropic.weekly?.utilizationPercent, resetAt: anthropic.weekly?.resetAt, resetAfterSeconds: anthropic.weekly?.resetAfterSeconds },
		], anthropic.status, anthropic.retryAfterSeconds, anthropic.retryResetAt, mode));
	}
	if (usageHasData(copilot)) {
		addChunk(["github-copilot", "GitHub Copilot", "Copilot"], copilot.status, "Copilot", copilot.status === "rate_limited" || copilot.status === "credits_error", footerSummary(theme, [
			{ ...copilot.premiumRequests, suffix: "p" },
			{ ...copilot.requests, suffix: "r" },
		], copilot.status, copilot.retryAfterSeconds, copilot.retryResetAt, mode));
	}
	for (const subscription of [go, ...subscriptions]) {
		if (!usageHasData(subscription)) continue;
		addChunk(
			subscriptionCandidates(subscription),
			subscription.status,
			subscription.shortLabel,
			subscription.status === "rate_limited" || subscription.status === "credits_error",
			footerSummary(theme, [
				{ ...subscription.rolling, suffix: "r" },
				{ ...subscription.weekly, suffix: "w" },
				{ ...subscription.monthly, suffix: "m" },
			], subscription.status, subscription.retryAfterSeconds, subscription.retryResetAt, mode),
		);
	}

	if (snapshot.openrouter) {
		const empty = openRouterIsEmpty(snapshot.openrouter);
		addChunk(
			["openrouter", "OpenRouter"],
			!empty ? "available" : snapshot.openrouter.error ? "error" : "unconfigured",
			"OpenRouter",
			false,
			openRouterFooter(snapshot.openrouter, (color, text) => theme.fg(color, text)),
		);
	}

	const parts = sortByProviderOrder(
		display,
		chunks
			.filter((chunk) => providerDisplays(display, chunk.candidates, chunk.status))
			.map((chunk) => ({
				candidates: chunk.candidates,
				value: `${dim(`${chunk.label}${chunk.limited ? " limited" : ""}:`)}${chunk.summary}`,
			})),
	);

	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `${dim("⚡ ")}${parts.join(dim(" │ "))}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

// ───────── Data Presence Guards ─────────

export function codexUsageHasData(codex: CodexUsage | undefined): codex is CodexUsage {
	return codex !== undefined && (codex.error === undefined || codex.rateLimited);
}

/** True when a probe-based provider is configured (anything but no_key). */
export function usageHasData<T extends { status: GoModelStatus }>(usage: T | undefined): usage is T {
	return usage !== undefined && usage.status !== "no_key";
}
