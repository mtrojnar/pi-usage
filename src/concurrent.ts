/**
 * Merge selected fields from an in-flight result into a newer cached value.
 * Fields changed by a concurrent passive update win; untouched fields can
 * still be refreshed by the completed check.
 */
export function mergeConcurrentFields<T extends object>(
	result: T,
	before: T | undefined,
	current: T | undefined,
	fields: readonly (keyof T)[],
): T {
	if (!current) return result;

	const merged = { ...current };
	for (const field of fields) {
		if (result[field] !== undefined && Object.is(current[field], before?.[field])) {
			merged[field] = result[field];
		}
	}
	return merged;
}
