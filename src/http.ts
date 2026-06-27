import { BODY_READ_TIMEOUT_MS, MAX_BODY_BYTES } from "./config.ts";

// ───────── HTTP Helpers ─────────

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
		timer.unref();
	}
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
	}, BODY_READ_TIMEOUT_MS);
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
