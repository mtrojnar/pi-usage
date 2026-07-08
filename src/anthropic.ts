import * as fs from "node:fs";
import * as os from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	AnthropicAuth,
	AnthropicUsage,
	AnthropicUsageWindow,
	AuthApiKeyCredential,
	CodexOAuthCredential,
	GoModelStatus,
	SelectedModel,
} from "./types.ts";
import {
	ANTHROPIC_PROVIDER,
	ANTHROPIC_PROBE_MODEL,
	ANTHROPIC_USAGE_URL,
	CHECK_TIMEOUT_MS,
	authJsonPath,
	resolveConfigValue,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseJson, readResponseText } from "./http.ts";

// ───────── Constants ─────────

const CLAUDE_CODE_VERSION = "2.1.75";
const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
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
	input?: string[];
}

const FALLBACK_ANTHROPIC_MODELS: AnthropicCheckModel[] = PREFERRED_ANTHROPIC_PROBE_MODELS.map((id, index) => ({
	id,
	endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
	costRank: index + 1,
}));

export const ANTHROPIC_COLOR_MAP: Record<GoModelStatus, ThemeColor> = {
	available: "success",
	rate_limited: "warning",
	credits_error: "error",
	error: "warning",
	no_key: "dim",
};

export const ANTHROPIC_STATUS_TEXT: Record<GoModelStatus, string> = {
	available: "available",
	rate_limited: "rate limited",
	credits_error: "credits exhausted",
	error: "error",
	no_key: "no auth",
};

export type AnthropicUsageApiResult =
	| { success: true; usage: AnthropicUsage }
	| { success: false; error: string };

// ───────── Auth Helpers ─────────

function inferAnthropicAuthType(token: string, fallback: AnthropicAuth["type"]): AnthropicAuth["type"] {
	return token.includes("sk-ant-oat") ? "oauth" : fallback;
}

function authFromApiKeyCredential(credential: AuthApiKeyCredential | undefined, source: string): AnthropicAuth | undefined {
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	const key = resolveConfigValue(credential.key)?.trim();
	if (!key) return undefined;
	return {
		token: key,
		type: inferAnthropicAuthType(key, "api_key"),
		source,
	};
}

export async function getAnthropicAuth(): Promise<AnthropicAuth | undefined> {
	try {
		const authPath = authJsonPath();
		if (fs.existsSync(authPath)) {
			const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
			const authStorage = AuthStorage.create(authPath);
			const credential = authStorage.get(ANTHROPIC_PROVIDER) as (CodexOAuthCredential | AuthApiKeyCredential | undefined);
			if (credential?.type === "oauth" && credential.access) {
				if (typeof credential.expires !== "number" || Date.now() < credential.expires) {
					return { token: credential.access, type: "oauth", source: "auth.json" };
				}
			}

			const apiKeyAuth = authFromApiKeyCredential(credential as AuthApiKeyCredential | undefined, "auth.json");
			if (apiKeyAuth) return apiKeyAuth;
		}
	} catch {
		// Fall through to environment variables.
	}

	const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (oauthToken) return { token: oauthToken, type: "oauth", source: "ANTHROPIC_OAUTH_TOKEN" };

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (apiKey) {
		return {
			token: apiKey,
			type: inferAnthropicAuthType(apiKey, "api_key"),
			source: "ANTHROPIC_API_KEY",
		};
	}

	return undefined;
}

// ───────── Header / Value Parsing ─────────

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

function parseOptionalNumber(headers: Record<string, string>, name: string): number | undefined {
	const value = headerValue(headers, name);
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

export function parseAnthropicResetAt(value: string | undefined): number {
	if (!value) return 0;
	const trimmed = value.trim();
	if (!trimmed) return 0;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) {
		// Unified rate-limit reset headers are unix seconds; tolerate ms too.
		if (numeric > 1_000_000_000_000) return Math.round(numeric / 1000);
		if (numeric > 1_000_000_000) return Math.round(numeric);
	}

	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : 0;
}

function resetAfterFromAt(resetAt: number): number | undefined {
	if (resetAt <= 0) return undefined;
	return Math.max(0, Math.round(resetAt - Date.now() / 1000));
}

// ───────── Unified Rate-Limit Header Parsing ─────────

function parseUnifiedWindow(headers: Record<string, string>, key: "5h" | "7d"): AnthropicUsageWindow | undefined {
	const utilization = parseOptionalNumber(headers, `anthropic-ratelimit-unified-${key}-utilization`);
	if (utilization === undefined) return undefined; // no percent → nothing to display
	const resetAt = parseAnthropicResetAt(headerValue(headers, `anthropic-ratelimit-unified-${key}-reset`));
	return {
		// Header utilization is a 0..1 fraction; scale to a percentage.
		utilizationPercent: clampPercent(utilization * 100),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
		status: headerValue(headers, `anthropic-ratelimit-unified-${key}-status`),
	};
}

export function parseAnthropicUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: AnthropicUsage,
): AnthropicUsage | undefined {
	const hasUnified = hasHeaderPrefix(headers, "anthropic-ratelimit-unified-");
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	const hasSignal = hasUnified || status === 429 || (status >= 200 && status < 300 && !!modelId);
	if (!hasSignal) return undefined;

	const fiveHour = parseUnifiedWindow(headers, "5h") ?? previous?.fiveHour;
	const weekly = parseUnifiedWindow(headers, "7d") ?? previous?.weekly;
	const overall = headerValue(headers, "anthropic-ratelimit-unified-status");
	const rejected = status === 429 || overall === "rejected"
		|| parseUnifiedWindow(headers, "5h")?.status === "rejected"
		|| parseUnifiedWindow(headers, "7d")?.status === "rejected";

	const inferredStatus: GoModelStatus = rejected
		? "rate_limited"
		: status === 401 || status === 403
			? "error"
			: status >= 400
				? "error"
				: "available";
	const available = inferredStatus === "available";
	const rateLimited = inferredStatus === "rate_limited";
	const nowSec = Math.round(Date.now() / 1000);

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
		retryAfterSeconds: rateLimited
			? retryAfterSeconds > 0 ? retryAfterSeconds : previous?.retryAfterSeconds
			: undefined,
		retryResetAt: rateLimited
			? retryAfterSeconds > 0 ? nowSec + retryAfterSeconds : previous?.retryResetAt
			: undefined,
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
	const resetAt = parseAnthropicResetAt(window.resets_at ?? undefined);
	return {
		utilizationPercent: clampPercent(utilization),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
	};
}

function anthropicUsageHeaders(token: string): Record<string, string> {
	return {
		"Authorization": `Bearer ${token}`,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": ANTHROPIC_BETA,
		"user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
		"x-app": "cli",
		"anthropic-dangerous-direct-browser-access": "true",
		"Accept": "application/json",
	};
}

export async function checkAnthropicUsageFromUsageApi(token: string, signal?: AbortSignal): Promise<AnthropicUsageApiResult> {
	try {
		const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);

		let response: Response;
		try {
			response = await fetch(ANTHROPIC_USAGE_URL, {
				headers: anthropicUsageHeaders(token),
				signal: timeoutSignal.signal,
			});
		} finally {
			timeoutSignal.cleanup();
		}

		if (!response.ok) {
			let detail = `HTTP ${response.status}`;
			try {
				const body = await readResponseText(response, signal);
				detail = truncate(body, 160) || detail;
			} catch { /* ignore */ }
			return { success: false, error: `Anthropic usage API: ${detail}` };
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
		return { success: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ───────── Model Probing (API-key auth and OAuth fallback) ─────────

function resolveAnthropicEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/v1/messages")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/messages`;
	return `${normalized}/v1/messages`;
}

async function getAnthropicCheckModels(preferredModel?: SelectedModel): Promise<AnthropicCheckModel[]> {
	const modelsById = new Map<string, AnthropicCheckModel>();
	for (const model of FALLBACK_ANTHROPIC_MODELS) {
		modelsById.set(model.id, model);
	}

	try {
		const { getModels } = await import("@earendil-works/pi-ai/compat");
		for (const model of getModels(ANTHROPIC_PROVIDER) as PiModelLike[]) {
			if (model.api !== "anthropic-messages" || modelsById.has(model.id)) continue;
			const cost = model.cost ?? {};
			const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
			const costRank = Number.isFinite(rawRank) && rawRank > 0 ? rawRank : 9999;
			modelsById.set(model.id, {
				id: model.id,
				endpoint: resolveAnthropicEndpoint(model.baseUrl || "https://api.anthropic.com"),
				costRank,
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
			endpoint: resolveAnthropicEndpoint(preferredModel!.baseUrl || "https://api.anthropic.com"),
			costRank: -1,
		});
	}
	const preferredOrder = preferredId
		? [preferredId, ...PREFERRED_ANTHROPIC_PROBE_MODELS]
		: PREFERRED_ANTHROPIC_PROBE_MODELS;

	return Array.from(modelsById.values()).sort((a, b) => {
		const aPreferred = preferredOrder.indexOf(a.id);
		const bPreferred = preferredOrder.indexOf(b.id);
		if (aPreferred !== -1 || bPreferred !== -1) {
			if (aPreferred === -1) return 1;
			if (bPreferred === -1) return -1;
			return aPreferred - bPreferred;
		}
		return a.costRank - b.costRank || a.id.localeCompare(b.id);
	});
}

function anthropicProbeHeaders(auth: AnthropicAuth): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept": "application/json",
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
	};

	if (auth.type === "oauth") {
		headers["Authorization"] = `Bearer ${auth.token}`;
		headers["anthropic-beta"] = ANTHROPIC_BETA;
		headers["user-agent"] = `claude-cli/${CLAUDE_CODE_VERSION}`;
		headers["x-app"] = "cli";
	} else {
		headers["x-api-key"] = auth.token;
		headers["User-Agent"] = `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`;
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

async function probeAnthropicModel(auth: AnthropicAuth, model: AnthropicCheckModel, signal: AbortSignal): Promise<Response> {
	return fetch(model.endpoint, {
		method: "POST",
		headers: anthropicProbeHeaders(auth),
		body: JSON.stringify(anthropicProbeBody(auth, model)),
		signal,
	});
}

async function readAnthropicErrorMessage(response: Response, fallback: string, signal?: AbortSignal): Promise<string> {
	try {
		const body = await readResponseText(response, signal);
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

export function isAnthropicModelUnavailable(message: string): boolean {
	return /model.*(disabled|not.*found|unsupported|unavailable|not.*available|does not exist|invalid)|unsupported.*model/i.test(message);
}

function responseHeadersToRecord(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

function mergeProbeMetadata(usage: AnthropicUsage, auth: AnthropicAuth, model: AnthropicCheckModel, checkedModels: number, totalModels: number): AnthropicUsage {
	return {
		...usage,
		authType: auth.type,
		workingModel: usage.available ? model.id : usage.workingModel,
		rateLimitedModel: usage.status === "rate_limited" ? model.id : usage.rateLimitedModel,
		checkedModels,
		totalModels,
		source: "probe",
	};
}

async function checkAnthropicUsageWithProbe(auth: AnthropicAuth, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<AnthropicUsage> {
	const models = await getAnthropicCheckModels(preferredModel);
	let checkedModels = 0;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			if (signal?.aborted) throw new Error("Anthropic check aborted");
			const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeAnthropicModel(auth, model, timeoutSignal.signal);
			} finally {
				timeoutSignal.cleanup();
			}

			const headers = responseHeadersToRecord(response);
			const parsedHeaders = parseAnthropicUsageHeaders(headers, response.status, model.id);

			if (response.ok) {
				await cancelResponseBody(response);
				return mergeProbeMetadata(parsedHeaders ?? {
					available: true,
					status: "available",
					workingModel: model.id,
				}, auth, model, checkedModels, models.length);
			}

			const errorMsg = await readAnthropicErrorMessage(response, `HTTP ${response.status}`, signal);

			if (response.status === 429) {
				return mergeProbeMetadata({
					...(parsedHeaders ?? {
						available: false,
						status: "rate_limited",
						rateLimitedModel: model.id,
					}),
					errorMessage: errorMsg,
				}, auth, model, checkedModels, models.length);
			}

			if (isAnthropicModelUnavailable(errorMsg)) {
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
			authType: auth.type,
			checkedModels,
			totalModels: models.length,
			errorMessage: `No Anthropic probe models were available.${suffix}`,
			source: "probe",
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			authType: auth.type,
			checkedModels,
			totalModels: models.length,
			error: e instanceof Error ? e.message : String(e),
			source: "probe",
		};
	}
}

// ───────── Public API ─────────

export async function checkAnthropicUsage(auth: AnthropicAuth | undefined, signal?: AbortSignal, preferredModel?: SelectedModel): Promise<AnthropicUsage> {
	if (!auth) {
		return {
			available: false,
			status: "no_key",
		};
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
