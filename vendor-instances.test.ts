/**
 * Unit tests for vendor-instance discovery, per-vendor checks, and parsing.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkVendorInstance,
	discoverAllVendorInstances,
	discoverLoginAccounts,
	discoverVendorInstances,
	instanceLabel,
	parseAntigravityQuota,
	parseBigModelQuota,
	parseDeepSeekBalance,
	parseShapedToken,
} from "./src/vendor-instances.ts";
import { renderVendorInstanceBalance, renderVendorInstanceWindows, renderVendorWindowGroups, updateFooterStatus } from "./src/render.ts";
import type { UsageContext, VendorInstanceUsage } from "./src/types.ts";

const plain = (_color: string, text: string) => text;

// ───────── BigModel parsing ─────────

const BIGMODEL_FIXTURE = {
	data: {
		level: "max",
		// Live order (2026-10-24): a TIME_LIMIT tool window first, then the 7d
		// TOKENS_LIMIT, then the 5h one - reset-time sorting must reorder them.
		limits: [
			{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 708, remaining: 3292, percentage: 17, nextResetTime: 1793091950998 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 1, nextResetTime: 1793437550983 },
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 9, nextResetTime: 1792853812849 },
		],
	},
};

test("bigmodel: TOKENS_LIMIT entries become rolling then weekly windows", () => {
	const { windows, tier } = parseBigModelQuota(BIGMODEL_FIXTURE);
	assert.equal(tier, "max");
	assert.equal(windows?.rolling?.usedPercent, 9);
	assert.equal(windows?.rolling?.resetAt, 1792853813);
	assert.equal(windows?.weekly?.usedPercent, 1);
	assert.equal(windows?.weekly?.resetAt, 1793437551);
});

test("bigmodel: single window and empty payloads degrade gracefully", () => {
	const single = parseBigModelQuota({ data: { level: "Lite", limits: [{ type: "TOKENS_LIMIT", percentage: 5 }] } });
	assert.equal(single.tier, "Lite");
	assert.equal(single.windows?.rolling?.usedPercent, 5);
	assert.equal(single.windows?.weekly, undefined);
	assert.equal(parseBigModelQuota({ data: { limits: [{ type: "OTHER" }] } }).windows, undefined);
	assert.deepEqual(parseBigModelQuota({}), {});
});

// ───────── DeepSeek parsing ─────────

test("deepseek: balance parses with string amounts, currency default, and availability", () => {
	const balance = parseDeepSeekBalance({
		is_available: true,
		balance_infos: [{ currency: "CNY", total_balance: "40.41", granted_balance: "10.00", topped_up_balance: "30.41" }],
	});
	assert.deepEqual(balance, { amount: 40.41, currency: "CNY", granted: 10, toppedUp: 30.41, available: true });
	assert.equal(parseDeepSeekBalance({ balance_infos: [] }), undefined);
	assert.equal(parseDeepSeekBalance({ balance_infos: [{ currency: "USD" }] }), undefined);
	assert.equal(parseDeepSeekBalance(undefined), undefined);
});

test("deepseek: unstable entry order prefers CNY, else the largest balance", () => {
	const usdFirst = parseDeepSeekBalance({
		is_available: true,
		balance_infos: [
			{ currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
			{ currency: "CNY", total_balance: "73.99", granted_balance: "0.00", topped_up_balance: "73.99" },
		],
	});
	assert.equal(usdFirst?.currency, "CNY");
	assert.equal(usdFirst?.amount, 73.99);
	const noCny = parseDeepSeekBalance({
		is_available: true,
		balance_infos: [
			{ currency: "EUR", total_balance: "1.00" },
			{ currency: "USD", total_balance: "5.00" },
		],
	});
	assert.equal(noCny?.currency, "USD");
	assert.equal(noCny?.amount, 5);
});

// ───────── Labels and discovery ─────────

test("instance labels come from the registration id", () => {
	assert.equal(instanceLabel("kimiqq"), "kimiqq");
	assert.equal(instanceLabel("globalaijc-openai"), "globalaijc");
	assert.equal(instanceLabel("dotc-bigmodeltoken-openai-completions"), "bigmodeltoken");
	assert.equal(instanceLabel("dotc-kimiqq-anthropic-messages"), "kimiqq");
	assert.equal(instanceLabel("plain-provider"), "plain-provider");
});

function mockRegistry(providers: Record<string, { baseUrl: string }>) {
	return {
		getRegisteredProviderIds: () => Object.keys(providers),
		getProvider: (id: string) => providers[id],
		getProviderAuth: async (id: string) => (providers[id] ? { auth: { apiKey: `key-${id}` }, source: "registration" } : undefined),
	} as unknown as UsageContext["modelRegistry"];
}

const REGISTRY = mockRegistry({
	"kimiqq": { baseUrl: "https://api.kimi.com/coding/" },
	"kimitoken": { baseUrl: "https://api.kimi.com/coding/" },
	"bigmodeltoken": { baseUrl: "https://open.bigmodel.cn/api/anthropic" },
	"deepseektoken": { baseUrl: "https://api.deepseek.com/anthropic" },
	"openrouter": { baseUrl: "https://openrouter.ai/api" },
	"globalaijc-openai": { baseUrl: "https://globalai.vip" },
});

test("discovery matches credential origins and skips unknown vendors", () => {
	assert.deepEqual(discoverVendorInstances({ modelRegistry: REGISTRY }), [
		{ providerId: "kimiqq", vendor: "kimi-coding", label: "kimiqq" },
		{ providerId: "kimitoken", vendor: "kimi-coding", label: "kimitoken" },
		{ providerId: "bigmodeltoken", vendor: "bigmodel", label: "bigmodeltoken" },
		{ providerId: "deepseektoken", vendor: "deepseek", label: "deepseektoken" },
		{ providerId: "openrouter", vendor: "openrouter", label: "openrouter" },
	]);
	assert.deepEqual(discoverVendorInstances(undefined as unknown as UsageContext), []);
});

// ───────── Checks (mocked fetch) ─────────

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

async function withMockedFetch<T>(
	payloads: Record<string, unknown>,
	run: () => Promise<T>,
): Promise<{ captured: CapturedRequest[]; result: T }> {
	const captured: CapturedRequest[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		captured.push({ url: href, headers: (init?.headers ?? {}) as Record<string, string> });
		for (const [prefix, payload] of Object.entries(payloads)) {
			if (href.startsWith(prefix)) return new Response(JSON.stringify(payload), { status: 200 });
		}
		return new Response("no fixture", { status: 404 });
	}) as typeof fetch;
	try {
		const result = await run();
		return { captured, result };
	} finally {
		globalThis.fetch = realFetch;
	}
}

test("bigmodel check sends the raw key without Bearer and parses windows", async () => {
	const { captured, result } = await withMockedFetch({ "https://open.bigmodel.cn/api/monitor/usage/quota/limit": BIGMODEL_FIXTURE }, () =>
		checkVendorInstance(
			{ providerId: "bigmodeltoken", vendor: "bigmodel", label: "bigmodeltoken" },
			{ modelRegistry: REGISTRY },
		));
	const usage = result;
	assert.equal(captured[0].headers.Authorization, "key-bigmodeltoken");
	assert.equal(usage?.windows?.rolling?.usedPercent, 9);
	assert.equal(usage?.tier, "max");
});

test("kimi check sends Bearer plus KimiCLI user agent per account", async () => {
	const { captured, result } = await withMockedFetch(
		{ "https://api.kimi.com/coding/v1/usages": { usage: { limit: "100", used: "25", remaining: "75", resetTime: "2026-10-25T12:00:00Z" } } },
		() => checkVendorInstance(
			{ providerId: "kimiqq", vendor: "kimi-coding", label: "kimiqq" },
			{ modelRegistry: REGISTRY },
		));
	const usage = result;
	assert.equal(captured[0].headers.Authorization, "Bearer key-kimiqq");
	assert.equal(captured[0].headers["User-Agent"], "KimiCLI/1.6");
	assert.equal(usage?.windows?.weekly?.usedPercent, 25);
});

test("deepseek check parses balance and flags unavailable accounts", async () => {
	const { result } = await withMockedFetch(
		{ "https://api.deepseek.com/user/balance": { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.5" }] } },
		() => checkVendorInstance(
			{ providerId: "deepseektoken", vendor: "deepseek", label: "deepseektoken" },
			{ modelRegistry: REGISTRY },
		));
	const usage = result;
	assert.equal(usage?.balance?.amount, 0.5);
	assert.equal(usage?.balance?.available, false);
});

test("openrouter instance reuses the accounting check; failures become error entries", async () => {
	const { result } = await withMockedFetch(
		{
			"https://openrouter.ai/api/v1/key": { data: { usage_daily: 3.42, limit: 25, limit_remaining: 18.7 } },
			"https://openrouter.ai/api/v1/credits": { data: { total_credits: 50, total_usage: 7.9 } },
		},
		() => checkVendorInstance(
			{ providerId: "openrouter", vendor: "openrouter", label: "openrouter" },
			{ modelRegistry: REGISTRY },
		));
	const usage = result;
	assert.equal(usage?.openrouter?.dailySpend, 3.42);
	assert.equal(usage?.openrouter?.creditRemaining, 42.1);
});

test("http failures and missing auth degrade to error or undefined", async () => {
	const failing = (await withMockedFetch({}, () => checkVendorInstance(
		{ providerId: "kimiqq", vendor: "kimi-coding", label: "kimiqq" },
		{ modelRegistry: REGISTRY },
	))).result;
	assert.equal(failing?.error, "HTTP 404");
	const noAuth = await checkVendorInstance(
		{ providerId: "dotc-unknown-anthropic-messages", vendor: "kimi-coding", label: "unknown" },
		{ modelRegistry: REGISTRY },
	);
	assert.equal(noAuth, undefined);
});

// ───────── Rendering ─────────

function windowInstance(overrides: Partial<VendorInstanceUsage> = {}): VendorInstanceUsage {
	return {
		providerId: "kimiqq",
		vendor: "kimi-coding",
		label: "kimiqq",
		windows: {
			rolling: { usedPercent: 32, resetAt: Math.floor(Date.now() / 1000) + 3600 },
			monthly: { usedPercent: 45, resetAt: Math.floor(Date.now() / 1000) + 86400 },
		},
		...overrides,
	};
}

test("window instance section renders reported windows only", () => {
	const lines = renderVendorInstanceWindows(windowInstance(), plain, false).join("\n");
	assert.match(lines, /Kimi Coding — kimiqq/);
	assert.match(lines, /5h/);
	assert.match(lines, /32%/);
	assert.match(lines, /month/);
	assert.doesNotMatch(lines, /week/);
});

test("balance instance section renders money detail", () => {
	const lines = renderVendorInstanceBalance(
		{
			providerId: "deepseektoken",
			vendor: "deepseek",
			label: "deepseektoken",
			balance: { amount: 40.41, currency: "CNY", granted: 10, toppedUp: 30.41, available: true },
		},
		plain,
	).join("\n");
	assert.match(lines, /DeepSeek — deepseektoken/);
	assert.match(lines, /balance: ¥40\.41/);
	assert.match(lines, /grant ¥10\.00/);
	assert.match(lines, /top-up ¥30\.41/);
});

test("footer disambiguates same-vendor instances and keeps singles short", () => {
	let status: string | undefined;
	updateFooterStatus(
		{
			hasUI: true,
			ui: {
				theme: { fg: plain } as never,
				setStatus: (_id: string, value?: string) => { status = value; },
			},
		} as unknown as UsageContext,
		{
			subscriptions: [],
			instances: [
				windowInstance(),
				windowInstance({ providerId: "kimitoken", label: "kimitoken" }),
				{
					providerId: "bigmodeltoken",
					vendor: "bigmodel",
					label: "bigmodeltoken",
					windows: { rolling: { usedPercent: 15, resetAt: Math.floor(Date.now() / 1000) + 1800 } },
				},
				{
					providerId: "deepseektoken",
					vendor: "deepseek",
					label: "deepseektoken",
					balance: { amount: 40.41, currency: "CNY", available: true },
				},
			],
		},
	);
	assert.ok(status);
	assert.match(status, /Kimi\(kimiqq\):32%/);
	assert.match(status, /Kimi\(kimitoken\):32%/);
	assert.match(status, /GLM:15%/);
	assert.match(status, /DS:¥40\.41/);
});

// ───────── Antigravity (OAuth login) ─────────

const ANTIGRAVITY_FIXTURE = {
	groups: [
		{
			displayName: "Gemini Models",
			buckets: [
				{ bucketId: "gemini-weekly", window: "weekly", resetTime: "2099-10-30T23:41:31Z", remainingFraction: 0.99406767 },
				{ bucketId: "gemini-5h", window: "5h", resetTime: "2099-10-24T15:24:26Z", remainingFraction: 0.998995 },
			],
		},
		{
			displayName: "Claude and GPT models",
			buckets: [
				{ bucketId: "3p-weekly", window: "weekly", resetTime: "2099-10-28T10:32:51Z", remainingFraction: 0 },
				{ bucketId: "3p-5h", window: "5h", resetTime: "2099-10-24T19:36:50Z", remainingFraction: 1 },
			],
		},
		{
			displayName: "Gemini 4 Argon",
			buckets: [
				{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", resetTime: "2099-10-31T07:51:44Z", remainingFraction: 1 },
			],
		},
	],
};

test("antigravity: quota summary parses into tagged window groups", () => {
	const groups = parseAntigravityQuota(ANTIGRAVITY_FIXTURE);
	assert.equal(groups.length, 3);
	const [gemini, thirdParty, argon] = groups;
	assert.deepEqual([gemini.tag, gemini.label], ["gem", "Gemini Models"]);
	assert.equal(gemini.windows.rolling?.remainingPercent, 99.8995);
	assert.ok(Math.abs((gemini.windows.rolling?.usedPercent ?? 0) - 0.1005) < 1e-9);
	assert.ok(Math.abs((gemini.windows.weekly?.usedPercent ?? 0) - 0.593233) < 1e-9);
	assert.deepEqual([thirdParty.tag, thirdParty.windows.weekly?.usedPercent, thirdParty.windows.weekly?.remainingPercent], ["3p", 100, 0]);
	assert.equal(thirdParty.windows.rolling?.usedPercent, 0);
	assert.equal(argon.tag, "argon");
	assert.equal(argon.windows.weekly?.usedPercent, 0);
	assert.deepEqual(parseAntigravityQuota({}), []);
	assert.deepEqual(parseAntigravityQuota({ groups: [{ displayName: "x", buckets: [{ bucketId: "y" }] }] }), []);
});

test("antigravity: shaped tokens unwrap JSON and ya29 forms", () => {
	assert.equal(parseShapedToken('{"token":"abc","projectId":"p"}'), "abc");
	assert.equal(parseShapedToken('{"access":"xyz"}'), "xyz");
	assert.equal(parseShapedToken("ya29.raw-token"), "ya29.raw-token");
	assert.equal(parseShapedToken("{broken"), "{broken");
});

test("antigravity check posts the quota RPC and maps groups", async () => {
	const { captured, result } = await withMockedFetch(
		{ "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": ANTIGRAVITY_FIXTURE },
		() => checkVendorInstance(
			{ providerId: "antigravity", vendor: "antigravity", label: "login", apiKey: "ya29.test", baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
			undefined,
		),
	);
	const usage = result;
	assert.equal(captured.length, 1);
	assert.equal(captured[0].headers.Authorization, "Bearer ya29.test");
	assert.match(captured[0].url, /retrieveUserQuotaSummary$/);
	assert.equal(usage?.windowGroups?.length, 3);
});

// ───────── Login accounts ─────────

function loginCredential(overrides: Record<string, unknown> = {}): { type: "oauth"; access: string; refresh: string; expires: number } {
	// expires is milliseconds since epoch (compared against Date.now()).
	return { type: "oauth", access: "tok", refresh: "ref", expires: Date.now() + 3_600_000, ...overrides };
}

test("login accounts come from stored OAuth credentials; expired tokens are skipped", async () => {
	const accounts = await discoverLoginAccounts(async (provider) => {
		if (provider === "kimi-coding") return loginCredential({ access: "kimi-tok" });
		if (provider === "antigravity") return loginCredential({ access: "ag-tok", expires: 1000 });
		return undefined;
	});
	assert.deepEqual(accounts, [
		{ providerId: "kimi-coding", vendor: "kimi-coding", label: "login", apiKey: "kimi-tok", baseUrl: "https://api.kimi.com/coding/" },
	]);
});

test("discovery merges registry instances with login accounts by provider id", async () => {
	const registry = mockRegistry({
		kimiqq: { baseUrl: "https://api.kimi.com/coding/" },
		antigravity: { baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
	});
	const merged = await discoverAllVendorInstances({ modelRegistry: registry }, async (provider) => {
		if (provider === "kimi-coding") return loginCredential({ access: "kimi-tok" });
		if (provider === "antigravity") return loginCredential({ access: "ag-tok" });
		return undefined;
	});
	assert.deepEqual(merged, [
		{ providerId: "kimiqq", vendor: "kimi-coding", label: "kimiqq" },
		{ providerId: "antigravity", vendor: "antigravity", label: "login", apiKey: "ag-tok", baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
		{ providerId: "kimi-coding", vendor: "kimi-coding", label: "login", apiKey: "kimi-tok", baseUrl: "https://api.kimi.com/coding/" },
	]);
});

test("antigravity window groups render per group and surface exhausted pools in the footer", () => {
	const usage: VendorInstanceUsage = {
		providerId: "antigravity",
		vendor: "antigravity",
		label: "login",
		windowGroups: parseAntigravityQuota(ANTIGRAVITY_FIXTURE),
	};
	const report = renderVendorWindowGroups(usage, plain, false).join("\n");
	assert.match(report, /Antigravity — login/);
	assert.match(report, /gem 5h/);
	assert.match(report, /3p week/);
	assert.match(report, /100%/);
	assert.match(report, /argon week/);

	let status: string | undefined;
	updateFooterStatus(
		{
			hasUI: true,
			ui: {
				theme: { fg: plain } as never,
				setStatus: (_id: string, value?: string) => { status = value; },
			},
		} as unknown as UsageContext,
		{ subscriptions: [], instances: [usage] },
	);
	assert.ok(status);
	assert.match(status, /AG:0%r/);
	assert.match(status, /1%w/);
	assert.match(status, /3p: 100%w/);
});
