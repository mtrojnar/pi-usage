import type { SubscriptionPlanDetail, SubscriptionQuotaWindow, SubscriptionUsageApiData } from "./types.ts";
import { clampPercent } from "./format.ts";
import { jsonNumber, jsonObject } from "./json.ts";
import { resetAfterFromAt } from "./headers.ts";

// ───────── Endpoint ─────────

const TOKEN_PLAN_PATH = "/v1/platform/token_plan";

/**
 * Credits endpoint under the account's dedicated Token Plan base URL
 * (`new URL` keeps it on the credential origin, satisfying the same-origin
 * rule for credentialed requests).
 */
export function xiaomiTokenPlanUsageUrl(baseUrl: string): string {
	return new URL(TOKEN_PLAN_PATH, baseUrl).toString();
}

/**
 * The endpoint accepts either documented auth method: `Authorization: Bearer`
 * or `api-key`. Send both so either server-side check passes.
 */
export function xiaomiUsageApiAuthHeaders(apiKey: string): Record<string, string> {
	return {
		"Authorization": `Bearer ${apiKey}`,
		"api-key": apiKey,
	};
}

// ───────── Parsing ─────────

/**
 * `period.start_at` / `period.end_at` are UTC `YYYY-MM-DD HH:mm:ss`.
 * `Date.parse` would read that format as local time, so normalize to ISO
 * with an explicit UTC marker first.
 */
function utcSeconds(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
		? `${trimmed.replace(" ", "T")}Z`
		: trimmed;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : undefined;
}

/**
 * Parse a `GET /v1/platform/token_plan` payload into a generic quota window
 * plus credit/plan detail.
 *
 * The quota covers the billing period, which may be a month or a year - it is
 * classified like the other usage endpoints (period <= 8 days -> weekly slot,
 * longer -> monthly slot) but always labeled "period" so a yearly plan is
 * never rendered as "month".
 */
export function parseXiaomiTokenPlanPayload(payload: unknown): SubscriptionUsageApiData | undefined {
	const data = jsonObject(payload);
	if (!data) return undefined;

	const quota = jsonObject(data.quota);
	if (!quota) return undefined;
	const total = jsonNumber(quota.total_credits);
	const used = jsonNumber(quota.used_credits);
	const remaining = jsonNumber(quota.remaining_credits);
	if (total === undefined || total <= 0 || (used === undefined && remaining === undefined)) return undefined;

	const usedPercent = used !== undefined
		? clampPercent(used / total * 100)
		: clampPercent(100 - (remaining as number) / total * 100);
	const remainingPercent = remaining !== undefined
		? clampPercent(remaining / total * 100)
		: clampPercent(100 - usedPercent);

	const period = jsonObject(data.period);
	const periodStartAt = utcSeconds(period?.start_at);
	const periodEndAt = utcSeconds(period?.end_at);

	const window: SubscriptionQuotaWindow = {
		label: "period",
		usedPercent,
		remainingPercent,
		...(periodEndAt !== undefined && periodEndAt > 0 && {
			resetAt: periodEndAt,
			resetAfterSeconds: resetAfterFromAt(periodEndAt),
		}),
	};

	const plan: SubscriptionPlanDetail = {
		...(typeof data.plan_code === "string" && { planCode: data.plan_code }),
		...(used !== undefined && { usedCredits: used }),
		totalCredits: total,
		...(remaining !== undefined && { remainingCredits: remaining }),
		...(periodStartAt !== undefined && periodStartAt > 0 && { periodStartAt }),
		...(periodEndAt !== undefined && periodEndAt > 0 && { periodEndAt }),
		...(typeof data.auto_renew === "boolean" && { autoRenew: data.auto_renew }),
		...(typeof data.claw_enabled === "boolean" && { clawEnabled: data.claw_enabled }),
	};

	const durationMinutes = periodStartAt !== undefined && periodEndAt !== undefined && periodEndAt > periodStartAt
		? (periodEndAt - periodStartAt) / 60
		: undefined;
	return durationMinutes !== undefined && durationMinutes <= 8 * 1440
		? { weekly: window, plan }
		: { monthly: window, plan };
}
