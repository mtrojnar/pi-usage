import * as fs from "node:fs";
import * as os from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	AnthropicAuth,
	AnthropicRateLimitWindow,
	AnthropicUsage,
	AnthropicUsageWindowKey,
	AuthApiKeyCredential,
	CodexOAuthCredential,
	GoModelStatus,
} from "./types.ts";
import {
	ANTHROPIC_PROVIDER,
	ANTHROPIC_PROBE_MODEL,
	CHECK_TIMEOUT_MS,
	authJsonPath,
	resolveConfigValue,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseText } from "./http.ts";

// ───────── Constants ─────────

const CLAUDE_CODE_VERSION = "2.1.75";
const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

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
		// Reset headers are normally RFC3339 timestamps, but tolerate unix seconds/ms.
		if (numeric > 1_000_000_000_000) return Math.round(numeric / 1000);
		if (numeric > 1_000_000_000) return Math.round(numeric);
	}

	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : 0;
}

function resetAfterFromAt(resetAt: number | undefined): number | undefined {
	if (resetAt === undefined || resetAt <= 0) return undefined;
	return Math.max(0, Math.round(resetAt - Date.now() / 1000));
}

function parseAnthropicRateLimitWindow(headers: Record<string, string>, headerKey: string): AnthropicRateLimitWindow | undefined {
	const prefix = `anthropic-ratelimit-${headerKey}`;
	const limit = parseOptionalNumber(headers, `${prefix}-limit`);
	const remaining = parseOptionalNumber(headers, `${prefix}-remaining`);
	const resetAt = parseAnthropicResetAt(headerValue(headers, `${prefix}-reset`));

	if (limit === undefined && remaining === undefined && resetAt <= 0) return undefined;

	const usedPercent = limit !== undefined && limit > 0 && remaining !== undefined
		? clampPercent(((limit - remaining) / limit) * 100)
		: undefined;
	const remainingPercent = limit !== undefined && limit > 0 && remaining !== undefined
		? clampPercent((remaining / limit) * 100)
		: undefined;

	return {
		limit,
		remaining,
		usedPercent,
		remainingPercent,
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
	};
}

function applyWindow(
	usage: AnthropicUsage,
	key: AnthropicUsageWindowKey,
	window: AnthropicRateLimitWindow | undefined,
	previous?: AnthropicUsage,
): void {
	const value = window ?? previous?.[key];
	if (!value) return;
	usage[key] = value;
}

function hasAnthropicRateLimitHeaders(headers: Record<string, string>): boolean {
	return hasHeaderPrefix(headers, "anthropic-ratelimit-");
}

export function parseAnthropicUsageHeaders(
	headers: Record<string, string>,
	status: number,
	modelId?: string,
	previous?: AnthropicUsage,
): AnthropicUsage | undefined {
	const hasRateLimitHeaders = hasAnthropicRateLimitHeaders(headers);
	const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, "retry-after"));
	const hasPassiveSignal = hasRateLimitHeaders || status === 429 || (status >= 200 && status < 300 && !!modelId);
	if (!hasPassiveSignal) return undefined;

	const inferredStatus: GoModelStatus = status === 429
		? "rate_limited"
		: status === 401 || status === 403
			? "error"
			: status >= 400
				? "error"
				: "available";
	const available = inferredStatus === "available";
	const rateLimited = inferredStatus === "rate_limited";
	const nowSec = Math.round(Date.now() / 1000);

	const usage: AnthropicUsage = {
		available,
		status: inferredStatus,
		workingModel: available ? modelId ?? previous?.workingModel : previous?.workingModel,
		rateLimitedModel: rateLimited ? modelId ?? previous?.rateLimitedModel : previous?.rateLimitedModel,
		checkedModels: previous?.checkedModels,
		totalModels: previous?.totalModels,
		authType: previous?.authType,
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
				: "Rate limited"
			: inferredStatus === "error"
				? `HTTP ${status}`
				: undefined,
	};

	applyWindow(usage, "requests", parseAnthropicRateLimitWindow(headers, "requests"), previous);
	applyWindow(usage, "tokens", parseAnthropicRateLimitWindow(headers, "tokens"), previous);
	applyWindow(usage, "inputTokens", parseAnthropicRateLimitWindow(headers, "input-tokens"), previous);
	applyWindow(usage, "outputTokens", parseAnthropicRateLimitWindow(headers, "output-tokens"), previous);

	return usage;
}

// ───────── Model Probing ─────────

function resolveAnthropicEndpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/v1/messages")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/messages`;
	return `${normalized}/v1/messages`;
}

async function getAnthropicCheckModels(): Promise<AnthropicCheckModel[]> {
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

	return Array.from(modelsById.values()).sort((a, b) => {
		const aPreferred = PREFERRED_ANTHROPIC_PROBE_MODELS.indexOf(a.id);
		const bPreferred = PREFERRED_ANTHROPIC_PROBE_MODELS.indexOf(b.id);
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
		headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
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

export async function checkAnthropicUsage(auth: AnthropicAuth | undefined, signal?: AbortSignal): Promise<AnthropicUsage> {
	if (!auth) {
		return {
			available: false,
			status: "no_key",
		};
	}

	const models = await getAnthropicCheckModels();
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
