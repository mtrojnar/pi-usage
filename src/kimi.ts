import type { SubscriptionQuotaWindow } from "./types.ts";
import { clampPercent } from "./format.ts";
import { parseResetAtSeconds, resetAfterFromAt } from "./headers.ts";

// ───────── Types ─────────

export interface UsageApiWindows {
	rolling?: SubscriptionQuotaWindow;
	weekly?: SubscriptionQuotaWindow;
	monthly?: SubscriptionQuotaWindow;
}

interface KimiQuotaDetail {
	limit?: string | number;
	used?: string | number;
	remaining?: string | number;
	resetTime?: string;
}

interface KimiUsagePayload {
	usage?: KimiQuotaDetail;
	limits?: Array<{
		window?: { duration?: string | number; timeUnit?: string };
		detail?: KimiQuotaDetail;
	}>;
}

// ───────── Parsing ─────────

const MINUTE_MS_UNITS: Record<string, number> = {
	TIME_UNIT_MINUTE: 1,
	TIME_UNIT_HOUR: 60,
	TIME_UNIT_DAY: 1440,
	TIME_UNIT_WEEK: 10080,
	TIME_UNIT_MONTH: 43200,
};

function windowMinutes(window: { duration?: string | number; timeUnit?: string } | undefined): number {
	if (!window) return 0;
	const duration = Number(window.duration);
	const unit = MINUTE_MS_UNITS[window.timeUnit ?? ""] ?? 0;
	return Number.isFinite(duration) && duration > 0 ? duration * unit : 0;
}

function quotaWindow(detail: KimiQuotaDetail | undefined): SubscriptionQuotaWindow | undefined {
	if (!detail) return undefined;
	const limit = Number(detail.limit);
	const used = Number(detail.used);
	const remaining = Number(detail.remaining);
	const resetAt = parseResetAtSeconds(detail.resetTime);

	const usedPercent = Number.isFinite(limit) && limit > 0 && Number.isFinite(used)
		? clampPercent((used / limit) * 100)
		: undefined;
	const remainingPercent = Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)
		? clampPercent((remaining / limit) * 100)
		: usedPercent !== undefined
			? clampPercent(100 - usedPercent)
			: undefined;

	if (usedPercent === undefined && remainingPercent === undefined && resetAt <= 0) return undefined;
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
	if (!payload || typeof payload !== "object") return undefined;
	const data = payload as KimiUsagePayload;

	const out: UsageApiWindows = {};
	const topLevel = quotaWindow(data.usage);
	if (topLevel) out.weekly = topLevel;

	for (const entry of data.limits ?? []) {
		const minutes = windowMinutes(entry?.window);
		const window = quotaWindow(entry?.detail);
		if (!minutes || !window) continue;
		if (minutes <= 1440) out.rolling ??= window;
		else if (minutes <= 11520) out.weekly ??= window;
		else out.monthly ??= window;
	}

	return out.rolling || out.weekly || out.monthly ? out : undefined;
}
