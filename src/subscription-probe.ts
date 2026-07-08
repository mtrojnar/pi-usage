import type {
	AuthApiKeyCredential,
	AuthJson,
	GoModelStatus,
	SubscriptionProbeApi,
	SubscriptionProbeModel,
	SubscriptionUsage,
	SubscriptionQuotaWindow,
} from "./types.ts";
import {
	CHECK_TIMEOUT_MS,
	readAuthJson,
	resolveConfigValue,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseText } from "./http.ts";

// ───────── Types ─────────

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
}

interface PiModelLike {
	id: string;
	api: string;
	baseUrl: string;
	headers?: Record<string, string>;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

const DEFAULT_SUPPORTED_APIS: SubscriptionProbeApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

// ───────── Auth Helpers ─────────

function getAuthApiKey(auth: AuthJson | undefined, provider: string): string | undefined {
	const credential = auth?.[provider] as AuthApiKeyCredential | undefined;
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	return resolveConfigValue(credential.key)?.trim() || undefined;
}

export function getSubscriptionApiKey(config: SubscriptionProviderConfig): string | undefined {
	const auth = readAuthJson();
	for (const provider of config.authProviderIds ?? [config.provider]) {
		const key = getAuthApiKey(auth, provider);
		if (key) return key;
	}
	for (const envKey of config.envKeys ?? []) {
		const key = process.env[envKey]?.trim();
		if (key) return key;
	}
	return undefined;
}

// ───────── Endpoint / Model Helpers ─────────

export function resolveSubscriptionEndpoint(baseUrl: string, api: SubscriptionProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		if (normalized.endsWith("/messages")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/messages`;
		return `${normalized}/v1/messages`;
	}
	if (api === "openai-responses") {
		if (normalized.endsWith("/responses")) return normalized;
		return `${normalized}/responses`;
	}
	if (normalized.endsWith("/chat/completions")) return normalized;
	return `${normalized}/chat/completions`;
}

function modelCostRank(model: PiModelLike): number {
	const cost = model.cost ?? {};
	const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
	return Number.isFinite(rawRank) ? rawRank : 9999;
}

function supportedApis(config: SubscriptionProviderConfig): Set<SubscriptionProbeApi> {
	return new Set(config.supportedApis ?? DEFAULT_SUPPORTED_APIS);
}

export async function getSubscriptionCheckModels(config: SubscriptionProviderConfig): Promise<SubscriptionProbeModel[]> {
	const modelsById = new Map<string, SubscriptionProbeModel>();
	for (const model of config.documentedModels ?? []) {
		modelsById.set(model.id, model);
	}

	try {
		const { getModels } = await import("@earendil-works/pi-ai/compat");
		const getProviderModels = getModels as (provider: string) => PiModelLike[];
		const allowedApis = supportedApis(config);
		for (const model of getProviderModels(config.provider)) {
			const api = model.api as SubscriptionProbeApi;
			if (!allowedApis.has(api)) continue;
			if (modelsById.has(model.id)) continue;
			modelsById.set(model.id, {
				id: model.id,
				api,
				endpoint: resolveSubscriptionEndpoint(model.baseUrl, api),
				costRank: modelCostRank(model),
				headers: model.headers,
			});
		}
	} catch {
		// pi-ai not available — use documented models only.
	}

	const preferred = config.preferredModelIds ?? [];
	return Array.from(modelsById.values()).sort((a, b) => {
		const aPreferred = preferred.indexOf(a.id);
		const bPreferred = preferred.indexOf(b.id);
		if (aPreferred !== -1 || bPreferred !== -1) {
			if (aPreferred === -1) return 1;
			if (bPreferred === -1) return -1;
			return aPreferred - bPreferred;
		}
		return a.costRank - b.costRank || a.id.localeCompare(b.id);
	});
}

// ───────── Header Parsing ─────────

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
	return undefined;
}

function hasHeaderPrefix(headers: Record<string, string>, prefix: string): boolean {
	const normalizedPrefix = prefix.toLowerCase();
	return Object.keys(headers).some((name) => name.toLowerCase().startsWith(normalizedPrefix));
}

function parseOptionalNumber(headers: Record<string, string>, names: string[]): number | undefined {
	for (const name of names) {
		const value = headerValue(headers, name);
		if (value === undefined || value.trim() === "") continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function parseSubscriptionRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

function parseResetAt(value: string | undefined): number {
	if (!value) return 0;
	const trimmed = value.trim();
	if (!trimmed) return 0;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) {
		if (numeric > 1_000_000_000_000) return Math.round(numeric / 1000);
		return Math.round(numeric);
	}

	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : 0;
}

function quotaHeaderNames(prefix: string, window: "rolling" | "weekly" | "monthly", metric: string): string[] {
	return [
		`x-${prefix}-${window}-${metric}`,
		`x-${prefix}-quota-${window}-${metric}`,
	];
}

function parseQuotaWindow(
	headers: Record<string, string>,
	prefixes: string[],
	window: "rolling" | "weekly" | "monthly",
): { window?: SubscriptionQuotaWindow; hasHeaders: boolean } {
	const names = (metric: string) => prefixes.flatMap((prefix) => quotaHeaderNames(prefix, window, metric));
	const used = parseOptionalNumber(headers, names("used-percent"));
	const remaining = parseOptionalNumber(headers, names("remaining-percent"));
	const resetAfter = parseOptionalNumber(headers, [
		...names("reset-after-seconds"),
		...names("reset-after"),
	]);
	const resetAtRaw = prefixes
		.map((prefix) => headerValue(headers, `x-${prefix}-${window}-reset-at`) ?? headerValue(headers, `x-${prefix}-quota-${window}-reset-at`))
		.find((value) => value !== undefined);
	const resetAt = parseResetAt(resetAtRaw);
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

function isModelStatus(value: string | undefined): value is GoModelStatus {
	return value === "available" || value === "rate_limited" || value === "credits_error" || value === "error" || value === "no_key";
}

function quotaPrefixes(config: SubscriptionProviderConfig): string[] {
	return config.quotaHeaderPrefixes ?? [config.provider];
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
): SubscriptionUsage | undefined {
	const prefixes = quotaPrefixes(config);
	const hasProviderHeaders = prefixes.some((prefix) => hasHeaderPrefix(headers, `x-${prefix}-`));
	const statusHeader = firstPrefixedHeader(headers, prefixes, "status");
	const headerStatus = isModelStatus(statusHeader) ? statusHeader : undefined;
	const responseModel = firstPrefixedHeader(headers, prefixes, "model") ?? modelId;
	const retryAfterSeconds = parseSubscriptionRetryAfterSeconds(headerValue(headers, "retry-after"));
	const rolling = parseQuotaWindow(headers, prefixes, "rolling");
	const weekly = parseQuotaWindow(headers, prefixes, "weekly");
	const monthly = parseQuotaWindow(headers, prefixes, "monthly");
	const hasQuotaHeaders = rolling.hasHeaders || weekly.hasHeaders || monthly.hasHeaders;
	const hasPassiveSignal = hasProviderHeaders || hasQuotaHeaders || status === 429 || (status >= 200 && status < 300 && !!responseModel);
	if (!hasPassiveSignal) return undefined;

	const inferredStatus: GoModelStatus = headerStatus
		?? (status === 429
			? "rate_limited"
			: status === 402
				? "credits_error"
				: status === 401 || status === 403
					? "error"
					: status >= 400
						? "error"
						: "available");
	const available = inferredStatus === "available";
	const limited = inferredStatus === "rate_limited" || inferredStatus === "credits_error";
	const nowSec = Math.round(Date.now() / 1000);

	return {
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
		retryAfterSeconds: limited
			? retryAfterSeconds > 0 ? retryAfterSeconds : previous?.retryAfterSeconds
			: undefined,
		retryResetAt: limited
			? retryAfterSeconds > 0 ? nowSec + retryAfterSeconds : previous?.retryResetAt
			: undefined,
		source: "headers",
		errorMessage: limited
			? retryAfterSeconds > 0
				? `Rate limited; retry after ${retryAfterSeconds}s`
				: inferredStatus === "credits_error" ? "Quota exhausted" : "Rate limited"
			: inferredStatus === "error"
				? `HTTP ${status}`
				: undefined,
	};
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

async function probeSubscriptionModel(apiKey: string, model: SubscriptionProbeModel, signal: AbortSignal): Promise<Response> {
	return fetch(model.endpoint, {
		method: "POST",
		headers: probeHeaders(apiKey, model),
		body: JSON.stringify(probeBody(model)),
		signal,
	});
}

async function readErrorMessage(response: Response, fallback: string, signal?: AbortSignal): Promise<string> {
	try {
		const body = await readResponseText(response, signal);
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

export function isSubscriptionModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid|not enabled)|unsupported.*model|disabled.*model|not.*authorized.*model/i.test(message);
}

export function isSubscriptionQuotaMessage(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|quota|usage limit|too many requests|subscription.*(quota|limit)|limit.*exceeded|exceeded.*limit|rate limit/i.test(message);
}

function responseHeadersToRecord(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

function mergeProbeMetadata(
	usage: SubscriptionUsage,
	config: SubscriptionProviderConfig,
	model: SubscriptionProbeModel,
	checkedModels: number,
	totalModels: number,
): SubscriptionUsage {
	return {
		...usage,
		provider: config.provider,
		label: config.label,
		shortLabel: config.shortLabel,
		workingModel: usage.available ? model.id : usage.workingModel,
		rateLimitedModel: usage.status === "rate_limited" || usage.status === "credits_error" ? model.id : usage.rateLimitedModel,
		checkedModels,
		totalModels,
		source: "probe",
	};
}

export async function checkSubscriptionProviderUsage(
	config: SubscriptionProviderConfig,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<SubscriptionUsage> {
	if (!apiKey) {
		return {
			provider: config.provider,
			label: config.label,
			shortLabel: config.shortLabel,
			available: false,
			status: "no_key",
		};
	}

	const models = await getSubscriptionCheckModels(config);
	let checkedModels = 0;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			if (signal?.aborted) throw new Error(`${config.label} check aborted`);
			const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeSubscriptionModel(apiKey, model, timeoutSignal.signal);
			} finally {
				timeoutSignal.cleanup();
			}

			const headers = responseHeadersToRecord(response);
			const parsedHeaders = parseSubscriptionUsageHeaders(config, headers, response.status, model.id);

			if (response.ok) {
				await cancelResponseBody(response);
				return mergeProbeMetadata(parsedHeaders ?? {
					provider: config.provider,
					label: config.label,
					shortLabel: config.shortLabel,
					available: true,
					status: "available",
					workingModel: model.id,
				}, config, model, checkedModels, models.length);
			}

			const errorMsg = await readErrorMessage(response, `HTTP ${response.status}`, signal);

			if (isSubscriptionModelUnavailable(errorMsg)) {
				lastUnavailable = { model: model.id, message: errorMsg };
				continue;
			}

			if (response.status === 429 || response.status === 402 || isSubscriptionQuotaMessage(errorMsg)) {
				const status: GoModelStatus = response.status === 402 || /credit|balance|quota exhausted|quota.*exhausted/i.test(errorMsg)
					? "credits_error"
					: "rate_limited";
				return mergeProbeMetadata({
					...(parsedHeaders ?? {
						provider: config.provider,
						label: config.label,
						shortLabel: config.shortLabel,
						available: false,
						status,
						rateLimitedModel: model.id,
					}),
					errorMessage: truncate(errorMsg, 180),
				}, config, model, checkedModels, models.length);
			}

			return mergeProbeMetadata({
				...(parsedHeaders ?? {
					provider: config.provider,
					label: config.label,
					shortLabel: config.shortLabel,
					available: false,
					status: "error",
				}),
				errorMessage: `${model.id}: ${truncate(errorMsg, 180)}`,
			}, config, model, checkedModels, models.length);
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return {
			provider: config.provider,
			label: config.label,
			shortLabel: config.shortLabel,
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			errorMessage: `No ${config.label} probe models were available.${suffix}`,
			source: "probe",
		};
	} catch (e: unknown) {
		return {
			provider: config.provider,
			label: config.label,
			shortLabel: config.shortLabel,
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			error: e instanceof Error ? e.message : String(e),
			source: "probe",
		};
	}
}
