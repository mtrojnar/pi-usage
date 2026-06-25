import * as os from "node:os";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type {
	AuthApiKeyCredential,
	AuthJson,
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
	readAuthJson,
	resolveConfigValue,
} from "./config.ts";
import { clampPercent, truncate } from "./format.ts";
import { cancelResponseBody, readResponseText } from "./http.ts";

// ───────── Constants ─────────

export const DOCUMENTED_GO_MODELS: GoCheckModel[] = [
	{ id: "qwen3.5-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 1 },
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

function getAuthApiKey(auth: AuthJson | undefined, provider: string): string | undefined {
	const credential = auth?.[provider] as AuthApiKeyCredential | undefined;
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	return resolveConfigValue(credential.key);
}

export function getOpenCodeApiKey(): string | undefined {
	const auth = readAuthJson();
	const goKey = getAuthApiKey(auth, "opencode-go");
	if (goKey) return goKey;
	const zenKey = getAuthApiKey(auth, "opencode");
	if (zenKey) return zenKey;
	return process.env.OPENCODE_API_KEY;
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

export function isPerModelUnavailable(status: number, message: string): boolean {
	if (status === 400 || status === 404 || status === 422) return true;
	return /model.*(disabled|not.*found|unsupported|unavailable)|disabled.*model/i.test(message);
}


async function fetchOpenCodeGoQuota(config: OpenCodeGoQuotaConfig): Promise<OpenCodeGoQuotaResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

	try {
		const response = await fetch(
			`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`,
			{
				headers: {
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Cookie": `auth=${config.authCookie}`,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				signal: controller.signal,
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

		const html = await readResponseText(response);
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
		clearTimeout(timeout);
	}
}

async function checkOpenCodeGoQuota(configState: OpenCodeGoQuotaConfigState): Promise<OpenCodeGoQuotaResult> {
	if (configState.error) {
		return { configured: false, error: configState.error };
	}
	if (!configState.config) {
		return { configured: false };
	}
	return fetchOpenCodeGoQuota(configState.config);
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const body = await readResponseText(response);
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

async function getOpenCodeGoCheckModels(): Promise<GoCheckModel[]> {
	const modelsById = new Map<string, GoCheckModel>();
	for (const model of DOCUMENTED_GO_MODELS) {
		modelsById.set(model.id, model);
	}
	try {
		const { getModels } = await import("@mariozechner/pi-ai");
		for (const model of getModels("opencode-go")) {
			if (modelsById.has(model.id)) continue;
			const api: GoProbeApi = (model.api as string) === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
			const cost = model.cost ?? {};
			const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
			const costRank = Number.isFinite(rawRank) ? rawRank : 9999;
			modelsById.set(model.id, {
				id: model.id,
				api,
				endpoint: resolveModelEndpoint(model.baseUrl, api),
				costRank,
			});
		}
	} catch {
		// pi-ai not available — use only documented models
	}
	return Array.from(modelsById.values()).sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
}

async function probeOpenCodeGoModel(apiKey: string, model: GoCheckModel, signal: AbortSignal): Promise<Response> {
	if (model.api === "anthropic-messages") {
		return fetch(model.endpoint, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
				stream: false,
			}),
			signal,
		});
	}

	return fetch(model.endpoint, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model.id,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		}),
		signal,
	});
}

async function checkOpenCodeGoModels(apiKey: string | undefined): Promise<OpenCodeGoUsage> {
	if (!apiKey) {
		return {
			available: false,
			status: "no_key",
		};
	}

	const models = await getOpenCodeGoCheckModels();
	let checkedModels = 0;
	let lastRateLimit: { model: string; message: string } | undefined;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeOpenCodeGoModel(apiKey, model, controller.signal);
			} finally {
				clearTimeout(timeout);
			}

			if (response.ok) {
				await cancelResponseBody(response);
				return {
					available: true,
					status: "available",
					workingModel: model.id,
					rateLimitedModel: lastRateLimit?.model,
					checkedModels,
					totalModels: models.length,
				};
			}

			if (response.status === 429) {
				const errorMsg = await readErrorMessage(response, "Rate limited");
				lastRateLimit = { model: model.id, message: errorMsg };

				if (isGlobalGoLimit(errorMsg)) {
					return {
						available: false,
						status: "rate_limited",
						rateLimitedModel: model.id,
						checkedModels,
						totalModels: models.length,
						errorMessage: errorMsg,
					};
				}
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				const errorMsg = await readErrorMessage(response, "Authentication error");
				const status: GoModelStatus = /credit|balance|quota|insufficient/i.test(errorMsg)
					? "credits_error"
					: "error";
				return {
					available: false,
					status,
					checkedModels,
					totalModels: models.length,
					errorMessage: errorMsg,
				};
			}

			const errorMsg = await readErrorMessage(response, `HTTP ${response.status}`);
			if (isPerModelUnavailable(response.status, errorMsg)) {
				lastUnavailable = { model: model.id, message: errorMsg };
				continue;
			}

			return {
				available: false,
				status: "error",
				checkedModels,
				totalModels: models.length,
				errorMessage: `${model.id}: ${errorMsg}`,
			};
		}

		if (lastRateLimit) {
			return {
				available: false,
				status: "rate_limited",
				rateLimitedModel: lastRateLimit.model,
				checkedModels,
				totalModels: models.length,
				errorMessage: lastRateLimit.message,
			};
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			errorMessage: `No documented Go models were available.${suffix}`,
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// ───────── Public API ─────────

export async function checkOpenCodeGoUsage(
	apiKey: string | undefined,
	configState: OpenCodeGoQuotaConfigState,
): Promise<OpenCodeGoUsage> {
	const quotaCheck = await checkOpenCodeGoQuota(configState);
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

	const modelCheck = await checkOpenCodeGoModels(apiKey);

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
