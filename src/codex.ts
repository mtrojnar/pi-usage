import * as fs from "node:fs";
import * as os from "node:os";
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
	authJsonPath,
	extractAccountId,
} from "./config.ts";
import { clampPercent, parseHeaderBool, parseHeaderNumber, truncate } from "./format.ts";
import { cancelResponseBody, createTimeoutSignal, readResponseJson, readResponseText } from "./http.ts";

// ───────── Codex Auth ─────────

export async function getCodexToken(): Promise<{ token: string; accountId: string } | undefined> {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;

		// Use pi's auth storage format, but do not trigger OAuth refresh from this
		// background check. Refresh may perform unbounded provider I/O; pi will
		// refresh the token during normal model use.
		const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
		const authStorage = AuthStorage.create(authPath);
		const codex = authStorage.get(OPENAI_CODEX_PROVIDER) as CodexOAuthCredential | undefined;
		if (codex?.type !== "oauth" || !codex.access) return undefined;
		if (typeof codex.expires === "number" && Date.now() >= codex.expires) return undefined;

		const accountId = codex.accountId ?? extractAccountId(codex.access);
		if (!accountId) return undefined;
		return { token: codex.access, accountId };
	} catch {
		return undefined;
	}
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
		const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);

		let response: Response;
		try {
			response = await fetch(OPENAI_USAGE_URL, {
				headers: {
					"Authorization": `Bearer ${token}`,
					"ChatGPT-Account-Id": accountId,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
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
			return { success: false, error: `OpenAI usage API: ${detail}` };
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
		return {
			success: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

const PROBE_ERROR_BASE: Omit<CodexUsage, "error"> = {
	planType: "unknown",
	activeLimit: "error",
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

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function hasHeaderPrefix(headers: Record<string, string>, prefix: string): boolean {
	const normalizedPrefix = prefix.toLowerCase();
	return Object.keys(headers).some((name) => name.toLowerCase().startsWith(normalizedPrefix));
}

export function parseRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

export function parseCodexUsageHeaders(headers: Record<string, string>, status: number = 200): CodexUsage | undefined {
	const getHeader = (name: string): string | undefined => headerValue(headers, name);
	const hasCodexHeaders = hasHeaderPrefix(headers, "x-codex-");
	if (!hasCodexHeaders && status !== 429) return undefined;

	const retryAfterSeconds = parseRetryAfterSeconds(getHeader("retry-after"));
	const primaryResetAfterSeconds = parseHeaderNumber(
		getHeader("x-codex-primary-reset-after-seconds"),
		retryAfterSeconds,
	);
	const secondaryResetAfterSeconds = parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0);
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
		primaryResetAfterSeconds,
		secondaryResetAfterSeconds,
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

async function checkCodexUsageWithProbe(token: string, accountId: string, signal?: AbortSignal): Promise<CodexUsage> {
	const baseUrl = "https://chatgpt.com/backend-api/codex/responses";

	try {
		const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);

		let response: Response;
		try {
			response = await fetch(baseUrl, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					"Content-Type": "application/json",
					"OpenAI-Beta": "responses=experimental",
					"accept": "text/event-stream",
					"originator": "pi-usage",
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				body: JSON.stringify({
					model: CODEX_PROBE_MODEL,
					instructions: "Reply with just: ok",
					input: [{ type: "message", role: "user", content: "hi" }],
					store: false,
					stream: true,
				}),
				signal: timeoutSignal.signal,
			});
		} finally {
			timeoutSignal.cleanup();
		}

		const getHeader = (name: string): string | undefined =>
			response.headers.get(name) ?? undefined;

		if (response.ok) {
			await cancelResponseBody(response);

			return {
				planType: getHeader("x-codex-plan-type") ?? "unknown",
				activeLimit: getHeader("x-codex-active-limit") ?? "unknown",
				primaryUsedPercent: parseHeaderNumber(getHeader("x-codex-primary-used-percent"), 0),
				secondaryUsedPercent: parseHeaderNumber(getHeader("x-codex-secondary-used-percent"), 0),
				primaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-primary-window-minutes"), 300),
				secondaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-secondary-window-minutes"), 10080),
				primaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-primary-reset-after-seconds"), 0),
				secondaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0),
				primaryResetAt: parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0),
				secondaryResetAt: parseHeaderNumber(getHeader("x-codex-secondary-reset-at"), 0),
				primaryOverSecondaryLimitPercent: parseHeaderNumber(getHeader("x-codex-primary-over-secondary-limit-percent"), 0),
				creditsHasCredits: parseHeaderBool(getHeader("x-codex-credits-has-credits")),
				creditsBalance: getHeader("x-codex-credits-balance") ?? "",
				creditsUnlimited: parseHeaderBool(getHeader("x-codex-credits-unlimited")),
				source: "probe",
			};
		}

		// 429 = rate limited
		if (response.status === 429) {
			let resetAt = parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0);
			try {
				const body = await readResponseText(response, signal);
				const parsed = JSON.parse(body);
				resetAt = parsed?.error?.resets_at ?? resetAt;
			} catch { /* ignore */ }

			return {
				planType: getHeader("x-codex-plan-type") ?? "unknown",
				activeLimit: getHeader("x-codex-active-limit") ?? "rate_limited",
				primaryUsedPercent: parseHeaderNumber(getHeader("x-codex-primary-used-percent"), 100),
				secondaryUsedPercent: parseHeaderNumber(getHeader("x-codex-secondary-used-percent"), 100),
				primaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-primary-window-minutes"), 300),
				secondaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-secondary-window-minutes"), 10080),
				primaryResetAfterSeconds: parseHeaderNumber(
					getHeader("x-codex-primary-reset-after-seconds"),
					resetAt ? Math.max(0, Math.round(resetAt - Date.now() / 1000)) : 0,
				),
				secondaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0),
				primaryResetAt: resetAt,
				secondaryResetAt: parseHeaderNumber(getHeader("x-codex-secondary-reset-at"), 0),
				primaryOverSecondaryLimitPercent: parseHeaderNumber(getHeader("x-codex-primary-over-secondary-limit-percent"), 0),
				creditsHasCredits: parseHeaderBool(getHeader("x-codex-credits-has-credits")),
				creditsBalance: getHeader("x-codex-credits-balance") ?? "",
				creditsUnlimited: parseHeaderBool(getHeader("x-codex-credits-unlimited")),
				source: "probe",
				error: "Rate limited (429)",
			};
		}

		// Other errors
		let errorMsg = `HTTP ${response.status}`;
		try {
			const body = await readResponseText(response, signal);
			const parsed = JSON.parse(body);
			errorMsg = parsed?.error?.message ?? parsed?.detail ?? errorMsg;
		} catch { /* ignore */ }

		return { ...PROBE_ERROR_BASE, error: errorMsg };
	} catch (e: unknown) {
		return {
			...PROBE_ERROR_BASE,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

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
