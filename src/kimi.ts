import type { SubscriptionQuotaWindow, UsageApiWindows } from "./types.ts";
import { clampPercent } from "./format.ts";
import { jsonNumber, jsonObject } from "./json.ts";
import { parseResetAtSeconds, resetAfterFromAt } from "./headers.ts";

// ───────── Parsing ─────────

const MINUTE_MS_UNITS: Record<string, number> = {
	TIME_UNIT_MINUTE: 1,
	TIME_UNIT_HOUR: 60,
	TIME_UNIT_DAY: 1440,
	TIME_UNIT_WEEK: 10080,
	TIME_UNIT_MONTH: 43200,
};

function windowMinutes(value: unknown): number {
	const window = jsonObject(value);
	if (!window) return 0;
	const duration = jsonNumber(window.duration);
	const unit = typeof window.timeUnit === "string" ? MINUTE_MS_UNITS[window.timeUnit] ?? 0 : 0;
	return duration !== undefined && duration > 0 ? duration * unit : 0;
}

function quotaWindow(value: unknown): SubscriptionQuotaWindow | undefined {
	const detail = jsonObject(value);
	if (!detail) return undefined;
	const limit = jsonNumber(detail.limit);
	const used = jsonNumber(detail.used);
	const remaining = jsonNumber(detail.remaining);
	if (limit === undefined || limit <= 0 || (used === undefined && remaining === undefined)) return undefined;
	const resetAt = parseResetAtSeconds(typeof detail.resetTime === "string" ? detail.resetTime : undefined);

	const usedPercent = used !== undefined ? clampPercent((used / limit) * 100) : undefined;
	const remainingPercent = remaining !== undefined
		? clampPercent((remaining / limit) * 100)
		: usedPercent !== undefined
			? clampPercent(100 - usedPercent)
			: undefined;

	return {
		usedPercent,
		remainingPercent,
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt),
	};
}

/**
 * Parse a Kimi Coding `GET <base>/usages` payload into generic quota windows.
 *
 * Shape (all numeric fields are strings):
 *   usage:  the top-level (weekly) plan window
 *   limits: additional sub-windows with an explicit duration/timeUnit
 *           (e.g. the 300-minute / 5-hour rolling window)
 *
 * Window classification by duration: <=1d → rolling, <=8d → weekly, else monthly.
 */
export function parseKimiUsagePayload(payload: unknown): UsageApiWindows | undefined {
	const data = jsonObject(payload);
	if (!data) return undefined;

	const out: UsageApiWindows = {};
	const topLevel = quotaWindow(data.usage);
	if (topLevel) out.weekly = topLevel;

	for (const value of Array.isArray(data.limits) ? data.limits : []) {
		const entry = jsonObject(value);
		const minutes = windowMinutes(entry?.window);
		const window = quotaWindow(entry?.detail);
		if (!minutes || !window) continue;
		if (minutes <= 1440) out.rolling ??= window;
		else if (minutes <= 11520) out.weekly ??= window;
		else out.monthly ??= window;
	}

	return out.rolling || out.weekly || out.monthly ? out : undefined;
}
