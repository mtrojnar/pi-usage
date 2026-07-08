/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex, Anthropic, GitHub Copilot, and OpenCode Go usage limits at startup.
 * Displays a startup report by default; persistent widget is opt-in.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   Anthropic:    Uses OAuth token/API key from pi's auth.json or env
 *   Copilot:      Uses OAuth token from pi's auth.json (same as github-copilot provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AnthropicUsage, CodexUsage, CopilotUsage, OpenCodeGoUsage, RefreshTrigger, UsageContext } from "./src/types.ts";
import {
	AUTO_REFRESH_MINUTES,
	CHECK_TIMEOUT_MS,
	PROACTIVE_REFRESH_ENABLED,
	UI_REFRESH_SECONDS,
	NO_USAGE_WIDGET_FLAG,
	USAGE_WIDGET_FLAG,
	WIDGET_ID,
	OPENAI_CODEX_PROVIDER,
	ANTHROPIC_PROVIDER,
	GITHUB_COPILOT_PROVIDER,
	CODEX_RESPONSE_REFRESH_ENABLED,
	CODEX_RESPONSE_REFRESH_SECONDS,
	getOpenCodeGoQuotaConfig,
	readUsageWidgetSetting,
} from "./src/config.ts";
import { getCodexToken, checkCodexUsage, checkCodexUsageFromUsageApi, parseCodexUsageHeaders } from "./src/codex.ts";
import { getAnthropicAuth, checkAnthropicUsage, parseAnthropicUsageHeaders } from "./src/anthropic.ts";
import { getCopilotAuth, checkCopilotUsage, parseCopilotUsageHeaders } from "./src/copilot.ts";
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
	let anthropicUsage: AnthropicUsage | undefined;
	let copilotUsage: CopilotUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let widgetLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;
	let startupDelayTimer: ReturnType<typeof setTimeout> | undefined;
	let codexResponseRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshController: AbortController | undefined;
	let codexResponseRefreshController: AbortController | undefined;
	let codexResponseDataTransferred = false;
	let codexResponseCleanTicks = 0;
	let codexUsageRequestAt = 0;
	let codexPassiveAt = 0;
	let anthropicPassiveAt = 0;
	let copilotPassiveAt = 0;
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
				buildUsageWidget(codexUsage, goUsage, theme, loading, anthropicUsage, copilotUsage),
			);
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		updateFooterStatus(ctx, codexUsage, goUsage, anthropicUsage, copilotUsage);
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

	function normalizeAnthropicResetTimes(usage: AnthropicUsage): AnthropicUsage {
		const nowSec = Math.round(Date.now() / 1000);
		if (usage.requests) usage.requests.resetAt = resetAtFromAfter(usage.requests.resetAt, usage.requests.resetAfterSeconds, nowSec);
		if (usage.tokens) usage.tokens.resetAt = resetAtFromAfter(usage.tokens.resetAt, usage.tokens.resetAfterSeconds, nowSec);
		if (usage.inputTokens) usage.inputTokens.resetAt = resetAtFromAfter(usage.inputTokens.resetAt, usage.inputTokens.resetAfterSeconds, nowSec);
		if (usage.outputTokens) usage.outputTokens.resetAt = resetAtFromAfter(usage.outputTokens.resetAt, usage.outputTokens.resetAfterSeconds, nowSec);
		usage.retryResetAt = resetAtFromAfter(usage.retryResetAt, usage.retryAfterSeconds, nowSec);
		return usage;
	}

	function normalizeCopilotResetTimes(usage: CopilotUsage): CopilotUsage {
		const nowSec = Math.round(Date.now() / 1000);
		if (usage.requests) usage.requests.resetAt = resetAtFromAfter(usage.requests.resetAt, usage.requests.resetAfterSeconds, nowSec);
		if (usage.premiumRequests) usage.premiumRequests.resetAt = resetAtFromAfter(usage.premiumRequests.resetAt, usage.premiumRequests.resetAfterSeconds, nowSec);
		usage.retryResetAt = resetAtFromAfter(usage.retryResetAt, usage.retryAfterSeconds, nowSec);
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

	function messageRole(message: unknown): string | undefined {
		return (message as { role?: string } | undefined)?.role;
	}

	function messageProvider(message: unknown): string | undefined {
		return (message as { provider?: string } | undefined)?.provider;
	}

	function messageHasTransferredUsageData(message: unknown): boolean {
		const usage = (message as {
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
		} | undefined)?.usage;
		if (!usage) return false;
		return [usage.totalTokens, usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
			.some((value) => typeof value === "number" && value > 0);
	}

	function recentCodexUsageRequest(maxAgeSeconds = CODEX_RESPONSE_REFRESH_SECONDS): boolean {
		return codexUsageRequestAt > 0 && Date.now() - codexUsageRequestAt < maxAgeSeconds * 1000;
	}

	function codexResponseIdleRefreshTicks(): number {
		return Math.max(1, Math.ceil((AUTO_REFRESH_MINUTES * 60) / CODEX_RESPONSE_REFRESH_SECONDS));
	}

	function refreshCodexUsageFromSchedule(ctx: UsageContext, generation: number = sessionGeneration): void {
		if (!ctx.hasUI || !CODEX_RESPONSE_REFRESH_ENABLED) return;
		if (generation !== sessionGeneration || recentCodexUsageRequest()) return;

		codexResponseRefreshController?.abort();
		const controller = new AbortController();
		codexResponseRefreshController = controller;

		void (async () => {
			try {
				const codexAuth = await getCodexToken();
				if (!codexAuth || controller.signal.aborted || generation !== sessionGeneration) return;

				codexUsageRequestAt = Date.now();
				codexResponseCleanTicks = 0;
				const result = await checkCodexUsageFromUsageApi(codexAuth.token, codexAuth.accountId, controller.signal);
				if (result.success && !controller.signal.aborted && generation === sessionGeneration) {
					codexUsage = normalizeCodexResetTimes(result.usage);
					widgetLoading = false;
					renderCachedUsage(ctx, false);
				}
			} catch {
				// Best-effort scheduled refresh; keep cached values on failure.
			} finally {
				if (codexResponseRefreshController === controller) codexResponseRefreshController = undefined;
			}
		})();
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

			// Check Codex; activity scheduler or recent passive headers defer auto probes.
			const skipCodexCheck = trigger === "auto" && (CODEX_RESPONSE_REFRESH_ENABLED || passiveUpdateIsFresh(codexPassiveAt) || recentCodexUsageRequest());
			const codexAuth = skipCodexCheck ? undefined : await getCodexToken();
			if (codexAuth) {
				codexUsageRequestAt = Date.now();
				codexResponseCleanTicks = 0;
				checks.push(
					checkCodexUsage(codexAuth.token, codexAuth.accountId, signal).then((result) => {
						if (!signal.aborted && generation === sessionGeneration) codexUsage = normalizeCodexResetTimes(result);
					}),
				);
			}

			// Check Anthropic Claude Pro/Max; recent passive headers defer auto probes.
			const skipAnthropicCheck = trigger === "auto" && passiveUpdateIsFresh(anthropicPassiveAt);
			const anthropicAuth = skipAnthropicCheck ? undefined : await getAnthropicAuth();
			if (anthropicAuth) {
				checks.push(
					checkAnthropicUsage(anthropicAuth, signal).then((result) => {
						if (!signal.aborted && generation === sessionGeneration) anthropicUsage = normalizeAnthropicResetTimes(result);
					}),
				);
			} else if (!skipAnthropicCheck) {
				anthropicUsage = undefined;
			}

			// Check GitHub Copilot; recent passive headers defer auto probes.
			const skipCopilotCheck = trigger === "auto" && passiveUpdateIsFresh(copilotPassiveAt);
			const copilotAuth = skipCopilotCheck ? undefined : await getCopilotAuth();
			if (copilotAuth) {
				checks.push(
					checkCopilotUsage(copilotAuth, signal).then((result) => {
						if (!signal.aborted && generation === sessionGeneration) copilotUsage = normalizeCopilotResetTimes(result);
					}),
				);
			} else if (!skipCopilotCheck) {
				copilotUsage = undefined;
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
					ctx.ui.notify(buildStartupUsageMessage(codexUsage, goUsage, true, anthropicUsage, copilotUsage), "info");
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

	function clearCodexResponseRefreshTimer(): void {
		if (codexResponseRefreshTimer) {
			clearInterval(codexResponseRefreshTimer);
			codexResponseRefreshTimer = undefined;
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

	function startCodexResponseRefreshTimer(ctx: UsageContext, generation: number = sessionGeneration): void {
		if (!ctx.hasUI || !CODEX_RESPONSE_REFRESH_ENABLED) return;
		clearCodexResponseRefreshTimer();
		codexResponseRefreshTimer = setInterval(() => {
			if (generation !== sessionGeneration) return;

			if (codexResponseDataTransferred) {
				if (recentCodexUsageRequest()) return;
				codexResponseDataTransferred = false;
				codexResponseCleanTicks = 0;
				refreshCodexUsageFromSchedule(ctx, generation);
				return;
			}

			codexResponseCleanTicks += 1;
			if (codexResponseCleanTicks < codexResponseIdleRefreshTicks()) return;
			codexResponseCleanTicks = 0;
			if (passiveUpdateIsFresh(codexPassiveAt) || recentCodexUsageRequest()) return;
			refreshCodexUsageFromSchedule(ctx, generation);
		}, CODEX_RESPONSE_REFRESH_SECONDS * 1000);
		unrefTimer(codexResponseRefreshTimer);
	}

	function startTimers(ctx: UsageContext, generation: number = sessionGeneration): void {
		startAutoRefreshTimer(ctx, generation);
		startDisplayRefreshTimer(ctx, generation);
		startCodexResponseRefreshTimer(ctx, generation);
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

		if (provider === ANTHROPIC_PROVIDER) {
			const parsed = parseAnthropicUsageHeaders(event.headers, event.status, id, anthropicUsage);
			if (parsed) {
				anthropicUsage = normalizeAnthropicResetTimes(parsed);
				anthropicPassiveAt = Date.now();
				updated = true;
			}
		}

		if (provider === GITHUB_COPILOT_PROVIDER) {
			const parsed = parseCopilotUsageHeaders(event.headers, event.status, id, copilotUsage);
			if (parsed) {
				copilotUsage = normalizeCopilotResetTimes(parsed);
				copilotPassiveAt = Date.now();
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

	// ── Mark Codex activity; refresh usage at most once per activity window ──
	pi.on("message_end", (event, ctx) => {
		if (!ctx.hasUI || !CODEX_RESPONSE_REFRESH_ENABLED) return;
		if (messageRole(event.message) !== "assistant") return;
		if (messageProvider(event.message) !== OPENAI_CODEX_PROVIDER) return;
		if (!messageHasTransferredUsageData(event.message)) return;
		codexResponseDataTransferred = true;
	});

	// ── Startup check + auto-refresh ──
	pi.on("session_start", async (event, ctx) => {
		const generation = ++sessionGeneration;
		codexResponseDataTransferred = false;
		codexResponseCleanTicks = 0;
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
		clearCodexResponseRefreshTimer();
		codexResponseDataTransferred = false;
		codexResponseCleanTicks = 0;
		refreshController?.abort();
		refreshController = undefined;
		codexResponseRefreshController?.abort();
		codexResponseRefreshController = undefined;
		widgetLoading = false;
		isLoading = false;
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show Codex, Anthropic, Copilot, and OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});
}

// ───────── Re-exported for testing ─────────

export { clampPercent, formatDuration, formatResetTime, parseHeaderBool, parseHeaderNumber, progressBar, statusIcon, truncate, usageColor } from "./src/format.ts";
export { dedupe, parseBoolValue, parseEnvBool, parseEnvInt, resolveConfigValue } from "./src/config.ts";
export { parseCodexUsageHeaders, windowMinutes, windowResetAfterSeconds, windowResetAt, windowUsedPercent } from "./src/codex.ts";
export { isAnthropicModelUnavailable, parseAnthropicResetAt, parseAnthropicUsageHeaders } from "./src/anthropic.ts";
export { getCopilotBaseUrl, isCopilotModelUnavailable, isCopilotQuotaMessage, normalizeCopilotDomain, parseCopilotResetAt, parseCopilotUsageHeaders } from "./src/copilot.ts";
export { footerResetDuration, footerUsageColor } from "./src/render.ts";
export { isGlobalGoLimit, isPerModelUnavailable, parseOpenCodeGoUsageHeaders, resolveModelEndpoint } from "./src/opencode-go.ts";
