/**
 * ClinePass usage tracking tests for pi-usage.
 * Run with: npm test
 *
 * Covers the piu-clinepass epic: quota normalization, provider registration
 * and alias policy, credential reuse and origin validation, statusline and
 * report presentation, failure-path and security hardening, and public-path
 * wiring (adapter lookup -> auth -> origin guard -> endpoint -> normalizer).
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CLINEPASS_USAGE_LIMITS_URL } from "./src/config.ts";
import {
	CLINEPASS_PROVIDER,
	parseClinePassUsagePayload,
} from "./src/clinepass.ts";
import {
	checkSubscriptionProviderUsage,
	checkSubscriptionUsageApi,
	getSubscriptionAuth,
	parseSubscriptionUsageHeaders,
	type SubscriptionProviderConfig,
} from "./src/subscription-probe.ts";
import {
	getSubscriptionProviderConfig,
	SUBSCRIPTION_PROVIDERS,
} from "./src/subscriptions.ts";
import {
	buildStartupUsageMessage,
	renderSubscriptionWindows,
	updateFooterStatus,
} from "./src/render.ts";
import type { BoundApiKey, UsageContext } from "./src/types.ts";

const realFetch = globalThis.fetch;

/** Plain formatter used where color output is irrelevant. */
const fmt = (_color: string, text: string) => text;

const OFFICIAL_BASE = "https://api.cline.bot/api/v1";
const API_KEY_AUTH: BoundApiKey = { apiKey: "test-cline-key", baseUrl: OFFICIAL_BASE, source: "test" };
const OAUTH_AUTH: BoundApiKey = { apiKey: "workos:eyJveHl0ZXN0", baseUrl: OFFICIAL_BASE, source: "test-oauth" };

function clinePassConfig(): SubscriptionProviderConfig {
	const config = getSubscriptionProviderConfig(CLINEPASS_PROVIDER);
	assert.ok(config);
	return config;
}

function mockRegistry(auth: BoundApiKey | undefined, models: Array<{ id: string; baseUrl: string }> = []) {
	return {
		getProviderAuth: async (provider: string) => provider === CLINEPASS_PROVIDER && auth
			? { auth: { apiKey: auth.apiKey, baseUrl: auth.baseUrl }, source: auth.source ?? "test" }
			: undefined,
		getProvider: (provider: string) => provider === CLINEPASS_PROVIDER
			? {
				baseUrl: auth?.baseUrl,
				getModels: () => models.map((model) => ({
					id: model.id,
					api: "openai-completions",
					baseUrl: model.baseUrl,
					cost: { input: 1, output: 1 },
				})),
			}
			: undefined,
	};
}

function mockCtx(auth: BoundApiKey | undefined, models: Array<{ id: string; baseUrl: string }> = []) {
	return { modelRegistry: mockRegistry(auth, models) } as unknown as Pick<UsageContext, "modelRegistry">;
}

function fullCtx() {
	return {
		hasUI: true,
		cwd: "/tmp",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWidget: () => {},
			setStatus: (_id: string, _status: string | undefined) => {},
			notify: () => {},
		},
		modelRegistry: mockRegistry(API_KEY_AUTH),
		isProjectTrusted: () => false,
	} as unknown as UsageContext;
}

function envelope(limits: unknown) {
	return JSON.stringify({ success: true, data: { limits } });
}

function completeLimits() {
	return [
		{ type: "monthly", percentUsed: 6, resetsAt: "2026-08-31T15:33:55Z" },
		{ type: "five_hour", percentUsed: 12.5 },
		{ type: "weekly", percentUsed: 24, resetsAt: "2026-08-08T15:33:55Z" },
	];
}

// ───────── Normalizer ─────────

describe("parseClinePassUsagePayload", () => {
	it("maps a complete reordered envelope to rolling/weekly/monthly windows", () => {
		const result = parseClinePassUsagePayload(JSON.parse(envelope(completeLimits())));
		assert.ok(result?.rolling);
		assert.ok(result?.weekly);
		assert.ok(result?.monthly);
		assert.equal(result?.rolling?.usedPercent, 12.5);
		assert.equal(result?.rolling?.remainingPercent, 87.5);
		assert.equal(result?.rolling?.resetAt, undefined);
		assert.equal(result?.weekly?.usedPercent, 24);
		assert.equal(result?.weekly?.remainingPercent, 76);
		assert.ok((result?.weekly?.resetAt ?? 0) > 0);
		assert.equal(result?.monthly?.usedPercent, 6);
		assert.equal(result?.monthly?.remainingPercent, 94);
		assert.ok((result?.monthly?.resetAt ?? 0) > 0);
	});

	it("accepts a bare limits object without the API envelope", () => {
		const result = parseClinePassUsagePayload({ limits: [{ type: "weekly", percentUsed: 10 }] });
		assert.equal(result?.weekly?.usedPercent, 10);
		assert.equal(result?.rolling, undefined);
		assert.equal(result?.monthly, undefined);
	});

	it("supports partial responses with only the available windows", () => {
		const result = parseClinePassUsagePayload(JSON.parse(envelope([{ type: "weekly", percentUsed: 3 }])));
		assert.equal(result?.weekly?.usedPercent, 3);
		assert.equal(result?.rolling, undefined);
		assert.equal(result?.monthly, undefined);
	});

	it("represents zero use as 0% used with 100% remaining", () => {
		const result = parseClinePassUsagePayload(JSON.parse(envelope([{ type: "five_hour", percentUsed: 0 }])));
		assert.equal(result?.rolling?.usedPercent, 0);
		assert.equal(result?.rolling?.remainingPercent, 100);
	});

	it("keeps exhausted and over-limit values at the 100% ceiling", () => {
		const even = parseClinePassUsagePayload(JSON.parse(envelope([{ type: "weekly", percentUsed: 100 }])));
		assert.equal(even?.weekly?.usedPercent, 100);
		assert.equal(even?.weekly?.remainingPercent, 0);
		const over = parseClinePassUsagePayload(JSON.parse(envelope([{ type: "weekly", percentUsed: 142.7 }])));
		assert.equal(over?.weekly?.usedPercent, 100);
		assert.equal(over?.weekly?.remainingPercent, 0);
	});

	it("returns undefined for a null plan, failed envelope, or missing limits", () => {
		assert.equal(parseClinePassUsagePayload({ success: true, data: null }), undefined);
		assert.equal(parseClinePassUsagePayload({ success: false, error: "bad key" }), undefined);
		assert.equal(parseClinePassUsagePayload({ success: true, data: {} }), undefined);
		assert.equal(parseClinePassUsagePayload({}), undefined);
		assert.equal(parseClinePassUsagePayload(undefined), undefined);
		assert.equal(parseClinePassUsagePayload(null), undefined);
		assert.equal(parseClinePassUsagePayload([]), undefined);
	});

	it("skips malformed rows and fails safely when none remain", () => {
		assert.equal(
			parseClinePassUsagePayload({
				limits: [
					{ type: "weekly", percentUsed: "abc" },
					{ type: "monthly", percentUsed: -5 },
					{ type: "five_hour" },
					{ percentUsed: 10 },
					{ type: 42, percentUsed: 10 },
					null,
				],
			}),
			undefined,
		);
	});

	it("ignores unknown future quota types while keeping known windows", () => {
		const result = parseClinePassUsagePayload({
			limits: [
				{ type: "yearly", percentUsed: 99, resetsAt: "2027-01-01T00:00:00Z" },
				{ type: "weekly", percentUsed: 11 },
			],
		});
		assert.equal(result?.weekly?.usedPercent, 11);
		assert.equal(parseClinePassUsagePayload({ limits: [{ type: "yearly", percentUsed: 99 }] }), undefined);
	});

	it("lets the first valid row win on duplicates", () => {
		const result = parseClinePassUsagePayload({
			limits: [
				{ type: "weekly", percentUsed: 20 },
				{ type: "weekly", percentUsed: 80 },
			],
		});
		assert.equal(result?.weekly?.usedPercent, 20);
	});

	it("keeps the window when the reset timestamp is invalid", () => {
		const result = parseClinePassUsagePayload({
			limits: [{ type: "monthly", percentUsed: 9, resetsAt: "not-a-date" }],
		});
		assert.equal(result?.monthly?.usedPercent, 9);
		assert.equal(result?.monthly?.resetAt, undefined);
	});
});

// ───────── Registration and alias policy ─────────

describe("ClinePass provider registration", () => {
	it("registers the canonical clinepass adapter with the official usage endpoint", () => {
		const config = clinePassConfig();
		assert.equal(config.provider, "clinepass");
		assert.equal(config.label, "ClinePass");
		assert.equal(config.usageApi?.url, "https://api.cline.bot/api/v1/users/me/plan/usage-limits");
		assert.equal(config.usageApi?.url, CLINEPASS_USAGE_LIMITS_URL);
		assert.ok(SUBSCRIPTION_PROVIDERS.some((entry) => entry.provider === "clinepass"));
	});

	it("pins the official Cline API origin and no other", () => {
		assert.equal(new URL(CLINEPASS_USAGE_LIMITS_URL).origin, "https://api.cline.bot");
	});

	it("does not register a cline-pass compatibility alias", () => {
		assert.equal(getSubscriptionProviderConfig("cline-pass"), undefined);
	});
});

// ───────── Transport, auth reuse, and origin validation ─────────

describe("checkSubscriptionUsageApi for ClinePass", () => {
	afterEach(() => { globalThis.fetch = realFetch; });

	it("sends Bearer auth to the official endpoint without redirects", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		globalThis.fetch = async (url, init) => {
			seenUrl = String(url);
			seenInit = init;
			return new Response(envelope(completeLimits()));
		};
		const result = await checkSubscriptionUsageApi(clinePassConfig(), API_KEY_AUTH);
		assert.equal(result.success, true);
		assert.equal(seenUrl, CLINEPASS_USAGE_LIMITS_URL);
		assert.equal(seenInit?.headers && (seenInit.headers as Record<string, string>)["Authorization"], "Bearer test-cline-key");
		assert.equal(seenInit?.redirect, "error");
	});

	it("reuses WorkOS OAuth access tokens through the same Bearer path", async () => {
		let authorization = "";
		globalThis.fetch = async (_url, init) => {
			authorization = (init?.headers as Record<string, string>)["Authorization"] ?? "";
			return new Response(envelope([{ type: "weekly", percentUsed: 1 }]));
		};
		const result = await checkSubscriptionUsageApi(clinePassConfig(), OAUTH_AUTH);
		assert.equal(result.success, true);
		assert.equal(authorization, "Bearer workos:eyJveHl0ZXN0");
	});

	it("refuses custom/proxy credential origins before any fetch", async () => {
		let requests = 0;
		globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
		const result = await checkSubscriptionUsageApi(
			clinePassConfig(),
			{ apiKey: "test-cline-key", baseUrl: "https://proxy.example/api/v1", source: "test" },
		);
		assert.equal(result.success, false);
		assert.equal(requests, 0);
		if (!result.success) assert.match(result.error, /Refusing credentialed request/);
	});

	for (const [status, body] of [[401, "Unauthorized"], [403, "not subscribed"], [404, "not found"], [429, "rate limited"], [500, "bad gateway"]] as const) {
		it(`fails safely on HTTP ${status} without leaking the credential`, async () => {
			globalThis.fetch = async () => new Response(body, { status });
			const result = await checkSubscriptionUsageApi(clinePassConfig(), API_KEY_AUTH);
			assert.equal(result.success, false);
			if (!result.success) {
				assert.match(result.error, /ClinePass usage API/);
				assert.doesNotMatch(result.error, /test-cline-key/);
			}
		});
	}

	it("fails safely on invalid JSON, failed envelopes, and null plans", async () => {
		for (const body of ["not json", JSON.stringify({ success: false, error: "bad key" }), JSON.stringify({ success: true, data: null }), JSON.stringify({ success: true, data: {} })]) {
			globalThis.fetch = async () => new Response(body);
			const result = await checkSubscriptionUsageApi(clinePassConfig(), API_KEY_AUTH);
			assert.equal(result.success, false);
			if (!result.success) assert.doesNotMatch(result.error, /test-cline-key/);
		}
	});

	it("does not fetch with an already-aborted signal", async () => {
		let requests = 0;
		globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
		const controller = new AbortController();
		controller.abort();
		const result = await checkSubscriptionUsageApi(clinePassConfig(), API_KEY_AUTH, controller.signal);
		assert.equal(result.success, false);
		assert.equal(requests, 0);
	});
});

// ───────── Public-path wiring ─────────

describe("checkSubscriptionProviderUsage for ClinePass", () => {
	afterEach(() => { globalThis.fetch = realFetch; });

	it("resolves pi auth and normalizes all three quota windows", async () => {
		globalThis.fetch = async () => new Response(envelope(completeLimits()));
		const usage = await checkSubscriptionProviderUsage(mockCtx(API_KEY_AUTH), clinePassConfig(), await getSubscriptionAuth(mockCtx(API_KEY_AUTH), clinePassConfig()));
		assert.equal(usage.provider, "clinepass");
		assert.equal(usage.status, "available");
		assert.equal(usage.available, true);
		assert.equal(usage.source, "usage_api");
		assert.equal(usage.quotaSource, "usage api");
		assert.equal(usage.rolling?.usedPercent, 12.5);
		assert.equal(usage.weekly?.usedPercent, 24);
		assert.equal(usage.monthly?.usedPercent, 6);
	});

	it("marks exhausted quota as rate limited", async () => {
		globalThis.fetch = async () => new Response(envelope([{ type: "weekly", percentUsed: 100 }]));
		const usage = await checkSubscriptionProviderUsage(mockCtx(API_KEY_AUTH), clinePassConfig(), await getSubscriptionAuth(mockCtx(API_KEY_AUTH), clinePassConfig()));
		assert.equal(usage.status, "rate_limited");
		assert.equal(usage.available, false);
	});

	it("reports no_key when pi has no ClinePass credential", async () => {
		let requests = 0;
		globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
		const usage = await checkSubscriptionProviderUsage(mockCtx(undefined), clinePassConfig(), await getSubscriptionAuth(mockCtx(undefined), clinePassConfig()));
		assert.equal(usage.status, "no_key");
		assert.equal(requests, 0);
	});

	it("falls back to probing when the usage endpoint fails and models exist", async () => {
		globalThis.fetch = async (url) => {
			if (String(url).includes("usage-limits")) return new Response("bad gateway", { status: 500 });
			return new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429 });
		};
		const usage = await checkSubscriptionProviderUsage(
			mockCtx(API_KEY_AUTH, [{ id: "cline-pass/mimo-v2.5", baseUrl: OFFICIAL_BASE }]),
			clinePassConfig(),
			await getSubscriptionAuth(mockCtx(API_KEY_AUTH), clinePassConfig()),
		);
		assert.equal(usage.status, "rate_limited");
		assert.equal(usage.rateLimitedModel, "cline-pass/mimo-v2.5");
	});

	it("merges usage-endpoint and probe errors when both fail with no models", async () => {
		globalThis.fetch = async () => new Response("bad gateway", { status: 500 });
		const usage = await checkSubscriptionProviderUsage(mockCtx(API_KEY_AUTH), clinePassConfig(), await getSubscriptionAuth(mockCtx(API_KEY_AUTH), clinePassConfig()));
		assert.equal(usage.status, "error");
		assert.match(usage.errorMessage ?? "", /fallback probe/);
		assert.doesNotMatch(usage.errorMessage ?? "", /test-cline-key/);
	});
});

// ───────── Presentation and lifecycle ─────────

describe("ClinePass presentation", () => {
	const usage = {
		provider: "clinepass",
		label: "ClinePass",
		shortLabel: "ClinePass",
		available: true,
		status: "available" as const,
		rolling: { usedPercent: 42, remainingPercent: 58 },
		weekly: { usedPercent: 31, remainingPercent: 69 },
		monthly: { usedPercent: 18, remainingPercent: 82 },
	};

	it("renders rolling/week/month buckets in the detailed report", () => {
		const lines = renderSubscriptionWindows(usage, fmt, false).join("\n");
		assert.match(lines, /ClinePass/);
		assert.match(lines, /rolling/);
		assert.match(lines, /week/);
		assert.match(lines, /month/);
		assert.match(lines, /42%/);
	});

	it("includes ClinePass in the startup report and footer status", () => {
		const report = buildStartupUsageMessage({ subscriptions: [usage] }, false);
		assert.match(report, /ClinePass/);
		const statuses: Array<string | undefined> = [];
		const ctx = { ...fullCtx(), ui: { ...fullCtx().ui, setStatus: (_id: string, status: string | undefined) => { statuses.push(status); } } } as unknown as UsageContext;
		updateFooterStatus(ctx, { subscriptions: [usage] });
		assert.ok(statuses.some((status) => status?.includes("ClinePass")));
	});

	it("parses passive ClinePass quota headers for lifecycle updates", () => {
		const parsed = parseSubscriptionUsageHeaders(
			clinePassConfig(),
			{ "x-clinepass-rolling-used-percent": "42" },
			200,
			"cline-pass/mimo-v2.5",
		);
		assert.ok(parsed);
		assert.equal(parsed.usage.provider, "clinepass");
		assert.equal(parsed.usage.rolling?.usedPercent, 42);
	});
});
