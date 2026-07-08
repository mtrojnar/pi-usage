import type {
	GoCheckModel,
	GoModelStatus,
	GoProbeApi,
	OpenCodeGoQuotaConfig,
	OpenCodeGoQuotaConfigState,
	OpenCodeGoQuotaResult,
	OpenCodeGoUsage,
	SelectedModel,
} from "./types.ts";
import { OPENCODE_GO_DASHBOARD_URL_PREFIX, OPENCODE_GO_PROVIDER } from "./config.ts";
import { clampPercent, errorText, truncate } from "./format.ts";
import { headerValue, parseRetryAfterSeconds } from "./headers.ts";
import { cancelResponseBody, fetchWithTimeout, piUsageUserAgent, readResponseText } from "./http.ts";
import { isGoModelStatus, resolveProbeEndpoint } from "./probe.ts";
import { checkSubscriptionProviderUsage, getSubscriptionApiKey, parseQuotaWindow } from "./subscription-probe.ts";
import type { QuotaWindowKind, SubscriptionProviderConfig } from "./subscription-probe.ts";

// ───────── Constants ─────────

const PREFERRED_GO_PROBE_MODEL = "qwen3.5-plus";

export const DOCUMENTED_GO_MODELS: GoCheckModel[] = [
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

export function parseOpenCodeGoUsageWindow(
	html: string,
	key: QuotaWindowKind,
): { usedPercent: number; remainingPercent: number; resetAfterSeconds: number; resetAt: number } | undefined {
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
		resetAt: resetAfterSeconds > 0 ? Math.round(Date.now() / 1000) + resetAfterSeconds : 0,
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

	return {
		rollingUsedPercent: rolling?.usedPercent,
		rollingRemainingPercent: rolling?.remainingPercent,
		rollingResetAfterSeconds: rolling?.resetAfterSeconds,
		rollingResetAt: rolling?.resetAt,
		weeklyUsedPercent: weekly?.usedPercent,
		weeklyRemainingPercent: weekly?.remainingPercent,
		weeklyResetAfterSeconds: weekly?.resetAfterSeconds,
		weeklyResetAt: weekly?.resetAt,
		monthlyUsedPercent: monthly?.usedPercent,
		monthlyRemainingPercent: monthly?.remainingPercent,
		monthlyResetAfterSeconds: monthly?.resetAfterSeconds,
		monthlyResetAt: monthly?.resetAt,
	};
}

// ───────── Message / Endpoint Helpers ─────────

export function resolveModelEndpoint(baseUrl: string, api: GoProbeApi): string {
	return resolveProbeEndpoint(baseUrl, api, { insertV1: true });
}

export function isGlobalGoLimit(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|opencode.*(quota|limit)|go.*(quota|limit)|subscription.*(quota|limit)/i.test(message);
}

export function isPerModelUnavailable(_status: number, message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable)|disabled.*model/i.test(message);
}

// ───────── Passive Header Parsing ─────────

/** True when any quota window has usage data. */
export function hasGoQuotaData(
	usage: { rollingUsedPercent?: number; weeklyUsedPercent?: number; monthlyUsedPercent?: number } | undefined,
): boolean {
	return usage?.rollingUsedPercent !== undefined
		|| usage?.weeklyUsedPercent !== undefined
		|| usage?.monthlyUsedPercent !== undefined;
}

export function parseOpenCodeGoUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: OpenCodeGoUsage,
): OpenCodeGoUsage | undefined {
	const statusHeader = headerValue(headers, "x-opencode-go-status");
	const headerStatus = isGoModelStatus(statusHeader) ? statusHeader : undefined;
	const responseModel = headerValue(headers, "x-opencode-go-model") ?? modelId;
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	const rolling = parseQuotaWindow(headers, GO_QUOTA_HEADER_PREFIXES, "rolling").window;
	const weekly = parseQuotaWindow(headers, GO_QUOTA_HEADER_PREFIXES, "weekly").window;
	const monthly = parseQuotaWindow(headers, GO_QUOTA_HEADER_PREFIXES, "monthly").window;
	const hasQuotaHeaders = Boolean(rolling || weekly || monthly);
	const hasGoHeaders = Object.keys(headers).some((name) => name.toLowerCase().startsWith("x-opencode-go-"));
	const hasPassiveSignal = hasGoHeaders || hasQuotaHeaders || status === 429 || (status >= 200 && status < 300 && !!responseModel);
	if (!hasPassiveSignal) return undefined;

	const inferredStatus: GoModelStatus = headerStatus
		?? (status === 429
			? "rate_limited"
			: status === 401 || status === 403
				? "credits_error"
				: status >= 400
					? "error"
					: "available");
	const rateLimited = inferredStatus === "rate_limited";
	const available = inferredStatus === "available";

	return {
		available,
		status: inferredStatus,
		workingModel: available ? responseModel ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? responseModel ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		quotaConfigured: hasQuotaHeaders ? true : previous?.quotaConfigured,
		quotaSource: hasQuotaHeaders ? "response headers" : previous?.quotaSource,
		rollingUsedPercent: rolling?.usedPercent ?? previous?.rollingUsedPercent,
		rollingRemainingPercent: rolling?.remainingPercent ?? previous?.rollingRemainingPercent,
		rollingResetAfterSeconds: rolling?.resetAfterSeconds ?? previous?.rollingResetAfterSeconds,
		rollingResetAt: rolling?.resetAt ?? previous?.rollingResetAt,
		weeklyUsedPercent: weekly?.usedPercent ?? previous?.weeklyUsedPercent,
		weeklyRemainingPercent: weekly?.remainingPercent ?? previous?.weeklyRemainingPercent,
		weeklyResetAfterSeconds: weekly?.resetAfterSeconds ?? previous?.weeklyResetAfterSeconds,
		weeklyResetAt: weekly?.resetAt ?? previous?.weeklyResetAt,
		monthlyUsedPercent: monthly?.usedPercent ?? previous?.monthlyUsedPercent,
		monthlyRemainingPercent: monthly?.remainingPercent ?? previous?.monthlyRemainingPercent,
		monthlyResetAfterSeconds: monthly?.resetAfterSeconds ?? previous?.monthlyResetAfterSeconds,
		monthlyResetAt: monthly?.resetAt ?? previous?.monthlyResetAt,
		quotaError: hasQuotaHeaders ? undefined : previous?.quotaError,
		errorMessage: rateLimited
			? retryAfterSeconds > 0 ? `Rate limited; retry after ${retryAfterSeconds}s` : "Rate limited"
			: inferredStatus === "credits_error" || inferredStatus === "error"
				? `HTTP ${status}`
				: undefined,
		error: undefined,
	};
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

// ───────── Model Probing ─────────

async function checkOpenCodeGoModels(apiKey: string | undefined, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<OpenCodeGoUsage> {
	const result = await checkSubscriptionProviderUsage(OPENCODE_GO_PROVIDER_CONFIG, apiKey, signal, preferredModel);
	return {
		available: result.available,
		status: result.status,
		workingModel: result.workingModel,
		rateLimitedModel: result.rateLimitedModel,
		checkedModels: result.checkedModels,
		totalModels: result.totalModels,
		errorMessage: result.errorMessage,
		error: result.error,
	};
}

// ───────── Public API ─────────

/** Quota fields shared by the dashboard-only and probe result shapes. */
function quotaFields(quota: OpenCodeGoQuotaResult): Partial<OpenCodeGoUsage> {
	return {
		quotaConfigured: quota.configured,
		quotaSource: quota.source,
		rollingUsedPercent: quota.rollingUsedPercent,
		rollingRemainingPercent: quota.rollingRemainingPercent,
		rollingResetAfterSeconds: quota.rollingResetAfterSeconds,
		rollingResetAt: quota.rollingResetAt,
		weeklyUsedPercent: quota.weeklyUsedPercent,
		weeklyRemainingPercent: quota.weeklyRemainingPercent,
		weeklyResetAfterSeconds: quota.weeklyResetAfterSeconds,
		weeklyResetAt: quota.weeklyResetAt,
		monthlyUsedPercent: quota.monthlyUsedPercent,
		monthlyRemainingPercent: quota.monthlyRemainingPercent,
		monthlyResetAfterSeconds: quota.monthlyResetAfterSeconds,
		monthlyResetAt: quota.monthlyResetAt,
	};
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
		const exhausted = [quota.rollingUsedPercent, quota.weeklyUsedPercent, quota.monthlyUsedPercent]
			.some((percent) => percent !== undefined && percent >= 100);
		return {
			available: !exhausted,
			status: exhausted ? "rate_limited" : "available",
			...quotaFields(quota),
		};
	}

	if (signal?.aborted) {
		return { available: false, status: "error", error: "OpenCode Go check aborted" };
	}

	const modelCheck = await checkOpenCodeGoModels(apiKey, signal, preferredModel);
	return { ...modelCheck, ...quotaFields(quota), quotaError: quota.error };
}
