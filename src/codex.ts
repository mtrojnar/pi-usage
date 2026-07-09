import type {
	CodexOAuthCredential,
	CodexUsage,
	CodexUsageApiResult,
	OpenAIUsageResponse,
	OpenAIUsageWindow,
} from "./types.ts";
import {
	CHECK_TIMEOUT_MS,
	CODEX_PROBE_MODEL,
	OPENAI_CODEX_PROVIDER,
	OPENAI_USAGE_URL,
	extractAccountId,
} from "./config.ts";
import { oauthAccessToken, readStoredCredential, refreshProviderToken } from "./auth.ts";
import { clampPercent, errorText } from "./format.ts";
import { hasHeaderPrefix, headerValue, parseHeaderBool, parseHeaderNumber, parseRetryAfterSeconds, responseHeadersToRecord } from "./headers.ts";
import {
	cancelResponseBody,
	fetchWithTimeout,
	piUsageUserAgent,
	readErrorDetail,
	readErrorMessage,
	readResponseJson,
	readResponseText,
} from "./http.ts";

// ───────── Codex Auth ─────────

export async function getCodexToken(): Promise<{ token: string; accountId: string } | undefined> {
	const credential = await readStoredCredential(OPENAI_CODEX_PROVIDER);
	// Use the stored access token when still valid; if it has expired, let pi
	// refresh it (bounded, so a stuck refresh can't hang startup). Without this
	// an expired token silently hides Codex usage until the token happens to be
	// refreshed by using the provider elsewhere.
	const token = oauthAccessToken(credential)
		?? (credential?.type === "oauth"
			? await refreshProviderToken(OPENAI_CODEX_PROVIDER, CHECK_TIMEOUT_MS)
			: undefined);
	if (!token) return undefined;

	const accountId = (credential as CodexOAuthCredential).accountId ?? extractAccountId(token);
	return accountId ? { token, accountId } : undefined;
}

// ───────── Window Helpers ─────────

export function windowUsedPercent(window: OpenAIUsageWindow | null | undefined): number {
	return clampPercent(Number(window?.used_percent ?? 0));
}

export function windowMinutes(window: OpenAIUsageWindow | null | undefined, fallback: number): number {
	const seconds = Number(window?.limit_window_seconds);
	return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : fallback;
}

export function windowResetAfterSeconds(window: OpenAIUsageWindow | null | undefined): number {
	const seconds = Number(window?.reset_after_seconds);
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

export function windowResetAt(window: OpenAIUsageWindow | null | undefined): number {
	const resetAt = Number(window?.reset_at);
	if (Number.isFinite(resetAt) && resetAt > 0) return Math.round(resetAt);
	const resetAfter = windowResetAfterSeconds(window);
	return resetAfter > 0 ? Math.round(Date.now() / 1000) + resetAfter : 0;
}

// ───────── Codex Usage Check ─────────

export async function checkCodexUsageFromUsageApi(token: string, accountId: string, signal?: AbortSignal): Promise<CodexUsageApiResult> {
	try {
		const response = await fetchWithTimeout(OPENAI_USAGE_URL, {
			headers: {
				"Authorization": `Bearer ${token}`,
				"ChatGPT-Account-Id": accountId,
				"User-Agent": piUsageUserAgent(),
			},
		}, signal);

		if (!response.ok) {
			return { success: false, error: `OpenAI usage API: ${await readErrorDetail(response, signal)}` };
		}

		const data = await readResponseJson<OpenAIUsageResponse>(response, signal);
		const primary = data.rate_limit?.primary_window;
		if (!primary) {
			return { success: false, error: "OpenAI usage API: no primary quota window" };
		}

		const secondary = data.rate_limit?.secondary_window;
		const codeReview = data.code_review_rate_limit?.primary_window;
		const usage: CodexUsage = {
			planType: data.plan_type ?? "unknown",
			activeLimit: data.rate_limit?.limit_reached ? "rate_limited" : "normal",
			primaryUsedPercent: windowUsedPercent(primary),
			secondaryUsedPercent: windowUsedPercent(secondary),
			codeReviewUsedPercent: codeReview ? windowUsedPercent(codeReview) : undefined,
			primaryWindowMinutes: windowMinutes(primary, 300),
			secondaryWindowMinutes: windowMinutes(secondary, 10080),
			codeReviewWindowMinutes: codeReview ? windowMinutes(codeReview, 0) : undefined,
			primaryResetAfterSeconds: windowResetAfterSeconds(primary),
			secondaryResetAfterSeconds: windowResetAfterSeconds(secondary),
			codeReviewResetAfterSeconds: codeReview ? windowResetAfterSeconds(codeReview) : undefined,
			primaryResetAt: windowResetAt(primary),
			secondaryResetAt: windowResetAt(secondary),
			codeReviewResetAt: codeReview ? windowResetAt(codeReview) : undefined,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: Boolean(data.credits?.has_credits),
			creditsBalance: data.credits?.balance ?? "",
			creditsUnlimited: Boolean(data.credits?.unlimited),
			source: "usage_api",
		};
		return { success: true, usage };
	} catch (e: unknown) {
		return { success: false, error: errorText(e) };
	}
}

// ───────── Header Parsing ─────────

const CODEX_USAGE_DEFAULTS: CodexUsage = {
	planType: "unknown",
	activeLimit: "unknown",
	primaryUsedPercent: 0,
	secondaryUsedPercent: 0,
	primaryWindowMinutes: 300,
	secondaryWindowMinutes: 10080,
	primaryResetAfterSeconds: 0,
	secondaryResetAfterSeconds: 0,
	primaryResetAt: 0,
	secondaryResetAt: 0,
	primaryOverSecondaryLimitPercent: 0,
	creditsHasCredits: false,
	creditsBalance: "",
	creditsUnlimited: false,
	source: "probe",
};

const PROBE_ERROR_BASE: CodexUsage = { ...CODEX_USAGE_DEFAULTS, activeLimit: "error" };

export function parseCodexUsageHeaders(headers: Record<string, string>, status: number = 200): CodexUsage | undefined {
	const getHeader = (name: string): string | undefined => headerValue(headers, name);
	if (!hasHeaderPrefix(headers, "x-codex-") && status !== 429) return undefined;

	const retryAfterSeconds = parseRetryAfterSeconds(getHeader("retry-after"));
	const codeReviewUsedHeader = getHeader("x-codex-code-review-used-percent");
	const codeReviewResetAfterHeader = getHeader("x-codex-code-review-reset-after-seconds");
	const codeReviewResetAtHeader = getHeader("x-codex-code-review-reset-at");

	return {
		planType: getHeader("x-codex-plan-type") ?? "unknown",
		activeLimit: getHeader("x-codex-active-limit") ?? (status === 429 ? "rate_limited" : "unknown"),
		primaryUsedPercent: parseHeaderNumber(getHeader("x-codex-primary-used-percent"), status === 429 ? 100 : 0),
		secondaryUsedPercent: parseHeaderNumber(getHeader("x-codex-secondary-used-percent"), status === 429 ? 100 : 0),
		codeReviewUsedPercent: codeReviewUsedHeader !== undefined
			? parseHeaderNumber(codeReviewUsedHeader, 0)
			: undefined,
		primaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-primary-window-minutes"), 300),
		secondaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-secondary-window-minutes"), 10080),
		codeReviewWindowMinutes: codeReviewUsedHeader !== undefined
			? parseHeaderNumber(getHeader("x-codex-code-review-window-minutes"), 0)
			: undefined,
		primaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-primary-reset-after-seconds"), retryAfterSeconds),
		secondaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0),
		codeReviewResetAfterSeconds: codeReviewResetAfterHeader !== undefined
			? parseHeaderNumber(codeReviewResetAfterHeader, 0)
			: undefined,
		primaryResetAt: parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0),
		secondaryResetAt: parseHeaderNumber(getHeader("x-codex-secondary-reset-at"), 0),
		codeReviewResetAt: codeReviewResetAtHeader !== undefined
			? parseHeaderNumber(codeReviewResetAtHeader, 0)
			: undefined,
		primaryOverSecondaryLimitPercent: parseHeaderNumber(getHeader("x-codex-primary-over-secondary-limit-percent"), 0),
		creditsHasCredits: parseHeaderBool(getHeader("x-codex-credits-has-credits")),
		creditsBalance: getHeader("x-codex-credits-balance") ?? "",
		creditsUnlimited: parseHeaderBool(getHeader("x-codex-credits-unlimited")),
		source: "headers",
	};
}

// ───────── Probe Fallback ─────────

async function checkCodexUsageWithProbe(token: string, accountId: string, signal?: AbortSignal): Promise<CodexUsage> {
	try {
		const response = await fetchWithTimeout("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				"Content-Type": "application/json",
				"OpenAI-Beta": "responses=experimental",
				"accept": "text/event-stream",
				"originator": "pi-usage",
				"User-Agent": piUsageUserAgent(),
			},
			body: JSON.stringify({
				model: CODEX_PROBE_MODEL,
				instructions: "Reply with just: ok",
				input: [{ type: "message", role: "user", content: "hi" }],
				store: false,
				stream: true,
			}),
		}, signal);

		const headers = responseHeadersToRecord(response);

		if (response.ok) {
			await cancelResponseBody(response);
			return { ...(parseCodexUsageHeaders(headers, response.status) ?? CODEX_USAGE_DEFAULTS), source: "probe" };
		}

		if (response.status === 429) {
			// parseCodexUsageHeaders always yields a result for 429 responses.
			const usage = parseCodexUsageHeaders(headers, response.status) ?? { ...CODEX_USAGE_DEFAULTS };
			usage.source = "probe";
			usage.error = "Rate limited (429)";
			applyResetsAtFromBody(usage, await readResponseText(response, signal).catch(() => ""));
			return usage;
		}

		return { ...PROBE_ERROR_BASE, error: await readErrorMessage(response, `HTTP ${response.status}`, signal) };
	} catch (e: unknown) {
		return { ...PROBE_ERROR_BASE, error: errorText(e) };
	}
}

/** Fill missing primary reset fields from the resets_at value in a 429 body. */
function applyResetsAtFromBody(usage: CodexUsage, body: string): void {
	try {
		const resetsAt = Number(JSON.parse(body)?.error?.resets_at);
		if (!Number.isFinite(resetsAt) || resetsAt <= 0) return;
		if (!usage.primaryResetAt) usage.primaryResetAt = Math.round(resetsAt);
		if (!usage.primaryResetAfterSeconds) {
			usage.primaryResetAfterSeconds = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
		}
	} catch { /* ignore malformed bodies */ }
}

// ───────── Public API ─────────

export async function checkCodexUsage(token: string, accountId: string, signal?: AbortSignal): Promise<CodexUsage> {
	const usageApiResult = await checkCodexUsageFromUsageApi(token, accountId, signal);
	if (usageApiResult.success || signal?.aborted) {
		return usageApiResult.success ? usageApiResult.usage : { ...PROBE_ERROR_BASE, error: usageApiResult.error };
	}

	const probeResult = await checkCodexUsageWithProbe(token, accountId, signal);
	if (probeResult.error && probeResult.activeLimit === "error") {
		probeResult.error = `${usageApiResult.error}; fallback probe: ${probeResult.error}`;
	}
	return probeResult;
}
