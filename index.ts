/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex, Anthropic, GitHub Copilot, OpenCode Go/Zen, ClinePass,
 * compatible subscription usage limits, and OpenRouter spending at startup.
 * Displays a startup report by default; persistent widget is opt-in.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   Anthropic:    Uses OAuth token/API key from pi's auth.json or env
 *   Copilot:      Uses OAuth token from pi's auth.json (same as github-copilot provider)
 *   ClinePass:    Uses pi-resolved clinepass auth (CLINE_API_KEY or WorkOS
 *                 OAuth access token) for the quota endpoint; official origin only
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 *   OpenCode Zen / compatible providers: Uses API keys from auth.json/env
 *   OpenRouter:   Uses resolved pi auth for daily spend, key budgets, and account credits
 */

import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnthropicUsage, CodexUsage, CopilotUsage, OpenCodeGoUsage, OpenRouterUsage, RefreshTrigger, SubscriptionUsage, UsageContext, UsageSnapshot } from "./src/types.ts";
import {
	ANTHROPIC_PROVIDER,
	CHECK_TIMEOUT_MS,
	CODEX_RESPONSE_REFRESH_ENABLED,
	CODEX_RESPONSE_REFRESH_SECONDS,
	EXPIRED_REFRESH_DEBOUNCE_MS,
	GITHUB_COPILOT_PROVIDER,
	NO_USAGE_WIDGET_FLAG,
	OPENAI_CODEX_PROVIDER,
	OPENCODE_GO_PROVIDER,
	PROACTIVE_REFRESH_ENABLED,
	USAGE_CONFIG_FILE,
	USAGE_WIDGET_FLAG,
	WIDGET_ID,
	effectiveRefreshMinutes,
	effectiveUiRefreshSeconds,
	getOpenCodeGoQuotaConfig,
	readJsonObject,
	readProviderDisplayPrefs,
	readUsageWidgetSetting,
	usageConfigPath,
} from "./src/config.ts";
import { wrapSelect } from "./src/wrap-select.ts";
import {
	applyOrderPosition,
	applyUsageConfigChange,
	canonicalProviderName,
	canonicalUsageConfigKey,
	menuProviderEntries,
	normalizeUsageConfigValue,
	orderRows,
	orderRowValue,
	parseUsageConfigArgs,
	resetUsageConfigFile,
	toggleInList,
	USAGE_MENU_KEYS,
	usageMenuRowValues,
	toggleRows,
	toggleRowValue,
	usageConfigKeyKind,
	usageConfigOptions,
	USAGE_CONFIG_KEYS,
} from "./src/usage-config.ts";
import { checkOpenRouterUsage, getOpenRouterAuth, OPENROUTER_PROVIDER } from "./src/openrouter.ts";
import { hasHeaderPrefix } from "./src/headers.ts";
import { quotaWindowIsExpired } from "./src/format.ts";
import { unrefTimer } from "./src/http.ts";
import { mergeConcurrentFields, runIsolatedTask } from "./src/concurrent.ts";
import { getCodexToken, checkCodexUsage, checkCodexUsageFromUsageApi, parseCodexUsageHeaders } from "./src/codex.ts";
import { getAnthropicAuth, checkAnthropicUsage, parseAnthropicUsageHeaders } from "./src/anthropic.ts";
import { getCopilotAuth, checkCopilotUsage, parseCopilotUsageHeaders } from "./src/copilot.ts";
import {
	checkOpenCodeGoUsage,
	getOpenCodeAuth,
	getOpenCodeGoQuotaHeaderWindows,
	hasCompleteGoQuotaData,
	parseOpenCodeGoUsageHeaders,
	reconcileOpenCodeGoRefresh,
} from "./src/opencode-go.ts";
import {
	checkSubscriptionProviderUsage,
	getSubscriptionAuth,
	parseSubscriptionUsageHeaders,
	QUOTA_WINDOW_KINDS,
	type QuotaWindowKind,
} from "./src/subscription-probe.ts";
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

function subscriptionHasExpiredWindows(usage?: SubscriptionUsage): boolean {
	return usage !== undefined
		&& [usage.rolling, usage.weekly, usage.monthly].some(quotaWindowIsExpired);
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

function goQuotaPassiveKey(window: QuotaWindowKind): string {
	return `${OPENCODE_GO_PROVIDER}:quota:${window}`;
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
	let openrouterUsage: OpenRouterUsage | undefined;
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
	const expiredRefreshAt = new Map<string, number>();

	// Quota freshness defers auto checks; every parsed state update advances the
	// revision so in-flight checks cannot overwrite newer availability changes.
	const passiveHeadersAt = new Map<string, number>();
	const passiveHeaderRevisions = new Map<string, number>();

	function passiveHeaderRevision(key: string): number {
		return passiveHeaderRevisions.get(key) ?? 0;
	}

	function markPassiveUpdate(key: string, hasSignal = true): void {
		if (hasSignal) passiveHeadersAt.set(key, Date.now());
		passiveHeaderRevisions.set(key, passiveHeaderRevision(key) + 1);
	}

	function passiveUpdateIsFresh(key: string): boolean {
		const at = passiveHeadersAt.get(key) ?? 0;
		return at > 0 && Date.now() - at < effectiveRefreshMinutes() * 60 * 1000;
	}

	function goQuotaUpdateIsFresh(): boolean {
		return hasCompleteGoQuotaData(goUsage)
			&& QUOTA_WINDOW_KINDS.every((window) => passiveUpdateIsFresh(goQuotaPassiveKey(window)));
	}

	/** Return only providers whose expired windows are due for another check. */
	function expiredProvidersNeedingRefresh(now: number): Set<string> {
		const providers = new Set<string>();
		if (subscriptionHasExpiredWindows(goUsage)) providers.add(OPENCODE_GO_PROVIDER);
		if ([openrouterUsage?.budget, { resetAt: openrouterUsage?.dailyResetAt }].some(quotaWindowIsExpired)) {
			providers.add(OPENROUTER_PROVIDER);
		}
		if ([anthropicUsage?.fiveHour, anthropicUsage?.weekly].some(quotaWindowIsExpired)) providers.add(ANTHROPIC_PROVIDER);
		if ([copilotUsage?.requests, copilotUsage?.premiumRequests].some(quotaWindowIsExpired)) providers.add(GITHUB_COPILOT_PROVIDER);
		for (const usage of subscriptionUsageList()) {
			if (subscriptionHasExpiredWindows(usage)) providers.add(usage.provider);
		}
		for (const provider of providers) {
			const at = expiredRefreshAt.get(provider);
			if (at !== undefined && now - at < EXPIRED_REFRESH_DEBOUNCE_MS) providers.delete(provider);
		}
		return providers;
	}

	function formatUsageConfigReport(ctx: UsageContext, projectFile?: string): string {
		const display = readProviderDisplayPrefs(ctx);
		const widget = readUsageWidgetSetting(ctx);
		const globalConfig = readJsonObject(usageConfigPath()) ?? {};
		const envRefresh = process.env.PI_USAGE_REFRESH_MIN !== undefined;
		const envUi = process.env.PI_USAGE_UI_REFRESH_SEC !== undefined;
		const lines = [
			`pi-usage settings (${usageConfigPath()}${projectFile ? ` + ${projectFile}` : ""}):`,
			`  showWidget = ${JSON.stringify(widget ?? false)}${pi.getFlag(USAGE_WIDGET_FLAG) === true ? " (--usage-widget flag on)" : pi.getFlag(NO_USAGE_WIDGET_FLAG) === true ? " (--no-usage-widget flag on)" : ""}`,
			`  showStatusLine = ${display.showStatusLine}`,
			`  hideUnconfiguredProviders = ${display.hideUnconfiguredProviders}`,
			`  compactWidget = ${display.compactWidget}`,
			`  quotaDisplay = ${display.quotaDisplay} (percentages read as quota ${display.quotaDisplay})`,
			`  visibleProviders = ${display.visibleProviders.length > 0 ? display.visibleProviders.join(", ") : "(all)"}`,
			`  hiddenProviders = ${display.hiddenProviders.length > 0 ? display.hiddenProviders.join(", ") : "(none)"}`,
			`  providerOrder = ${display.providerOrder.length > 0 ? display.providerOrder.join(", ") : "(default)"}`,
			`  refreshMinutes = ${effectiveRefreshMinutes()}${envRefresh ? " (from PI_USAGE_REFRESH_MIN)" : globalConfig.refreshMinutes !== undefined ? " (from pi-usage.json)" : " (default)"} — applies after reload`,
			`  uiRefreshSeconds = ${effectiveUiRefreshSeconds()}${envUi ? " (from PI_USAGE_UI_REFRESH_SEC)" : globalConfig.uiRefreshSeconds !== undefined ? " (from pi-usage.json)" : " (default)"} — applies after reload`,
		];
		return lines.join("\n");
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
			openrouter: openrouterUsage,
			anthropic: anthropicUsage,
			copilot: copilotUsage,
			go: goUsage,
			subscriptions: subscriptionUsageList(),
		};
	}

	function renderCachedUsage(ctx: UsageContext, loading = false): void {
		if (!ctx.hasUI) return;
		const snapshot = currentSnapshot();
		const display = readProviderDisplayPrefs(ctx);
		if (isUsageWidgetEnabled(ctx)) {
			ctx.ui.setWidget(WIDGET_ID, buildUsageWidget(snapshot, ctx.ui.theme, loading, display));
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
		updateFooterStatus(ctx, snapshot, display);
	}

	function recentCodexUsageRequest(maxAgeSeconds = CODEX_RESPONSE_REFRESH_SECONDS): boolean {
		return codexUsageRequestAt > 0 && Date.now() - codexUsageRequestAt < maxAgeSeconds * 1000;
	}

	function codexResponseIdleRefreshTicks(): number {
		return Math.max(1, Math.ceil((effectiveRefreshMinutes() * 60) / CODEX_RESPONSE_REFRESH_SECONDS));
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
				const codexAuth = await getCodexToken(ctx);
				if (!codexAuth || controller.signal.aborted || generation !== sessionGeneration) return;

				codexUsageRequestAt = Date.now();
				codexResponseCleanTicks = 0;
				const result = await checkCodexUsageFromUsageApi(codexAuth.token, codexAuth.accountId, controller.signal, codexAuth.baseUrl);
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

	async function refreshUsage(
		ctx: UsageContext,
		trigger: RefreshTrigger = "manual",
		providers?: ReadonlySet<string>,
	): Promise<void> {
		if (!ctx.hasUI) return;
		if (isLoading) {
			if (trigger !== "auto") ctx.ui.notify("Usage check already in progress", "info");
			return;
		}
		isLoading = true;
		const generation = sessionGeneration;
		const controller = new AbortController();
		let refreshTimedOut = false;
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

			// Resolve auth and check each provider behind an independent deadline. A
			// stalled auth resolver or request must not delay or cancel its peers.
			const runCheck = <T extends object>(
				provider: string,
				check: (providerSignal: AbortSignal) => Promise<T | undefined>,
				current: () => T | undefined,
				refreshFields: readonly (keyof T)[],
				apply: (result: T) => void,
				resultIsAuthoritative: (result: T) => boolean,
				reconcileResult?: (result: T, merged: T) => T,
				onUnavailable?: () => void,
			): void => {
				if (providers && !providers.has(provider)) return;
				const passiveRevision = passiveHeaderRevision(provider);
				const before = current();
				checks.push(runIsolatedTask(check, CHECK_TIMEOUT_MS * 2, signal).then((outcome) => {
					if (signal.aborted || generation !== sessionGeneration) return;
					if (outcome.status === "timed_out") {
						refreshTimedOut = true;
					} else if (outcome.status === "fulfilled") {
						const result = outcome.value;
						if (!result) {
							if (passiveHeaderRevision(provider) === passiveRevision) onUnavailable?.();
						} else {
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
						}
					}
					// Expose completed providers while slower checks are still running.
					renderCachedUsage(ctx, widgetLoading);
				}));
			};

			// Prefer probing the currently selected model so reported limits match its tier.
			const selected = ctx.model;
			const preferredFor = (provider: string) => selected?.provider === provider ? selected : undefined;

			// Check Codex; activity scheduler or recent passive headers defer auto probes.
			const skipCodexCheck = trigger === "auto"
				&& (CODEX_RESPONSE_REFRESH_ENABLED || passiveUpdateIsFresh(OPENAI_CODEX_PROVIDER) || recentCodexUsageRequest());
			if (!skipCodexCheck) {
				runCheck(
					OPENAI_CODEX_PROVIDER,
					async (providerSignal) => {
						const codexAuth = await getCodexToken(ctx);
						if (!codexAuth || providerSignal.aborted) return undefined;
						codexUsageRequestAt = Date.now();
						codexResponseCleanTicks = 0;
						return checkCodexUsage(codexAuth.token, codexAuth.accountId, providerSignal, codexAuth.baseUrl);
					},
					() => codexUsage,
					CODEX_REFRESH_FIELDS,
					(result) => { codexUsage = normalizeCodexResetTimes(result); },
					codexRefreshIsAuthoritative,
				);
			}

			// Check Anthropic Claude Pro/Max; recent passive headers defer auto probes.
			const skipAnthropicCheck = trigger === "auto"
				&& passiveUpdateIsFresh(ANTHROPIC_PROVIDER)
				&& ![anthropicUsage?.fiveHour, anthropicUsage?.weekly].some(quotaWindowIsExpired);
			if (!skipAnthropicCheck) {
				runCheck(
					ANTHROPIC_PROVIDER,
					async (providerSignal) => {
						const anthropicAuth = await getAnthropicAuth(ctx);
						return anthropicAuth && !providerSignal.aborted
							? checkAnthropicUsage(ctx, anthropicAuth, providerSignal, selected)
							: undefined;
					},
					() => anthropicUsage,
					ANTHROPIC_REFRESH_FIELDS,
					(result) => { anthropicUsage = normalizeAnthropicResetTimes(result); },
					probeRefreshIsAuthoritative,
					undefined,
					() => { anthropicUsage = undefined; },
				);
			}

			// Check GitHub Copilot; recent passive headers defer auto probes.
			const skipCopilotCheck = trigger === "auto"
				&& passiveUpdateIsFresh(GITHUB_COPILOT_PROVIDER)
				&& ![copilotUsage?.requests, copilotUsage?.premiumRequests].some(quotaWindowIsExpired);
			if (!skipCopilotCheck) {
				runCheck(
					GITHUB_COPILOT_PROVIDER,
					async (providerSignal) => {
						const copilotAuth = await getCopilotAuth(ctx);
						return copilotAuth && !providerSignal.aborted
							? checkCopilotUsage(ctx, copilotAuth, providerSignal, selected)
							: undefined;
					},
					() => copilotUsage,
					COPILOT_REFRESH_FIELDS,
					(result) => { copilotUsage = normalizeCopilotResetTimes(result); },
					probeRefreshIsAuthoritative,
					undefined,
					() => { copilotUsage = undefined; },
				);
			}

			// Check OpenCode Go; passive model headers can defer probes, but dashboard quota still needs proactive fetches.
			const goQuotaState = getOpenCodeGoQuotaConfig();
			const skipGoCheck = trigger === "auto"
				&& passiveUpdateIsFresh(OPENCODE_GO_PROVIDER)
				&& !subscriptionHasExpiredWindows(goUsage)
				&& (!goQuotaState.config || goQuotaUpdateIsFresh())
				&& !goQuotaState.error;
			if (!skipGoCheck) {
				runCheck(
					OPENCODE_GO_PROVIDER,
					async (providerSignal) => {
						const goAuth = await getOpenCodeAuth(ctx);
						if (providerSignal.aborted || (!goAuth && !goQuotaState.config && !goQuotaState.error)) return undefined;
						return checkOpenCodeGoUsage(ctx, goAuth, goQuotaState, providerSignal, preferredFor(OPENCODE_GO_PROVIDER));
					},
					() => goUsage,
					GO_REFRESH_FIELDS,
					(result) => { goUsage = normalizeSubscriptionResetTimes(result); },
					probeRefreshIsAuthoritative,
					reconcileOpenCodeGoRefresh,
					() => { goUsage = undefined; },
				);
			}

			// Accounting only: normal model responses cannot establish accounting freshness.
			runCheck<OpenRouterUsage>(
				OPENROUTER_PROVIDER,
				async (providerSignal) => {
					const auth = await getOpenRouterAuth(ctx);
					return auth && !providerSignal.aborted ? checkOpenRouterUsage(auth, providerSignal) : undefined;
				},
				() => openrouterUsage,
				[],
				(result) => { openrouterUsage = result; },
				(result) => !result.error,
				undefined,
				() => { openrouterUsage = undefined; },
			);

			// Check other OpenAI/Anthropic-compatible subscription providers.
			for (const providerConfig of SUBSCRIPTION_PROVIDERS) {
				if (trigger === "auto"
					&& passiveUpdateIsFresh(providerConfig.provider)
					&& !subscriptionHasExpiredWindows(subscriptionUsages.get(providerConfig.provider))) continue;
				runCheck(
					providerConfig.provider,
					async (providerSignal) => {
						const providerAuth = await getSubscriptionAuth(ctx, providerConfig);
						return providerAuth && !providerSignal.aborted
							? checkSubscriptionProviderUsage(ctx, providerConfig, providerAuth, providerSignal, preferredFor(providerConfig.provider))
							: undefined;
					},
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
					undefined,
					() => { subscriptionUsages.delete(providerConfig.provider); },
				);
			}

			await Promise.allSettled(checks);

			if (generation !== sessionGeneration) return;

			// Update display with results.
			widgetLoading = false;
			renderCachedUsage(ctx, false);
			if (signal.aborted) return;
			if (refreshTimedOut && trigger !== "auto") {
				ctx.ui.notify("Some usage checks timed out", "warning");
			}
			if (!isUsageWidgetEnabled(ctx) && trigger !== "auto") {
				ctx.ui.notify(buildStartupUsageMessage(currentSnapshot(), true, readProviderDisplayPrefs(ctx)), "info");
			}
		} finally {
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
			}, effectiveRefreshMinutes() * 60 * 1000);
			unrefTimer(refreshTimer);
		}

		displayTimer = stopTimer(displayTimer);
		displayTimer = setInterval(() => {
			if (generation !== sessionGeneration) return;
			renderCachedUsage(ctx, widgetLoading);

			// A window past its reset time shows stale data; refresh promptly
			// (debounced) instead of waiting for the next auto refresh tick.
			if (PROACTIVE_REFRESH_ENABLED && !isLoading) {
				const now = Date.now();
				const providers = expiredProvidersNeedingRefresh(now);
				if (providers.size > 0) {
					for (const provider of providers) expiredRefreshAt.set(provider, now);
					refreshUsage(ctx, "auto", providers).catch(() => {});
				}
			}
		}, effectiveUiRefreshSeconds() * 1000);
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
				codexUsage = normalizeCodexResetTimes(parsed.usage);
				markPassiveUpdate(OPENAI_CODEX_PROVIDER, parsed.hasSignal);
				updated = true;
			}
		}

		if (provider === ANTHROPIC_PROVIDER) {
			const parsed = parseAnthropicUsageHeaders(event.headers, event.status, modelId, anthropicUsage);
			if (parsed) {
				anthropicUsage = normalizeAnthropicResetTimes(parsed.usage);
				// Bare successful responses carry no quota data; only real signal
				// counts as freshness for deferring proactive refreshes.
				markPassiveUpdate(ANTHROPIC_PROVIDER, parsed.hasSignal);
				updated = true;
			}
		}

		if (provider === GITHUB_COPILOT_PROVIDER) {
			const parsed = parseCopilotUsageHeaders(event.headers, event.status, modelId, copilotUsage);
			if (parsed) {
				copilotUsage = normalizeCopilotResetTimes(parsed.usage);
				markPassiveUpdate(GITHUB_COPILOT_PROVIDER, parsed.hasSignal);
				updated = true;
			}
		}

		if (provider === OPENCODE_GO_PROVIDER || hasHeaderPrefix(event.headers, "x-opencode-go-")) {
			const parsed = parseOpenCodeGoUsageHeaders(event.headers, event.status, modelId, goUsage);
			if (parsed) {
				goUsage = normalizeSubscriptionResetTimes(parsed.usage);
				markPassiveUpdate(OPENCODE_GO_PROVIDER, parsed.hasSignal);
				for (const window of getOpenCodeGoQuotaHeaderWindows(event.headers)) {
					markPassiveUpdate(goQuotaPassiveKey(window));
				}
				updated = true;
			}
		}

		const subscriptionConfig = getSubscriptionProviderConfig(provider);
		if (subscriptionConfig) {
			const previous = subscriptionUsages.get(subscriptionConfig.provider);
			const parsed = parseSubscriptionUsageHeaders(subscriptionConfig, event.headers, event.status, modelId, previous);
			if (parsed) {
				subscriptionUsages.set(subscriptionConfig.provider, normalizeSubscriptionResetTimes(parsed.usage));
				// Bare successful responses carry no quota data; only real signal
				// counts as freshness for deferring proactive refreshes.
				markPassiveUpdate(subscriptionConfig.provider, parsed.hasSignal);
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
		expiredRefreshAt.clear();
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

	const MENU_KEY_HINTS: Record<string, string> = {
		showWidget: "Persistent usage panel above the editor; when off, the report shows once and only the footer remains.",
		showStatusLine: "Footer quota summary; turn off when the widget already shows it.",
		hideUnconfiguredProviders: "Hide failed-check entries as well as providers without credentials.",
		compactWidget: "One themed line per provider so the widget fits pi's 10-line cap.",
		quotaDisplay: "Read percentages as quota consumed (used) or still available (remaining).",
		visibleProviders: "Allowlist: only these providers display; empty shows all.",
		hiddenProviders: "Denylist: these providers never display.",
		providerOrder: "Numbered positions; unlisted providers keep default order after.",
		refreshMinutes: "Network usage-check interval in minutes; applies after reload.",
		uiRefreshSeconds: "Widget and footer re-render interval in seconds; applies after reload.",
	};

	const MENU_CHOICE_HINTS: Record<string, Record<string, string>> = {
		showWidget: {
			true: "Keep the themed usage panel visible above the editor.",
			false: "Show the one-time report; keep only the footer status line.",
		},
		showStatusLine: {
			true: "Keep the quota summary in the footer status line.",
			false: "Clear the footer status; use with a persistent widget.",
		},
		hideUnconfiguredProviders: {
			true: "Show only providers with usable quota data.",
			false: "Show error-state entries for providers you may not use.",
		},
		compactWidget: {
			true: "One line per provider: label plus quota summary.",
			false: "Full detail blocks per provider (may overflow the widget cap).",
		},
		quotaDisplay: {
			used: "Percentages read as quota consumed: 0% is nothing used.",
			remaining: "Percentages read as quota still available: 0% is nothing left.",
		},
	};

	/** Interactive settings menu for bare /usage-config. Loops until Done or dismiss. */
	async function runUsageConfigMenu(ctx: UsageContext, targetFile: string, scopeLabel: string): Promise<void> {
		const MENU_RESET = "Reset to defaults";
		const MENU_DONE = "Done";
		const KEY_ORDER = [...USAGE_MENU_KEYS];
		for (;;) {
			const display = readProviderDisplayPrefs(ctx);
			const widget = readUsageWidgetSetting(ctx);
			const values = usageMenuRowValues(display, widget ?? false);
			const rows = [...KEY_ORDER.map((key) => `${key} = ${values[key]}`), MENU_RESET, MENU_DONE];
			const rowHints = [
				...KEY_ORDER.map((key) => MENU_KEY_HINTS[key] ?? ""),
				"Remove all pi-usage settings from this file after confirmation.",
				"Close the settings menu.",
			];
			const choice = await wrapSelect(ctx, `pi-usage settings (${scopeLabel})`, rows, undefined, rowHints);
			if (!choice || choice === MENU_DONE) return;
			if (choice === MENU_RESET) {
				const confirmed = await ctx.ui.confirm(
					"Reset pi-usage settings",
					`Remove all pi-usage settings from ${scopeLabel} pi-usage.json?`,
				).catch(() => false);
				if (confirmed) {
					resetUsageConfigFile(targetFile);
					ctx.ui.notify(`Reset ${scopeLabel} pi-usage settings to defaults.`, "info");
					renderCachedUsage(ctx);
				}
				continue;
			}
			const key = KEY_ORDER[rows.indexOf(choice)];
			if (!key) return;
			await editUsageConfigKey(ctx, targetFile, scopeLabel, key, values[key]);
		}
	}

	/** Single-key editor used by the interactive menu. */
	async function editUsageConfigKey(
		ctx: UsageContext,
		targetFile: string,
		scopeLabel: string,
		key: string,
		currentLabel: string,
	): Promise<void> {
		const kind = usageConfigKeyKind(key.toLowerCase());
		if (kind === "bool" || kind === "option") {
			const choices = kind === "bool" ? ["true", "false"] : usageConfigOptions(key.toLowerCase()) ?? [];
			const rows = choices.map((value) => `${value === currentLabel ? "●" : "○"} ${value}`);
			const choiceHints = choices.map((value) => MENU_CHOICE_HINTS[key]?.[value] ?? "");
			const choice = await wrapSelect(ctx, key, rows, `● ${currentLabel}`, choiceHints);
			if (choice === undefined) return;
			const value = choice.replace(/^[●○] /, "");
			applyUsageConfigChange(targetFile, { type: "set", key, value: kind === "bool" ? value === "true" : value });
			ctx.ui.notify(`Set ${key} = ${value} in ${scopeLabel} pi-usage.json.`, "info");
			renderCachedUsage(ctx);
			return;
		}
		if (kind === "int") {
			const raw = await ctx.ui.input(`${key} — positive integer (takes effect after reload)`, currentLabel);
			if (raw === undefined) return;
			const normalized = normalizeUsageConfigValue(key.toLowerCase(), raw);
			if ("error" in normalized) {
				ctx.ui.notify(normalized.error, "warning");
				return;
			}
			applyUsageConfigChange(targetFile, { type: "set", key, value: normalized.value });
			ctx.ui.notify(`Set ${key} = ${JSON.stringify(normalized.value)} in ${scopeLabel} pi-usage.json. Takes effect after reload.`, "info");
			return;
		}
		if (key === "providerOrder") {
			await editProviderOrder(ctx, targetFile, scopeLabel);
			return;
		}
		// Allow/deny lists: tickbox toggle loops over the known providers.
		await editProviderToggleList(ctx, targetFile, scopeLabel, key);
	}

	/** Tickbox editor for visibleProviders/hiddenProviders. Loops until Done. */
	async function editProviderToggleList(
		ctx: UsageContext,
		targetFile: string,
		scopeLabel: string,
		key: string,
	): Promise<void> {
		const MENU_DONE = "Done";
		const emptyNote = key === "visibleProviders" ? "empty shows all providers" : "empty hides nothing";
		const display = readProviderDisplayPrefs(ctx);
		const current = key === "visibleProviders" ? display.visibleProviders : display.hiddenProviders;
		const entries = menuProviderEntries(current);
		const ids = entries.map((provider) => provider.id);
		const labels = new Map(entries.map((provider) => [provider.id, provider.label]));
		let selected = current
			.map((name) => ids.find((id) => canonicalProviderName(id) === canonicalProviderName(name)) ?? name)
			.filter((name, index, all) => all.findIndex((other) => canonicalProviderName(other) === canonicalProviderName(name)) === index);
		for (;;) {
		const rows = [...toggleRows(ids.map((id) => labels.get(id) ?? id), selected.map((name) => {
			const id = ids.find((candidate) => canonicalProviderName(candidate) === canonicalProviderName(name)) ?? name;
			return labels.get(id) ?? id;
		})), MENU_DONE];
			const choice = await wrapSelect(ctx, `${key} (${scopeLabel}) — ${emptyNote}`, rows);
		if (choice === undefined || choice === MENU_DONE) break;
		const label = toggleRowValue(choice);
		const id = ids.find((candidate) => (labels.get(candidate) ?? candidate) === label) ?? label;
		selected = toggleInList(selected, ids, id);
	}
		applyUsageConfigChange(targetFile, { type: "set", key, value: selected });
		ctx.ui.notify(`Set ${key} = ${selected.length > 0 ? selected.join(", ") : "(empty)"} in ${scopeLabel} pi-usage.json.`, "info");
		renderCachedUsage(ctx);
	}

	/** Numbered position editor for providerOrder. Loops until Done. */
	async function editProviderOrder(ctx: UsageContext, targetFile: string, scopeLabel: string): Promise<void> {
		const MENU_DONE = "Done";
		const display = readProviderDisplayPrefs(ctx);
		const entries = menuProviderEntries(display.providerOrder);
		let order = display.providerOrder
			.map((name) => entries.find((provider) => canonicalProviderName(provider.id) === canonicalProviderName(name))?.id ?? name)
			.filter((name, index, all) => all.findIndex((other) => canonicalProviderName(other) === canonicalProviderName(name)) === index);
		for (;;) {
		const rows = [...orderRows(entries, order), MENU_DONE];
			const choice = await wrapSelect(ctx, `providerOrder (${scopeLabel}) — unnumbered providers keep default order after`, rows);
		if (choice === undefined || choice === MENU_DONE) break;
		const label = orderRowValue(choice);
		const provider = entries.find((entry) => entry.label === label);
		if (!provider) continue;
		const position = order.findIndex((name) => canonicalProviderName(name) === canonicalProviderName(provider.id));
		const raw = await ctx.ui.input(
				`Position for ${label} (1-${entries.length}, empty removes)`,
				position >= 0 ? String(position + 1) : "",
			);
		if (raw === undefined) continue;
		if (raw.trim() === "") {
			order = applyOrderPosition(order, entries, provider.id, undefined);
			continue;
		}
		if (!/^\d+$/.test(raw.trim())) {
			ctx.ui.notify(`Invalid position "${raw.trim()}" — enter a number 1-${entries.length} or leave empty to remove.`, "warning");
			continue;
		}
		order = applyOrderPosition(order, entries, provider.id, parseInt(raw.trim(), 10));
	}
		applyUsageConfigChange(targetFile, { type: "set", key: "providerOrder", value: order });
		ctx.ui.notify(`Set providerOrder = ${order.length > 0 ? order.join(", ") : "(default)"} in ${scopeLabel} pi-usage.json.`, "info");
		renderCachedUsage(ctx);
	}

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh usage limits for Codex, Anthropic, Copilot, OpenCode, ClinePass, and compatible providers, plus OpenRouter spend, budgets, and credits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});

	// ── /usage-config command ──
	pi.registerCommand("usage-config", {
		description: "Interactive pi-usage settings menu (showWidget, provider filters/order, refresh intervals). Usage: /usage-config [show] | set <key> <value> | unset <key> [--local]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const parsed = parseUsageConfigArgs(args);
			if (parsed.action === "error") {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}
			const globalFile = usageConfigPath();
			const isProjectTrusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
			const targetFile = parsed.local ? path.join(ctx.cwd, CONFIG_DIR_NAME, USAGE_CONFIG_FILE) : globalFile;

			if (parsed.action === "menu") {
				if (parsed.local && !isProjectTrusted) {
					ctx.ui.notify("Project settings apply only after the project is trusted. Use /usage-config without --local for global settings.", "warning");
					return;
				}
				try {
					await runUsageConfigMenu(ctx, targetFile, parsed.local ? "project" : "global");
				} catch {
					ctx.ui.notify(formatUsageConfigReport(ctx, parsed.local ? targetFile : undefined), "info");
				}
				return;
			}

			if (parsed.action === "show") {
				ctx.ui.notify(formatUsageConfigReport(ctx, parsed.local ? targetFile : undefined), "info");
				return;
			}

			if (parsed.local && !isProjectTrusted) {
				ctx.ui.notify("Project settings apply only after the project is trusted. Use /usage-config without --local for global settings.", "warning");
				return;
			}

			if (parsed.action === "unset") {
				if (!USAGE_CONFIG_KEYS.includes(parsed.key as (typeof USAGE_CONFIG_KEYS)[number])) {
					ctx.ui.notify(`Unknown key "${parsed.key}".`, "warning");
					return;
				}
				applyUsageConfigChange(targetFile, { type: "unset", key: canonicalUsageConfigKey(parsed.key) });
				ctx.ui.notify(`Removed ${canonicalUsageConfigKey(parsed.key)} from ${parsed.local ? "project" : "global"} pi-usage.json.`, "info");
				renderCachedUsage(ctx);
				return;
			}

			const normalized = normalizeUsageConfigValue(parsed.key, parsed.value);
			if ("error" in normalized) {
				ctx.ui.notify(normalized.error, "warning");
				return;
			}
			const key = canonicalUsageConfigKey(parsed.key);
			applyUsageConfigChange(targetFile, { type: "set", key, value: normalized.value });
			const reloadNote = key === "refreshMinutes" || key === "uiRefreshSeconds"
				? " Takes effect after reload."
				: "";
			ctx.ui.notify(`Set ${key} = ${JSON.stringify(normalized.value)} in ${parsed.local ? "project" : "global"} pi-usage.json.${reloadNote}`, "info");
			renderCachedUsage(ctx);
		},
	});
}
