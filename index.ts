/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex, Anthropic, GitHub Copilot, OpenCode Go/Zen,
 * and compatible subscription usage limits at startup.
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
 *   OpenCode Zen / compatible providers: Uses API keys from auth.json/env
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnthropicUsage, CodexUsage, CopilotUsage, OpenCodeGoUsage, RefreshTrigger, SubscriptionUsage, UsageContext, UsageSnapshot } from "./src/types.ts";
import {
	ANTHROPIC_PROVIDER,
	AUTO_REFRESH_MINUTES,
	CHECK_TIMEOUT_MS,
	CODEX_RESPONSE_REFRESH_ENABLED,
	CODEX_RESPONSE_REFRESH_SECONDS,
	GITHUB_COPILOT_PROVIDER,
	NO_USAGE_WIDGET_FLAG,
	OPENAI_CODEX_PROVIDER,
	OPENCODE_GO_PROVIDER,
	PROACTIVE_REFRESH_ENABLED,
	UI_REFRESH_SECONDS,
	USAGE_WIDGET_FLAG,
	WIDGET_ID,
	getOpenCodeGoQuotaConfig,
	readUsageWidgetSetting,
} from "./src/config.ts";
import { hasHeaderPrefix } from "./src/headers.ts";
import { unrefTimer } from "./src/http.ts";
import { mergeConcurrentFields } from "./src/concurrent.ts";
import { getCodexToken, checkCodexUsage, checkCodexUsageFromUsageApi, parseCodexUsageHeaders } from "./src/codex.ts";
import { getAnthropicAuth, checkAnthropicUsage, parseAnthropicUsageHeaders } from "./src/anthropic.ts";
import { getCopilotAuth, checkCopilotUsage, parseCopilotUsageHeaders } from "./src/copilot.ts";
import { getOpenCodeApiKey, checkOpenCodeGoUsage, hasGoQuotaData, hasOpenCodeGoQuotaHeaders, parseOpenCodeGoUsageHeaders, reconcileOpenCodeGoRefresh } from "./src/opencode-go.ts";
import { checkSubscriptionProviderUsage, getSubscriptionApiKey, parseSubscriptionUsageHeaders } from "./src/subscription-probe.ts";
import { getSubscriptionProviderConfig, SUBSCRIPTION_PROVIDERS } from "./src/subscriptions.ts";
import {
	buildStartupUsageMessage,
	buildUsageWidget,
	updateFooterStatus,
} from "./src/render.ts";

// ───────── Reset-Time Normalization ─────────

function nowSeconds(): number {
	return Math.round(Date.now() / 1000);
}

function resetAtFromAfter(resetAt: number | undefined, resetAfterSeconds: number | undefined, nowSec: number): number | undefined {
	if (resetAt !== undefined && resetAt > 0) return resetAt;
	return resetAfterSeconds !== undefined && resetAfterSeconds > 0
		? nowSec + Math.round(resetAfterSeconds)
		: resetAt;
}

function normalizeWindowResets(windows: Array<{ resetAt?: number; resetAfterSeconds?: number } | undefined>, nowSec: number): void {
	for (const window of windows) {
		if (window) window.resetAt = resetAtFromAfter(window.resetAt, window.resetAfterSeconds, nowSec);
	}
}

function normalizeCodexResetTimes(usage: CodexUsage): CodexUsage {
	const nowSec = nowSeconds();
	usage.primaryResetAt = resetAtFromAfter(usage.primaryResetAt, usage.primaryResetAfterSeconds, nowSec) ?? 0;
	usage.secondaryResetAt = resetAtFromAfter(usage.secondaryResetAt, usage.secondaryResetAfterSeconds, nowSec) ?? 0;
	usage.codeReviewResetAt = resetAtFromAfter(usage.codeReviewResetAt, usage.codeReviewResetAfterSeconds, nowSec);
	return usage;
}

function normalizeAnthropicResetTimes(usage: AnthropicUsage): AnthropicUsage {
	const nowSec = nowSeconds();
	normalizeWindowResets([usage.fiveHour, usage.weekly], nowSec);
	usage.retryResetAt = resetAtFromAfter(usage.retryResetAt, usage.retryAfterSeconds, nowSec);
	return usage;
}

function normalizeCopilotResetTimes(usage: CopilotUsage): CopilotUsage {
	const nowSec = nowSeconds();
	normalizeWindowResets([usage.requests, usage.premiumRequests], nowSec);
	usage.retryResetAt = resetAtFromAfter(usage.retryResetAt, usage.retryAfterSeconds, nowSec);
	return usage;
}

/** Shared by OpenCode Go and the generic subscription providers. */
function normalizeSubscriptionResetTimes<T extends SubscriptionUsage>(usage: T): T {
	const nowSec = nowSeconds();
	normalizeWindowResets([usage.rolling, usage.weekly, usage.monthly], nowSec);
	usage.retryResetAt = resetAtFromAfter(usage.retryResetAt, usage.retryAfterSeconds, nowSec);
	return usage;
}

// ───────── Message Helpers ─────────

interface AssistantMessageLike {
	role?: string;
	provider?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
}

function isCodexResponseWithUsageData(message: unknown): boolean {
	const { role, provider, usage } = (message ?? {}) as AssistantMessageLike;
	if (role !== "assistant" || provider !== OPENAI_CODEX_PROVIDER || !usage) return false;
	return [usage.totalTokens, usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
		.some((value) => typeof value === "number" && value > 0);
}

// ───────── Timers ─────────

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/** Stop a timeout or interval (interchangeable in Node) and clear its slot. */
function stopTimer(timer: TimerHandle | undefined): undefined {
	if (timer !== undefined) clearInterval(timer);
	return undefined;
}

// ───────── Concurrent Refresh Merging ─────────

const CODEX_REFRESH_FIELDS = [
	"planType", "activeLimit",
	"primaryUsedPercent", "secondaryUsedPercent", "codeReviewUsedPercent",
	"primaryWindowMinutes", "secondaryWindowMinutes", "codeReviewWindowMinutes",
	"primaryResetAfterSeconds", "secondaryResetAfterSeconds", "codeReviewResetAfterSeconds",
	"primaryResetAt", "secondaryResetAt", "codeReviewResetAt",
	"primaryOverSecondaryLimitPercent",
	"creditsHasCredits", "creditsBalance", "creditsUnlimited",
] as const satisfies readonly (keyof CodexUsage)[];

const ANTHROPIC_REFRESH_FIELDS = [
	"authType", "fiveHour", "weekly", "checkedModels", "totalModels",
] as const satisfies readonly (keyof AnthropicUsage)[];

const COPILOT_REFRESH_FIELDS = [
	"requests", "premiumRequests", "availableModels", "checkedModels", "totalModels",
] as const satisfies readonly (keyof CopilotUsage)[];

const SUBSCRIPTION_REFRESH_FIELDS = [
	"rolling", "weekly", "monthly", "quotaSource", "checkedModels", "totalModels",
] as const satisfies readonly (keyof SubscriptionUsage)[];

const GO_REFRESH_FIELDS = [
	...SUBSCRIPTION_REFRESH_FIELDS, "quotaError",
] as const satisfies readonly (keyof OpenCodeGoUsage)[];

function codexRefreshIsAuthoritative(result: CodexUsage): boolean {
	return result.error === undefined || result.rateLimited;
}

function probeRefreshIsAuthoritative(result: { status: string }): boolean {
	return result.status !== "error";
}

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

	// Cached usage per provider.
	let codexUsage: CodexUsage | undefined;
	let anthropicUsage: AnthropicUsage | undefined;
	let copilotUsage: CopilotUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	const subscriptionUsages = new Map<string, SubscriptionUsage>();

	// Refresh bookkeeping.
	let isLoading = false;
	let widgetLoading = false;
	let refreshTimer: TimerHandle | undefined;
	let displayTimer: TimerHandle | undefined;
	let startupDelayTimer: TimerHandle | undefined;
	let codexResponseRefreshTimer: TimerHandle | undefined;
	let refreshController: AbortController | undefined;
	let codexResponseRefreshController: AbortController | undefined;
	let codexResponseDataTransferred = false;
	let codexResponseCleanTicks = 0;
	let codexUsageRequestAt = 0;
	let sessionGeneration = 0;

	// Timestamps and revisions of passive response-header updates, keyed by provider.
	const passiveHeadersAt = new Map<string, number>();
	const passiveHeaderRevisions = new Map<string, number>();
	const GO_QUOTA_PASSIVE_KEY = `${OPENCODE_GO_PROVIDER}:quota`;

	function passiveHeaderRevision(key: string): number {
		return passiveHeaderRevisions.get(key) ?? 0;
	}

	function markPassiveUpdate(key: string): void {
		passiveHeadersAt.set(key, Date.now());
		passiveHeaderRevisions.set(key, passiveHeaderRevision(key) + 1);
	}

	function passiveUpdateIsFresh(key: string): boolean {
		const at = passiveHeadersAt.get(key) ?? 0;
		return at > 0 && Date.now() - at < AUTO_REFRESH_MINUTES * 60 * 1000;
	}

	function isUsageWidgetEnabled(ctx: UsageContext): boolean {
		if (pi.getFlag(NO_USAGE_WIDGET_FLAG) === true) return false;
		if (pi.getFlag(USAGE_WIDGET_FLAG) === true) return true;
		return readUsageWidgetSetting(ctx) ?? false;
	}

	function subscriptionUsageList(): SubscriptionUsage[] {
		return SUBSCRIPTION_PROVIDERS
			.map((config) => subscriptionUsages.get(config.provider))
			.filter((usage): usage is SubscriptionUsage => usage !== undefined);
	}

	function currentSnapshot(): UsageSnapshot {
		return {
			codex: codexUsage,
			anthropic: anthropicUsage,
			copilot: copilotUsage,
			go: goUsage,
			subscriptions: subscriptionUsageList(),
		};
	}

	function renderCachedUsage(ctx: UsageContext, loading = false): void {
		if (!ctx.hasUI) return;
		const snapshot = currentSnapshot();
		if (isUsageWidgetEnabled(ctx)) {
			ctx.ui.setWidget(WIDGET_ID, buildUsageWidget(snapshot, ctx.ui.theme, loading));
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		updateFooterStatus(ctx, snapshot);
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

		const passiveRevision = passiveHeaderRevision(OPENAI_CODEX_PROVIDER);
		const before = codexUsage;
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
					const usage = passiveHeaderRevision(OPENAI_CODEX_PROVIDER) === passiveRevision
						? result.usage
						: mergeConcurrentFields(result.usage, before, codexUsage, CODEX_REFRESH_FIELDS);
					codexUsage = normalizeCodexResetTimes(usage);
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
			renderCachedUsage(ctx, widgetLoading);
			if (showStartupReport) ctx.ui.notify("⚡ Checking usage limits...", "info");

			const checks: Promise<void>[] = [];
			const signal = controller.signal;

			// Run a check in parallel. If passive headers arrive first, preserve their
			// status while still accepting independently refreshed quota fields.
			const runCheck = <T extends object>(
				provider: string,
				check: Promise<T>,
				current: () => T | undefined,
				refreshFields: readonly (keyof T)[],
				apply: (result: T) => void,
				resultIsAuthoritative: (result: T) => boolean,
				reconcileResult?: (result: T, merged: T) => T,
			): void => {
				const passiveRevision = passiveHeaderRevision(provider);
				const before = current();
				checks.push(check.then((result) => {
					if (signal.aborted || generation !== sessionGeneration) return;
					const merged = passiveHeaderRevision(provider) === passiveRevision
						? result
						: mergeConcurrentFields(
							result,
							before,
							current(),
							refreshFields,
							resultIsAuthoritative(result),
						);
					apply(reconcileResult ? reconcileResult(result, merged) : merged);
				}));
			};

			// Prefer probing the currently selected model so reported limits match its tier.
			const selected = ctx.model;
			const preferredFor = (provider: string) => selected?.provider === provider ? selected : undefined;

			// Check Codex; activity scheduler or recent passive headers defer auto probes.
			const skipCodexCheck = trigger === "auto"
				&& (CODEX_RESPONSE_REFRESH_ENABLED || passiveUpdateIsFresh(OPENAI_CODEX_PROVIDER) || recentCodexUsageRequest());
			const codexAuth = skipCodexCheck ? undefined : await getCodexToken();
			if (codexAuth) {
				codexUsageRequestAt = Date.now();
				codexResponseCleanTicks = 0;
				runCheck(
					OPENAI_CODEX_PROVIDER,
					checkCodexUsage(codexAuth.token, codexAuth.accountId, signal),
					() => codexUsage,
					CODEX_REFRESH_FIELDS,
					(result) => { codexUsage = normalizeCodexResetTimes(result); },
					codexRefreshIsAuthoritative,
				);
			}

			// Check Anthropic Claude Pro/Max; recent passive headers defer auto probes.
			const skipAnthropicCheck = trigger === "auto" && passiveUpdateIsFresh(ANTHROPIC_PROVIDER);
			const anthropicAuth = skipAnthropicCheck ? undefined : await getAnthropicAuth();
			if (anthropicAuth) {
				runCheck(
					ANTHROPIC_PROVIDER,
					checkAnthropicUsage(anthropicAuth, signal, selected),
					() => anthropicUsage,
					ANTHROPIC_REFRESH_FIELDS,
					(result) => { anthropicUsage = normalizeAnthropicResetTimes(result); },
					probeRefreshIsAuthoritative,
				);
			} else if (!skipAnthropicCheck) {
				anthropicUsage = undefined;
			}

			// Check GitHub Copilot; recent passive headers defer auto probes.
			const skipCopilotCheck = trigger === "auto" && passiveUpdateIsFresh(GITHUB_COPILOT_PROVIDER);
			const copilotAuth = skipCopilotCheck ? undefined : await getCopilotAuth();
			if (copilotAuth) {
				runCheck(
					GITHUB_COPILOT_PROVIDER,
					checkCopilotUsage(copilotAuth, signal, selected),
					() => copilotUsage,
					COPILOT_REFRESH_FIELDS,
					(result) => { copilotUsage = normalizeCopilotResetTimes(result); },
					probeRefreshIsAuthoritative,
				);
			} else if (!skipCopilotCheck) {
				copilotUsage = undefined;
			}

			// Check OpenCode Go; passive model headers can defer probes, but dashboard quota still needs proactive fetches.
			const goQuotaState = getOpenCodeGoQuotaConfig();
			const skipGoCheck = trigger === "auto"
				&& passiveUpdateIsFresh(OPENCODE_GO_PROVIDER)
				&& (!goQuotaState.config || (hasGoQuotaData(goUsage) && passiveUpdateIsFresh(GO_QUOTA_PASSIVE_KEY)))
				&& !goQuotaState.error;
			const goKey = skipGoCheck ? undefined : getOpenCodeApiKey();
			if (!skipGoCheck && (goKey || goQuotaState.config || goQuotaState.error)) {
				runCheck(
					OPENCODE_GO_PROVIDER,
					checkOpenCodeGoUsage(goKey, goQuotaState, signal, preferredFor(OPENCODE_GO_PROVIDER)),
					() => goUsage,
					GO_REFRESH_FIELDS,
					(result) => { goUsage = normalizeSubscriptionResetTimes(result); },
					probeRefreshIsAuthoritative,
					reconcileOpenCodeGoRefresh,
				);
			} else if (!skipGoCheck) {
				goUsage = undefined;
			}

			// Check other OpenAI/Anthropic-compatible subscription providers.
			for (const providerConfig of SUBSCRIPTION_PROVIDERS) {
				if (trigger === "auto" && passiveUpdateIsFresh(providerConfig.provider)) continue;
				const apiKey = getSubscriptionApiKey(providerConfig);
				if (!apiKey) {
					subscriptionUsages.delete(providerConfig.provider);
					continue;
				}
				runCheck(
					providerConfig.provider,
					checkSubscriptionProviderUsage(providerConfig, apiKey, signal, preferredFor(providerConfig.provider)),
					() => subscriptionUsages.get(providerConfig.provider),
					SUBSCRIPTION_REFRESH_FIELDS,
					(result) => {
						if (result.status === "no_key") {
							subscriptionUsages.delete(providerConfig.provider);
						} else {
							subscriptionUsages.set(providerConfig.provider, normalizeSubscriptionResetTimes(result));
						}
					},
					probeRefreshIsAuthoritative,
				);
			}

			await Promise.allSettled(checks);

			if (generation !== sessionGeneration) return;

			// Update display with results.
			widgetLoading = false;
			renderCachedUsage(ctx, false);
			if (signal.aborted) {
				if (refreshTimedOut && trigger !== "auto") ctx.ui.notify("Usage check timed out", "warning");
				return;
			}
			if (!isUsageWidgetEnabled(ctx) && trigger !== "auto") {
				ctx.ui.notify(buildStartupUsageMessage(currentSnapshot(), true), "info");
			}
		} finally {
			clearTimeout(refreshTimeout);
			if (refreshController === controller) refreshController = undefined;
			widgetLoading = false;
			isLoading = false;
		}
	}

	function startTimers(ctx: UsageContext, generation: number = sessionGeneration): void {
		if (!ctx.hasUI) return;

		if (PROACTIVE_REFRESH_ENABLED) {
			refreshTimer = stopTimer(refreshTimer);
			refreshTimer = setInterval(() => {
				if (generation !== sessionGeneration) return;
				refreshUsage(ctx, "auto").catch(() => {});
			}, AUTO_REFRESH_MINUTES * 60 * 1000);
			unrefTimer(refreshTimer);
		}

		displayTimer = stopTimer(displayTimer);
		displayTimer = setInterval(() => {
			if (generation !== sessionGeneration) return;
			renderCachedUsage(ctx, widgetLoading);
		}, UI_REFRESH_SECONDS * 1000);
		unrefTimer(displayTimer);

		if (CODEX_RESPONSE_REFRESH_ENABLED) {
			codexResponseRefreshTimer = stopTimer(codexResponseRefreshTimer);
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
				if (passiveUpdateIsFresh(OPENAI_CODEX_PROVIDER) || recentCodexUsageRequest()) return;
				refreshCodexUsageFromSchedule(ctx, generation);
			}, CODEX_RESPONSE_REFRESH_SECONDS * 1000);
			unrefTimer(codexResponseRefreshTimer);
		}
	}

	// ── Passive provider response headers ──
	pi.on("after_provider_response", async (event, ctx) => {
		if (!ctx.hasUI) return;

		let updated = false;
		const provider = ctx.model?.provider;
		const modelId = ctx.model?.id;

		if (provider === OPENAI_CODEX_PROVIDER || hasHeaderPrefix(event.headers, "x-codex-")) {
			const parsed = parseCodexUsageHeaders(event.headers, event.status, codexUsage);
			if (parsed) {
				codexUsage = normalizeCodexResetTimes(parsed);
				markPassiveUpdate(OPENAI_CODEX_PROVIDER);
				updated = true;
			}
		}

		if (provider === ANTHROPIC_PROVIDER) {
			const parsed = parseAnthropicUsageHeaders(event.headers, event.status, modelId, anthropicUsage);
			if (parsed) {
				anthropicUsage = normalizeAnthropicResetTimes(parsed);
				markPassiveUpdate(ANTHROPIC_PROVIDER);
				updated = true;
			}
		}

		if (provider === GITHUB_COPILOT_PROVIDER) {
			const parsed = parseCopilotUsageHeaders(event.headers, event.status, modelId, copilotUsage);
			if (parsed) {
				copilotUsage = normalizeCopilotResetTimes(parsed);
				markPassiveUpdate(GITHUB_COPILOT_PROVIDER);
				updated = true;
			}
		}

		if (provider === OPENCODE_GO_PROVIDER || hasHeaderPrefix(event.headers, "x-opencode-go-")) {
			const parsed = parseOpenCodeGoUsageHeaders(event.headers, event.status, modelId, goUsage);
			if (parsed) {
				goUsage = normalizeSubscriptionResetTimes(parsed);
				markPassiveUpdate(OPENCODE_GO_PROVIDER);
				if (hasOpenCodeGoQuotaHeaders(event.headers)) markPassiveUpdate(GO_QUOTA_PASSIVE_KEY);
				updated = true;
			}
		}

		const subscriptionConfig = getSubscriptionProviderConfig(provider);
		if (subscriptionConfig) {
			const previous = subscriptionUsages.get(subscriptionConfig.provider);
			const parsed = parseSubscriptionUsageHeaders(subscriptionConfig, event.headers, event.status, modelId, previous);
			if (parsed) {
				subscriptionUsages.set(subscriptionConfig.provider, normalizeSubscriptionResetTimes(parsed));
				markPassiveUpdate(subscriptionConfig.provider);
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
		if (isCodexResponseWithUsageData(event.message)) codexResponseDataTransferred = true;
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
			startupDelayTimer = stopTimer(startupDelayTimer);
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
		startupDelayTimer = stopTimer(startupDelayTimer);
		refreshTimer = stopTimer(refreshTimer);
		displayTimer = stopTimer(displayTimer);
		codexResponseRefreshTimer = stopTimer(codexResponseRefreshTimer);
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
		description: "Refresh and show Codex, Anthropic, Copilot, OpenCode, and compatible subscription usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});
}
