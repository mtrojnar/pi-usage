import type {
	AnthropicAuth,
	AnthropicUsage,
	AnthropicUsageWindow,
	GoModelStatus,
	SelectedModel,
} from "./types.ts";
import {
	ANTHROPIC_PROVIDER,
	ANTHROPIC_PROBE_MODEL,
	ANTHROPIC_USAGE_URL,
} from "./config.ts";
import { apiKeyFromCredential, oauthAccessToken, readStoredCredential } from "./auth.ts";
import { clampPercent, errorText } from "./format.ts";
import {
	hasHeaderPrefix,
	headerValue,
	parseOptionalNumber,
	parseResetAtSeconds,
	parseRetryAfterSeconds,
	resetAfterFromAt,
	retryResetFields,
} from "./headers.ts";
import { fetchWithTimeout, piUsageUserAgent, readErrorDetail, readResponseJson } from "./http.ts";
import {
	modelCostRank,
	probeProviderUsage,
	resolveProbeEndpoint,
	sortModelsByPreference,
	type PiModelLike,
} from "./probe.ts";

// ───────── Constants ─────────

const CLAUDE_CODE_VERSION = "2.1.75";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const ANTHROPIC_BETA = "claude-code-20250219,oauth-2025-04-20";

const PREFERRED_ANTHROPIC_PROBE_MODELS = [
	ANTHROPIC_PROBE_MODEL,
	"claude-haiku-4-5",
	"claude-sonnet-4-5",
	"claude-sonnet-4-0",
	"claude-3-5-haiku-latest",
];

interface AnthropicCheckModel {
	id: string;
	endpoint: string;
	costRank: number;
}

const FALLBACK_ANTHROPIC_MODELS: AnthropicCheckModel[] = PREFERRED_ANTHROPIC_PROBE_MODELS.map((id, index) => ({
	id,
	endpoint: resolveProbeEndpoint(ANTHROPIC_BASE_URL, "anthropic-messages"),
	costRank: index + 1,
}));

export type AnthropicUsageApiResult =
	| { success: true; usage: AnthropicUsage }
	| { success: false; error: string };

// ───────── Auth Helpers ─────────

function inferAnthropicAuthType(token: string, fallback: AnthropicAuth["type"]): AnthropicAuth["type"] {
	return token.includes("sk-ant-oat") ? "oauth" : fallback;
}

export async function getAnthropicAuth(): Promise<AnthropicAuth | undefined> {
	const credential = await readStoredCredential(ANTHROPIC_PROVIDER);
	const accessToken = oauthAccessToken(credential);
	if (accessToken) return { token: accessToken, type: "oauth", source: "auth.json" };

	const storedKey = apiKeyFromCredential(credential);
	if (storedKey) {
		return { token: storedKey, type: inferAnthropicAuthType(storedKey, "api_key"), source: "auth.json" };
	}

	const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (oauthToken) return { token: oauthToken, type: "oauth", source: "ANTHROPIC_OAUTH_TOKEN" };

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (apiKey) {
		return { token: apiKey, type: inferAnthropicAuthType(apiKey, "api_key"), source: "ANTHROPIC_API_KEY" };
	}

	return undefined;
}

// ───────── Header Parsing ─────────

function parseUnifiedWindow(headers: Record<string, string>, key: "5h" | "7d"): AnthropicUsageWindow | undefined {
	const utilization = parseOptionalNumber(headers, `anthropic-ratelimit-unified-${key}-utilization`);
	if (utilization === undefined) return undefined; // no percent → nothing to display
	const resetAt = parseResetAtSeconds(headerValue(headers, `anthropic-ratelimit-unified-${key}-reset`));
	return {
		// Header utilization is a 0..1 fraction; scale to a percentage.
		utilizationPercent: clampPercent(utilization * 100),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
		status: headerValue(headers, `anthropic-ratelimit-unified-${key}-status`),
	};
}

/**
 * True when the response carried real Anthropic rate-limit signal (unified
 * rate-limit headers or a limit error) — as opposed to a bare successful
 * response that only confirms the model works. Only real signal should mark
 * quota freshness for deferring proactive refreshes.
 */
export function hasAnthropicHeaderSignal(headers: Record<string, string>, status: number): boolean {
	return hasHeaderPrefix(headers, "anthropic-ratelimit-unified-") || status === 429 || status === 402;
}

export function parseAnthropicUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: AnthropicUsage,
): AnthropicUsage | undefined {
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	// Bare 2xx responses still parse for status/model recovery, but carry no
	// quota data and must not count as freshness for deferring refreshes.
	const hasPassiveSignal = hasAnthropicHeaderSignal(headers, status) || (status >= 200 && status < 300 && !!modelId);
	if (!hasPassiveSignal) return undefined;

	const parsedFiveHour = parseUnifiedWindow(headers, "5h");
	const parsedWeekly = parseUnifiedWindow(headers, "7d");
	const fiveHour = parsedFiveHour ?? previous?.fiveHour;
	const weekly = parsedWeekly ?? previous?.weekly;
	const overall = headerValue(headers, "anthropic-ratelimit-unified-status");
	const rejected = status === 429 || overall === "rejected"
		|| parsedFiveHour?.status === "rejected"
		|| parsedWeekly?.status === "rejected";

	const inferredStatus: GoModelStatus = rejected ? "rate_limited" : status >= 400 ? "error" : "available";
	const available = inferredStatus === "available";
	const rateLimited = inferredStatus === "rate_limited";

	return {
		available,
		status: inferredStatus,
		authType: previous?.authType,
		source: "headers",
		fiveHour,
		weekly,
		workingModel: available ? modelId ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? modelId ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		...retryResetFields(rateLimited, retryAfterSeconds, previous),
		errorMessage: rateLimited
			? retryAfterSeconds > 0 ? `Rate limited; retry after ${retryAfterSeconds}s` : "Rate limited"
			: inferredStatus === "error"
				? `HTTP ${status}`
				: undefined,
	};
}

// ───────── Usage Endpoint (Claude Pro/Max OAuth) ─────────

interface AnthropicUsageApiWindow {
	utilization?: number | null;
	resets_at?: string | null;
}

interface AnthropicUsageApiResponse {
	five_hour?: AnthropicUsageApiWindow | null;
	seven_day?: AnthropicUsageApiWindow | null;
}

function windowFromApi(window: AnthropicUsageApiWindow | null | undefined): AnthropicUsageWindow | undefined {
	if (!window) return undefined;
	const utilization = Number(window.utilization);
	if (!Number.isFinite(utilization)) return undefined;
	const resetAt = parseResetAtSeconds(window.resets_at ?? undefined);
	return {
		utilizationPercent: clampPercent(utilization),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
	};
}

function anthropicOAuthHeaders(token: string): Record<string, string> {
	return {
		"Authorization": `Bearer ${token}`,
		"anthropic-beta": ANTHROPIC_BETA,
		"user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
		"x-app": "cli",
	};
}

export async function checkAnthropicUsageFromUsageApi(token: string, signal?: AbortSignal): Promise<AnthropicUsageApiResult> {
	try {
		const response = await fetchWithTimeout(ANTHROPIC_USAGE_URL, {
			headers: {
				...anthropicOAuthHeaders(token),
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
				"Accept": "application/json",
			},
		}, signal);

		if (!response.ok) {
			return { success: false, error: `Anthropic usage API: ${await readErrorDetail(response, signal)}` };
		}

		const data = await readResponseJson<AnthropicUsageApiResponse>(response, signal);
		const fiveHour = windowFromApi(data.five_hour);
		const weekly = windowFromApi(data.seven_day);
		if (!fiveHour && !weekly) {
			return { success: false, error: "Anthropic usage API: no usage windows" };
		}

		const rateLimited = (fiveHour?.utilizationPercent ?? 0) >= 100 || (weekly?.utilizationPercent ?? 0) >= 100;
		return {
			success: true,
			usage: {
				available: !rateLimited,
				status: rateLimited ? "rate_limited" : "available",
				authType: "oauth",
				source: "usage_api",
				fiveHour,
				weekly,
			},
		};
	} catch (e: unknown) {
		return { success: false, error: errorText(e) };
	}
}

// ───────── Model Probing (API-key auth and OAuth fallback) ─────────

async function getAnthropicCheckModels(preferredModel?: SelectedModel): Promise<AnthropicCheckModel[]> {
	const modelsById = new Map<string, AnthropicCheckModel>();
	for (const model of FALLBACK_ANTHROPIC_MODELS) {
		modelsById.set(model.id, model);
	}

	try {
		const { getModels } = await import("@earendil-works/pi-ai/compat");
		for (const model of getModels(ANTHROPIC_PROVIDER) as PiModelLike[]) {
			if (model.api !== "anthropic-messages" || modelsById.has(model.id)) continue;
			modelsById.set(model.id, {
				id: model.id,
				endpoint: resolveProbeEndpoint(model.baseUrl || ANTHROPIC_BASE_URL, "anthropic-messages"),
				costRank: modelCostRank(model),
			});
		}
	} catch {
		// pi-ai not available — use fallback models.
	}

	// Prefer the currently selected Anthropic model.
	const preferredId = preferredModel?.provider === ANTHROPIC_PROVIDER && preferredModel.api === "anthropic-messages"
		? preferredModel.id
		: undefined;
	if (preferredId && !modelsById.has(preferredId)) {
		modelsById.set(preferredId, {
			id: preferredId,
			endpoint: resolveProbeEndpoint(preferredModel!.baseUrl || ANTHROPIC_BASE_URL, "anthropic-messages"),
			costRank: -1,
		});
	}

	return sortModelsByPreference(
		Array.from(modelsById.values()),
		preferredId ? [preferredId, ...PREFERRED_ANTHROPIC_PROBE_MODELS] : PREFERRED_ANTHROPIC_PROBE_MODELS,
	);
}

function anthropicProbeHeaders(auth: AnthropicAuth): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": "application/json",
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
	};

	if (auth.type === "oauth") {
		Object.assign(headers, anthropicOAuthHeaders(auth.token));
	} else {
		headers["x-api-key"] = auth.token;
		headers["User-Agent"] = piUsageUserAgent();
	}

	return headers;
}

function anthropicProbeBody(auth: AnthropicAuth, model: AnthropicCheckModel): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens: 1,
		stream: false,
		messages: [{ role: "user", content: "Reply with exactly: ok" }],
	};

	if (auth.type === "oauth") {
		body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }];
	}

	return body;
}

export function isAnthropicModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid)|unsupported.*model/i.test(message);
}

async function checkAnthropicUsageWithProbe(auth: AnthropicAuth, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<AnthropicUsage> {
	return probeProviderUsage<AnthropicCheckModel, AnthropicUsage>({
		label: "Anthropic",
		models: await getAnthropicCheckModels(preferredModel),
		signal,
		request: (model, probeSignal) => fetch(model.endpoint, {
			method: "POST",
			headers: anthropicProbeHeaders(auth),
			body: JSON.stringify(anthropicProbeBody(auth, model)),
			signal: probeSignal,
		}),
		parseHeaders: parseAnthropicUsageHeaders,
		classifyError: (status, message) =>
			status === 429 ? "rate_limited" : isAnthropicModelUnavailable(message) ? "unavailable" : "failed",
		emptyUsage: () => ({ available: false, status: "error", authType: auth.type }),
	});
}

// ───────── Public API ─────────

export async function checkAnthropicUsage(auth: AnthropicAuth | undefined, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<AnthropicUsage> {
	if (!auth) {
		return { available: false, status: "no_key" };
	}

	// Claude Pro/Max: read the free usage endpoint (no model request, no extra-usage billing).
	if (auth.type === "oauth") {
		const usageApiResult = await checkAnthropicUsageFromUsageApi(auth.token, signal);
		if (usageApiResult.success) return usageApiResult.usage;
		if (signal?.aborted) {
			return { available: false, status: "error", authType: "oauth", source: "usage_api", error: usageApiResult.error };
		}

		// Endpoint unavailable — fall back to a probe that surfaces the unified rate-limit headers.
		const probeResult = await checkAnthropicUsageWithProbe(auth, signal, preferredModel);
		if (probeResult.status === "error" && !probeResult.fiveHour && !probeResult.weekly) {
			const probeError = probeResult.errorMessage || probeResult.error;
			probeResult.error = `${usageApiResult.error}; fallback probe: ${probeError ?? "failed"}`;
		}
		return probeResult;
	}

	// API-key auth has no subscription usage endpoint; probe for availability only.
	return checkAnthropicUsageWithProbe(auth, signal, preferredModel);
}
