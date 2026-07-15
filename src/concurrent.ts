/**
 * Merge selected fields from an in-flight result into a newer cached value.
 * Fields changed by a concurrent passive update win; untouched fields can
 * still be refreshed by an authoritative completed check. Failed checks keep
 * the newer cached value intact.
 */
export function mergeConcurrentFields<T extends object>(
	result: T,
	before: T | undefined,
	current: T | undefined,
	fields: readonly (keyof T)[],
	resultIsAuthoritative = true,
): T {
	if (!current) return result;
	if (!resultIsAuthoritative) return current;

	const merged = { ...current };
	for (const field of fields) {
		if (Object.is(current[field], before?.[field])) {
			merged[field] = result[field];
		}
	}
	return merged;
}
