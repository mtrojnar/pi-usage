import * as os from "node:os";
import { CHECK_TIMEOUT_MS, MAX_BODY_BYTES } from "./config.ts";
import { truncate } from "./format.ts";

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
	const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
	try {
		return await fetch(url, { ...init, signal: timeoutSignal.signal });
	} finally {
		timeoutSignal.cleanup();
	}
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

export async function readResponseJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
	return JSON.parse(await readResponseText(response, signal)) as T;
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
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
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
