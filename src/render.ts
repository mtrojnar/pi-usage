import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AnthropicRateLimitWindow, AnthropicUsage, CodexUsage, CopilotRateLimitWindow, CopilotUsage, OpenCodeGoUsage, SubscriptionUsage, UsageContext } from "./types.ts";
import { ANTHROPIC_COLOR_MAP, ANTHROPIC_STATUS_TEXT } from "./anthropic.ts";
import { COPILOT_COLOR_MAP, COPILOT_STATUS_TEXT } from "./copilot.ts";
import { GO_COLOR_MAP, GO_STATUS_TEXT } from "./opencode-go.ts";
import { USAGE_CONFIG_FILE, USAGE_WIDGET_FLAG, USAGE_WIDGET_HELP } from "./config.ts";
import {
	clampPercent,
	formatDuration,
	formatResetTime,
	progressBar,
	statusIcon,
	truncate,
	usageColor,
} from "./format.ts";

// ───────── Rendering: Codex Windows ─────────

export function renderCodexWindows(codex: CodexUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];
	if (codex.error && codex.activeLimit === "error") {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(`${fmt("error", "✗ Codex")} ${fmt("dim", "— " + truncate(codex.error, 120))}`);
		return lines;
	}

	const planLabel = codex.planType !== "unknown" ? ` (${codex.planType})` : "";
	const limitLabel = codex.activeLimit !== "unknown" && codex.activeLimit !== "normal"
		? ` [${codex.activeLimit}]`
		: "";

	const p5 = codex.primaryUsedPercent;
	const p5Window = codex.primaryWindowMinutes === 300 ? "5hr" : `${codex.primaryWindowMinutes / 60}h`;
	const p5Reset = codex.primaryResetAt > 0
		? ` resets ${formatResetTime(codex.primaryResetAt)}`
		: codex.primaryResetAfterSeconds > 0
			? ` resets in ${formatDuration(codex.primaryResetAfterSeconds)}`
			: "";
	const pW = codex.secondaryUsedPercent;
	const pWReset = codex.secondaryResetAt > 0
		? ` resets ${formatResetTime(codex.secondaryResetAt)}`
		: codex.secondaryResetAfterSeconds > 0
			? ` resets in ${formatDuration(codex.secondaryResetAfterSeconds)}`
			: "";

	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt("accent", "Codex")}${fmt("dim", planLabel + limitLabel)}`);

	if (useColor) {
		const p5Color = usageColor(p5);
		const pWColor = usageColor(pW);
		const p5Bar = progressBar(p5);
		const pWBar = progressBar(pW);
		lines.push(`  ${p5Window}  ${fmt(p5Color, p5Bar)} ${fmt(p5Color, `${p5.toFixed(0)}%`)}${fmt("dim", p5Reset)}`);
		lines.push(`  week  ${fmt(pWColor, pWBar)} ${fmt(pWColor, `${pW.toFixed(0)}%`)}${fmt("dim", pWReset)}`);
	} else {
		lines.push(`  ${p5Window}  ${progressBar(p5)} ${p5.toFixed(0)}%${p5Reset}`);
		lines.push(`  week  ${progressBar(pW)} ${pW.toFixed(0)}%${pWReset}`);
	}

	if (codex.codeReviewUsedPercent !== undefined) {
		const pC = codex.codeReviewUsedPercent;
		const pCReset = codex.codeReviewResetAt
			? ` resets ${formatResetTime(codex.codeReviewResetAt)}`
			: codex.codeReviewResetAfterSeconds
				? ` resets in ${formatDuration(codex.codeReviewResetAfterSeconds)}`
				: "";
		if (useColor) {
			const pCColor = usageColor(pC);
			const pCBar = progressBar(pC);
			lines.push(`  review ${fmt(pCColor, pCBar)} ${fmt(pCColor, `${pC.toFixed(0)}%`)}${fmt("dim", pCReset)}`);
		} else {
			lines.push(`  review ${progressBar(pC)} ${pC.toFixed(0)}%${pCReset}`);
		}
	}

	if (codex.creditsHasCredits && codex.creditsBalance) {
		lines.push(`  ${fmt("dim", `credits: ${codex.creditsBalance}`)}`);
	}
	if (codex.primaryOverSecondaryLimitPercent > 0) {
		lines.push(`  ${fmt("warning", `⚠ 5hr exceeds weekly allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
	}

	return lines;
}

// ───────── Rendering: Anthropic Windows ─────────

function renderAnthropicLimitWindow(
	label: string,
	window: AnthropicRateLimitWindow | undefined,
	fmt: (color: ThemeColor, text: string) => string,
	useColor: boolean,
): string | undefined {
	if (!window || window.usedPercent === undefined) return undefined;
	const reset = window.resetAt
		? ` resets ${formatResetTime(window.resetAt)}`
		: window.resetAfterSeconds !== undefined && window.resetAfterSeconds > 0
			? ` resets in ${formatDuration(window.resetAfterSeconds)}`
			: "";
	const remaining = window.remainingPercent !== undefined
		? ` / ${window.remainingPercent.toFixed(0)}% left`
		: "";
	if (useColor) {
		const windowColor = usageColor(window.usedPercent);
		const windowBar = progressBar(window.usedPercent);
		return `  ${label.padEnd(8)} ${fmt(windowColor, windowBar)} ${fmt(windowColor, `${window.usedPercent.toFixed(0)}% used`)}${fmt("dim", remaining + reset)}`;
	}
	return `  ${label.padEnd(8)} ${progressBar(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used${remaining}${reset}`;
}

export function renderAnthropicWindows(anthropic: AnthropicUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];
	const icon = statusIcon(anthropic.status);
	const color = ANTHROPIC_COLOR_MAP[anthropic.status];
	const authLabel = anthropic.authType === "oauth"
		? "Claude Pro/Max"
		: anthropic.authType === "api_key"
			? "API"
			: "Claude";

	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt(color, `${icon} Anthropic`)} ${fmt("dim", `(${authLabel}) — ${ANTHROPIC_STATUS_TEXT[anthropic.status]}`)}`);

	const windows = [
		{ label: "requests", window: anthropic.requests },
		{ label: "tokens", window: anthropic.tokens },
		{ label: "input", window: anthropic.inputTokens },
		{ label: "output", window: anthropic.outputTokens },
	];
	for (const { label, window } of windows) {
		const rendered = renderAnthropicLimitWindow(label, window, fmt, useColor);
		if (rendered) lines.push(rendered);
	}

	if (anthropic.status === "rate_limited" && anthropic.retryAfterSeconds && !windows.some(({ window }) => window?.usedPercent !== undefined)) {
		lines.push(`  ${fmt("warning", `retry: ${formatDuration(anthropic.retryAfterSeconds)}`)}`);
	}
	if (anthropic.workingModel) lines.push(`  ${fmt("dim", `working: ${anthropic.workingModel}`)}`);
	if (anthropic.checkedModels && anthropic.totalModels) lines.push(`  ${fmt("dim", `checked: ${anthropic.checkedModels}/${anthropic.totalModels} Anthropic models`)}`);
	if (anthropic.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${anthropic.rateLimitedModel}`)}`);
	const error = anthropic.errorMessage || anthropic.error;
	if (error) lines.push(`  ${fmt("dim", truncate(error, 80))}`);

	return lines;
}

// ───────── Rendering: GitHub Copilot Windows ─────────

function renderCopilotLimitWindow(
	label: string,
	window: CopilotRateLimitWindow | undefined,
	fmt: (color: ThemeColor, text: string) => string,
	useColor: boolean,
): string | undefined {
	if (!window || window.usedPercent === undefined) return undefined;
	const reset = window.resetAt
		? ` resets ${formatResetTime(window.resetAt)}`
		: window.resetAfterSeconds !== undefined && window.resetAfterSeconds > 0
			? ` resets in ${formatDuration(window.resetAfterSeconds)}`
			: "";
	const remaining = window.remainingPercent !== undefined
		? ` / ${window.remainingPercent.toFixed(0)}% left`
		: "";
	if (useColor) {
		const windowColor = usageColor(window.usedPercent);
		const windowBar = progressBar(window.usedPercent);
		return `  ${label.padEnd(8)} ${fmt(windowColor, windowBar)} ${fmt(windowColor, `${window.usedPercent.toFixed(0)}% used`)}${fmt("dim", remaining + reset)}`;
	}
	return `  ${label.padEnd(8)} ${progressBar(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used${remaining}${reset}`;
}

export function renderCopilotWindows(copilot: CopilotUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];
	const icon = statusIcon(copilot.status);
	const color = COPILOT_COLOR_MAP[copilot.status];

	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt(color, `${icon} GitHub Copilot`)} ${fmt("dim", "— " + COPILOT_STATUS_TEXT[copilot.status])}`);

	const windows = [
		{ label: "premium", window: copilot.premiumRequests },
		{ label: "requests", window: copilot.requests },
	];
	for (const { label, window } of windows) {
		const rendered = renderCopilotLimitWindow(label, window, fmt, useColor);
		if (rendered) lines.push(rendered);
	}

	if ((copilot.status === "rate_limited" || copilot.status === "credits_error") && copilot.retryAfterSeconds && !windows.some(({ window }) => window?.usedPercent !== undefined)) {
		lines.push(`  ${fmt("warning", `retry: ${formatDuration(copilot.retryAfterSeconds)}`)}`);
	}
	if (copilot.workingModel) lines.push(`  ${fmt("dim", `working: ${copilot.workingModel}`)}`);
	if (copilot.checkedModels && copilot.totalModels) lines.push(`  ${fmt("dim", `checked: ${copilot.checkedModels}/${copilot.totalModels} Copilot models`)}`);
	if (copilot.availableModels) lines.push(`  ${fmt("dim", `available: ${copilot.availableModels} account models`)}`);
	if (copilot.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${copilot.rateLimitedModel}`)}`);
	const error = copilot.errorMessage || copilot.error;
	if (error) lines.push(`  ${fmt("dim", truncate(error, 80))}`);

	return lines;
}

// ───────── Rendering: Go Windows ─────────

export function renderGoWindows(go: OpenCodeGoUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];

	const icon = statusIcon(go.status);
	const goColor = GO_COLOR_MAP[go.status];
	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt(goColor, `${icon} OpenCode Go`)} ${fmt("dim", "— " + GO_STATUS_TEXT[go.status])}`);

	const goWindows = [
		{
			label: "rolling", used: go.rollingUsedPercent, remaining: go.rollingRemainingPercent,
			resetAt: go.rollingResetAt, resetAfterSeconds: go.rollingResetAfterSeconds,
		},
		{
			label: "week", used: go.weeklyUsedPercent, remaining: go.weeklyRemainingPercent,
			resetAt: go.weeklyResetAt, resetAfterSeconds: go.weeklyResetAfterSeconds,
		},
		{
			label: "month", used: go.monthlyUsedPercent, remaining: go.monthlyRemainingPercent,
			resetAt: go.monthlyResetAt, resetAfterSeconds: go.monthlyResetAfterSeconds,
		},
	];
	for (const w of goWindows) {
		if (w.used === undefined) continue;
		const reset = w.resetAt
			? ` resets ${formatResetTime(w.resetAt)}`
			: w.resetAfterSeconds !== undefined && w.resetAfterSeconds > 0
				? ` resets in ${formatDuration(w.resetAfterSeconds)}`
				: "";
		const remaining = w.remaining !== undefined
			? ` / ${w.remaining.toFixed(0)}% left`
			: "";
		if (useColor) {
			const windowColor = usageColor(w.used);
			const windowBar = progressBar(w.used);
			lines.push(`  ${w.label.padEnd(7)} ${fmt(windowColor, windowBar)} ${fmt(windowColor, `${w.used.toFixed(0)}% used`)}${fmt("dim", remaining + reset)}`);
		} else {
			lines.push(`  ${w.label.padEnd(7)} ${progressBar(w.used)} ${w.used.toFixed(0)}% used${remaining}${reset}`);
		}
	}

	if (go.quotaError) lines.push(`  ${fmt("dim", `quota: ${truncate(go.quotaError, 80)}`)}`);
	if (go.workingModel) lines.push(`  ${fmt("dim", `working: ${go.workingModel}`)}`);
	if (go.checkedModels && go.totalModels) lines.push(`  ${fmt("dim", `checked: ${go.checkedModels}/${go.totalModels} Go models`)}`);
	if (go.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${go.rateLimitedModel}`)}`);
	const goError = go.errorMessage || go.error;
	if (goError) lines.push(`  ${fmt("dim", truncate(goError, 80))}`);

	return lines;
}

// ───────── Rendering: Generic Subscription Providers ─────────

export function renderSubscriptionWindows(subscription: SubscriptionUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];
	const icon = statusIcon(subscription.status);
	const color = GO_COLOR_MAP[subscription.status];

	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt(color, `${icon} ${subscription.label}`)} ${fmt("dim", "— " + GO_STATUS_TEXT[subscription.status])}`);

	const windows = [
		{ label: "rolling", window: subscription.rolling },
		{ label: "week", window: subscription.weekly },
		{ label: "month", window: subscription.monthly },
	];
	for (const { label, window } of windows) {
		if (window?.usedPercent === undefined) continue;
		const reset = window.resetAt
			? ` resets ${formatResetTime(window.resetAt)}`
			: window.resetAfterSeconds !== undefined && window.resetAfterSeconds > 0
				? ` resets in ${formatDuration(window.resetAfterSeconds)}`
				: "";
		const remaining = window.remainingPercent !== undefined
			? ` / ${window.remainingPercent.toFixed(0)}% left`
			: "";
		if (useColor) {
			const windowColor = usageColor(window.usedPercent);
			const windowBar = progressBar(window.usedPercent);
			lines.push(`  ${label.padEnd(7)} ${fmt(windowColor, windowBar)} ${fmt(windowColor, `${window.usedPercent.toFixed(0)}% used`)}${fmt("dim", remaining + reset)}`);
		} else {
			lines.push(`  ${label.padEnd(7)} ${progressBar(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used${remaining}${reset}`);
		}
	}

	if ((subscription.status === "rate_limited" || subscription.status === "credits_error") && subscription.retryAfterSeconds && !windows.some(({ window }) => window?.usedPercent !== undefined)) {
		lines.push(`  ${fmt("warning", `retry: ${formatDuration(subscription.retryAfterSeconds)}`)}`);
	}
	if (subscription.workingModel) lines.push(`  ${fmt("dim", `working: ${subscription.workingModel}`)}`);
	if (subscription.checkedModels && subscription.totalModels) lines.push(`  ${fmt("dim", `checked: ${subscription.checkedModels}/${subscription.totalModels} ${subscription.shortLabel} models`)}`);
	if (subscription.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${subscription.rateLimitedModel}`)}`);
	const error = subscription.errorMessage || subscription.error;
	if (error) lines.push(`  ${fmt("dim", truncate(error, 80))}`);

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

	const lines: string[] = [];
	const fmt = (color: ThemeColor, text: string) => theme.fg(color, text);

	lines.push(theme.bold(fmt("accent", "⚡ Usage Limits")));

	if (codex) {
		lines.push(...renderCodexWindows(codex, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "Codex — not configured"));
	}

	if (anthropic) {
		lines.push(...renderAnthropicWindows(anthropic, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "Anthropic — not configured"));
	}

	if (copilot) {
		lines.push(...renderCopilotWindows(copilot, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "GitHub Copilot — not configured"));
	}

	if (go) {
		lines.push(...renderGoWindows(go, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "OpenCode Go — not configured"));
	}

	for (const subscription of subscriptions) {
		if (subscriptionUsageHasData(subscription)) lines.push(...renderSubscriptionWindows(subscription, fmt, true));
	}

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
	const lines: string[] = [];
	const fmt = (_color: ThemeColor, text: string) => text;

	lines.push("⚡ Usage Limits");

	if (codex) {
		lines.push(...renderCodexWindows(codex, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("Codex — not configured");
	}

	if (anthropic) {
		lines.push(...renderAnthropicWindows(anthropic, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("Anthropic — not configured");
	}

	if (copilot) {
		lines.push(...renderCopilotWindows(copilot, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("GitHub Copilot — not configured");
	}

	if (go) {
		lines.push(...renderGoWindows(go, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("OpenCode Go — not configured");
	}

	for (const subscription of subscriptions) {
		if (subscriptionUsageHasData(subscription)) lines.push(...renderSubscriptionWindows(subscription, fmt, false));
	}

	if (includeHelp) {
		lines.push("─".repeat(40));
		lines.push(USAGE_WIDGET_HELP);
	}

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

function footerWindowSummary(
	usedPercent: number,
	theme: Theme,
	resetAt?: number,
	resetAfterSeconds?: number,
	suffix: string = "",
): string {
	const reset = footerResetDuration(resetAt, resetAfterSeconds);
	const rounded = Math.round(clampPercent(usedPercent));
	const used = `${rounded}%${suffix}`;
	const text = reset ? `${used}/${reset}` : used;
	return theme.fg(footerUsageColor(usedPercent), text);
}

function codexFooterSummary(codex: CodexUsage, theme: Theme): string {
	return [
		footerWindowSummary(codex.primaryUsedPercent, theme, codex.primaryResetAt, codex.primaryResetAfterSeconds),
		footerWindowSummary(codex.secondaryUsedPercent, theme, codex.secondaryResetAt, codex.secondaryResetAfterSeconds),
	].join(theme.fg("dim", ","));
}

function goFooterSummary(go: OpenCodeGoUsage, theme: Theme): string {
	const quotaParts: string[] = [];
	if (go.rollingUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.rollingUsedPercent, theme, go.rollingResetAt, go.rollingResetAfterSeconds, "r"));
	}
	if (go.weeklyUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.weeklyUsedPercent, theme, go.weeklyResetAt, go.weeklyResetAfterSeconds, "w"));
	}
	if (go.monthlyUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.monthlyUsedPercent, theme, go.monthlyResetAt, go.monthlyResetAfterSeconds, "m"));
	}
	return quotaParts.length > 0 ? quotaParts.join(theme.fg("dim", ",")) : theme.fg("dim", statusIcon(go.status));
}

function subscriptionFooterSummary(subscription: SubscriptionUsage, theme: Theme): string {
	const quotaParts: string[] = [];
	if (subscription.rolling?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(subscription.rolling.usedPercent, theme, subscription.rolling.resetAt, subscription.rolling.resetAfterSeconds, "r"));
	}
	if (subscription.weekly?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(subscription.weekly.usedPercent, theme, subscription.weekly.resetAt, subscription.weekly.resetAfterSeconds, "w"));
	}
	if (subscription.monthly?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(subscription.monthly.usedPercent, theme, subscription.monthly.resetAt, subscription.monthly.resetAfterSeconds, "m"));
	}
	if (quotaParts.length > 0) return quotaParts.join(theme.fg("dim", ","));
	if ((subscription.status === "rate_limited" || subscription.status === "credits_error") && subscription.retryAfterSeconds) {
		return theme.fg("warning", `limited/${formatDuration(subscription.retryAfterSeconds)}`);
	}
	return theme.fg("dim", statusIcon(subscription.status));
}

function anthropicFooterSummary(anthropic: AnthropicUsage, theme: Theme): string {
	const quotaParts: string[] = [];
	if (anthropic.tokens?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(anthropic.tokens.usedPercent, theme, anthropic.tokens.resetAt, anthropic.tokens.resetAfterSeconds, "t"));
	}
	if (anthropic.requests?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(anthropic.requests.usedPercent, theme, anthropic.requests.resetAt, anthropic.requests.resetAfterSeconds, "r"));
	}
	if (anthropic.inputTokens?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(anthropic.inputTokens.usedPercent, theme, anthropic.inputTokens.resetAt, anthropic.inputTokens.resetAfterSeconds, "i"));
	}
	if (anthropic.outputTokens?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(anthropic.outputTokens.usedPercent, theme, anthropic.outputTokens.resetAt, anthropic.outputTokens.resetAfterSeconds, "o"));
	}
	if (quotaParts.length > 0) return quotaParts.join(theme.fg("dim", ","));
	if (anthropic.status === "rate_limited" && anthropic.retryAfterSeconds) {
		return theme.fg("warning", `limited/${formatDuration(anthropic.retryAfterSeconds)}`);
	}
	return theme.fg("dim", statusIcon(anthropic.status));
}

function copilotFooterSummary(copilot: CopilotUsage, theme: Theme): string {
	const quotaParts: string[] = [];
	if (copilot.premiumRequests?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(copilot.premiumRequests.usedPercent, theme, copilot.premiumRequests.resetAt, copilot.premiumRequests.resetAfterSeconds, "p"));
	}
	if (copilot.requests?.usedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(copilot.requests.usedPercent, theme, copilot.requests.resetAt, copilot.requests.resetAfterSeconds, "r"));
	}
	if (quotaParts.length > 0) return quotaParts.join(theme.fg("dim", ","));
	if ((copilot.status === "rate_limited" || copilot.status === "credits_error") && copilot.retryAfterSeconds) {
		return theme.fg("warning", `limited/${formatDuration(copilot.retryAfterSeconds)}`);
	}
	return theme.fg("dim", statusIcon(copilot.status));
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
	if (codexUsageHasData(codex)) {
		const limited = codex.activeLimit === "rate_limited" ? " limited" : "";
		parts.push(`${dim(`Codex${limited}:`)}${codexFooterSummary(codex, theme)}`);
	}
	if (anthropicUsageHasData(anthropic)) {
		const limited = anthropic.status === "rate_limited" ? " limited" : "";
		parts.push(`${dim(`Claude${limited}:`)}${anthropicFooterSummary(anthropic, theme)}`);
	}
	if (copilotUsageHasData(copilot)) {
		const limited = copilot.status === "rate_limited" || copilot.status === "credits_error" ? " limited" : "";
		parts.push(`${dim(`Copilot${limited}:`)}${copilotFooterSummary(copilot, theme)}`);
	}
	if (goUsageHasData(go)) {
		parts.push(`${dim("Go:")}${goFooterSummary(go, theme)}`);
	}
	for (const subscription of subscriptions) {
		if (!subscriptionUsageHasData(subscription)) continue;
		const limited = subscription.status === "rate_limited" || subscription.status === "credits_error" ? " limited" : "";
		parts.push(`${dim(`${subscription.shortLabel}${limited}:`)}${subscriptionFooterSummary(subscription, theme)}`);
	}
	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `${dim("⚡ ")}${parts.join(dim(" │ "))}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

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
