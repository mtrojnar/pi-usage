import * as os from "node:os";
import { CHECK_TIMEOUT_MS, MAX_BODY_BYTES } from "./config.ts";
import { truncate } from "./format.ts";
import { jsonObject } from "./json.ts";

// ───────── HTTP Helpers ─────────

/** Prevent a timer from keeping the process alive. */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
	if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
		timer.unref();
	}
}

export function piUsageUserAgent(): string {
	return `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`;
}

/** Return the normalized origin of an absolute HTTP(S) URL. */
export function httpOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

/** Whether two absolute HTTP(S) URLs have exactly the same origin. */
export function isSameHttpOrigin(left: string, right: string): boolean {
	const leftOrigin = httpOrigin(left);
	return leftOrigin !== undefined && leftOrigin === httpOrigin(right);
}

function assertCredentialOrigin(url: string, credentialBaseUrl: string): void {
	if (isSameHttpOrigin(url, credentialBaseUrl)) return;
	const actual = httpOrigin(url) ?? "an invalid URL";
	const expected = httpOrigin(credentialBaseUrl) ?? "an invalid credential origin";
	throw new Error(`Refusing credentialed request to ${actual}; expected ${expected}`);
}

/**
 * Fetch an endpoint only when it shares the credential's resolved origin.
 * Redirects are rejected so credentials cannot escape after this check.
 */
export async function fetchSameOrigin(
	url: string,
	credentialBaseUrl: string,
	init: RequestInit,
): Promise<Response> {
	assertCredentialOrigin(url, credentialBaseUrl);
	init.signal?.throwIfAborted();
	return fetch(url, { ...init, redirect: "error" });
}

export function createTimeoutSignal(
	ms: number,
	parentSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abort = () => {
		if (!controller.signal.aborted) controller.abort();
	};

	if (parentSignal?.aborted) abort();
	else parentSignal?.addEventListener("abort", abort, { once: true });

	const timeout = setTimeout(abort, ms);
	unrefTimer(timeout);

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abort);
		},
	};
}

/** Fetch with the standard check timeout, chained to an optional parent signal. */
export async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	signal?.throwIfAborted();
	const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
	try {
		return await fetch(url, { ...init, redirect: "error", signal: timeoutSignal.signal });
	} finally {
		timeoutSignal.cleanup();
	}
}

/** Same-origin credentialed fetch with the standard check timeout. */
export async function fetchSameOriginWithTimeout(
	url: string,
	credentialBaseUrl: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	assertCredentialOrigin(url, credentialBaseUrl);
	return fetchWithTimeout(url, init, signal);
}

export async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let timedOut = false;
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		reader.cancel().catch(() => {});
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	const timeout = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => {});
	}, CHECK_TIMEOUT_MS);
	unrefTimer(timeout);

	try {
		while (true) {
			try {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				chunks.push(value);
				totalBytes += value.byteLength;
				if (totalBytes > MAX_BODY_BYTES) {
					reader.cancel().catch(() => {});
					throw new Error(`Response body exceeded ${MAX_BODY_BYTES} byte limit`);
				}
			} catch (readErr: unknown) {
				if (timedOut) throw new Error("Response body read timed out");
				if (aborted) throw new Error("Response body read aborted");
				throw readErr;
			}
		}
		if (timedOut) throw new Error("Response body read timed out");
		if (aborted) throw new Error("Response body read aborted");
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		try { reader.releaseLock(); } catch { /* ignore */ }
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export async function readResponseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
	return JSON.parse(await readResponseText(response, signal));
}

export async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch { /* ignore */ }
}

/** Error message from a JSON error body, or the fallback when unparsable. */
export async function readErrorMessage(response: Response, fallback: string, signal?: AbortSignal): Promise<string> {
	try {
		const body = await readResponseText(response, signal);
		const parsed = jsonObject(JSON.parse(body));
		const messages = [jsonObject(parsed?.error)?.message, parsed?.message, parsed?.detail];
		return messages.find((value): value is string => typeof value === "string" && value.length > 0) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Short error detail from a response body, falling back to the HTTP status. */
export async function readErrorDetail(response: Response, signal?: AbortSignal): Promise<string> {
	const fallback = `HTTP ${response.status}`;
	try {
		const body = await readResponseText(response, signal);
		return truncate(body, 160) || fallback;
	} catch {
		return fallback;
	}
}
