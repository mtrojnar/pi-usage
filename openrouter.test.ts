import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CHECK_TIMEOUT_MS } from "./src/config.ts";
import { checkOpenRouterUsage, getOpenRouterAuth, openRouterResetAt, parseOpenRouterCredits, parseOpenRouterKey } from "./src/openrouter.ts";
import { buildStartupUsageMessage, formatMoney, openRouterFooter, renderOpenRouter } from "./src/render.ts";
import type { UsageContext } from "./src/types.ts";

const plain = (_color: string, text: string) => text;
const now = Date.UTC(2026, 0, 31, 12);
const key = { data: { usage_daily: 3.42, limit: 25, limit_remaining: 18.7, usage: 999, limit_reset: "monthly" } };

test("OpenRouter uses authoritative budget remaining, not lifetime spend", () => {
	const usage = parseOpenRouterKey(key, now)!;
	assert.equal(usage.dailySpend, 3.42);
	assert.ok(Math.abs(usage.budget!.used! - 6.3) < 1e-10);
	assert.equal(usage.budget!.limit, 25);
	assert.equal(usage.budget!.resetAt, Date.UTC(2026, 1, 1) / 1000);
	assert.equal(usage.dailyResetAt, Date.UTC(2026, 1, 1) / 1000);
});

test("calendar reset boundaries and unknown periods", () => {
	assert.equal(openRouterResetAt("weekly", Date.UTC(2026, 1, 1, 23)), Date.UTC(2026, 1, 2) / 1000);
	assert.equal(openRouterResetAt("weekly", Date.UTC(2026, 1, 2)), Date.UTC(2026, 1, 9) / 1000);
	assert.equal(openRouterResetAt("monthly", Date.UTC(2024, 1, 29)), Date.UTC(2024, 2, 1) / 1000);
	assert.equal(openRouterResetAt("monthly", Date.UTC(2026, 11, 31)), Date.UTC(2027, 0, 1) / 1000);
	for (const period of [null, undefined, "yearly", 12]) assert.equal(openRouterResetAt(period, now), undefined);
});

test("uncapped, partial, zero, exhausted, and malformed budgets", () => {
	assert.equal(parseOpenRouterKey({ data: { usage_daily: 0, limit: null } })?.budget, undefined);
	assert.deepEqual(parseOpenRouterKey({ data: { limit: 25 } })?.budget, { limit: 25, used: undefined, resetAt: undefined });
	assert.equal(parseOpenRouterKey({ data: { limit: 0, limit_remaining: 0 } })?.budget?.used, 0);
	assert.equal(parseOpenRouterKey({ data: { limit: 25, limit_remaining: -2 } })?.budget?.used, 27);
	assert.equal(parseOpenRouterKey({ data: { limit: 25, limit_remaining: 26 } })?.budget?.used, undefined);
	for (const bad of [null, {}, { data: [] }, { data: { usage_daily: "3" } }, { data: { limit: -1 } }, { data: { usage_daily: Infinity } }]) {
		assert.equal(parseOpenRouterKey(bad), undefined);
	}
	assert.equal(parseOpenRouterCredits({ data: { total_credits: 50, total_usage: 7.9 } }), 42.1);
	assert.equal(parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 1 } }), -1);
	assert.equal(parseOpenRouterCredits({ data: { total_credits: 50 } }), undefined);
});

test("compact accounting footer and widget bar only for complete budget", () => {
	const usage = { dailySpend: 3.42, budget: { used: 6.3, limit: 25 }, creditRemaining: 42.1 };
	assert.equal(openRouterFooter(usage, plain), "$3.42/d,$6.30/$25,$42.10 left");
	assert.equal(openRouterFooter({ dailySpend: 0.001 }, plain), "<$0.01/d");
	assert.equal(formatMoney(0), "$0.00");
	assert.equal(formatMoney(-0.001), "-<$0.01");
	assert.equal(formatMoney(-1), "-$1.00");
	assert.match(renderOpenRouter(usage, plain).join("\n"), /key: [█░]+ \$6.30\/\$25/);
	assert.doesNotMatch(renderOpenRouter({ budget: { limit: 25 }, creditRemaining: 42 }, plain).join("\n"), /[█░]/);
	assert.match(buildStartupUsageMessage({ openrouter: usage, subscriptions: [] }, false), /OpenRouter/);
	assert.equal(openRouterFooter({ dailySpend: 3, dailyResetAt: 1, budget: { used: 5, limit: 25, resetAt: 1 } }, plain), "--/d,--/$25");
	assert.doesNotMatch(renderOpenRouter({ budget: { used: 5, limit: 25, resetAt: 1 } }, plain).join("\n"), /[█░]/);
	const colored = openRouterFooter({ budget: { limit: 0, used: 0 }, creditRemaining: 0 }, (color, text) => `<${color}>${text}</${color}>`);
	assert.match(colored, /<error>\$0.00\/\$0<\/error>/);
});

test("read-only requests, optional credit permission, invalid JSON, and origin binding", async (t) => {
	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		calls.push(url);
		assert.equal(init.redirect, "error");
		assert.equal(init.body, undefined);
		assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
		return url.endsWith("/key") ? Response.json(key) : new Response("forbidden", { status: 403 });
	});
	const auth = { apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1" };
	const usage = await checkOpenRouterUsage(auth);
	assert.equal(usage.dailySpend, 3.42);
	assert.equal(usage.error, undefined);
	assert.equal(usage.creditRemaining, undefined);
	assert.deepEqual(calls.sort(), ["https://openrouter.ai/api/v1/credits", "https://openrouter.ai/api/v1/key"]);
	calls.length = 0;
	assert.match((await checkOpenRouterUsage({ ...auth, baseUrl: "https://custom.example/v1" })).error!, /Refusing credentialed request/);
	assert.equal(calls.length, 0);
	const controller = new AbortController();
	controller.abort();
	await checkOpenRouterUsage(auth, controller.signal);
	assert.equal(calls.length, 0);
	t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/key")
		? new Response("invalid") : Response.json({ data: { total_credits: 50, total_usage: 7.9 } }));
	const partial = await checkOpenRouterUsage(auth);
	assert.ok(partial.error);
	assert.equal(partial.creditRemaining, 42.1);
});

test("stalled optional credits cannot discard key usage or advance its reset boundary", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 0, 31, 23, 59, 58) });
	let creditSignal: AbortSignal | undefined;
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		if (url.endsWith("/key")) return Response.json(key);
		creditSignal = init.signal!;
		return new Promise<Response>(() => {}); // Deliberately ignores abort.
	});
	const pending = checkOpenRouterUsage({ apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1" });
	await setImmediate();
	t.mock.timers.tick(CHECK_TIMEOUT_MS);
	const usage = await pending;
	assert.equal(creditSignal?.aborted, true);
	assert.equal(usage.error, undefined);
	assert.equal(usage.dailySpend, 3.42);
	assert.equal(usage.creditRemaining, undefined);
	assert.equal(usage.dailyResetAt, Date.UTC(2026, 1, 1) / 1000);
	assert.equal(usage.budget?.resetAt, Date.UTC(2026, 1, 1) / 1000);
	assert.equal(openRouterFooter(usage, plain), "--/d,--/$25");
});

test("OpenRouter reuses resolved auth and does not default a custom credential to official origin", async () => {
	const ctx = { modelRegistry: {
		getProviderAuth: async (provider: string) => {
			assert.equal(provider, "openrouter");
			return { auth: { apiKey: " key ", baseUrl: "https://custom.example/v1" }, source: "test" };
		},
	} } as unknown as UsageContext;
	assert.deepEqual(await getOpenRouterAuth(ctx), { apiKey: "key", baseUrl: "https://custom.example/v1", source: "test" });
});
