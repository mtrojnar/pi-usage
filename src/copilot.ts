import * as fs from "node:fs";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	AuthApiKeyCredential,
	CopilotAuth,
	CopilotOAuthCredential,
	CopilotProbeApi,
	CopilotRateLimitWindow,
	CopilotUsage,
	CopilotUsageWindowKey,
	GoModelStatus,
} from "./types.ts";
import {
	CHECK_TIMEOUT_MS,
	GITHUB_COPILOT_PROBE_MODEL,
	GITHUB_COPILOT_PROVIDER,
	authJsonPath,
	resolveConfigValue,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseText } from "./http.ts";

// ───────── Constants ─────────

const COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_API_VERSION = "2026-06-01";

const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_DYNAMIC_HEADERS: Record<string, string> = {
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
	api: CopilotProbeApi;
	endpoint: string;
	costRank: number;
}

interface PiModelLike {
	id: string;
	api: string;
	baseUrl: string;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export const COPILOT_COLOR_MAP: Record<GoModelStatus, ThemeColor> = {
	available: "success",
	rate_limited: "warning",
	credits_error: "error",
	error: "warning",
	no_key: "dim",
};

export const COPILOT_STATUS_TEXT: Record<GoModelStatus, string> = {
	available: "available",
	rate_limited: "rate limited",
	credits_error: "quota exhausted",
	error: "error",
	no_key: "no auth",
};

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

function authFromApiKeyCredential(credential: AuthApiKeyCredential | undefined, source: string): CopilotAuth | undefined {
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	const token = resolveConfigValue(credential.key)?.trim();
	if (!token) return undefined;
	return { token, source, baseUrl: getCopilotBaseUrl(token) };
}

function availableModelIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return ids.length > 0 ? ids : undefined;
}

export async function getCopilotAuth(): Promise<CopilotAuth | undefined> {
	try {
		const authPath = authJsonPath();
		if (fs.existsSync(authPath)) {
			const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
			const authStorage = AuthStorage.create(authPath);
			const credential = authStorage.get(GITHUB_COPILOT_PROVIDER) as (CopilotOAuthCredential | AuthApiKeyCredential | undefined);
			if (credential?.type === "oauth" && credential.access) {
				if (typeof credential.expires !== "number" || Date.now() < credential.expires) {
					const enterpriseDomain = normalizeCopilotDomain(credential.enterpriseUrl);
					return {
						token: credential.access,
						source: "auth.json",
						baseUrl: getCopilotBaseUrl(credential.access, enterpriseDomain),
						enterpriseDomain,
						availableModelIds: availableModelIds(credential.availableModelIds),
					};
				}
			}

			const apiKeyAuth = authFromApiKeyCredential(credential as AuthApiKeyCredential | undefined, "auth.json");
			if (apiKeyAuth) return apiKeyAuth;
		}
	} catch {
		// Fall through to environment variables.
	}

	const copilotToken = process.env.COPILOT_GITHUB_TOKEN?.trim();
	if (copilotToken) return { token: copilotToken, source: "COPILOT_GITHUB_TOKEN", baseUrl: getCopilotBaseUrl(copilotToken) };

	const githubCopilotToken = process.env.GITHUB_COPILOT_TOKEN?.trim();
	if (githubCopilotToken) return { token: githubCopilotToken, source: "GITHUB_COPILOT_TOKEN", baseUrl: getCopilotBaseUrl(githubCopilotToken) };

	return undefined;
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

function parseRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

export function parseCopilotResetAt(value: string | undefined): number {
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

function resetAfterFromAt(resetAt: number | undefined): number | undefined {
	if (resetAt === undefined || resetAt <= 0) return undefined;
	return Math.max(0, Math.round(resetAt - Date.now() / 1000));
}

function parseCopilotWindowFromPrefix(
	headers: Record<string, string>,
	prefix: string,
	resource?: string,
): CopilotRateLimitWindow | undefined {
	const limit = parseOptionalNumber(headers, [`${prefix}-limit`]);
	const remaining = parseOptionalNumber(headers, [`${prefix}-remaining`]);
	const used = parseOptionalNumber(headers, [`${prefix}-used`]);
	const usedPercentHeader = parseOptionalNumber(headers, [`${prefix}-used-percent`, `${prefix}-usage-percent`]);
	const remainingPercentHeader = parseOptionalNumber(headers, [`${prefix}-remaining-percent`]);
	const resetAfterSeconds = parseOptionalNumber(headers, [`${prefix}-reset-after-seconds`, `${prefix}-reset-after`]);
	const resetAt = parseCopilotResetAt(headerValue(headers, `${prefix}-reset-at`) ?? headerValue(headers, `${prefix}-reset`));

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

function hasCopilotQuotaHeaders(headers: Record<string, string>): boolean {
	return hasHeaderPrefix(headers, "x-ratelimit-") || hasHeaderPrefix(headers, "x-copilot-");
}

export function parseCopilotUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: CopilotUsage,
): CopilotUsage | undefined {
	const hasQuotaHeaders = hasCopilotQuotaHeaders(headers);
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	const hasPassiveSignal = hasQuotaHeaders || status === 429 || (status >= 200 && status < 300 && !!modelId);
	if (!hasPassiveSignal) return undefined;

	const inferredStatus: GoModelStatus = status === 429
		? "rate_limited"
		: status === 402
			? "credits_error"
			: status === 401 || status === 403
				? "error"
				: status >= 400
					? "error"
					: "available";
	const available = inferredStatus === "available";
	const rateLimited = inferredStatus === "rate_limited" || inferredStatus === "credits_error";
	const nowSec = Math.round(Date.now() / 1000);

	const usage: CopilotUsage = {
		available,
		status: inferredStatus,
		workingModel: available ? modelId ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? modelId ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		availableModels: previous?.availableModels,
		source: "headers",
		retryAfterSeconds: rateLimited
			? retryAfterSeconds > 0 ? retryAfterSeconds : previous?.retryAfterSeconds
			: undefined,
		retryResetAt: rateLimited
			? retryAfterSeconds > 0 ? nowSec + retryAfterSeconds : previous?.retryResetAt
			: undefined,
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

function resolveCopilotEndpoint(baseUrl: string, api: CopilotProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		if (normalized.endsWith("/messages")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/messages`;
		return `${normalized}/v1/messages`;
	}
	if (api === "openai-responses") {
		if (normalized.endsWith("/responses")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/responses`;
		return `${normalized}/responses`;
	}
	if (normalized.endsWith("/chat/completions")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
	return `${normalized}/chat/completions`;
}

function fallbackCopilotModels(auth: CopilotAuth): CopilotCheckModel[] {
	const fallback: Array<{ id: string; api: CopilotProbeApi }> = [
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
			endpoint: resolveCopilotEndpoint(auth.baseUrl, model.api),
			costRank: index + 1,
		}));
}

async function getCopilotCheckModels(auth: CopilotAuth): Promise<CopilotCheckModel[]> {
	const modelsById = new Map<string, CopilotCheckModel>();
	const allowed = auth.availableModelIds ? new Set(auth.availableModelIds) : undefined;

	try {
		const { getModels } = await import("@earendil-works/pi-ai/compat");
		for (const model of getModels(GITHUB_COPILOT_PROVIDER) as PiModelLike[]) {
			const api = model.api as CopilotProbeApi;
			if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") continue;
			if (allowed && !allowed.has(model.id)) continue;
			const cost = model.cost ?? {};
			const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
			const costRank = Number.isFinite(rawRank) && rawRank > 0 ? rawRank : 9999;
			modelsById.set(model.id, {
				id: model.id,
				api,
				endpoint: resolveCopilotEndpoint(auth.baseUrl || model.baseUrl || COPILOT_API_BASE_URL, api),
				costRank,
			});
		}
	} catch {
		// pi-ai not available — use fallback models.
	}

	if (modelsById.size === 0) {
		for (const model of fallbackCopilotModels(auth)) modelsById.set(model.id, model);
	}

	return Array.from(modelsById.values()).sort((a, b) => {
		const aPreferred = PREFERRED_COPILOT_PROBE_MODELS.indexOf(a.id);
		const bPreferred = PREFERRED_COPILOT_PROBE_MODELS.indexOf(b.id);
		if (aPreferred !== -1 || bPreferred !== -1) {
			if (aPreferred === -1) return 1;
			if (bPreferred === -1) return -1;
			return aPreferred - bPreferred;
		}
		return a.costRank - b.costRank || a.id.localeCompare(b.id);
	});
}

function copilotProbeHeaders(auth: CopilotAuth, api: CopilotProbeApi): Record<string, string> {
	const headers: Record<string, string> = {
		...COPILOT_HEADERS,
		...COPILOT_DYNAMIC_HEADERS,
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

async function probeCopilotModel(auth: CopilotAuth, model: CopilotCheckModel, signal: AbortSignal): Promise<Response> {
	return fetch(model.endpoint, {
		method: "POST",
		headers: copilotProbeHeaders(auth, model.api),
		body: JSON.stringify(copilotProbeBody(model)),
		signal,
	});
}

async function readCopilotErrorMessage(response: Response, fallback: string, signal?: AbortSignal): Promise<string> {
	try {
		const body = await readResponseText(response, signal);
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

export function isCopilotModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid|not enabled)|unsupported.*model|not.*authorized.*model|model.*not.*enabled/i.test(message);
}

export function isCopilotQuotaMessage(message: string): boolean {
	return /quota|premium.*requests?|rate limit|too many requests|usage limit|exceeded.*limit|limit.*exceeded/i.test(message);
}

function responseHeadersToRecord(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

function mergeProbeMetadata(usage: CopilotUsage, auth: CopilotAuth, model: CopilotCheckModel, checkedModels: number, totalModels: number): CopilotUsage {
	return {
		...usage,
		workingModel: usage.available ? model.id : usage.workingModel,
		rateLimitedModel: usage.status === "rate_limited" || usage.status === "credits_error" ? model.id : usage.rateLimitedModel,
		checkedModels,
		totalModels,
		availableModels: auth.availableModelIds?.length,
		source: "probe",
	};
}

export async function checkCopilotUsage(auth: CopilotAuth | undefined, signal?: AbortSignal): Promise<CopilotUsage> {
	if (!auth) {
		return {
			available: false,
			status: "no_key",
		};
	}

	const models = await getCopilotCheckModels(auth);
	let checkedModels = 0;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			if (signal?.aborted) throw new Error("GitHub Copilot check aborted");
			const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeCopilotModel(auth, model, timeoutSignal.signal);
			} finally {
				timeoutSignal.cleanup();
			}

			const headers = responseHeadersToRecord(response);
			const parsedHeaders = parseCopilotUsageHeaders(headers, response.status, model.id);

			if (response.ok) {
				await cancelResponseBody(response);
				return mergeProbeMetadata(parsedHeaders ?? {
					available: true,
					status: "available",
					workingModel: model.id,
				}, auth, model, checkedModels, models.length);
			}

			const errorMsg = await readCopilotErrorMessage(response, `HTTP ${response.status}`, signal);

			if (response.status === 429 || isCopilotQuotaMessage(errorMsg)) {
				const status: GoModelStatus = response.status === 402 ? "credits_error" : "rate_limited";
				return mergeProbeMetadata({
					...(parsedHeaders ?? {
						available: false,
						status,
						rateLimitedModel: model.id,
					}),
					errorMessage: errorMsg,
				}, auth, model, checkedModels, models.length);
			}

			if (isCopilotModelUnavailable(errorMsg)) {
				lastUnavailable = { model: model.id, message: errorMsg };
				continue;
			}

			return mergeProbeMetadata({
				...(parsedHeaders ?? {
					available: false,
					status: "error",
				}),
				errorMessage: `${model.id}: ${truncate(errorMsg, 180)}`,
			}, auth, model, checkedModels, models.length);
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			availableModels: auth.availableModelIds?.length,
			errorMessage: `No GitHub Copilot probe models were available.${suffix}`,
			source: "probe",
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			availableModels: auth.availableModelIds?.length,
			error: e instanceof Error ? e.message : String(e),
			source: "probe",
		};
	}
}
