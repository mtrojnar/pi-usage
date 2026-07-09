// ───────── Response Header Parsing ─────────

/** Case-insensitive lookup of a single header value. */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
	return undefined;
}

/** True when any header name starts with the given prefix (case-insensitive). */
export function hasHeaderPrefix(headers: Record<string, string>, prefix: string): boolean {
	const normalizedPrefix = prefix.toLowerCase();
	return Object.keys(headers).some((name) => name.toLowerCase().startsWith(normalizedPrefix));
}

/** Finite number from a single header value, or the fallback. */
export function parseHeaderNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Case-insensitive "true" from a single header value. */
export function parseHeaderBool(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
}

/** First finite number among the named headers, or undefined. */
export function parseOptionalNumber(headers: Record<string, string>, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = headerValue(headers, name);
		if (value === undefined || value.trim() === "") continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** Parse a Retry-After header (delay seconds or HTTP date) into seconds from now. */
export function parseRetryAfterSeconds(value: string | undefined): number {
	if (!value) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((timestamp - Date.now()) / 1000)) : 0;
}

/** Parse a reset timestamp (unix seconds, unix millis, or date string) into unix seconds. */
export function parseResetAtSeconds(value: string | undefined): number {
	if (!value) return 0;
	const trimmed = value.trim();
	if (!trimmed) return 0;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) {
		if (numeric > 1_000_000_000_000) return Math.round(numeric / 1000);
		return Math.round(numeric);
	}

	const timestamp = Date.parse(trimmed);
	return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : 0;
}

/** Seconds from now until the given unix timestamp, or undefined when unknown. */
export function resetAfterFromAt(resetAt: number | undefined): number | undefined {
	if (resetAt === undefined || resetAt <= 0) return undefined;
	return Math.max(0, Math.round(resetAt - Date.now() / 1000));
}

export interface RetryResetFields {
	retryAfterSeconds?: number;
	retryResetAt?: number;
}

/** Retry countdown fields for a limited response, preserving prior values when no Retry-After is present. */
export function retryResetFields(
	limited: boolean,
	retryAfterSeconds: number,
	previous?: RetryResetFields,
): RetryResetFields {
	if (!limited) return { retryAfterSeconds: undefined, retryResetAt: undefined };
	if (retryAfterSeconds > 0) {
		return {
			retryAfterSeconds,
			retryResetAt: Math.round(Date.now() / 1000) + retryAfterSeconds,
		};
	}
	return {
		retryAfterSeconds: previous?.retryAfterSeconds,
		retryResetAt: previous?.retryResetAt,
	};
}

/** Collect fetch Response headers into a plain record. */
export function responseHeadersToRecord(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}
