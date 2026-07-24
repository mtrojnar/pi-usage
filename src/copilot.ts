import type {
	CopilotAuth,
	CopilotOAuthCredential,
	CopilotRateLimitWindow,
	CopilotUsage,
	CopilotUsageWindowKey,
	GoModelStatus,
	SelectedModel,
	SubscriptionProbeApi,
} from "./types.ts";
import {
	GITHUB_COPILOT_PROBE_MODEL,
	GITHUB_COPILOT_PROVIDER,
} from "./config.ts";
import { apiKeyFromCredential, envApiKey, oauthAccessToken, readStoredCredential } from "./auth.ts";
import { clampPercent } from "./format.ts";
import {
	hasHeaderPrefix,
	headerValue,
	parseOptionalNumber,
	parseResetAtSeconds,
	parseRetryAfterSeconds,
	resetAfterFromAt,
	retryResetFields,
} from "./headers.ts";
import {
	asProbeApi,
	modelCostRank,
	probeProviderUsage,
	resolveProbeEndpoint,
	sortModelsByPreference,
	type PiModelLike,
} from "./probe.ts";

// ───────── Constants ─────────

const COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_API_VERSION = "2026-06-01";

const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-Initiator": "user",
	"Openai-Intent": "conversation-edits",
};

const PREFERRED_COPILOT_PROBE_MODELS = [
	GITHUB_COPILOT_PROBE_MODEL,
	"gpt-5-mini",
	"gpt-4.1",
	"claude-haiku-4.5",
	"claude-sonnet-4",
];

interface CopilotCheckModel {
	id: string;
	api: SubscriptionProbeApi;
	endpoint: string;
	costRank: number;
}

// ───────── Auth Helpers ─────────

export function normalizeCopilotDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname || undefined;
	} catch {
		return undefined;
	}
}

function baseUrlFromToken(token: string): string | undefined {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return undefined;
	const apiHost = match[1].replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export function getCopilotBaseUrl(token: string, enterpriseDomain?: string): string {
	return baseUrlFromToken(token)
		?? (enterpriseDomain ? `https://copilot-api.${enterpriseDomain}` : COPILOT_API_BASE_URL);
}

function availableModelIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return ids.length > 0 ? ids : undefined;
}

export async function getCopilotAuth(): Promise<CopilotAuth | undefined> {
	const credential = await readStoredCredential(GITHUB_COPILOT_PROVIDER);
	const accessToken = oauthAccessToken(credential);
	if (accessToken) {
		const oauth = credential as CopilotOAuthCredential;
		const enterpriseDomain = normalizeCopilotDomain(oauth.enterpriseUrl);
		return {
			token: accessToken,
			source: "auth.json",
			baseUrl: getCopilotBaseUrl(accessToken, enterpriseDomain),
			enterpriseDomain,
			availableModelIds: availableModelIds(oauth.availableModelIds),
		};
	}

	const storedKey = apiKeyFromCredential(credential);
	if (storedKey) return { token: storedKey, source: "auth.json", baseUrl: getCopilotBaseUrl(storedKey) };

	const envToken = envApiKey("COPILOT_GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN");
	if (envToken) return { token: envToken.key, source: envToken.source, baseUrl: getCopilotBaseUrl(envToken.key) };

	return undefined;
}

// ───────── Header Parsing ─────────

function parseCopilotWindowFromPrefix(
	headers: Record<string, string>,
	prefix: string,
	resource?: string,
): CopilotRateLimitWindow | undefined {
	const limit = parseOptionalNumber(headers, `${prefix}-limit`);
	const remaining = parseOptionalNumber(headers, `${prefix}-remaining`);
	const used = parseOptionalNumber(headers, `${prefix}-used`);
	const usedPercentHeader = parseOptionalNumber(headers, `${prefix}-used-percent`, `${prefix}-usage-percent`);
	const remainingPercentHeader = parseOptionalNumber(headers, `${prefix}-remaining-percent`);
	const resetAfterSeconds = parseOptionalNumber(headers, `${prefix}-reset-after-seconds`, `${prefix}-reset-after`);
	const resetAt = parseResetAtSeconds(headerValue(headers, `${prefix}-reset-at`) ?? headerValue(headers, `${prefix}-reset`));

	if (
		limit === undefined && remaining === undefined && used === undefined &&
		usedPercentHeader === undefined && remainingPercentHeader === undefined &&
		resetAfterSeconds === undefined && resetAt <= 0
	) return undefined;

	const derivedUsed = used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
	const usedPercent = usedPercentHeader !== undefined
		? clampPercent(usedPercentHeader)
		: limit !== undefined && limit > 0 && derivedUsed !== undefined
			? clampPercent((derivedUsed / limit) * 100)
			: undefined;
	const remainingPercent = remainingPercentHeader !== undefined
		? clampPercent(remainingPercentHeader)
		: limit !== undefined && limit > 0 && remaining !== undefined
			? clampPercent((remaining / limit) * 100)
			: usedPercent !== undefined
				? clampPercent(100 - usedPercent)
				: undefined;

	return {
		limit,
		remaining,
		used: derivedUsed,
		usedPercent,
		remainingPercent,
		resetAfterSeconds: resetAfterSeconds !== undefined ? Math.max(0, Math.round(resetAfterSeconds)) : resetAfterFromAt(resetAt),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resource,
	};
}

function applyWindow(
	usage: CopilotUsage,
	key: CopilotUsageWindowKey,
	window: CopilotRateLimitWindow | undefined,
	previous?: CopilotUsage,
): void {
	const value = window ?? previous?.[key];
	if (!value) return;
	usage[key] = value;
}

/**
 * True when the response carried real Copilot rate-limit signal (quota
 * headers or a limit error) — as opposed to a bare successful response that
 * only confirms the model works. Only real signal should mark quota
 * freshness for deferring proactive refreshes.
 */
export function hasCopilotHeaderSignal(headers: Record<string, string>, status: number): boolean {
	return hasHeaderPrefix(headers, "x-ratelimit-") || hasHeaderPrefix(headers, "x-copilot-")
		|| status === 429 || status === 402;
}

export function parseCopilotUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: CopilotUsage,
): CopilotUsage | undefined {
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	// Bare 2xx responses still parse for status/model recovery, but carry no
	// quota data and must not count as freshness for deferring refreshes.
	const hasPassiveSignal = hasCopilotHeaderSignal(headers, status) || (status >= 200 && status < 300 && !!modelId);
	if (!hasPassiveSignal) return undefined;

	const inferredStatus: GoModelStatus = status === 429
		? "rate_limited"
		: status === 402
			? "credits_error"
			: status >= 400
				? "error"
				: "available";
	const available = inferredStatus === "available";
	const rateLimited = inferredStatus === "rate_limited" || inferredStatus === "credits_error";

	const usage: CopilotUsage = {
		available,
		status: inferredStatus,
		workingModel: available ? modelId ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? modelId ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		availableModels: previous?.availableModels,
		source: "headers",
		...retryResetFields(rateLimited, retryAfterSeconds, previous),
		errorMessage: rateLimited
			? retryAfterSeconds > 0
				? `Rate limited; retry after ${retryAfterSeconds}s`
				: inferredStatus === "credits_error" ? "Quota exhausted" : "Rate limited"
			: inferredStatus === "error"
				? `HTTP ${status}`
				: undefined,
	};

	const resource = headerValue(headers, "x-ratelimit-resource");
	applyWindow(usage, "requests", parseCopilotWindowFromPrefix(headers, "x-ratelimit", resource), previous);
	applyWindow(usage, "premiumRequests", parseCopilotWindowFromPrefix(headers, "x-copilot-premium-requests", "premium"), previous);

	return usage;
}

// ───────── Model Probing ─────────

function fallbackCopilotModels(auth: CopilotAuth): CopilotCheckModel[] {
	const fallback: Array<{ id: string; api: SubscriptionProbeApi }> = [
		{ id: GITHUB_COPILOT_PROBE_MODEL, api: "openai-responses" },
		{ id: "gpt-5-mini", api: "openai-responses" },
		{ id: "gpt-4.1", api: "openai-completions" },
		{ id: "claude-haiku-4.5", api: "anthropic-messages" },
	];
	const allowed = auth.availableModelIds ? new Set(auth.availableModelIds) : undefined;
	return fallback
		.filter((model) => !allowed || allowed.has(model.id))
		.map((model, index) => ({
			...model,
			endpoint: resolveProbeEndpoint(auth.baseUrl, model.api),
			costRank: index + 1,
		}));
}

async function getCopilotCheckModels(auth: CopilotAuth, preferredModel?: SelectedModel): Promise<CopilotCheckModel[]> {
	const modelsById = new Map<string, CopilotCheckModel>();
	const allowed = auth.availableModelIds ? new Set(auth.availableModelIds) : undefined;

	try {
		const { getModels } = await import("@earendil-works/pi-ai/compat");
		for (const model of getModels(GITHUB_COPILOT_PROVIDER) as PiModelLike[]) {
			const api = asProbeApi(model.api);
			if (!api || (allowed && !allowed.has(model.id))) continue;
			modelsById.set(model.id, {
				id: model.id,
				api,
				endpoint: resolveProbeEndpoint(auth.baseUrl || model.baseUrl || COPILOT_API_BASE_URL, api),
				costRank: modelCostRank(model),
			});
		}
	} catch {
		// pi-ai not available — use fallback models.
	}

	if (modelsById.size === 0) {
		for (const model of fallbackCopilotModels(auth)) modelsById.set(model.id, model);
	}

	// Prefer the currently selected Copilot model when the account allows it.
	const preferredApi = preferredModel?.provider === GITHUB_COPILOT_PROVIDER ? asProbeApi(preferredModel.api) : undefined;
	const preferredId = preferredApi && (!allowed || allowed.has(preferredModel!.id)) ? preferredModel!.id : undefined;
	if (preferredId && preferredApi && !modelsById.has(preferredId)) {
		modelsById.set(preferredId, {
			id: preferredId,
			api: preferredApi,
			endpoint: resolveProbeEndpoint(auth.baseUrl || preferredModel!.baseUrl || COPILOT_API_BASE_URL, preferredApi),
			costRank: -1,
		});
	}

	return sortModelsByPreference(
		Array.from(modelsById.values()),
		preferredId ? [preferredId, ...PREFERRED_COPILOT_PROBE_MODELS] : PREFERRED_COPILOT_PROBE_MODELS,
	);
}

function copilotProbeHeaders(auth: CopilotAuth, api: SubscriptionProbeApi): Record<string, string> {
	const headers: Record<string, string> = {
		...COPILOT_HEADERS,
		"Accept": "application/json",
		"Content-Type": "application/json",
		"Authorization": `Bearer ${auth.token}`,
		"X-GitHub-Api-Version": COPILOT_API_VERSION,
	};

	if (api === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
		headers["anthropic-dangerous-direct-browser-access"] = "true";
	}

	return headers;
}

function copilotProbeBody(model: CopilotCheckModel): Record<string, unknown> {
	if (model.api === "anthropic-messages") {
		return {
			model: model.id,
			messages: [{ role: "user", content: "Reply with exactly: ok" }],
			max_tokens: 1,
			stream: true,
		};
	}

	if (model.api === "openai-responses") {
		return {
			model: model.id,
			input: "Reply with exactly: ok",
			max_output_tokens: 1,
			stream: true,
			store: false,
		};
	}

	return {
		model: model.id,
		messages: [{ role: "user", content: "Reply with exactly: ok" }],
		max_completion_tokens: 1,
		stream: true,
	};
}

export function isCopilotModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid|not enabled)|unsupported.*model|not.*authorized.*model|model.*not.*enabled/i.test(message);
}

export function isCopilotQuotaMessage(message: string): boolean {
	return /quota|premium.*requests?|rate limit|too many requests|usage limit|exceeded.*limit|limit.*exceeded/i.test(message);
}

export async function checkCopilotUsage(auth: CopilotAuth | undefined, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<CopilotUsage> {
	if (!auth) {
		return { available: false, status: "no_key" };
	}

	return probeProviderUsage<CopilotCheckModel, CopilotUsage>({
		label: "GitHub Copilot",
		models: await getCopilotCheckModels(auth, preferredModel),
		signal,
		request: (model, probeSignal) => fetch(model.endpoint, {
			method: "POST",
			headers: copilotProbeHeaders(auth, model.api),
			body: JSON.stringify(copilotProbeBody(model)),
			signal: probeSignal,
		}),
		parseHeaders: parseCopilotUsageHeaders,
		classifyError: (status, message) =>
			status === 429 || isCopilotQuotaMessage(message)
				? status === 402 ? "credits_error" : "rate_limited"
				: isCopilotModelUnavailable(message)
					? "unavailable"
					: "failed",
		emptyUsage: () => ({ available: false, status: "error", availableModels: auth.availableModelIds?.length }),
	});
}
