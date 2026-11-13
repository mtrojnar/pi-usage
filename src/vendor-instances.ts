import type {
	BoundApiKey,
	UsageApiWindows,
	UsageContext,
	VendorInstanceBalance,
	VendorInstanceId,
	VendorInstanceUsage,
	VendorWindowGroup,
} from "./types.ts";
import { oauthAccessToken, readStoredCredential, resolveBoundProviderAuth, resolveProviderBaseUrl, type StoredCredential } from "./auth.ts";
import { KIMI_CODING_USAGE_URL } from "./config.ts";
import { runIsolatedTask } from "./concurrent.ts";
import { clampPercent } from "./format.ts";
import { cancelResponseBody, fetchSameOriginWithTimeout, httpOrigin, readResponseJson } from "./http.ts";
import { parseResetAtSeconds } from "./headers.ts";
import { jsonNumber, jsonObject } from "./json.ts";
import { parseKimiUsagePayload } from "./kimi.ts";
import { checkOpenRouterUsage } from "./openrouter.ts";
import { CHECK_TIMEOUT_MS } from "./config.ts";

// ───────── Vendor table ─────────

interface VendorProfile {
	id: VendorInstanceId;
	/** Report section title. */
	title: string;
	/** Compact status-line label. */
	short: string;
	/** Credential origins this vendor is discovered by. */
	origins: string[];
}

export const VENDOR_PROFILES: readonly VendorProfile[] = [
	{ id: "bigmodel", title: "BigModel", short: "GLM", origins: ["https://open.bigmodel.cn"] },
	{ id: "kimi-coding", title: "Kimi Coding", short: "Kimi", origins: ["https://api.kimi.com"] },
	{ id: "deepseek", title: "DeepSeek", short: "DS", origins: ["https://api.deepseek.com"] },
	{ id: "openrouter", title: "OpenRouter", short: "OR", origins: ["https://openrouter.ai"] },
	{ id: "antigravity", title: "Antigravity", short: "AG", origins: ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"] },
];

const VENDOR_BY_ORIGIN = new Map(VENDOR_PROFILES.flatMap((profile) => profile.origins.map((origin) => [origin, profile])));

export function vendorProfile(vendor: VendorInstanceId): VendorProfile {
	const profile = VENDOR_PROFILES.find((entry) => entry.id === vendor);
	if (!profile) throw new Error(`unknown vendor: ${vendor}`);
	return profile;
}

/**
 * Instance label from a yaml-providers registration id. Since the bare-name
 * scheme, ids are usually the instance name itself (kimiqq); multi-API
 * instances carry an -openai suffix, and reserved-name instances keep the
 * legacy dotc-<instance>-<api> form - all three strip to the instance name.
 */
export function instanceLabel(providerId: string): string {
	const match = /^(?:dotc-)?(.+?)-(?:anthropic-messages|openai-completions|openai-responses|openai)$/.exec(providerId);
	return match ? match[1] : providerId;
}

// ───────── Discovery ─────────

export interface VendorInstance {
	providerId: string;
	vendor: VendorInstanceId;
	label: string;
	/** Explicit credential (OAuth login accounts); registry auth is used when absent. */
	apiKey?: string;
	/** Explicit base URL bound to apiKey (same-origin checks use it). */
	baseUrl?: string;
}

type ModelRegistryLike = UsageContext["modelRegistry"];

function registryProviderIds(registry: ModelRegistryLike | undefined): string[] {
	if (!registry) return [];
	try {
		// pi >= 1.0 exposes registered provider ids directly; older builds and
		// test doubles may only offer the provider map. Both are read defensively.
		const withIds = registry as ModelRegistryLike & { getRegisteredProviderIds?: () => readonly string[] };
		if (typeof withIds.getRegisteredProviderIds === "function") {
			return [...withIds.getRegisteredProviderIds()];
		}
		const withMap = registry as ModelRegistryLike & {
			getProviders?: () => Map<string, unknown> | undefined;
		};
		const providers = typeof withMap.getProviders === "function" ? withMap.getProviders() : undefined;
		return providers ? [...providers.keys()] : [];
	} catch {
		return [];
	}
}

/**
 * Discover vendor instances among the session's registered providers by
 * credential origin. yaml-providers registers ids like
 * yaml-providers registers ids named after the instance (kimiqq), with a
 * -openai suffix on multi-API instances, so origin matching finds them
 * regardless of instance naming. Synchronous; auth is resolved later
 * inside each check so one stalled resolver cannot delay its peers.
 */
export function discoverVendorInstances(ctx: Pick<UsageContext, "modelRegistry"> | undefined): VendorInstance[] {
	if (!ctx) return [];
	const instances: VendorInstance[] = [];
	for (const providerId of registryProviderIds(ctx.modelRegistry)) {
		let origin: string | undefined;
		try {
			origin = httpOrigin(resolveProviderBaseUrl(ctx, providerId) ?? "");
		} catch {
			continue;
		}
		const profile = origin ? VENDOR_BY_ORIGIN.get(origin) : undefined;
		if (!profile) continue;
		instances.push({ providerId, vendor: profile.id, label: instanceLabel(providerId) });
	}
	return instances;
}

// ───────── HTTP ─────────

async function fetchInstanceJson(
	auth: BoundApiKey,
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
	init?: { method?: string; body?: string },
): Promise<unknown> {
	const result = await runIsolatedTask(async (taskSignal) => {
		const response = await fetchSameOriginWithTimeout(url, auth.baseUrl, {
			method: init?.method ?? "GET",
			headers,
			...(init?.body !== undefined ? { body: init.body } : {}),
	}, taskSignal);
		if (!response.ok) {
			await cancelResponseBody(response);
			throw new Error(`HTTP ${response.status}`);
		}
		return readResponseJson(response, taskSignal);
	}, CHECK_TIMEOUT_MS, signal);
	if (result.status === "fulfilled") return result.value;
	if (result.status === "rejected") throw result.reason;
	throw new Error(result.status === "timed_out" ? "Request timed out" : "Request aborted");
}

// ───────── BigModel (open.bigmodel.cn) ─────────

const BIGMODEL_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

function bigModelWindow(entry: Record<string, unknown>): { usedPercent: number; resetAt?: number } | undefined {
	const percentage = jsonNumber(entry.percentage);
	if (percentage === undefined) return undefined;
	const resetMs = jsonNumber(entry.nextResetTime);
	return {
		usedPercent: clampPercent(percentage),
		resetAt: resetMs !== undefined && resetMs > 0 ? Math.round(resetMs / 1000) : undefined,
	};
}

/**
 * Parse the BigModel quota payload: data.level is the tier, data.limits[]
 * TOKENS_LIMIT entries carry percentage plus nextResetTime (epoch ms) and are
 * ordered by reset time - first the 5h window, then the 7d window.
 */
export function parseBigModelQuota(payload: unknown): { windows?: UsageApiWindows; tier?: string } {
	const data = jsonObject(jsonObject(payload)?.data);
	if (!data) return {};
	const entries = (Array.isArray(data.limits) ? data.limits : [])
		.map((value) => jsonObject(value))
		.filter((entry): entry is Record<string, unknown> => entry?.type === "TOKENS_LIMIT")
		.map((entry) => bigModelWindow(entry))
		.filter((entry): entry is { usedPercent: number; resetAt?: number } => entry !== undefined)
		// Live payloads order TOKENS_LIMIT entries arbitrarily (verified
		// 2026-10-24); the earlier reset is the 5h window, the later the 7d one.
		.sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0));
	if (entries.length === 0) return { tier: typeof data.level === "string" && data.level ? data.level : undefined };
	const out: UsageApiWindows = { rolling: entries[0] };
	if (entries[1]) out.weekly = entries[1];
	return { windows: out, tier: typeof data.level === "string" && data.level ? data.level : undefined };
}

// Raw key in Authorization, NO Bearer prefix (verified live by info_widget).
async function checkBigModel(auth: BoundApiKey, signal?: AbortSignal): Promise<{ windows?: UsageApiWindows; tier?: string }> {
	return parseBigModelQuota(await fetchInstanceJson(auth, BIGMODEL_QUOTA_URL, { Authorization: auth.apiKey }, signal));
}

// ───────── Kimi Coding (api.kimi.com) ─────────

async function checkKimiCoding(auth: BoundApiKey, signal?: AbortSignal): Promise<UsageApiWindows | undefined> {
	const payload = await fetchInstanceJson(auth, KIMI_CODING_USAGE_URL, {
		Authorization: `Bearer ${auth.apiKey}`,
		"User-Agent": "KimiCLI/1.6",
	}, signal);
	return parseKimiUsagePayload(payload);
}

// ───────── DeepSeek (api.deepseek.com) ─────────

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Parse DeepSeek's /user/balance. Entry order is unstable (verified live:
 * CNY/USD swap positions between calls), so pick CNY first, then the largest
 * balance; amounts are strings. */
export function parseDeepSeekBalance(payload: unknown): VendorInstanceBalance | undefined {
	const root = jsonObject(payload);
	if (!root) return undefined;
	const infos = (Array.isArray(root.balance_infos) ? root.balance_infos : [])
		.map((value) => jsonObject(value))
		.filter((info): info is Record<string, unknown> => info !== undefined)
		.map((info) => ({ info, amount: jsonNumber(info.total_balance) }))
		.filter((entry): entry is { info: Record<string, unknown>; amount: number } => entry.amount !== undefined);
	const chosen = infos.find(({ info }) => info.currency === "CNY")
		?? infos.reduce<(typeof infos)[number] | undefined>(
			(best, entry) => (!best || entry.amount > best.amount ? entry : best),
			undefined,
		);
	if (!chosen) return undefined;
	const { info } = chosen;
	return {
		amount: chosen.amount,
		currency: typeof info.currency === "string" && info.currency ? info.currency : "CNY",
		granted: jsonNumber(info.granted_balance),
		toppedUp: jsonNumber(info.topped_up_balance),
		available: root.is_available === true,
	};
}

async function checkDeepSeek(auth: BoundApiKey, signal?: AbortSignal): Promise<VendorInstanceBalance | undefined> {
	return parseDeepSeekBalance(
		await fetchInstanceJson(auth, DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${auth.apiKey}` }, signal),
	);
}

// ───────── Antigravity (OAuth login) ─────────

/** Same endpoint fallback order as the pi-antigravity extension's client. */
const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const ANTIGRAVITY_USER_AGENT =
	"antigravity/cli/1.3.7 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

/** A provider key may be a bare token, ya29.*, or a JSON {token|access, projectId} blob. */
export function parseShapedToken(apiKey: string): string {
	const trimmed = apiKey.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { token?: unknown; access?: unknown };
			for (const value of [parsed?.token, parsed?.access]) {
				if (typeof value === "string" && value) return value;
			}
		} catch { /* fall through to raw */ }
	}
	return trimmed;
}

function antigravityTag(bucketId: string): string {
	if (bucketId.startsWith("gemini-argon")) return "argon";
	const head = bucketId.split("-")[0];
	return head === "gemini" ? "gem" : head || "quota";
}

const ANTIGRAVITY_WINDOW_KIND: Record<string, keyof UsageApiWindows> = {
	"5h": "rolling",
	weekly: "weekly",
	monthly: "monthly",
};

/**
 * Parse the retrieveUserQuotaSummary payload: groups of buckets, each bucket a
 * window with a remaining fraction (0..1) and an ISO reset time. Used percent
 * is the complement - Antigravity only reports remaining.
 */
export function parseAntigravityQuota(payload: unknown): VendorWindowGroup[] {
	const root = jsonObject(payload);
	if (!root || !Array.isArray(root.groups)) return [];
	const groups: VendorWindowGroup[] = [];
	for (const value of root.groups) {
		const group = jsonObject(value);
		if (!group || !Array.isArray(group.buckets)) continue;
		const windows: UsageApiWindows = {};
		let firstBucketId = "";
		for (const bucketValue of group.buckets) {
			const bucket = jsonObject(bucketValue);
			if (!bucket) continue;
			const remaining = jsonNumber(bucket.remainingFraction);
			const kind = typeof bucket.window === "string" ? ANTIGRAVITY_WINDOW_KIND[bucket.window] : undefined;
			if (remaining === undefined || !kind) continue;
			firstBucketId ||= typeof bucket.bucketId === "string" ? bucket.bucketId : "";
			const resetAt = typeof bucket.resetTime === "string" ? parseResetAtSeconds(bucket.resetTime) : 0;
			const remainingPercent = clampPercent(remaining * 100);
			windows[kind] = {
				usedPercent: clampPercent(100 - remainingPercent),
				remainingPercent,
				resetAt: resetAt > 0 ? resetAt : undefined,
			};
		}
		if (!windows.rolling && !windows.weekly && !windows.monthly) continue;
		groups.push({
			tag: antigravityTag(firstBucketId),
			label: typeof group.displayName === "string" && group.displayName ? group.displayName : "Quota",
			windows,
		});
	}
	return groups;
}

async function checkAntigravity(auth: BoundApiKey, signal?: AbortSignal): Promise<VendorWindowGroup[]> {
	const token = parseShapedToken(auth.apiKey);
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": ANTIGRAVITY_USER_AGENT,
	};
	let lastError = "no endpoint available";
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const payload = await fetchInstanceJson(
				{ apiKey: token, baseUrl: endpoint },
			`${endpoint}/v1internal:retrieveUserQuotaSummary`,
			headers,
				signal,
				{ method: "POST", body: "{}" },
			);
			const groups = parseAntigravityQuota(payload);
			if (groups.length > 0) return groups;
			lastError = "quota summary returned no groups (paid subscription required?)";
		} catch (error: unknown) {
			if (signal?.aborted) throw error;
			lastError = error instanceof Error ? error.message : "request failed";
		}
	}
	throw new Error(lastError);
}

// ───────── Login accounts (OAuth via pi auth.json) ─────────

const KIMI_LOGIN_BASE_URL = "https://api.kimi.com/coding/";

type CredentialReader = (provider: string) => Promise<StoredCredential | undefined>;

/** Vendor checks for accounts logged in with pi OAuth, independent of the model registry. */
export async function discoverLoginAccounts(
	read: CredentialReader = (provider) => readStoredCredential(provider),
): Promise<VendorInstance[]> {
	const accounts: VendorInstance[] = [];
	const kimiToken = oauthAccessToken(await read("kimi-coding"));
	if (kimiToken) {
		accounts.push({
			providerId: "kimi-coding",
			vendor: "kimi-coding",
			label: "login",
			apiKey: kimiToken,
			baseUrl: KIMI_LOGIN_BASE_URL,
		});
	}
	const antigravityToken = oauthAccessToken(await read("antigravity"));
	if (antigravityToken) {
		accounts.push({
			providerId: "antigravity",
			vendor: "antigravity",
			label: "login",
			apiKey: antigravityToken,
			baseUrl: ANTIGRAVITY_ENDPOINTS[0],
		});
	}
	return accounts;
}

/** Registry-origin instances plus OAuth login accounts; logins relabel matching provider ids. */
export async function discoverAllVendorInstances(
	ctx: Pick<UsageContext, "modelRegistry">,
	read: CredentialReader = (provider) => readStoredCredential(provider),
): Promise<VendorInstance[]> {
	const merged = new Map<string, VendorInstance>();
	for (const instance of discoverVendorInstances(ctx)) merged.set(instance.providerId, instance);
	for (const login of await discoverLoginAccounts(read)) {
		const existing = merged.get(login.providerId);
		merged.set(login.providerId, existing ? { ...existing, ...login } : login);
	}
	return [...merged.values()];
}

// ───────── Unified check ─────────

/**
 * Check one vendor instance. Resolves the instance's own API key, so two
 * instances of the same vendor (two Kimi accounts) are independent.
 * Undefined means no usable auth; the caller drops the instance.
 */
export async function checkVendorInstance(
	instance: VendorInstance,
	ctx: Pick<UsageContext, "modelRegistry"> | undefined,
	signal?: AbortSignal,
): Promise<VendorInstanceUsage | undefined> {
	const resolved = instance.apiKey !== undefined && instance.baseUrl !== undefined
		? { apiKey: instance.apiKey, baseUrl: instance.baseUrl }
		: ctx
			? await resolveBoundProviderAuth(ctx, instance.providerId)
			: undefined;
	// Vendor checks require a concrete key; registry auth may resolve without one.
	const auth: BoundApiKey | undefined = resolved?.apiKey
		? { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, ...(resolved.source !== undefined && { source: resolved.source }) }
		: undefined;
	if (!auth || signal?.aborted) return undefined;

	const base: VendorInstanceUsage = {
		providerId: instance.providerId,
		vendor: instance.vendor,
		label: instance.label,
	};
	try {
		switch (instance.vendor) {
			case "bigmodel": {
				const { windows, tier } = await checkBigModel(auth, signal);
				return { ...base, windows, tier: tier || undefined };
			}
			case "antigravity": {
				const groups = await checkAntigravity(auth, signal);
				return { ...base, windowGroups: groups };
			}
			case "kimi-coding": {
				const windows = await checkKimiCoding(auth, signal);
				return { ...base, windows };
			}
			case "deepseek": {
				const balance = await checkDeepSeek(auth, signal);
				return balance ? { ...base, balance } : { ...base, error: "No balance info in response" };
			}
			case "openrouter": {
				return { ...base, openrouter: await checkOpenRouterUsage(auth, signal) };
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "check failed";
		return { ...base, error: message };
	}
}
