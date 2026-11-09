import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type {
	CodexUsage,
	CodexUsageApiResult,
	UsageContext,
	OpenAIUsageWindow,
	PassiveUsageUpdate,
} from "./types.ts";
import {
	CODEX_PROBE_MODEL,
	OPENAI_CODEX_PROVIDER,
	OPENAI_USAGE_URL,
	extractAccountId,
} from "./config.ts";
import { readStoredCredential, resolveBoundProviderAuth } from "./auth.ts";
import { clampPercent, errorText } from "./format.ts";
import { jsonNumber, jsonObject } from "./json.ts";
import { resolveProbeAuth, resolveProbeEndpoint } from "./probe.ts";
import { bearerToken, mergeRequestHeaders, hasHeaderPrefix, headerValue, parseHeaderBool, parseHeaderNumber, parseRetryAfterSeconds, responseHeadersToRecord } from "./headers.ts";
import {
	cancelResponseBody,
	fetchSameOriginWithTimeout,
	piUsageUserAgent,
	readErrorDetail,
	readErrorMessage,
	readResponseJson,
	readResponseText,
} from "./http.ts";

// ───────── Codex Auth ─────────

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export async function getCodexToken(ctx: Pick<UsageContext, "modelRegistry">): Promise<{ token: string; accountId: string; baseUrl: string; headers?: ProviderHeaders } | undefined> {
	const [credential, resolved] = await Promise.all([
		readStoredCredential(OPENAI_CODEX_PROVIDER),
		resolveBoundProviderAuth(ctx, OPENAI_CODEX_PROVIDER),
	]);
	if (!resolved) return undefined;
	const token = bearerToken(resolved.headers) ?? resolved.apiKey;
	if (!token) return undefined;

	const storedAccountId = credential?.type === "oauth" && credential.access === token
		&& typeof credential.accountId === "string" ? credential.accountId.trim() || undefined : undefined;
	const accountId = headerValue(mergeRequestHeaders(resolved.headers), "chatgpt-account-id")
		?? extractAccountId(token) ?? storedAccountId;
	return accountId ? { token, accountId, baseUrl: resolved.baseUrl, ...(resolved.headers && { headers: resolved.headers }) } : undefined;
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

function windowFromApi(value: unknown): OpenAIUsageWindow | undefined {
	const window = jsonObject(value);
	if (!window) return undefined;
	const used = jsonNumber(window.used_percent);
	if (used === undefined) return undefined;
	return {
		used_percent: used,
		limit_window_seconds: jsonNumber(window.limit_window_seconds),
		reset_after_seconds: jsonNumber(window.reset_after_seconds),
		reset_at: jsonNumber(window.reset_at),
	};
}

export async function checkCodexUsageFromUsageApi(
	token: string,
	accountId: string,
	signal?: AbortSignal,
	credentialBaseUrl = CODEX_BASE_URL,
	providerHeaders?: ProviderHeaders,
): Promise<CodexUsageApiResult> {
	try {
		const response = await fetchSameOriginWithTimeout(OPENAI_USAGE_URL, credentialBaseUrl, {
			headers: mergeRequestHeaders({
				"Authorization": `Bearer ${token}`,
				"ChatGPT-Account-Id": accountId,
				"User-Agent": piUsageUserAgent(),
			}, providerHeaders),
		}, signal);

		if (!response.ok) {
			return { success: false, error: `OpenAI usage API: ${await readErrorDetail(response, signal)}` };
		}

		const data = jsonObject(await readResponseJson(response, signal));
		const rateLimit = jsonObject(data?.rate_limit);
		const primary = windowFromApi(rateLimit?.primary_window);
		if (!primary) {
			return { success: false, error: "OpenAI usage API: no primary quota window" };
		}

		const secondary = windowFromApi(rateLimit?.secondary_window);
		const codeReview = windowFromApi(jsonObject(data?.code_review_rate_limit)?.primary_window);
		const credits = jsonObject(data?.credits);
		const usage: CodexUsage = {
			planType: typeof data?.plan_type === "string" ? data.plan_type : "unknown",
			activeLimit: "unknown",
			rateLimited: rateLimit?.limit_reached === true,
			primaryUsedPercent: windowUsedPercent(primary),
			// Some plans temporarily expose only a weekly window and place it in
			// primary_window. Do not turn an absent secondary_window into a fake 0% row.
			secondaryUsedPercent: secondary ? windowUsedPercent(secondary) : undefined,
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
			creditsHasCredits: credits?.has_credits === true,
			creditsBalance: typeof credits?.balance === "string" ? credits.balance : "",
			creditsUnlimited: credits?.unlimited === true,
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
	rateLimited: false,
	primaryUsedPercent: undefined,
	secondaryUsedPercent: undefined,
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

const PROBE_ERROR_BASE: CodexUsage = { ...CODEX_USAGE_DEFAULTS };

export function parseCodexUsageHeaders(
	headers: Record<string, string>,
	status: number = 200,
	previous?: CodexUsage,
): PassiveUsageUpdate<CodexUsage> | undefined {
	const getHeader = (name: string): string | undefined => headerValue(headers, name);
	if (!hasHeaderPrefix(headers, "x-codex-") && status !== 429) return undefined;

	const usage: CodexUsage = {
		...(previous ?? CODEX_USAGE_DEFAULTS),
		rateLimited: status === 429,
		source: "headers",
	};
	delete usage.error;

	const setNumber = (name: string, apply: (value: number) => void): void => {
		const value = getHeader(name);
		if (value !== undefined) apply(parseHeaderNumber(value, 0));
	};
	const setString = (name: string, apply: (value: string) => void): void => {
		const value = getHeader(name);
		if (value !== undefined) apply(value);
	};
	const setBool = (name: string, apply: (value: boolean) => void): void => {
		const value = getHeader(name);
		if (value !== undefined) apply(parseHeaderBool(value));
	};

	setString("x-codex-plan-type", (value) => { usage.planType = value; });
	setString("x-codex-active-limit", (value) => { usage.activeLimit = value; });
	setNumber("x-codex-primary-used-percent", (value) => { usage.primaryUsedPercent = value; });
	setNumber("x-codex-secondary-used-percent", (value) => { usage.secondaryUsedPercent = value; });
	setNumber("x-codex-code-review-used-percent", (value) => { usage.codeReviewUsedPercent = value; });
	setNumber("x-codex-primary-window-minutes", (value) => { usage.primaryWindowMinutes = value; });
	setNumber("x-codex-secondary-window-minutes", (value) => { usage.secondaryWindowMinutes = value; });
	setNumber("x-codex-code-review-window-minutes", (value) => { usage.codeReviewWindowMinutes = value; });
	setNumber("x-codex-primary-reset-after-seconds", (value) => {
		usage.primaryResetAfterSeconds = value;
		if (getHeader("x-codex-primary-reset-at") === undefined) usage.primaryResetAt = 0;
	});
	setNumber("x-codex-secondary-reset-after-seconds", (value) => {
		usage.secondaryResetAfterSeconds = value;
		if (getHeader("x-codex-secondary-reset-at") === undefined) usage.secondaryResetAt = 0;
	});
	setNumber("x-codex-code-review-reset-after-seconds", (value) => {
		usage.codeReviewResetAfterSeconds = value;
		if (getHeader("x-codex-code-review-reset-at") === undefined) usage.codeReviewResetAt = 0;
	});
	setNumber("x-codex-primary-reset-at", (value) => { usage.primaryResetAt = value; });
	setNumber("x-codex-secondary-reset-at", (value) => { usage.secondaryResetAt = value; });
	setNumber("x-codex-code-review-reset-at", (value) => { usage.codeReviewResetAt = value; });
	setNumber("x-codex-primary-over-secondary-limit-percent", (value) => { usage.primaryOverSecondaryLimitPercent = value; });
	setBool("x-codex-credits-has-credits", (value) => { usage.creditsHasCredits = value; });
	setString("x-codex-credits-balance", (value) => { usage.creditsBalance = value; });
	setBool("x-codex-credits-unlimited", (value) => { usage.creditsUnlimited = value; });

	const retryAfterHeader = getHeader("retry-after");
	const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
	if (getHeader("x-codex-primary-reset-after-seconds") === undefined && retryAfterHeader !== undefined) {
		usage.primaryResetAfterSeconds = retryAfterSeconds;
		if (getHeader("x-codex-primary-reset-at") === undefined) usage.primaryResetAt = 0;
	}
	return { usage, hasSignal: true };
}

// ───────── Probe Fallback ─────────

export function resolveCodexProbeEndpoint(baseUrl: string): string {
	return resolveProbeEndpoint(baseUrl, "openai-codex-responses");
}

async function checkCodexUsageWithProbe(token: string, accountId: string, signal?: AbortSignal, credentialBaseUrl = CODEX_BASE_URL, providerHeaders?: ProviderHeaders, ctx?: Pick<UsageContext, "modelRegistry">): Promise<CodexUsage> {
	try {
		const probe = { id: CODEX_PROBE_MODEL, api: "openai-codex-responses" as const, endpoint: resolveCodexProbeEndpoint(credentialBaseUrl) };
		const fallback = { apiKey: token, baseUrl: credentialBaseUrl, headers: providerHeaders };
		const auth = ctx ? await resolveProbeAuth(ctx, OPENAI_CODEX_PROVIDER, probe, fallback) : { ...fallback, endpoint: probe.endpoint };
		const requestToken = bearerToken(auth.headers) ?? auth.apiKey;
		const requestAccountId = headerValue(mergeRequestHeaders(auth.headers), "chatgpt-account-id")
			?? (requestToken ? extractAccountId(requestToken) : undefined) ?? (requestToken === token ? accountId : undefined);
		if (!requestToken || !requestAccountId) throw new Error("Codex authentication is missing a token-bound account ID");
		const response = await fetchSameOriginWithTimeout(auth.endpoint, auth.baseUrl, {
			method: "POST",
			headers: mergeRequestHeaders({
				...(requestToken && { Authorization: `Bearer ${requestToken}` }),
				"chatgpt-account-id": requestAccountId,
				"Content-Type": "application/json",
				"OpenAI-Beta": "responses=experimental",
				"accept": "text/event-stream",
				"originator": "pi-usage",
				"User-Agent": piUsageUserAgent(),
			}, auth.headers),
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
			return { ...(parseCodexUsageHeaders(headers, response.status)?.usage ?? CODEX_USAGE_DEFAULTS), source: "probe" };
		}

		if (response.status === 429) {
			// parseCodexUsageHeaders always yields a result for 429 responses.
			const usage = parseCodexUsageHeaders(headers, response.status)?.usage ?? { ...CODEX_USAGE_DEFAULTS };
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

export async function checkCodexUsage(
	token: string,
	accountId: string,
	signal?: AbortSignal,
	credentialBaseUrl = CODEX_BASE_URL,
	providerHeaders?: ProviderHeaders,
	ctx?: Pick<UsageContext, "modelRegistry">,
): Promise<CodexUsage> {
	const usageApiResult = await checkCodexUsageFromUsageApi(token, accountId, signal, credentialBaseUrl, providerHeaders);
	if (usageApiResult.success || signal?.aborted) {
		return usageApiResult.success ? usageApiResult.usage : { ...PROBE_ERROR_BASE, error: usageApiResult.error };
	}

	const probeResult = await checkCodexUsageWithProbe(token, accountId, signal, credentialBaseUrl, providerHeaders, ctx);
	if (probeResult.error && !probeResult.rateLimited) {
		probeResult.error = `${usageApiResult.error}; fallback probe: ${probeResult.error}`;
	}
	return probeResult;
}
