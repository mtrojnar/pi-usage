import type {
	BoundApiKey,
	GoModelStatus,
	PassiveUsageUpdate,
	SelectedModel,
	SubscriptionProbeApi,
	SubscriptionProbeModel,
	SubscriptionUsage,
	SubscriptionQuotaWindow,
	UsageContext,
	UsageApiWindows,
} from "./types.ts";
import { resolveBoundProviderAuth } from "./auth.ts";
import { clampPercent, errorText } from "./format.ts";
import { fetchSameOrigin, fetchSameOriginWithTimeout, isSameHttpOrigin, piUsageUserAgent, readErrorDetail, readResponseJson } from "./http.ts";
import {
	hasHeaderPrefix,
	headerValue,
	parseOptionalNumber,
	parseResetAtSeconds,
	parseRetryAfterSeconds,
	retryResetFields,
} from "./headers.ts";
import {
	asProbeApi,
	isGoModelStatus,
	modelCostRank,
	probeProviderUsage,
	resolveProbeEndpoint,
	sortModelsByPreference,
	type PiModelLike,
} from "./probe.ts";

// ───────── Types ─────────

export interface SubscriptionUsageApiConfig {
	/** Dedicated quota endpoint (GET, Bearer auth), tried before model probing. */
	url: string;
	/** Maps the endpoint's payload to generic quota windows; undefined = unusable payload. */
	parse: (payload: unknown) => UsageApiWindows | undefined;
}

export interface SubscriptionProviderConfig {
	provider: string;
	label: string;
	shortLabel: string;
	authProviderIds?: string[];
	envKeys?: string[];
	supportedApis?: SubscriptionProbeApi[];
	preferredModelIds?: string[];
	documentedModels?: SubscriptionProbeModel[];
	quotaHeaderPrefixes?: string[];
	usageApi?: SubscriptionUsageApiConfig;
}

const DEFAULT_SUPPORTED_APIS: SubscriptionProbeApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

// ───────── Auth Helpers ─────────

export async function getSubscriptionAuth(
	ctx: Pick<UsageContext, "modelRegistry">,
	config: SubscriptionProviderConfig,
): Promise<BoundApiKey | undefined> {
	for (const provider of config.authProviderIds ?? [config.provider]) {
		const resolved = await resolveBoundProviderAuth(ctx, provider);
		if (resolved) return resolved;
	}
	return undefined;
}

/** @deprecated Use getSubscriptionAuth() so the key remains bound to its origin. */
export async function getSubscriptionApiKey(
	ctx: Pick<UsageContext, "modelRegistry">,
	config: SubscriptionProviderConfig,
): Promise<string | undefined> {
	return (await getSubscriptionAuth(ctx, config))?.apiKey;
}

// ───────── Model Helpers ─────────

export async function getSubscriptionCheckModels(
	config: SubscriptionProviderConfig,
	preferredModel?: SelectedModel,
	ctx?: Pick<UsageContext, "modelRegistry">,
	credentialBaseUrl?: string,
): Promise<SubscriptionProbeModel[]> {
	const allowedApis = new Set(config.supportedApis ?? DEFAULT_SUPPORTED_APIS);
	const modelsById = new Map<string, SubscriptionProbeModel>();
	const addModel = (model: SubscriptionProbeModel): void => {
		if ((!credentialBaseUrl || isSameHttpOrigin(model.endpoint, credentialBaseUrl)) && !modelsById.has(model.id)) {
			modelsById.set(model.id, model);
		}
	};
	for (const model of config.documentedModels ?? []) addModel(model);

	const providerModels = ctx?.modelRegistry.getProvider(config.provider)?.getModels() ?? [];
	for (const model of providerModels as readonly PiModelLike[]) {
		const api = asProbeApi(model.api);
		if (!api || !allowedApis.has(api)) continue;
		addModel({
			id: model.id,
			api,
			endpoint: resolveProbeEndpoint(model.baseUrl, api),
			costRank: modelCostRank(model, 0),
			headers: model.headers,
		});
	}

	// Prefer the currently selected model when it belongs to this provider.
	const preferredApi = preferredModel?.provider === config.provider ? asProbeApi(preferredModel.api) : undefined;
	if (preferredModel && preferredApi && allowedApis.has(preferredApi) && !modelsById.has(preferredModel.id)) {
		addModel({
			id: preferredModel.id,
			api: preferredApi,
			endpoint: resolveProbeEndpoint(preferredModel.baseUrl, preferredApi),
			costRank: -1,
		});
	}

	const preferredId = preferredModel?.provider === config.provider ? preferredModel.id : undefined;
	return sortModelsByPreference(
		Array.from(modelsById.values()),
		preferredId ? [preferredId, ...(config.preferredModelIds ?? [])] : config.preferredModelIds ?? [],
	);
}

// ───────── Header Parsing ─────────

export const QUOTA_WINDOW_KINDS = ["rolling", "weekly", "monthly"] as const;
export type QuotaWindowKind = (typeof QUOTA_WINDOW_KINDS)[number];

/**
 * Parse one passive quota window from x-<prefix>[-quota]-<window>-<metric>
 * response headers.
 */
export function parseQuotaWindow(
	headers: Record<string, string>,
	prefixes: string[],
	window: QuotaWindowKind,
): { window?: SubscriptionQuotaWindow; hasHeaders: boolean } {
	const names = (metric: string) => prefixes.flatMap((prefix) => [
		`x-${prefix}-${window}-${metric}`,
		`x-${prefix}-quota-${window}-${metric}`,
	]);
	const used = parseOptionalNumber(headers, ...names("used-percent"));
	const remaining = parseOptionalNumber(headers, ...names("remaining-percent"));
	const resetAfter = parseOptionalNumber(headers, ...names("reset-after-seconds"), ...names("reset-after"));
	const resetAtValue = names("reset-at").map((name) => headerValue(headers, name)).find((value) => value !== undefined);
	const resetAt = parseResetAtSeconds(resetAtValue);
	const hasHeaders = used !== undefined || remaining !== undefined || resetAfter !== undefined || resetAt > 0;
	if (!hasHeaders) return { hasHeaders: false };

	return {
		hasHeaders: true,
		window: {
			usedPercent: used !== undefined ? clampPercent(used) : undefined,
			remainingPercent: remaining !== undefined
				? clampPercent(remaining)
				: used !== undefined
					? clampPercent(100 - used)
					: undefined,
			resetAfterSeconds: resetAfter !== undefined ? Math.max(0, Math.round(resetAfter)) : undefined,
			resetAt: resetAt > 0 ? resetAt : undefined,
		},
	};
}

function firstPrefixedHeader(headers: Record<string, string>, prefixes: string[], suffix: string): string | undefined {
	for (const prefix of prefixes) {
		const value = headerValue(headers, `x-${prefix}-${suffix}`);
		if (value !== undefined) return value;
	}
	return undefined;
}

export function parseSubscriptionUsageHeaders(
	config: SubscriptionProviderConfig,
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: SubscriptionUsage,
): PassiveUsageUpdate<SubscriptionUsage> | undefined {
	const prefixes = config.quotaHeaderPrefixes ?? [config.provider];
	const hasProviderHeaders = prefixes.some((prefix) => hasHeaderPrefix(headers, `x-${prefix}-`));
	const statusHeader = firstPrefixedHeader(headers, prefixes, "status");
	const headerStatus = isGoModelStatus(statusHeader) ? statusHeader : undefined;
	const responseModel = firstPrefixedHeader(headers, prefixes, "model") ?? modelId;
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	const rolling = parseQuotaWindow(headers, prefixes, "rolling");
	const weekly = parseQuotaWindow(headers, prefixes, "weekly");
	const monthly = parseQuotaWindow(headers, prefixes, "monthly");
	const hasQuotaHeaders = rolling.hasHeaders || weekly.hasHeaders || monthly.hasHeaders;
	// Bare 2xx responses allow status/model recovery, but only provider/quota
	// signals and limit errors count as freshness for deferring auto refreshes.
	const hasSignal = hasProviderHeaders || hasQuotaHeaders || status === 429 || status === 402;
	if (!hasSignal && !(status >= 200 && status < 300 && !!responseModel)) return undefined;

	const inferredStatus: GoModelStatus = headerStatus
		?? (status === 429
			? "rate_limited"
			: status === 402
				? "credits_error"
				: status >= 400
					? "error"
					: "available");
	const available = inferredStatus === "available";
	const limited = inferredStatus === "rate_limited" || inferredStatus === "credits_error";

	return {
		hasSignal,
		usage: {
			provider: config.provider,
			label: config.label,
			shortLabel: config.shortLabel,
			available,
			status: inferredStatus,
			workingModel: available ? responseModel ?? previous?.workingModel : previous?.workingModel,
			rateLimitedModel: limited ? responseModel ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
			checkedModels: previous?.checkedModels,
			totalModels: previous?.totalModels,
			quotaSource: hasQuotaHeaders ? "response headers" : previous?.quotaSource,
			rolling: rolling.window ?? previous?.rolling,
			weekly: weekly.window ?? previous?.weekly,
			monthly: monthly.window ?? previous?.monthly,
			...retryResetFields(limited, retryAfterSeconds, previous),
			source: "headers",
			errorMessage: limited
				? retryAfterSeconds > 0
					? `Rate limited; retry after ${retryAfterSeconds}s`
					: inferredStatus === "credits_error" ? "Quota exhausted" : "Rate limited"
				: inferredStatus === "error"
					? `HTTP ${status}`
					: undefined,
		},
	};
}

// ───────── Usage Endpoint ─────────

export type SubscriptionUsageApiResult =
	| { success: true; usage: SubscriptionUsage }
	| { success: false; error: string };

/**
 * Read a provider's dedicated quota endpoint (no model request, no usage billing).
 * Returns quota windows mapped by the provider-specific parser.
 */
export async function checkSubscriptionUsageApi(
	config: SubscriptionProviderConfig,
	auth: BoundApiKey,
	signal?: AbortSignal,
): Promise<SubscriptionUsageApiResult> {
	if (!config.usageApi) return { success: false, error: "no usage endpoint configured" };
	try {
		const response = await fetchSameOriginWithTimeout(config.usageApi.url, auth.baseUrl, {
			headers: {
				"Authorization": `Bearer ${auth.apiKey}`,
				"Accept": "application/json",
				"User-Agent": piUsageUserAgent(),
			},
		}, signal);

		if (!response.ok) {
			return { success: false, error: `${config.label} usage API: ${await readErrorDetail(response, signal)}` };
		}

		const windows = config.usageApi.parse(await readResponseJson(response, signal));
		if (!windows) {
			return { success: false, error: `${config.label} usage API: no usage windows` };
		}

		const exhausted = [windows.rolling, windows.weekly, windows.monthly]
			.some((window) => (window?.usedPercent ?? 0) >= 100 || (window?.remainingPercent ?? 100) <= 0);
		return {
			success: true,
			usage: {
				provider: config.provider,
				label: config.label,
				shortLabel: config.shortLabel,
				available: !exhausted,
				status: exhausted ? "rate_limited" : "available",
				quotaSource: "usage api",
				rolling: windows.rolling,
				weekly: windows.weekly,
				monthly: windows.monthly,
				source: "usage_api",
			},
		};
	} catch (e: unknown) {
		return { success: false, error: errorText(e) };
	}
}

// ───────── Model Probing ─────────

function probeHeaders(apiKey: string, model: SubscriptionProbeModel): Record<string, string> {
	const headers: Record<string, string> = {
		...model.headers,
		"Accept": "application/json",
		"Content-Type": "application/json",
	};

	if (model.api === "anthropic-messages") {
		headers["x-api-key"] = apiKey;
		headers["anthropic-version"] = "2023-06-01";
		headers["anthropic-dangerous-direct-browser-access"] = "true";
	} else {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	return headers;
}

function probeBody(model: SubscriptionProbeModel): Record<string, unknown> {
	if (model.api === "anthropic-messages") {
		return {
			model: model.id,
			messages: [{ role: "user", content: "Reply with exactly: ok" }],
			max_tokens: 1,
			stream: false,
		};
	}

	if (model.api === "openai-responses") {
		return {
			model: model.id,
			input: "Reply with exactly: ok",
			max_output_tokens: 1,
			stream: false,
			store: false,
		};
	}

	return {
		model: model.id,
		messages: [{ role: "user", content: "Reply with exactly: ok" }],
		max_tokens: 1,
		stream: false,
	};
}

export function isSubscriptionModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid|not enabled)|unsupported.*model|disabled.*model|not.*authorized.*model/i.test(message);
}

export function isSubscriptionQuotaMessage(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|quota|usage limit|too many requests|subscription.*(quota|limit)|limit.*exceeded|exceeded.*limit|rate limit/i.test(message);
}

export async function checkSubscriptionProviderUsage(
	ctx: Pick<UsageContext, "modelRegistry">,
	config: SubscriptionProviderConfig,
	auth: BoundApiKey | undefined,
	signal?: AbortSignal,
	preferredModel?: SelectedModel,
): Promise<SubscriptionUsage> {
	const emptyUsage = (): SubscriptionUsage => ({
		provider: config.provider,
		label: config.label,
		shortLabel: config.shortLabel,
		available: false,
		status: "no_key",
	});
	if (!auth) return emptyUsage();

	// Dedicated quota endpoint first (no model request, no usage billing).
	let usageApiError: string | undefined;
	if (config.usageApi) {
		const apiResult = await checkSubscriptionUsageApi(config, auth, signal);
		if (apiResult.success) return apiResult.usage;
		if (signal?.aborted) {
			return { ...emptyUsage(), status: "error", source: "usage_api", error: apiResult.error };
		}
		usageApiError = apiResult.error;
	}

	const probeResult = await probeProviderUsage<SubscriptionProbeModel, SubscriptionUsage>({
		label: config.label,
		models: await getSubscriptionCheckModels(config, preferredModel, ctx, auth.baseUrl),
		signal,
		request: (model, probeSignal) => fetchSameOrigin(model.endpoint, auth.baseUrl, {
			method: "POST",
			headers: probeHeaders(auth.apiKey, model),
			body: JSON.stringify(probeBody(model)),
			signal: probeSignal,
		}),
		parseHeaders: (headers, status, modelId) => parseSubscriptionUsageHeaders(config, headers, status, modelId)?.usage,
		classifyError: (status, message) =>
			isSubscriptionModelUnavailable(message)
				? "unavailable"
				: status === 429 || status === 402 || isSubscriptionQuotaMessage(message)
					? status === 402 || /credit|balance|quota.*exhausted/i.test(message)
						? "credits_error"
						: "rate_limited"
					: "failed",
		emptyUsage,
	});
	if (usageApiError && probeResult.status === "error") {
		const mergedError = `${usageApiError}; fallback probe: ${probeResult.errorMessage ?? probeResult.error ?? "failed"}`;
		probeResult.errorMessage = mergedError;
		probeResult.error = mergedError;
	}
	return probeResult;
}
