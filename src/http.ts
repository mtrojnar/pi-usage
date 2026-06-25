import { BODY_READ_TIMEOUT_MS, MAX_BODY_BYTES } from "./config.ts";

// ───────── HTTP Helpers ─────────

export async function readResponseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => {});
	}, BODY_READ_TIMEOUT_MS);

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
				throw readErr;
			}
		}
	} finally {
		clearTimeout(timeout);
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

export async function readResponseJson<T>(response: Response): Promise<T> {
	return JSON.parse(await readResponseText(response)) as T;
}

export async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch { /* ignore */ }
}
