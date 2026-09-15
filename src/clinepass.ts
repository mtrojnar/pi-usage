import type { UsageApiWindows } from "./types.ts";
import { clampPercent } from "./format.ts";
import { jsonNumber, jsonObject } from "./json.ts";
import { parseResetAtSeconds, resetAfterFromAt } from "./headers.ts";

// ───────── Constants ─────────

/** Canonical pi provider ID for ClinePass (see pi-clinepass-provider PROVIDER_NAME). */
export const CLINEPASS_PROVIDER = "clinepass";

/**
 * Official ClinePass quota endpoint. The only origin pi-usage will send
 * ClinePass credentials to is the origin of this URL; custom/proxy bases
 * fail closed in the shared same-origin fetch guard before any fetch.
 */
export const CLINEPASS_USAGE_LIMITS_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";

/** pi provider IDs that resolve to the ClinePass adapter (canonical only). */
export const CLINEPASS_AUTH_PROVIDER_IDS = [CLINEPASS_PROVIDER] as const;

/** Env var holding a static ClinePass API key (documentary; pi resolves the effective credential). */
export const CLINEPASS_ENV_KEYS = ["CLINE_API_KEY"] as const;

// ───────── Parsing ─────────

/** ClinePass quota window types, mapped to generic subscription windows. */
const WINDOW_BY_TYPE: Record<string, keyof UsageApiWindows> = {
	five_hour: "rolling",
	weekly: "weekly",
	monthly: "monthly",
};

function clinePassWindow(percentUsed: unknown, resetsAt: unknown): UsageApiWindows[keyof UsageApiWindows] | undefined {
	const used = jsonNumber(percentUsed);
	if (used === undefined || used < 0) return undefined;
	const usedPercent = clampPercent(used);
	const resetAt = parseResetAtSeconds(typeof resetsAt === "string" ? resetsAt : undefined);
	return {
		usedPercent,
		remainingPercent: clampPercent(100 - usedPercent),
		resetAt: resetAt > 0 ? resetAt : undefined,
		resetAfterSeconds: resetAfterFromAt(resetAt > 0 ? resetAt : undefined),
	};
}

/**
 * Parse a ClinePass `GET /api/v1/users/me/plan/usage-limits` payload into
 * generic quota windows.
 *
 * Envelope shape (cf. cline-usage-tool `ApiEnvelope<UsageLimits>`):
 *   { success: true, data: { limits: [{ type, percentUsed, resetsAt? }] } }
 *   { success: true, data: null }                       // no active plan
 *   { success: false, error: string }                   // request failure
 *
 * A bare `{ limits: [...] }` object is also accepted for testability.
 *
 * Mapping: `five_hour` → rolling, `weekly` → weekly, `monthly` → monthly.
 * First valid row wins on duplicates; unknown future types are ignored;
 * rows with missing/non-numeric/negative `percentUsed` are skipped; reset
 * timestamps are kept only when valid. Returns undefined when no valid
 * window remains so the caller fails safely instead of fabricating quota.
 */
export function parseClinePassUsagePayload(payload: unknown): UsageApiWindows | undefined {
	const root = jsonObject(payload);
	if (!root) return undefined;
	if (root.success === false) return undefined;

	const data = "data" in root ? root.data : payload;
	if (data === null) return undefined;
	const body = jsonObject(data);
	if (!body) return undefined;

	const limits = Array.isArray(body.limits) ? body.limits : undefined;
	if (!limits) return undefined;

	const out: UsageApiWindows = {};
	for (const value of limits) {
		const row = jsonObject(value);
		if (!row || typeof row.type !== "string") continue;
		const window = WINDOW_BY_TYPE[row.type];
		if (!window || out[window] !== undefined) continue;
		const parsed = clinePassWindow(row.percentUsed, row.resetsAt);
		if (parsed) out[window] = parsed;
	}

	return out.rolling || out.weekly || out.monthly ? out : undefined;
}
