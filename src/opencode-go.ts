import type {
	GoCheckModel,
	OpenCodeGoQuotaConfig,
	OpenCodeGoQuotaConfigState,
	OpenCodeGoQuotaResult,
	OpenCodeGoUsage,
	SelectedModel,
	SubscriptionQuotaWindow,
} from "./types.ts";
import { OPENCODE_GO_DASHBOARD_URL_PREFIX, OPENCODE_GO_PROVIDER } from "./config.ts";
import { clampPercent, errorText, truncate } from "./format.ts";
import { cancelResponseBody, fetchWithTimeout, piUsageUserAgent, readResponseText } from "./http.ts";
import {
	checkSubscriptionProviderUsage,
	getSubscriptionApiKey,
	parseQuotaWindow,
	parseSubscriptionUsageHeaders,
	QUOTA_WINDOW_KINDS,
	type QuotaWindowKind,
	type SubscriptionProviderConfig,
} from "./subscription-probe.ts";
import { hasHeaderPrefix } from "./headers.ts";

// ───────── Constants ─────────

const PREFERRED_GO_PROBE_MODEL = "qwen3.5-plus";

const DOCUMENTED_GO_MODELS: GoCheckModel[] = [
	{ id: PREFERRED_GO_PROBE_MODEL, api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 1 },
	{ id: "minimax-m2.5", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 2 },
	{ id: "minimax-m2.7", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 3 },
	{ id: "qwen3.6-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 4 },
	{ id: "mimo-v2-omni", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 5 },
	{ id: "kimi-k2.5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 6 },
	{ id: "glm-5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 7 },
	{ id: "kimi-k2.6", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 8 },
	{ id: "mimo-v2-pro", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 9 },
	{ id: "glm-5.1", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 10 },
];

const OPENCODE_GO_PROVIDER_CONFIG: SubscriptionProviderConfig = {
	provider: OPENCODE_GO_PROVIDER,
	label: "OpenCode Go",
	shortLabel: "Go",
	authProviderIds: [OPENCODE_GO_PROVIDER, "opencode"],
	envKeys: ["OPENCODE_API_KEY"],
	supportedApis: ["openai-completions", "anthropic-messages"],
	preferredModelIds: [PREFERRED_GO_PROBE_MODEL],
	documentedModels: DOCUMENTED_GO_MODELS,
	quotaHeaderPrefixes: ["opencode-go", "opencode"],
};

const GO_QUOTA_HEADER_PREFIXES = OPENCODE_GO_PROVIDER_CONFIG.quotaHeaderPrefixes!;

// ───────── Auth Helpers ─────────

export function getOpenCodeApiKey(): string | undefined {
	return getSubscriptionApiKey(OPENCODE_GO_PROVIDER_CONFIG);
}

// ───────── Dashboard Quota Parsing ─────────

export function parseOpenCodeGoUsageWindow(html: string, key: QuotaWindowKind): SubscriptionQuotaWindow | undefined {
	const objectMatch = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`).exec(html);
	const body = objectMatch?.[1];
	if (!body) return undefined;

	const usageMatch = /usagePercent:(\d+(?:\.\d+)?)/.exec(body);
	if (!usageMatch) return undefined;

	const usedPercent = clampPercent(Number(usageMatch[1]));
	const resetMatch = /resetInSec:(\d+(?:\.\d+)?)/.exec(body);
	const resetAfterSeconds = resetMatch ? Math.max(0, Math.round(Number(resetMatch[1]))) : 0;
	return {
		usedPercent,
		remainingPercent: clampPercent(100 - usedPercent),
		resetAfterSeconds,
		resetAt: resetAfterSeconds > 0 ? Math.round(Date.now() / 1000) + resetAfterSeconds : undefined,
	};
}

export function parseOpenCodeGoDashboardUsage(html: string): Omit<OpenCodeGoQuotaResult, "configured" | "source"> {
	const rolling = parseOpenCodeGoUsageWindow(html, "rolling");
	const weekly = parseOpenCodeGoUsageWindow(html, "weekly");
	const monthly = parseOpenCodeGoUsageWindow(html, "monthly");
	if (!rolling && !weekly && !monthly) {
		const snippet = truncate(html, 300).replace(/\s+/g, " ");
		return {
			error: `OpenCode Go dashboard structure not recognized. HTML: ${snippet}`,
		};
	}

	return { rolling, weekly, monthly };
}

// ───────── Passive Header Parsing ─────────

/** True when any quota window has usage data. */
export function hasGoQuotaData(
	usage: Pick<OpenCodeGoQuotaResult, QuotaWindowKind> | undefined,
): boolean {
	return QUOTA_WINDOW_KINDS.some((window) => usage?.[window]?.usedPercent !== undefined);
}

/** True when every quota window has a displayable usage percentage. */
export function hasCompleteGoQuotaData(
	usage: Pick<OpenCodeGoQuotaResult, QuotaWindowKind> | undefined,
): boolean {
	return QUOTA_WINDOW_KINDS.every((window) => usage?.[window]?.usedPercent !== undefined);
}

export function getOpenCodeGoQuotaHeaderWindows(headers: Record<string, string>): QuotaWindowKind[] {
	return QUOTA_WINDOW_KINDS.filter((window) =>
		parseQuotaWindow(headers, GO_QUOTA_HEADER_PREFIXES, window).hasHeaders,
	);
}

export function hasOpenCodeGoQuotaHeaders(headers: Record<string, string>): boolean {
	return getOpenCodeGoQuotaHeaderWindows(headers).length > 0;
}

/**
 * True when the response carried real OpenCode Go signal (quota/provider
 * headers or a limit error) — as opposed to a bare successful response that
 * only confirms the model works. Only real signal should mark quota
 * freshness for deferring proactive refreshes.
 */
export function hasOpenCodeGoHeaderSignal(headers: Record<string, string>, status: number): boolean {
	const prefixes = OPENCODE_GO_PROVIDER_CONFIG.quotaHeaderPrefixes ?? [OPENCODE_GO_PROVIDER];
	return prefixes.some((prefix) => hasHeaderPrefix(headers, `x-${prefix}-`)) || status === 429 || status === 402;
}

/** Keep an exhausted refresh limited when its quota survives a concurrent merge. */
export function reconcileOpenCodeGoRefresh(
	result: OpenCodeGoUsage,
	merged: OpenCodeGoUsage,
): OpenCodeGoUsage {
	const quotaExhausted = result.status === "rate_limited"
		&& [merged.rolling, merged.weekly, merged.monthly]
			.some((window) => window?.usedPercent !== undefined && window.usedPercent >= 100);
	return merged.status === "available" && quotaExhausted
		? { ...merged, available: false, status: "rate_limited" }
		: merged;
}

export function parseOpenCodeGoUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: OpenCodeGoUsage,
): OpenCodeGoUsage | undefined {
	const parsed = parseSubscriptionUsageHeaders(OPENCODE_GO_PROVIDER_CONFIG, headers, status, modelId, previous);
	if (!parsed) return undefined;

	// Fresh quota headers supersede any stale dashboard error.
	const hasQuotaHeaders = hasOpenCodeGoQuotaHeaders(headers);
	return { ...parsed.usage, quotaError: hasQuotaHeaders ? undefined : previous?.quotaError };
}

// ───────── Dashboard Quota Fetch ─────────

async function fetchOpenCodeGoQuota(config: OpenCodeGoQuotaConfig, signal?: AbortSignal): Promise<OpenCodeGoQuotaResult> {
	const base: OpenCodeGoQuotaResult = { configured: true, source: config.source };

	try {
		const response = await fetchWithTimeout(
			`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`,
			{
				headers: {
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Cookie": `auth=${config.authCookie}`,
					"User-Agent": piUsageUserAgent(),
				},
			},
			signal,
		);

		if (!response.ok) {
			await cancelResponseBody(response);
			return { ...base, error: `OpenCode Go quota dashboard returned HTTP ${response.status}` };
		}

		return { ...base, ...parseOpenCodeGoDashboardUsage(await readResponseText(response, signal)) };
	} catch (e: unknown) {
		return { ...base, error: errorText(e) };
	}
}

async function checkOpenCodeGoQuota(configState: OpenCodeGoQuotaConfigState, signal?: AbortSignal): Promise<OpenCodeGoQuotaResult> {
	if (configState.error) return { configured: false, error: configState.error };
	if (!configState.config) return { configured: false };
	return fetchOpenCodeGoQuota(configState.config, signal);
}

// ───────── Public API ─────────

/** Provider identity fields for usages built outside the generic probe. */
function goIdentity(): Pick<OpenCodeGoUsage, "provider" | "label" | "shortLabel"> {
	const { provider, label, shortLabel } = OPENCODE_GO_PROVIDER_CONFIG;
	return { provider, label, shortLabel };
}

/** Defined dashboard quota fields; never clobbers probe results with undefined. */
function quotaFields(quota: OpenCodeGoQuotaResult): Partial<OpenCodeGoUsage> {
	const fields: Partial<OpenCodeGoUsage> = {};
	if (quota.source !== undefined) fields.quotaSource = quota.source;
	if (quota.rolling) fields.rolling = quota.rolling;
	if (quota.weekly) fields.weekly = quota.weekly;
	if (quota.monthly) fields.monthly = quota.monthly;
	return fields;
}

export async function checkOpenCodeGoUsage(
	apiKey: string | undefined,
	configState: OpenCodeGoQuotaConfigState,
	signal?: AbortSignal,
	preferredModel?: SelectedModel,
): Promise<OpenCodeGoUsage> {
	const quota = await checkOpenCodeGoQuota(configState, signal);

	// Dashboard quota is authoritative; skip the model probe when it is available.
	if (hasGoQuotaData(quota)) {
		const exhausted = [quota.rolling, quota.weekly, quota.monthly]
			.some((window) => window?.usedPercent !== undefined && window.usedPercent >= 100);
		return {
			...goIdentity(),
			available: !exhausted,
			status: exhausted ? "rate_limited" : "available",
			...quotaFields(quota),
		};
	}

	if (signal?.aborted) {
		return { ...goIdentity(), available: false, status: "error", error: "OpenCode Go check aborted" };
	}

	const modelCheck = await checkSubscriptionProviderUsage(OPENCODE_GO_PROVIDER_CONFIG, apiKey, signal, preferredModel);
	return { ...modelCheck, ...quotaFields(quota), quotaError: quota.error };
}
