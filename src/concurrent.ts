import { unrefTimer } from "./http.ts";

export type IsolatedTaskResult<T> =
	| { status: "fulfilled"; value: T }
	| { status: "rejected"; reason: unknown }
	| { status: "timed_out" }
	| { status: "aborted" };

/**
 * Run one provider operation behind its own deadline. A task that ignores its
 * abort signal is detached after the deadline instead of blocking its peers.
 */
export function runIsolatedTask<T>(
	task: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parentSignal?: AbortSignal,
): Promise<IsolatedTaskResult<T>> {
	return new Promise((resolve) => {
		const controller = new AbortController();
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: IsolatedTaskResult<T>) => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onParentAbort);
			resolve(result);
		};
		const onParentAbort = () => {
			controller.abort();
			finish({ status: "aborted" });
		};

		if (parentSignal?.aborted) {
			onParentAbort();
			return;
		}
		parentSignal?.addEventListener("abort", onParentAbort, { once: true });
		timeout = setTimeout(() => {
			controller.abort();
			finish({ status: "timed_out" });
		}, timeoutMs);
		unrefTimer(timeout);

		Promise.resolve()
			.then(() => task(controller.signal))
			.then(
				(value) => finish({ status: "fulfilled", value }),
				(reason: unknown) => finish({ status: "rejected", reason }),
			);
	});
}

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
