import type { GoModelStatus, SubscriptionProbeApi } from "./types.ts";
import { CHECK_TIMEOUT_MS } from "./config.ts";
import { errorText, truncate } from "./format.ts";
import { responseHeadersToRecord } from "./headers.ts";
import { cancelResponseBody, createTimeoutSignal, readErrorMessage } from "./http.ts";

// ───────── Probe Model Helpers ─────────

/** Shape of pi-ai catalog models used for probing. */
export interface PiModelLike {
	id: string;
	api: string;
	baseUrl: string;
	headers?: Record<string, string>;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export function asProbeApi(api: string | undefined): SubscriptionProbeApi | undefined {
	return api === "openai-completions" || api === "openai-responses" || api === "anthropic-messages" ? api : undefined;
}

export function isGoModelStatus(value: string | undefined): value is GoModelStatus {
	return value === "available" || value === "rate_limited" || value === "credits_error" || value === "error" || value === "no_key";
}

/** Rank a model by combined token cost; unknown costs sort last. */
export function modelCostRank(model: PiModelLike, zeroCostRank = 9999): number {
	const cost = model.cost ?? {};
	const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
	if (!Number.isFinite(rawRank)) return 9999;
	return rawRank > 0 ? rawRank : zeroCostRank;
}

/** Sort probe candidates in place: explicitly preferred ids first, then cheapest first. */
export function sortModelsByPreference<T extends { id: string; costRank: number }>(models: T[], preferredOrder: string[]): T[] {
	return models.sort((a, b) => {
		const aPreferred = preferredOrder.indexOf(a.id);
		const bPreferred = preferredOrder.indexOf(b.id);
		if (aPreferred !== -1 || bPreferred !== -1) {
			if (aPreferred === -1) return 1;
			if (bPreferred === -1) return -1;
			return aPreferred - bPreferred;
		}
		return a.costRank - b.costRank || a.id.localeCompare(b.id);
	});
}

/**
 * Resolve the request endpoint for a probe API relative to a base URL.
 * Anthropic endpoints always live under /v1; OpenAI-style endpoints are
 * appended to the base path as-is.
 */
export function resolveProbeEndpoint(baseUrl: string, api: SubscriptionProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	const leaf = api === "anthropic-messages" ? "messages" : api === "openai-responses" ? "responses" : "chat/completions";
	if (normalized.endsWith(`/${leaf}`)) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/${leaf}`;
	const versionPrefix = api === "anthropic-messages" ? "/v1" : "";
	return `${normalized}${versionPrefix}/${leaf}`;
}

// ───────── Generic Probe Loop ─────────

/** Usage fields shared by all probe-based providers. */
export interface ProbeUsageBase {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	source?: string;
	errorMessage?: string;
	error?: string;
}

export type ProbeErrorClass = "unavailable" | "rate_limited" | "credits_error" | "failed";

export interface ProbeProviderOptions<TModel extends { id: string }, TUsage extends ProbeUsageBase> {
	/** Provider name used in abort and no-models error messages. */
	label: string;
	models: TModel[];
	signal?: AbortSignal;
	/** Send one probe request; the given signal already enforces the check timeout. */
	request(model: TModel, signal: AbortSignal): Promise<Response>;
	/** Parse provider-specific rate-limit response headers, if any. */
	parseHeaders(headers: Record<string, string>, status: number, modelId: string): TUsage | undefined;
	/** Classify a non-OK response; "unavailable" advances to the next model. */
	classifyError(status: number, message: string): ProbeErrorClass;
	/** Usage skeleton carrying provider-specific constant fields. */
	emptyUsage(): TUsage;
}

/**
 * Probe models in preference order until one yields a definitive result.
 * Models rejected as unavailable are skipped; rate limits, quota errors,
 * and hard failures stop the scan.
 */
export async function probeProviderUsage<TModel extends { id: string }, TUsage extends ProbeUsageBase>(
	opts: ProbeProviderOptions<TModel, TUsage>,
): Promise<TUsage> {
	const { models, signal } = opts;
	let checkedModels = 0;
	let lastUnavailable: { model: string; message: string } | undefined;

	// Layer fields over the provider skeleton; undefined values never
	// overwrite provider constants (later layers win otherwise).
	const build = (...layers: Array<Partial<ProbeUsageBase> | TUsage | undefined>): TUsage => {
		const usage = { ...opts.emptyUsage() } as Record<string, unknown>;
		for (const layer of layers) {
			for (const [key, value] of Object.entries(layer ?? {})) {
				if (value !== undefined) usage[key] = value;
			}
		}
		usage.checkedModels = checkedModels;
		usage.totalModels = models.length;
		usage.source = "probe";
		return usage as TUsage;
	};

	const finalize = (
		model: TModel,
		parsed: TUsage | undefined,
		fallback: Partial<ProbeUsageBase>,
		overrides?: Partial<ProbeUsageBase>,
	): TUsage => {
		const usage = build(parsed ?? fallback, overrides);
		usage.workingModel = usage.available ? model.id : usage.workingModel;
		usage.rateLimitedModel = usage.status === "rate_limited" || usage.status === "credits_error"
			? model.id
			: usage.rateLimitedModel;
		return usage;
	};

	try {
		for (const model of models) {
			if (signal?.aborted) throw new Error(`${opts.label} check aborted`);
			checkedModels += 1;

			const timeoutSignal = createTimeoutSignal(CHECK_TIMEOUT_MS, signal);
			let response: Response;
			try {
				response = await opts.request(model, timeoutSignal.signal);
			} finally {
				timeoutSignal.cleanup();
			}

			const headers = responseHeadersToRecord(response);
			const parsed = opts.parseHeaders(headers, response.status, model.id);

			if (response.ok) {
				await cancelResponseBody(response);
				return finalize(model, parsed, { available: true, status: "available" });
			}

			const message = await readErrorMessage(response, `HTTP ${response.status}`, signal);
			const classified = opts.classifyError(response.status, message);

			if (classified === "unavailable") {
				lastUnavailable = { model: model.id, message };
				continue;
			}

			if (classified === "failed") {
				return finalize(model, parsed, { available: false, status: "error" }, {
					errorMessage: `${model.id}: ${truncate(message, 180)}`,
				});
			}

			return finalize(model, parsed, { available: false, status: classified }, {
				errorMessage: truncate(message, 180),
			});
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return build({
			available: false,
			status: "error",
			errorMessage: `No ${opts.label} probe models were available.${suffix}`,
		});
	} catch (e: unknown) {
		return build({ available: false, status: "error", error: errorText(e) });
	}
}
