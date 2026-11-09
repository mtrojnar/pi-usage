import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAnthropicAuth, checkAnthropicUsage } from "./src/anthropic.ts";
import { resolveBoundProviderAuth, resolveProviderAuth } from "./src/auth.ts";
import { getCodexToken, checkCodexUsage, checkCodexUsageFromUsageApi } from "./src/codex.ts";
import { agentDir } from "./src/config.ts";
import { getCopilotAuth, checkCopilotUsage } from "./src/copilot.ts";
import { bearerToken, hasCredentialHeaders, mergeProviderHeaders, mergeRequestHeaders } from "./src/headers.ts";
import { checkOpenRouterUsage, getOpenRouterAuth } from "./src/openrouter.ts";
import { checkSubscriptionProviderUsage, getSubscriptionAuth } from "./src/subscription-probe.ts";
import type { SubscriptionProviderConfig } from "./src/subscription-probe.ts";
import type { SubscriptionProbeApi, UsageContext } from "./src/types.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-auth-"));
beforeEach(() => { process.env.PI_CODING_AGENT_DIR = testAgentDir; });
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

interface TestAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

function context(provider: string, auth: TestAuth, models: object[] = []): UsageContext {
	return { modelRegistry: {
		find: () => undefined,
		getProviderAuth: async (id: string) => id === provider ? { auth, source: "test" } : undefined,
		getProvider: (id: string) => id === provider ? { baseUrl: auth.baseUrl, getModels: () => models } : undefined,
	} } as unknown as UsageContext;
}

test("new openai ChatGPT credentials are not borrowed for legacy Codex monitoring", async () => {
	const ctx = context("openai", { apiKey: "new-chatgpt-token", baseUrl: "https://api.openai.com/v1" });
	assert.equal(await getCodexToken(ctx), undefined);
});

function codexPayload() {
	return { plan_type: "plus", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } } };
}

test("request headers merge case-insensitively and honor null removals without mutating inputs", () => {
	const defaults = { Authorization: "Bearer default", "X-Remove": "default", "Content-Type": "application/json" };
	const model = { AUTHORIZATION: "Bearer model", "x-remove": "model", "X-Model": "model" };
	const resolved = { authorization: "Bearer provider", "X-REMOVE": null };
	assert.deepEqual(mergeRequestHeaders(defaults, model, resolved), {
		authorization: "Bearer provider", "content-type": "application/json", "x-model": "model",
	});
	assert.equal(defaults.Authorization, "Bearer default");
	assert.equal(model["x-remove"], "model");
	assert.equal(mergeRequestHeaders(defaults, { authorization: null }).authorization, undefined);
	assert.equal(bearerToken({ AUTHORIZATION: "bEaReR opaque-token" }), "opaque-token");
	assert.equal(bearerToken({ Authorization: "Basic opaque-token" }), undefined);
});

test("credential-header detection is case-insensitive and distinguishes routing and removals", () => {
	for (const name of ["Authorization", "AUTHORIZATION", "x-api-key", "X-API-Key", "aPi-KeY"]) {
		assert.equal(hasCredentialHeaders({ [name]: "credential" }), true);
		for (const value of [null, "", "   "]) assert.equal(hasCredentialHeaders({ [name]: value }), false);
	}
	assert.equal(hasCredentialHeaders({ Authorization: "Basic dXNlcjpwYXNz" }), true);
	assert.equal(hasCredentialHeaders({ Authorization: "Bearer model-token" }), true);
	assert.equal(hasCredentialHeaders({ "X-Route": "route", "X-Model-Secret": "routing-metadata" }), false);
	assert.equal(hasCredentialHeaders(undefined), false);
	assert.equal(hasCredentialHeaders({ Authorization: "Bearer old", authorization: null }), false);
	assert.equal(hasCredentialHeaders({ Authorization: null, authorization: "Bearer current" }), true);
});

test("shared provider header merging retains null markers and model precedence", () => {
	const shared = { Authorization: "Bearer shared", "X-Route": "shared", "x-route": "shared-lowercase" };
	const merged = mergeProviderHeaders(shared, { "X-Route": "model", AUTHORIZATION: null });
	assert.deepEqual(merged, { authorization: null, "x-route": "model" });
	assert.deepEqual(mergeRequestHeaders({ Authorization: "Bearer generated-default" }, merged), { "x-route": "model" });
	assert.equal(shared.Authorization, "Bearer shared");
	const specialName = { ["__proto__"]: "valid-header" };
	assert.deepEqual(mergeProviderHeaders(specialName), specialName);
});

test("resolved header-only auth stays bound to its origin and retains deletion markers", async () => {
	const headers = { Authorization: "Bearer gateway-token", "x-api-key": null };
	const ctx = context("anthropic", { headers, baseUrl: "https://gateway.example/anthropic" });
	assert.deepEqual(await resolveBoundProviderAuth(ctx, "anthropic"), {
		apiKey: undefined, headers, baseUrl: "https://gateway.example/anthropic", source: "test",
	});
});

test("empty or deletion-only auth is not considered configured", async () => {
	const cases: ProviderHeaders[] = [{}, { Authorization: null }, { Authorization: "   " }];
	for (const headers of cases) {
		assert.equal(await resolveProviderAuth(context("demo", { apiKey: "  ", headers }), "demo"), undefined);
	}
});

test("header-only auth requires an unambiguous HTTP origin", async () => {
	const headers = { Authorization: "Bearer gateway-token" };
	assert.equal(await resolveBoundProviderAuth(context("demo", { headers }), "demo"), undefined);
	assert.equal(await resolveBoundProviderAuth(context("demo", { headers, baseUrl: "file:///tmp/demo" }), "demo"), undefined);
	const ctx = context("demo", { headers }, [
		{ baseUrl: "https://one.example/v1" }, { baseUrl: "https://two.example/v1" },
	]);
	assert.equal(await resolveBoundProviderAuth(ctx, "demo"), undefined);
});

test("agent directory resolution matches Pi for default, absolute, relative and tilde paths", () => {
	for (const value of [undefined, "", testAgentDir, "./relative-agent", "~/pi-usage-test-agent"]) {
		if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = value;
		assert.equal(agentDir(), getAgentDir());
	}
});

test("Anthropic gateways use resolved bearer headers without manufacturing an API key", async (t) => {
	const baseUrl = "https://gateway.example/anthropic";
	const model = { provider: "anthropic", id: "gateway-model", api: "anthropic-messages", baseUrl };
	const ctx = context("anthropic", {
		baseUrl,
		headers: { AUTHORIZATION: "Bearer gateway-token", "X-Gateway": "required", "x-remove": null },
	}, [{ ...model, headers: { "X-Model": "model", "X-Remove": "remove", authorization: "Bearer model-token" } }]);
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		requests++;
		assert.equal(String(url), `${baseUrl}/v1/messages`);
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "error");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer gateway-token");
		assert.equal(headers.get("x-api-key"), null);
		assert.equal(headers.get("x-model"), "model");
		assert.equal(headers.get("x-gateway"), "required");
		assert.equal(headers.get("x-remove"), null);
		return new Response(null, { status: 200 });
	});
	const auth = await getAnthropicAuth(ctx);
	assert.equal(auth?.type, "api_key");
	assert.equal((await checkAnthropicUsage(ctx, auth, undefined, model)).status, "available");
	assert.equal(requests, 1);
});

test("Anthropic OAuth resolved through headers keeps the free quota endpoint and extra headers", async (t) => {
	const ctx = context("anthropic", {
		baseUrl: "https://api.anthropic.com",
		headers: { Authorization: "Bearer sk-ant-oat-current", "X-Gateway": "required", "X-App": null },
	});
	t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
		assert.equal(init.method, undefined);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer sk-ant-oat-current");
		assert.equal(headers.get("x-gateway"), "required");
		assert.equal(headers.get("x-app"), null);
		return Response.json({ five_hour: { utilization: 17 } });
	});
	const auth = await getAnthropicAuth(ctx);
	assert.equal(auth?.type, "oauth");
	assert.equal((await checkAnthropicUsage(ctx, auth)).source, "usage_api");
});

test("Anthropic API keys preserve supplemental provider headers", async (t) => {
	const ctx = context("anthropic", { apiKey: "api-key", baseUrl: "https://gateway.example", headers: { "X-Gateway": "required" } });
	t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("x-api-key"), "api-key");
		assert.equal(headers.get("x-gateway"), "required");
		return new Response(null, { status: 200 });
	});
	assert.equal((await checkAnthropicUsage(ctx, await getAnthropicAuth(ctx))).status, "available");
});

test("Copilot supports header-only auth and same-origin model headers", async (t) => {
	const baseUrl = "https://copilot.gateway.example";
	const ctx = context("github-copilot", {
		baseUrl, headers: { "X-Gateway-Key": "secret", Authorization: null, "x-remove": null },
	}, [{ id: "gpt-test", api: "openai-completions", baseUrl, headers: { "X-Model": "model", "X-Remove": "remove" } }]);
	t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), `${baseUrl}/chat/completions`);
		assert.equal(init.redirect, "error");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("x-gateway-key"), "secret");
		assert.equal(headers.get("authorization"), null);
		assert.equal(headers.get("x-model"), "model");
		assert.equal(headers.get("x-remove"), null);
		return new Response(null, { status: 200 });
	});
	assert.equal((await checkCopilotUsage(ctx, await getCopilotAuth(ctx))).status, "available");
});

test("Copilot never copies foreign-origin model credentials to its resolved endpoint", async (t) => {
	const ctx = context("github-copilot", {
		baseUrl: "https://copilot.gateway.example", apiKey: "copilot-token", headers: { "X-Gateway": "required" },
	}, [{ id: "gpt-test", api: "openai-completions", baseUrl: "https://foreign.example", headers: { "X-Foreign-Secret": "foreign-secret" } }]);
	t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer copilot-token");
		assert.equal(headers.get("x-gateway"), "required");
		assert.equal(headers.get("x-foreign-secret"), null);
		return new Response(null, { status: 200 });
	});
	assert.equal((await checkCopilotUsage(ctx, await getCopilotAuth(ctx))).status, "available");
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] satisfies SubscriptionProbeApi[]) {
	for (const apiKey of [undefined, "fallback-key"]) {
		test(`${api} probes preserve ${apiKey ? "key-plus-header" : "header-only"} authentication`, async (t) => {
			const baseUrl = "https://gateway.example/v1";
			const config: SubscriptionProviderConfig = { provider: "demo", label: "Demo", shortLabel: "Demo" };
			const ctx = context("demo", {
				apiKey, baseUrl,
				headers: { authorization: "Bearer resolved-token", "x-api-key": null, "X-Gateway": "required", "x-remove": null },
			}, [{ id: "demo-model", api, baseUrl, headers: { Authorization: "Bearer model-token", "X-Model": "model", "X-Remove": "remove" } }]);
			t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
				assert.equal(new URL(String(url)).origin, "https://gateway.example");
				assert.equal(init.redirect, "error");
				const headers = new Headers(init.headers);
				assert.equal(headers.get("authorization"), "Bearer resolved-token");
				assert.equal(headers.get("x-api-key"), null);
				assert.equal(headers.get("x-gateway"), "required");
				assert.equal(headers.get("x-model"), "model");
				assert.equal(headers.get("x-remove"), null);
				return new Response(null, { status: 200 });
			});
			assert.equal((await checkSubscriptionProviderUsage(ctx, config, await getSubscriptionAuth(ctx, config))).status, "available");
		});
	}
}

test("dedicated subscription quota endpoints preserve header-only authentication", async (t) => {
	const config: SubscriptionProviderConfig = {
		provider: "demo", label: "Demo", shortLabel: "Demo",
		usageApi: { url: "https://gateway.example/usage", parse: () => ({ rolling: { usedPercent: 17 } }) },
	};
	const ctx = context("demo", { baseUrl: "https://gateway.example", headers: { "X-Gateway-Key": "secret", Authorization: null } });
	t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), config.usageApi!.url);
		assert.equal(init.method, undefined);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("x-gateway-key"), "secret");
		assert.equal(headers.get("authorization"), null);
		return Response.json({});
	});
	assert.equal((await checkSubscriptionProviderUsage(ctx, config, await getSubscriptionAuth(ctx, config))).source, "usage_api");
});

test("header-only subscription credentials cannot reach a foreign quota endpoint or model", async (t) => {
	const config: SubscriptionProviderConfig = {
		provider: "demo", label: "Demo", shortLabel: "Demo",
		usageApi: { url: "https://foreign.example/usage", parse: () => ({ rolling: { usedPercent: 0 } }) },
	};
	const ctx = context("demo", {
		baseUrl: "https://gateway.example", headers: { Authorization: "Bearer gateway-token" },
	}, [{ id: "foreign-model", api: "openai-completions", baseUrl: "https://foreign.example" }]);
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	const result = await checkSubscriptionProviderUsage(ctx, config, await getSubscriptionAuth(ctx, config));
	assert.equal(result.status, "error");
	assert.match(result.error!, /Refusing credentialed request/);
	assert.equal(fetch.mock.callCount(), 0);
});

test("OpenRouter accounting preserves header-only auth and rejects a foreign credential origin", async (t) => {
	const ctx = context("openrouter", {
		baseUrl: "https://openrouter.ai/api/v1", headers: { Authorization: "Bearer resolved-token", "X-Gateway": "required" },
	});
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer resolved-token");
		assert.equal(headers.get("x-gateway"), "required");
		assert.equal(init.redirect, "error");
		return String(url).endsWith("/key") ? Response.json({ data: { usage_daily: 3 } }) : new Response(null, { status: 403 });
	});
	const auth = await getOpenRouterAuth(ctx);
	assert.ok(auth);
	assert.equal((await checkOpenRouterUsage(auth)).dailySpend, 3);
	assert.equal(fetch.mock.callCount(), 2);
	assert.match((await checkOpenRouterUsage({ ...auth, baseUrl: "https://foreign.example" })).error!, /Refusing credentialed request/);
	assert.equal(fetch.mock.callCount(), 2);
});

test("Codex resolves bearer and account headers and preserves them on quota and fallback requests", async (t) => {
	const ctx = context("openai-codex", {
		baseUrl: "https://chatgpt.com/backend-api",
		headers: { Authorization: "Bearer opaque-token", "ChatGPT-Account-Id": "header-account", "X-Gateway": "required", "User-Agent": null },
	});
	const auth = await getCodexToken(ctx);
	assert.ok(auth);
	assert.equal(auth.accountId, "header-account");
	assert.equal(auth.token, "opaque-token");
	let fallback = false;
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer opaque-token");
		assert.equal(headers.get("chatgpt-account-id"), "header-account");
		assert.equal(headers.get("x-gateway"), "required");
		assert.equal(headers.get("user-agent"), null);
		assert.equal(init.redirect, "error");
		if (String(url).endsWith("/usage")) return fallback ? new Response(null, { status: 500 }) : Response.json(codexPayload());
		assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
		return new Response(null, { status: 200, headers: { "x-codex-primary-used-percent": "42" } });
	});
	assert.equal((await checkCodexUsage(auth.token, auth.accountId, undefined, auth.baseUrl, auth.headers)).primaryUsedPercent, 42);
	fallback = true;
	assert.equal((await checkCodexUsage(auth.token, auth.accountId, undefined, auth.baseUrl, auth.headers)).source, "probe");
	assert.equal(fetch.mock.callCount(), 3);
	const rejected = await checkCodexUsageFromUsageApi(auth.token, auth.accountId, undefined, "https://foreign.example", auth.headers);
	assert.equal(rejected.success, false);
	if (!rejected.success) assert.match(rejected.error, /Refusing credentialed request/);
	assert.equal(fetch.mock.callCount(), 3);
});
