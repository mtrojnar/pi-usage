/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex (5hr & weekly) and OpenCode Go usage limits at startup.
 * Displays a startup report by default; persistent widget is opt-in.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { CodexUsage, OpenCodeGoUsage, RefreshTrigger, UsageContext } from "./src/types.ts";
import {
	AUTO_REFRESH_MINUTES,
	CHECK_TIMEOUT_MS,
	PROACTIVE_REFRESH_ENABLED,
	UI_REFRESH_SECONDS,
	NO_USAGE_WIDGET_FLAG,
	USAGE_WIDGET_FLAG,
	WIDGET_ID,
	OPENAI_CODEX_PROVIDER,
	getOpenCodeGoQuotaConfig,
	readUsageWidgetSetting,
} from "./src/config.ts";
import { getCodexToken, checkCodexUsage, parseCodexUsageHeaders } from "./src/codex.ts";
import { getOpenCodeApiKey, checkOpenCodeGoUsage, parseOpenCodeGoUsageHeaders } from "./src/opencode-go.ts";
import {
	buildStartupUsageMessage,
	buildUsageWidget,
	updateFooterStatus,
} from "./src/render.ts";

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag(USAGE_WIDGET_FLAG, {
		description: "Display pi-usage as a persistent widget above the editor",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(NO_USAGE_WIDGET_FLAG, {
		description: "Disable the pi-usage persistent widget for this run",
		type: "boolean",
		default: false,
	});

	let codexUsage: CodexUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let widgetLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;
	let startupDelayTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshController: AbortController | undefined;
	let codexPassiveAt = 0;
	let goPassiveAt = 0;
	let goPassiveQuotaAt = 0;
	let sessionGeneration = 0;

	function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
		if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
			timer.unref();
		}
	}

	function isUsageWidgetEnabled(ctx: UsageContext): boolean {
		if (pi.getFlag(NO_USAGE_WIDGET_FLAG) === true) return false;
		if (pi.getFlag(USAGE_WIDGET_FLAG) === true) return true;
		return readUsageWidgetSetting(ctx) ?? false;
	}

	function renderCachedUsage(ctx: UsageContext, loading = false): void {
		if (!ctx.hasUI) return;
		if (isUsageWidgetEnabled(ctx)) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) =>
				buildUsageWidget(codexUsage, goUsage, theme, loading),
			);
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		updateFooterStatus(ctx, codexUsage, goUsage);
	}

	function resetAtFromAfter(resetAt: number | undefined, resetAfterSeconds: number | undefined, nowSec: number): number | undefined {
		if (resetAt !== undefined && resetAt > 0) return resetAt;
		return resetAfterSeconds !== undefined && resetAfterSeconds > 0
			? nowSec + Math.round(resetAfterSeconds)
			: resetAt;
	}

	function normalizeCodexResetTimes(usage: CodexUsage): CodexUsage {
		const nowSec = Math.round(Date.now() / 1000);
		usage.primaryResetAt = resetAtFromAfter(usage.primaryResetAt, usage.primaryResetAfterSeconds, nowSec) ?? 0;
		usage.secondaryResetAt = resetAtFromAfter(usage.secondaryResetAt, usage.secondaryResetAfterSeconds, nowSec) ?? 0;
		usage.codeReviewResetAt = resetAtFromAfter(usage.codeReviewResetAt, usage.codeReviewResetAfterSeconds, nowSec);
		return usage;
	}

	function normalizeGoResetTimes(usage: OpenCodeGoUsage): OpenCodeGoUsage {
		const nowSec = Math.round(Date.now() / 1000);
		usage.rollingResetAt = resetAtFromAfter(usage.rollingResetAt, usage.rollingResetAfterSeconds, nowSec);
		usage.weeklyResetAt = resetAtFromAfter(usage.weeklyResetAt, usage.weeklyResetAfterSeconds, nowSec);
		usage.monthlyResetAt = resetAtFromAfter(usage.monthlyResetAt, usage.monthlyResetAfterSeconds, nowSec);
		return usage;
	}

	function hasGoQuotaData(usage: OpenCodeGoUsage | undefined): boolean {
		return usage?.rollingUsedPercent !== undefined || usage?.weeklyUsedPercent !== undefined || usage?.monthlyUsedPercent !== undefined;
	}

	function passiveUpdateIsFresh(timestamp: number): boolean {
		return timestamp > 0 && Date.now() - timestamp < AUTO_REFRESH_MINUTES * 60 * 1000;
	}

	function hasHeaderPrefix(headers: Record<string, string>, prefix: string): boolean {
		const normalizedPrefix = prefix.toLowerCase();
		return Object.keys(headers).some((name) => name.toLowerCase().startsWith(normalizedPrefix));
	}

	function modelProvider(ctx: UsageContext): string | undefined {
		return (ctx as UsageContext & { model?: { provider?: string } }).model?.provider;
	}

	function modelId(ctx: UsageContext): string | undefined {
		return (ctx as UsageContext & { model?: { id?: string } }).model?.id;
	}

	async function refreshUsage(ctx: UsageContext, trigger: RefreshTrigger = "manual"): Promise<void> {
		if (!ctx.hasUI) return;
		if (isLoading) {
			if (trigger !== "auto") ctx.ui.notify("Usage check already in progress", "info");
			return;
		}
		isLoading = true;
		const generation = sessionGeneration;
		const controller = new AbortController();
		let refreshTimedOut = false;
		const refreshTimeout = setTimeout(() => {
			refreshTimedOut = true;
			controller.abort();
		}, CHECK_TIMEOUT_MS * 2);
		unrefTimer(refreshTimeout);
		refreshController = controller;

		try {
			const showWidget = isUsageWidgetEnabled(ctx);
			const showStartupReport = !showWidget && trigger !== "auto";
			widgetLoading = showWidget && trigger !== "auto";

			// Show loading state for user-triggered checks; keep cached values during auto refresh.
			if (ctx.hasUI) {
				renderCachedUsage(ctx, widgetLoading);
				if (showStartupReport) ctx.ui.notify("⚡ Checking usage limits...", "info");
			}

			const checks: Promise<void>[] = [];
			const signal = controller.signal;

			// Check Codex; recent passive headers defer auto probes.
			const skipCodexCheck = trigger === "auto" && passiveUpdateIsFresh(codexPassiveAt);
			const codexAuth = skipCodexCheck ? undefined : await getCodexToken();
			if (codexAuth) {
				checks.push(
					checkCodexUsage(codexAuth.token, codexAuth.accountId, signal).then((result) => {
						if (!signal.aborted && generation === sessionGeneration) codexUsage = normalizeCodexResetTimes(result);
					}),
				);
			}

			// Check OpenCode Go; passive model headers can defer probes, but dashboard quota still needs proactive fetches.
			const goQuotaState = getOpenCodeGoQuotaConfig();
			const skipGoCheck = trigger === "auto"
				&& passiveUpdateIsFresh(goPassiveAt)
				&& (!goQuotaState.config || (hasGoQuotaData(goUsage) && passiveUpdateIsFresh(goPassiveQuotaAt)))
				&& !goQuotaState.error;
			const goKey = skipGoCheck ? undefined : getOpenCodeApiKey();
			if (!skipGoCheck && (goKey || goQuotaState.config || goQuotaState.error)) {
				checks.push(
					checkOpenCodeGoUsage(goKey, goQuotaState, signal).then((result) => {
						if (!signal.aborted && generation === sessionGeneration) goUsage = normalizeGoResetTimes(result);
					}),
				);
			} else if (!skipGoCheck) {
				goUsage = undefined;
			}

			// Run checks in parallel
			await Promise.allSettled(checks);

			if (signal.aborted || generation !== sessionGeneration) {
				if (generation === sessionGeneration) {
					widgetLoading = false;
					renderCachedUsage(ctx, false);
					if (refreshTimedOut && trigger !== "auto") ctx.ui.notify("Usage check timed out", "warning");
				}
				return;
			}

			// Update display with results
			if (ctx.hasUI) {
				widgetLoading = false;
				renderCachedUsage(ctx, false);
				if (!isUsageWidgetEnabled(ctx) && trigger !== "auto") {
					ctx.ui.notify(buildStartupUsageMessage(codexUsage, goUsage, true), "info");
				}
			}
		} finally {
			clearTimeout(refreshTimeout);
			if (refreshController === controller) refreshController = undefined;
			widgetLoading = false;
			isLoading = false;
		}
	}

	function clearAutoRefreshTimer(): void {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	}

	function clearDisplayRefreshTimer(): void {
		if (displayTimer) {
			clearInterval(displayTimer);
			displayTimer = undefined;
		}
	}

	function clearStartupDelayTimer(): void {
		if (startupDelayTimer) {
			clearTimeout(startupDelayTimer);
			startupDelayTimer = undefined;
		}
	}

	function startAutoRefreshTimer(ctx: UsageContext, generation: number = sessionGeneration): void {
		if (!ctx.hasUI || !PROACTIVE_REFRESH_ENABLED) return;
		clearAutoRefreshTimer();
		refreshTimer = setInterval(() => {
			if (generation !== sessionGeneration) return;
			refreshUsage(ctx, "auto").catch(() => {});
		}, AUTO_REFRESH_MINUTES * 60 * 1000);
		unrefTimer(refreshTimer);
	}

	function startDisplayRefreshTimer(ctx: UsageContext, generation: number = sessionGeneration): void {
		if (!ctx.hasUI) return;
		clearDisplayRefreshTimer();
		displayTimer = setInterval(() => {
			if (generation !== sessionGeneration) return;
			renderCachedUsage(ctx, widgetLoading);
		}, UI_REFRESH_SECONDS * 1000);
		unrefTimer(displayTimer);
	}

	function startTimers(ctx: UsageContext, generation: number = sessionGeneration): void {
		startAutoRefreshTimer(ctx, generation);
		startDisplayRefreshTimer(ctx, generation);
	}

	// ── Passive provider response headers ──
	pi.on("after_provider_response", async (event, ctx) => {
		if (!ctx.hasUI) return;

		let updated = false;
		const provider = modelProvider(ctx);
		const id = modelId(ctx);

		if (provider === OPENAI_CODEX_PROVIDER || hasHeaderPrefix(event.headers, "x-codex-")) {
			const parsed = parseCodexUsageHeaders(event.headers, event.status);
			if (parsed) {
				codexUsage = normalizeCodexResetTimes(parsed);
				codexPassiveAt = Date.now();
				updated = true;
			}
		}

		if (provider === "opencode-go" || hasHeaderPrefix(event.headers, "x-opencode-go-")) {
			const parsed = parseOpenCodeGoUsageHeaders(event.headers, event.status, id, goUsage);
			if (parsed) {
				goUsage = normalizeGoResetTimes(parsed);
				goPassiveAt = Date.now();
				if (hasGoQuotaData(parsed)) goPassiveQuotaAt = goPassiveAt;
				updated = true;
			}
		}

		if (updated) {
			widgetLoading = false;
			renderCachedUsage(ctx, false);
		}
	});

	// ── Startup check + auto-refresh ──
	pi.on("session_start", async (event, ctx) => {
		const generation = ++sessionGeneration;
		if (!ctx.hasUI) return;

		if (PROACTIVE_REFRESH_ENABLED && (event.reason === "startup" || event.reason === "reload")) {
			// Block /usage during startup delay to avoid duplicate checks
			isLoading = true;
			clearStartupDelayTimer();
			// Small delay to let TUI settle, then refresh; start timers only after first check
			startupDelayTimer = setTimeout(() => {
				startupDelayTimer = undefined;
				if (generation !== sessionGeneration) return;
				isLoading = false;
				refreshUsage(ctx, "startup")
					.catch(() => {})
					.then(() => {
						if (generation === sessionGeneration) startTimers(ctx, generation);
					});
			}, 500);
			unrefTimer(startupDelayTimer);
		} else {
			startTimers(ctx, generation);
		}
	});

	pi.on("session_shutdown", async () => {
		sessionGeneration += 1;
		clearStartupDelayTimer();
		clearAutoRefreshTimer();
		clearDisplayRefreshTimer();
		refreshController?.abort();
		refreshController = undefined;
		widgetLoading = false;
		isLoading = false;
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show Codex & OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});
}

// ───────── Re-exported for testing ─────────

export { clampPercent, formatDuration, formatResetTime, parseHeaderBool, parseHeaderNumber, progressBar, statusIcon, truncate, usageColor } from "./src/format.ts";
export { dedupe, parseBoolValue, parseEnvBool, parseEnvInt, resolveConfigValue } from "./src/config.ts";
export { parseCodexUsageHeaders, windowMinutes, windowResetAfterSeconds, windowResetAt, windowUsedPercent } from "./src/codex.ts";
export { footerResetDuration, footerUsageColor } from "./src/render.ts";
export { isGlobalGoLimit, isPerModelUnavailable, parseOpenCodeGoUsageHeaders, resolveModelEndpoint } from "./src/opencode-go.ts";
