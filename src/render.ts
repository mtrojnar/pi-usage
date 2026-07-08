import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
	AnthropicUsage,
	CodexUsage,
	CopilotUsage,
	GoModelStatus,
	OpenCodeGoUsage,
	SubscriptionUsage,
	UsageContext,
} from "./types.ts";
import { USAGE_WIDGET_HELP } from "./config.ts";
import {
	clampPercent,
	formatDuration,
	formatResetTime,
	progressBar,
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

/** Consistent " resets in <duration>" / " resets now" suffix from a reset timestamp or countdown. */
export function resetPhrase(resetAt?: number, resetAfterSeconds?: number): string {
	const duration = resetAt !== undefined && resetAt > 0
		? formatResetTime(resetAt)
		: resetAfterSeconds !== undefined && resetAfterSeconds > 0
			? formatDuration(resetAfterSeconds)
			: undefined;
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

/** One "  label ████░░ 42%[ used][ / 58% left][ resets in 2h]" line per window with data. */
function windowLines(
	windows: UsageWindowLine[],
	pad: number,
	fmt: Fmt,
	useColor: boolean,
	percentSuffix = "",
): string[] {
	const lines: string[] = [];
	for (const window of windows) {
		if (window.usedPercent === undefined) continue;
		const percent = `${window.usedPercent.toFixed(0)}%${percentSuffix}`;
		const remaining = window.remainingPercent !== undefined ? ` / ${window.remainingPercent.toFixed(0)}% left` : "";
		const reset = resetPhrase(window.resetAt, window.resetAfterSeconds);
		if (useColor) {
			const color = usageColor(window.usedPercent);
			lines.push(`  ${window.label.padEnd(pad)} ${fmt(color, progressBar(window.usedPercent))} ${fmt(color, percent)}${fmt("dim", remaining + reset)}`);
		} else {
			lines.push(`  ${window.label.padEnd(pad)} ${progressBar(window.usedPercent)} ${percent}${remaining}${reset}`);
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
	errorMessage?: string;
	error?: string;
}

/** Trailing detail lines shared by the probe-based providers. */
function detailLines(usage: ProbeDetails, modelNoun: string, hasWindowData: boolean, fmt: Fmt): string[] {
	const lines: string[] = [];
	const limited = usage.status === "rate_limited" || usage.status === "credits_error";
	if (limited && usage.retryAfterSeconds && !hasWindowData) {
		lines.push(`  ${fmt("warning", `retry: ${formatDuration(usage.retryAfterSeconds)}`)}`);
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

export function renderCodexWindows(codex: CodexUsage, fmt: Fmt, useColor: boolean): string[] {
	if (codex.error && codex.activeLimit === "error") {
		return sectionLines(fmt, "✗ Codex", "error", `— ${truncate(codex.error, 120)}`);
	}

	const planLabel = codex.planType !== "unknown" ? ` (${codex.planType})` : "";
	const limitLabel = codex.activeLimit !== "unknown" && codex.activeLimit !== "normal"
		? ` [${codex.activeLimit}]`
		: "";
	const primaryLabel = codex.primaryWindowMinutes === 300 ? "5hr" : `${codex.primaryWindowMinutes / 60}h`;

	const lines = [
		fmt("dim", DIVIDER),
		`${fmt("accent", "Codex")}${fmt("dim", planLabel + limitLabel)}`,
		...windowLines([
			{ label: primaryLabel, usedPercent: codex.primaryUsedPercent, resetAt: codex.primaryResetAt, resetAfterSeconds: codex.primaryResetAfterSeconds },
			{ label: "week", usedPercent: codex.secondaryUsedPercent, resetAt: codex.secondaryResetAt, resetAfterSeconds: codex.secondaryResetAfterSeconds },
			{ label: "review", usedPercent: codex.codeReviewUsedPercent, resetAt: codex.codeReviewResetAt, resetAfterSeconds: codex.codeReviewResetAfterSeconds },
		], 6, fmt, useColor),
	];

	if (codex.creditsHasCredits && codex.creditsBalance) {
		lines.push(`  ${fmt("dim", `credits: ${codex.creditsBalance}`)}`);
	}
	if (codex.primaryOverSecondaryLimitPercent > 0) {
		lines.push(`  ${fmt("warning", `⚠ 5hr exceeds weekly allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
	}

	return lines;
}

// ───────── Rendering: Anthropic Windows ─────────

export function renderAnthropicWindows(anthropic: AnthropicUsage, fmt: Fmt, useColor: boolean): string[] {
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
		], 6, fmt, useColor),
		...detailLines(anthropic, "Anthropic", Boolean(anthropic.fiveHour || anthropic.weekly), fmt),
	];
}

// ───────── Rendering: GitHub Copilot Windows ─────────

export function renderCopilotWindows(copilot: CopilotUsage, fmt: Fmt, useColor: boolean): string[] {
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
		...windowLines(windows, 8, fmt, useColor, " used"),
		...detailLines(copilot, "Copilot", windows.some((window) => window.usedPercent !== undefined), fmt),
	];
}

// ───────── Rendering: Go Windows ─────────

export function renderGoWindows(go: OpenCodeGoUsage, fmt: Fmt, useColor: boolean): string[] {
	const lines = [
		...sectionLines(fmt, `${statusIcon(go.status)} OpenCode Go`, STATUS_COLOR[go.status], `— ${GO_STATUS_TEXT[go.status]}`),
		...windowLines([
			{ label: "rolling", usedPercent: go.rollingUsedPercent, remainingPercent: go.rollingRemainingPercent, resetAt: go.rollingResetAt, resetAfterSeconds: go.rollingResetAfterSeconds },
			{ label: "week", usedPercent: go.weeklyUsedPercent, remainingPercent: go.weeklyRemainingPercent, resetAt: go.weeklyResetAt, resetAfterSeconds: go.weeklyResetAfterSeconds },
			{ label: "month", usedPercent: go.monthlyUsedPercent, remainingPercent: go.monthlyRemainingPercent, resetAt: go.monthlyResetAt, resetAfterSeconds: go.monthlyResetAfterSeconds },
		], 7, fmt, useColor, " used"),
	];

	if (go.quotaError) lines.push(`  ${fmt("dim", `quota: ${truncate(go.quotaError, 80)}`)}`);
	lines.push(...detailLines(go, "Go", false, fmt));

	return lines;
}

// ───────── Rendering: Generic Subscription Providers ─────────

export function renderSubscriptionWindows(subscription: SubscriptionUsage, fmt: Fmt, useColor: boolean): string[] {
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
		...windowLines(windows, 7, fmt, useColor, " used"),
		...detailLines(subscription, subscription.shortLabel, windows.some((window) => window.usedPercent !== undefined), fmt),
	];
}

// ───────── Report Builder ─────────

interface UsageReportOptions {
	fmt: Fmt;
	bold: (text: string) => string;
	useColor: boolean;
	helpLine?: string;
}

function buildUsageReportLines(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	anthropic: AnthropicUsage | undefined,
	copilot: CopilotUsage | undefined,
	subscriptions: SubscriptionUsage[],
	opts: UsageReportOptions,
): string[] {
	const { fmt, bold, useColor, helpLine } = opts;
	const lines: string[] = [];

	lines.push(bold(fmt("accent", "⚡ Usage Limits")));

	if (codex) lines.push(...renderCodexWindows(codex, fmt, useColor));
	if (anthropic) lines.push(...renderAnthropicWindows(anthropic, fmt, useColor));
	if (copilot) lines.push(...renderCopilotWindows(copilot, fmt, useColor));
	if (go) lines.push(...renderGoWindows(go, fmt, useColor));
	for (const subscription of subscriptions) {
		if (subscriptionUsageHasData(subscription)) lines.push(...renderSubscriptionWindows(subscription, fmt, useColor));
	}

	if (helpLine) {
		lines.push(fmt("dim", DIVIDER));
		lines.push(helpLine);
	}

	return lines;
}

// ───────── Widget ─────────

export function buildUsageWidget(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	theme: Theme,
	loading: boolean,
	anthropic?: AnthropicUsage,
	copilot?: CopilotUsage,
	subscriptions: SubscriptionUsage[] = [],
): Text {
	if (loading) {
		return new Text(theme.fg("muted", "⚡ Checking usage limits..."), 0, 0);
	}

	const lines = buildUsageReportLines(codex, go, anthropic, copilot, subscriptions, {
		fmt: (color, text) => theme.fg(color, text),
		bold: (text) => theme.bold(text),
		useColor: true,
	});

	return new Text(lines.join("\n"), 0, 0);
}

// ───────── Startup Message ─────────

export function buildStartupUsageMessage(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	includeHelp: boolean,
	anthropic?: AnthropicUsage,
	copilot?: CopilotUsage,
	subscriptions: SubscriptionUsage[] = [],
): string {
	const lines = buildUsageReportLines(codex, go, anthropic, copilot, subscriptions, {
		fmt: (_color, text) => text,
		bold: (text) => text,
		useColor: false,
		helpLine: includeHelp ? USAGE_WIDGET_HELP : undefined,
	});

	return lines.join("\n");
}

// ───────── Status Line ─────────

export function footerResetDuration(resetAt?: number, resetAfterSeconds?: number): string | undefined {
	if (resetAt !== undefined && resetAt > 0) return formatResetTime(resetAt);
	if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) return formatDuration(resetAfterSeconds);
	return undefined;
}

export function footerUsageColor(usedPercent: number): "dim" | "accent" | "warning" | "error" {
	const rounded = Math.round(clampPercent(usedPercent));
	if (rounded >= 100) return "error";
	if (rounded >= 81) return "warning";
	if (rounded >= 51) return "accent";
	return "dim";
}

interface FooterWindow {
	usedPercent?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
	suffix?: string;
}

/** Compact "42%w/2h" summary for one usage window. */
function footerWindowSummary(window: FooterWindow & { usedPercent: number }, theme: Theme): string {
	const reset = footerResetDuration(window.resetAt, window.resetAfterSeconds);
	const used = `${Math.round(clampPercent(window.usedPercent))}%${window.suffix ?? ""}`;
	return theme.fg(footerUsageColor(window.usedPercent), reset ? `${used}/${reset}` : used);
}

function footerQuotaParts(theme: Theme, windows: FooterWindow[]): string[] {
	return windows
		.filter((window): window is FooterWindow & { usedPercent: number } => window.usedPercent !== undefined)
		.map((window) => footerWindowSummary(window, theme));
}

/** Join window summaries; fall back to a retry hint or a bare status icon. */
function footerSummary(theme: Theme, windows: FooterWindow[], status: GoModelStatus, retryAfterSeconds?: number): string {
	const parts = footerQuotaParts(theme, windows);
	if (parts.length > 0) return parts.join(theme.fg("dim", ","));
	if ((status === "rate_limited" || status === "credits_error") && retryAfterSeconds) {
		return theme.fg("warning", `limited/${formatDuration(retryAfterSeconds)}`);
	}
	return theme.fg("dim", statusIcon(status));
}

export function updateFooterStatus(
	ctx: UsageContext,
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	anthropic?: AnthropicUsage,
	copilot?: CopilotUsage,
	subscriptions: SubscriptionUsage[] = [],
): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;
	const dim = (text: string) => theme.fg("dim", text);
	const parts: string[] = [];
	const addPart = (label: string, limited: boolean, summary: string) => {
		parts.push(`${dim(`${label}${limited ? " limited" : ""}:`)}${summary}`);
	};

	if (codexUsageHasData(codex)) {
		const summary = footerQuotaParts(theme, [
			{ usedPercent: codex.primaryUsedPercent, resetAt: codex.primaryResetAt, resetAfterSeconds: codex.primaryResetAfterSeconds },
			{ usedPercent: codex.secondaryUsedPercent, resetAt: codex.secondaryResetAt, resetAfterSeconds: codex.secondaryResetAfterSeconds },
		]).join(dim(","));
		addPart("Codex", codex.activeLimit === "rate_limited", summary);
	}
	if (anthropicUsageHasData(anthropic)) {
		addPart("Claude", anthropic.status === "rate_limited", footerSummary(theme, [
			{ usedPercent: anthropic.fiveHour?.utilizationPercent, resetAt: anthropic.fiveHour?.resetAt, resetAfterSeconds: anthropic.fiveHour?.resetAfterSeconds },
			{ usedPercent: anthropic.weekly?.utilizationPercent, resetAt: anthropic.weekly?.resetAt, resetAfterSeconds: anthropic.weekly?.resetAfterSeconds },
		], anthropic.status, anthropic.retryAfterSeconds));
	}
	if (copilotUsageHasData(copilot)) {
		addPart("Copilot", copilot.status === "rate_limited" || copilot.status === "credits_error", footerSummary(theme, [
			{ ...copilot.premiumRequests, suffix: "p" },
			{ ...copilot.requests, suffix: "r" },
		], copilot.status, copilot.retryAfterSeconds));
	}
	if (goUsageHasData(go)) {
		addPart("Go", false, footerSummary(theme, [
			{ usedPercent: go.rollingUsedPercent, resetAt: go.rollingResetAt, resetAfterSeconds: go.rollingResetAfterSeconds, suffix: "r" },
			{ usedPercent: go.weeklyUsedPercent, resetAt: go.weeklyResetAt, resetAfterSeconds: go.weeklyResetAfterSeconds, suffix: "w" },
			{ usedPercent: go.monthlyUsedPercent, resetAt: go.monthlyResetAt, resetAfterSeconds: go.monthlyResetAfterSeconds, suffix: "m" },
		], go.status));
	}
	for (const subscription of subscriptions) {
		if (!subscriptionUsageHasData(subscription)) continue;
		addPart(
			subscription.shortLabel,
			subscription.status === "rate_limited" || subscription.status === "credits_error",
			footerSummary(theme, [
				{ ...subscription.rolling, suffix: "r" },
				{ ...subscription.weekly, suffix: "w" },
				{ ...subscription.monthly, suffix: "m" },
			], subscription.status, subscription.retryAfterSeconds),
		);
	}

	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `${dim("⚡ ")}${parts.join(dim(" │ "))}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

// ───────── Data Presence Guards ─────────

export function codexUsageHasData(codex: CodexUsage | undefined): codex is CodexUsage & { error: undefined } {
	return codex !== undefined && codex.error === undefined && codex.activeLimit !== "error";
}

export function anthropicUsageHasData(anthropic: AnthropicUsage | undefined): anthropic is AnthropicUsage {
	return anthropic !== undefined && anthropic.status !== "no_key";
}

export function copilotUsageHasData(copilot: CopilotUsage | undefined): copilot is CopilotUsage {
	return copilot !== undefined && copilot.status !== "no_key";
}

export function subscriptionUsageHasData(subscription: SubscriptionUsage | undefined): subscription is SubscriptionUsage {
	return subscription !== undefined && subscription.status !== "no_key";
}

export function goUsageHasData(go: OpenCodeGoUsage | undefined): go is OpenCodeGoUsage {
	return go !== undefined && go.status !== "no_key";
}
