import { resolveBoundProviderAuth } from "./auth.ts";
import { runIsolatedTask } from "./concurrent.ts";
import { CHECK_TIMEOUT_MS } from "./config.ts";
import { cancelResponseBody, fetchSameOriginWithTimeout, readResponseJson } from "./http.ts";
import { jsonObject } from "./json.ts";
import type { BoundApiKey, OpenRouterUsage, UsageContext } from "./types.ts";

export const OPENROUTER_PROVIDER = "openrouter";
const API_URL = "https://openrouter.ai/api/v1";

export function getOpenRouterAuth(ctx: UsageContext): Promise<BoundApiKey | undefined> {
	return resolveBoundProviderAuth(ctx, OPENROUTER_PROVIDER);
}

function amount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** OpenRouter documents calendar resets at midnight UTC, with weeks starting Monday. */
export function openRouterResetAt(period: unknown, now = Date.now()): number | undefined {
	const date = new Date(now);
	date.setUTCHours(0, 0, 0, 0);
	if (period === "daily") date.setUTCDate(date.getUTCDate() + 1);
	else if (period === "weekly") date.setUTCDate(date.getUTCDate() + (7 - ((date.getUTCDay() + 6) % 7)));
	else if (period === "monthly") date.setUTCMonth(date.getUTCMonth() + 1, 1);
	else return undefined;
	return date.getTime() / 1000;
}

export function parseOpenRouterKey(payload: unknown, now = Date.now()): OpenRouterUsage | undefined {
	const data = jsonObject(jsonObject(payload)?.data);
	if (!data) return undefined;
	const dailySpend = amount(data.usage_daily);
	const limit = amount(data.limit);
	// Use the authoritative remaining amount: this already accounts for the
	// reset period and include_byok_in_limit. Lifetime usage is not a budget numerator.
	const remaining = typeof data.limit_remaining === "number" && Number.isFinite(data.limit_remaining)
		? data.limit_remaining : undefined;
	const used = limit !== undefined && remaining !== undefined && remaining <= limit && Number.isFinite(limit - remaining)
		? limit - remaining : undefined;
	if (dailySpend === undefined && limit === undefined) return undefined;
	return {
		dailySpend,
		dailyResetAt: dailySpend !== undefined ? openRouterResetAt("daily", now) : undefined,
		budget: limit !== undefined ? { limit, used, resetAt: openRouterResetAt(data.limit_reset, now) } : undefined,
	};
}

export function parseOpenRouterCredits(payload: unknown): number | undefined {
	const data = jsonObject(jsonObject(payload)?.data);
	const total = amount(data?.total_credits);
	const used = amount(data?.total_usage);
	return total !== undefined && used !== undefined ? total - used : undefined;
}

export async function checkOpenRouterUsage(auth: BoundApiKey, signal?: AbortSignal): Promise<OpenRouterUsage> {
	const request = async (path: string): Promise<unknown> => {
		// Bound headers + body together, independently of the other endpoint.
		// Detach even a request/body cancellation that ignores its abort signal.
		const result = await runIsolatedTask(async (requestSignal) => {
			const response = await fetchSameOriginWithTimeout(`${API_URL}/${path}`, auth.baseUrl, {
				headers: { Authorization: `Bearer ${auth.apiKey}` },
			}, requestSignal);
			if (!response.ok) {
				await cancelResponseBody(response);
				throw new Error(`HTTP ${response.status}`);
			}
			return readResponseJson(response, requestSignal);
		}, CHECK_TIMEOUT_MS, signal);
		if (result.status === "fulfilled") return result.value;
		if (result.status === "rejected") throw result.reason;
		throw new Error(result.status === "timed_out" ? "Request timed out" : "Request aborted");
	};
	// Independent requests: optional credit permissions/failures must not hide key usage.
	// Conservative boundary: a request spanning midnight must not make the
	// previous period's spend look fresh for another day/week/month.
	const requestedAt = Date.now();
	const [key, credits] = await Promise.allSettled([request("key"), request("credits")]);
	const usage = key.status === "fulfilled" ? parseOpenRouterKey(key.value, requestedAt) : undefined;
	return {
		...usage,
		creditRemaining: credits.status === "fulfilled" ? parseOpenRouterCredits(credits.value) : undefined,
		error: usage ? undefined : key.status === "rejected"
			? `Key accounting unavailable: ${key.reason instanceof Error ? key.reason.message : "request failed"}`
			: "Invalid key accounting response",
	};
}
