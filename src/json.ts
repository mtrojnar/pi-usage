/** Treat external JSON as unknown until the fields we consume are validated. */
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** Accept finite numbers and numeric strings, but never coerce null or booleans. */
export function jsonNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}
