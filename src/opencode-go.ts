import * as os from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	GoCheckModel,
	GoModelStatus,
	GoProbeApi,
	OpenCodeGoQuotaConfig,
	OpenCodeGoQuotaConfigState,
	OpenCodeGoQuotaResult,
	OpenCodeGoUsage,
} from "./types.ts";
import {
	CHECK_TIMEOUT_MS,
	OPENCODE_GO_DASHBOARD_URL_PREFIX,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseText } from "./http.ts";
import { checkSubscriptionProviderUsage, getSubscriptionApiKey } from "./subscription-probe.ts";
import type { SubscriptionProviderConfig } from "./subscription-probe.ts";

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
	provider: "opencode-go",
	label: "OpenCode Go",
	shortLabel: "Go",
	authProviderIds: ["opencode-go", "opencode"],
	envKeys: ["OPENCODE_API_KEY"],
	supportedApis: ["openai-completions", "anthropic-messages"],
	preferredModelIds: [PREFERRED_GO_PROBE_MODEL],
	documentedModels: DOCUMENTED_GO_MODELS,
	quotaHeaderPrefixes: ["opencode-go", "opencode"],
};

export const GO_COLOR_MAP: Record<GoModelStatus, ThemeColor> = {
	available: "success",
	rate_limited: "warning",
	credits_error: "error",
	error: "warning",
	no_key: "dim",
};

export const GO_STATUS_TEXT: Record<GoModelStatus, string> = {
	available: "available",
	rate_limited: "rate limited",
	credits_error: "credits exhausted",
	error: "error",
	no_key: "no key",
};

// ───────── Auth Helpers ─────────

export function getOpenCodeApiKey(): string | undefined {
	return getSubscriptionApiKey(OPENCODE_GO_PROVIDER_CONFIG);
}

// ───────── Dashboard Quota Parsing ─────────

export function parseOpenCodeGoUsageWindow(
	html: string,
	key: "rolling" | "weekly" | "monthly",
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

export function resolveModelEndpoint(baseUrl: string, api: GoProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		if (normalized.endsWith("/messages")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/messages`;
		return `${normalized}/v1/messages`;
	}
	if (normalized.endsWith("/chat/completions")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
	return `${normalized}/v1/chat/completions`;
}

export function isGlobalGoLimit(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|opencode.*(quota|limit)|go.*(quota|limit)|subscription.*(quota|limit)/i.test(message);
}

export function isPerModelUnavailable(_status: number, message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable)|disabled.*model/i.test(message);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function parseOptionalNumber(headers: Record<string, string>, names: string[]): number | undefined {
	for (const name of names) {
		const value = headerValue(headers, name);
		if (value === undefined || value === "") continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

function isGoModelStatus(value: string | undefined): value is GoModelStatus {
	return value === "available" || value === "rate_limited" || value === "credits_error" || value === "error" || value === "no_key";
}

function goQuotaHeaderNames(window: "rolling" | "weekly" | "monthly", metric: string): string[] {
	return [
		`x-opencode-go-${window}-${metric}`,
		`x-opencode-go-quota-${window}-${metric}`,
		`x-opencode-${window}-${metric}`,
	];
}

function parsePassiveQuotaWindow(headers: Record<string, string>, window: "rolling" | "weekly" | "monthly"): {
	usedPercent?: number;
	remainingPercent?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
	hasHeaders: boolean;
} {
	const used = parseOptionalNumber(headers, goQuotaHeaderNames(window, "used-percent"));
	const remaining = parseOptionalNumber(headers, goQuotaHeaderNames(window, "remaining-percent"));
	const resetAfter = parseOptionalNumber(headers, [
		...goQuotaHeaderNames(window, "reset-after-seconds"),
		...goQuotaHeaderNames(window, "reset-after"),
	]);
	const resetAt = parseOptionalNumber(headers, goQuotaHeaderNames(window, "reset-at"));

	return {
		usedPercent: used !== undefined ? clampPercent(used) : undefined,
		remainingPercent: remaining !== undefined
			? clampPercent(remaining)
			: used !== undefined
				? clampPercent(100 - used)
				: undefined,
		resetAfterSeconds: resetAfter !== undefined ? Math.max(0, Math.round(resetAfter)) : undefined,
		resetAt: resetAt !== undefined ? Math.max(0, Math.round(resetAt)) : undefined,
		hasHeaders: used !== undefined || remaining !== undefined || resetAfter !== undefined || resetAt !== undefined,
	};
}

function hasOpenCodeGoPassiveHeaders(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((name) => name.toLowerCase().startsWith("x-opencode-go-"));
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
	const rolling = parsePassiveQuotaWindow(headers, "rolling");
	const weekly = parsePassiveQuotaWindow(headers, "weekly");
	const monthly = parsePassiveQuotaWindow(headers, "monthly");
	const hasQuotaHeaders = rolling.hasHeaders || weekly.hasHeaders || monthly.hasHeaders;
	const hasPassiveSignal = hasOpenCodeGoPassiveHeaders(headers) || hasQuotaHeaders || status === 429 || (status >= 200 && status < 300 && responseModel);
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
	const retryMessage = retryAfterSeconds > 0 ? `Rate limited; retry after ${retryAfterSeconds}s` : "Rate limited";

	return {
		available,
		status: inferredStatus,
		workingModel: available ? responseModel ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? responseModel ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		quotaConfigured: hasQuotaHeaders ? true : previous?.quotaConfigured,
		quotaSource: hasQuotaHeaders ? "response headers" : previous?.quotaSource,
		rollingUsedPercent: rolling.usedPercent ?? previous?.rollingUsedPercent,
		rollingRemainingPercent: rolling.remainingPercent ?? previous?.rollingRemainingPercent,
		rollingResetAfterSeconds: rolling.resetAfterSeconds ?? previous?.rollingResetAfterSeconds,
		rollingResetAt: rolling.resetAt ?? previous?.rollingResetAt,
		weeklyUsedPercent: weekly.usedPercent ?? previous?.weeklyUsedPercent,
		weeklyRemainingPercent: weekly.remainingPercent ?? previous?.weeklyRemainingPercent,
		weeklyResetAfterSeconds: weekly.resetAfterSeconds ?? previous?.weeklyResetAfterSeconds,
		weeklyResetAt: weekly.resetAt ?? previous?.weeklyResetAt,
		monthlyUsedPercent: monthly.usedPercent ?? previous?.monthlyUsedPercent,
		monthlyRemainingPercent: monthly.remainingPercent ?? previous?.monthlyRemainingPercent,
		monthlyResetAfterSeconds: monthly.resetAfterSeconds ?? previous?.monthlyResetAfterSeconds,
		monthlyResetAt: monthly.resetAt ?? previous?.monthlyResetAt,
		quotaError: hasQuotaHeaders ? undefined : previous?.quotaError,
		errorMessage: rateLimited
			? retryMessage
			: inferredStatus === "credits_error"
				? `HTTP ${status}`
				: inferredStatus === "error"
					? `HTTP ${status}`
					: undefined,
		error: undefined,
	};
}


async function fetchOpenCodeGoQuota(config: OpenCodeGoQuotaConfig, signal?: AbortSignal): Promise<OpenCodeGoQuotaResult> {
	const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);

	try {
		const response = await fetch(
			`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`,
			{
				headers: {
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Cookie": `auth=${config.authCookie}`,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				signal: timeoutSignal.signal,
			},
		);

		if (!response.ok) {
			await cancelResponseBody(response);
			return {
				configured: true,
				source: config.source,
				error: `OpenCode Go quota dashboard returned HTTP ${response.status}`,
			};
		}

		const html = await readResponseText(response, signal);
		const parsed = parseOpenCodeGoDashboardUsage(html);
		if (parsed.error) {
			return {
				configured: true,
				source: config.source,
				error: parsed.error,
			};
		}

		return {
			configured: true,
			source: config.source,
			...parsed,
		};
	} catch (e: unknown) {
		return {
			configured: true,
			source: config.source,
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		timeoutSignal.cleanup();
	}
}

async function checkOpenCodeGoQuota(configState: OpenCodeGoQuotaConfigState, signal?: AbortSignal): Promise<OpenCodeGoQuotaResult> {
	if (configState.error) {
		return { configured: false, error: configState.error };
	}
	if (!configState.config) {
		return { configured: false };
	}
	return fetchOpenCodeGoQuota(configState.config, signal);
}

async function checkOpenCodeGoModels(apiKey: string | undefined, signal?: AbortSignal): Promise<OpenCodeGoUsage> {
	const result = await checkSubscriptionProviderUsage(OPENCODE_GO_PROVIDER_CONFIG, apiKey, signal);
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

export async function checkOpenCodeGoUsage(
	apiKey: string | undefined,
	configState: OpenCodeGoQuotaConfigState,
	signal?: AbortSignal,
): Promise<OpenCodeGoUsage> {
	const quotaCheck = await checkOpenCodeGoQuota(configState, signal);
	if (
		quotaCheck.rollingUsedPercent !== undefined ||
		quotaCheck.weeklyUsedPercent !== undefined ||
		quotaCheck.monthlyUsedPercent !== undefined
	) {
		const quotaExhausted = (
			quotaCheck.rollingUsedPercent !== undefined && quotaCheck.rollingUsedPercent >= 100
		) || (
			quotaCheck.weeklyUsedPercent !== undefined && quotaCheck.weeklyUsedPercent >= 100
		) || (
			quotaCheck.monthlyUsedPercent !== undefined && quotaCheck.monthlyUsedPercent >= 100
		);
		return {
			available: !quotaExhausted,
			status: quotaExhausted ? "rate_limited" : "available",
			quotaConfigured: quotaCheck.configured,
			quotaSource: quotaCheck.source,
			rollingUsedPercent: quotaCheck.rollingUsedPercent,
			rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
			rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
			rollingResetAt: quotaCheck.rollingResetAt,
			weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
			weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
			weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
			weeklyResetAt: quotaCheck.weeklyResetAt,
			monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
			monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
			monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
			monthlyResetAt: quotaCheck.monthlyResetAt,
		};
	}

	if (signal?.aborted) {
		return {
			available: false,
			status: "error",
			error: "OpenCode Go check aborted",
		};
	}

	const modelCheck = await checkOpenCodeGoModels(apiKey, signal);

	return {
		...modelCheck,
		quotaConfigured: quotaCheck.configured,
		quotaSource: quotaCheck.source,
		rollingUsedPercent: quotaCheck.rollingUsedPercent,
		rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
		rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
		rollingResetAt: quotaCheck.rollingResetAt,
		weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
		weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
		weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
		weeklyResetAt: quotaCheck.weeklyResetAt,
		monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
		monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
		monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
		monthlyResetAt: quotaCheck.monthlyResetAt,
		quotaError: quotaCheck.error,
	};
}
