import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { checkAnthropicUsage, getAnthropicAuth } from "./src/anthropic.ts";
import { checkCodexUsage, getCodexToken } from "./src/codex.ts";
import { CODEX_PROBE_MODEL } from "./src/config.ts";
import { checkCopilotUsage, getCopilotAuth } from "./src/copilot.ts";
import { resolveProbeAuth } from "./src/probe.ts";
import { checkOpenCodeGoUsage, getOpenCodeAuth } from "./src/opencode-go.ts";
import { getSubscriptionProviderConfig } from "./src/subscriptions.ts";
import { checkSubscriptionProviderUsage, getSubscriptionAuth } from "./src/subscription-probe.ts";
import type { SubscriptionProviderConfig } from "./src/subscription-probe.ts";
import type { SubscriptionProbeApi } from "./src/types.ts";

type ProbeApi = SubscriptionProbeApi | "openai-codex-responses";
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-usage-runtime-auth-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

async function runtimeContext(provider: string, api: ProbeApi, options: {
	baseUrl?: string;
	modelBaseUrl?: string;
	modelHeaders?: Record<string, string>;
	providerHeaders?: Record<string, string>;
	apiKey?: string | null;
	credential?: Credential;
} = {}) {
	const credentials: CredentialStore = {
		read: async (id) => id === provider ? options.credential : undefined,
		list: async () => [],
		modify: async (_id, fn) => fn(undefined),
		delete: async () => {},
	};
	const runtime = await ModelRuntime.create({
		credentials, modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false,
	});
	const baseUrl = options.baseUrl ?? "https://gateway.example/v1";
	const id = provider === "openai-codex" ? CODEX_PROBE_MODEL : "configured-model";
	runtime.registerProvider(provider, {
		baseUrl,
		apiKey: options.apiKey === null ? undefined : options.apiKey ?? "provider-key",
		headers: { "X-Route": "provider-route", "X-Provider": "required", ...options.providerHeaders },
		models: [{
			id, name: "Configured model", api, baseUrl: options.modelBaseUrl ?? baseUrl,
			reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 64,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			headers: options.modelHeaders,
		}],
	});
	const modelRegistry = new ModelRegistry(runtime);
	const model = modelRegistry.find(provider, id);
	assert.ok(model);
	return { runtime, ctx: { modelRegistry }, model, baseUrl };
}

const probeCases: Array<{ provider: string; api: SubscriptionProbeApi; leaf: string }> = [
	{ provider: "anthropic", api: "anthropic-messages", leaf: "messages" },
	{ provider: "github-copilot", api: "openai-completions", leaf: "chat/completions" },
	{ provider: "github-copilot", api: "openai-responses", leaf: "responses" },
	{ provider: "github-copilot", api: "anthropic-messages", leaf: "messages" },
	{ provider: "demo", api: "openai-completions", leaf: "chat/completions" },
	{ provider: "demo", api: "openai-responses", leaf: "responses" },
	{ provider: "demo", api: "anthropic-messages", leaf: "messages" },
];

for (const { provider, api, leaf } of probeCases) {
	test(`real runtime resolves ${provider}/${api} model headers and routing overrides`, async (t) => {
		const previousSecret = process.env.PI_USAGE_RUNTIME_MODEL_SECRET;
		process.env.PI_USAGE_RUNTIME_MODEL_SECRET = "resolved-model-secret";
		t.after(() => {
			if (previousSecret === undefined) delete process.env.PI_USAGE_RUNTIME_MODEL_SECRET;
			else process.env.PI_USAGE_RUNTIME_MODEL_SECRET = previousSecret;
		});
		const { ctx, model, baseUrl } = await runtimeContext(provider, api, { modelHeaders: {
			"X-Route": "model-route", "X-Model-Secret": "$PI_USAGE_RUNTIME_MODEL_SECRET", Authorization: "Bearer model-token",
		} });
		assert.equal(model.headers, undefined, "Pi stores configured headers outside the catalog model");
		const canonical = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		assert.equal(canonical.ok, true);
		const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
			assert.equal(String(url), `${baseUrl}/${leaf}`);
			assert.equal(init.redirect, "error");
			assert.equal(init.method, "POST");
			const headers = new Headers(init.headers);
			assert.equal(headers.get("x-route"), "model-route");
			assert.equal(headers.get("x-model-secret"), "resolved-model-secret");
			assert.equal(headers.get("x-provider"), "required");
			assert.equal(headers.get("authorization"), "Bearer model-token");
			assert.equal(JSON.parse(String(init.body)).model, model.id);
			return new Response(null, { status: 200 });
		});
		let usage;
		if (provider === "anthropic") {
			usage = await checkAnthropicUsage(ctx, await getAnthropicAuth(ctx), undefined, model);
		} else if (provider === "github-copilot") {
			usage = await checkCopilotUsage(ctx, await getCopilotAuth(ctx), undefined, model);
		} else {
			const config: SubscriptionProviderConfig = {
				provider, label: "Demo", shortLabel: "Demo",
				// A documented fallback must not replace the configured API or endpoint.
				documentedModels: [{ id: model.id, api: "openai-completions", endpoint: `${baseUrl}/old-endpoint`, costRank: 0 }],
			};
			usage = await checkSubscriptionProviderUsage(ctx, config, await getSubscriptionAuth(ctx, config), undefined, model);
		}
		assert.equal(usage.status, "available");
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test("real runtime Codex fallback uses model headers without sending them to the quota endpoint", async (t) => {
	const { ctx, baseUrl } = await runtimeContext("openai-codex", "openai-codex-responses", {
		baseUrl: "https://chatgpt.com/backend-api",
		modelHeaders: { "X-Route": "model-route", "X-Model-Secret": "model-secret", Authorization: "Bearer model-token", "ChatGPT-Account-Id": "model-account" },
	});
	const provider = await ctx.modelRegistry.getProviderAuth("openai-codex");
	assert.ok(provider);
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		if (String(url).endsWith("/usage")) {
			assert.equal(headers.get("x-route"), "provider-route");
			assert.equal(headers.get("x-model-secret"), null);
			return new Response(null, { status: 500 });
		}
		assert.equal(String(url), `${baseUrl}/codex/responses`);
		assert.equal(init.redirect, "error");
		assert.equal(headers.get("x-route"), "model-route");
		assert.equal(headers.get("x-model-secret"), "model-secret");
		assert.equal(headers.get("authorization"), "Bearer model-token");
		assert.equal(headers.get("chatgpt-account-id"), "model-account");
		return new Response(null, { status: 200, headers: { "x-codex-primary-used-percent": "17" } });
	});
	const usage = await checkCodexUsage("provider-key", "provider-account", undefined, baseUrl, provider.auth.headers, ctx);
	assert.equal(usage.source, "probe");
	assert.equal(usage.primaryUsedPercent, 17);
	assert.equal(fetch.mock.callCount(), 2);
});

test("stale file-backed OAuth metadata cannot misclassify a real runtime API key", async (t) => {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: {
		type: "oauth", access: "sk-ant-oat-stale", refresh: "stale-refresh", expires: 1,
	} }));
	const { ctx, model, baseUrl } = await runtimeContext("anthropic", "anthropic-messages", { apiKey: "sk-ant-api-current" });
	const auth = await getAnthropicAuth(ctx);
	assert.equal(auth?.token, "sk-ant-api-current");
	assert.equal(auth?.type, "api_key");
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), `${baseUrl}/messages`);
		assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("x-api-key"), "sk-ant-api-current");
		assert.equal(new Headers(init.headers).get("authorization"), null);
		assert.equal(JSON.parse(String(init.body)).system, undefined);
		return new Response(null, { status: 200 });
	});
	assert.equal((await checkAnthropicUsage(ctx, auth, undefined, model)).status, "available");
	assert.equal(fetch.mock.callCount(), 1);
});

test("a real runtime OAuth token still uses free usage even when auth.json contains an old API key", async (t) => {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "old-api-key" } }));
	const { ctx } = await runtimeContext("anthropic", "anthropic-messages", {
		baseUrl: "https://api.anthropic.com", apiKey: null,
		credential: { type: "oauth", access: "sk-ant-oat-current", refresh: "refresh-token", expires: Date.now() + 3_600_000 },
	});
	const auth = await getAnthropicAuth(ctx);
	assert.equal(auth?.type, "oauth");
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
		assert.equal(init.method, undefined);
		assert.equal(new Headers(init.headers).get("authorization"), "Bearer sk-ant-oat-current");
		return Response.json({ five_hour: { utilization: 17 } });
	});
	assert.equal((await checkAnthropicUsage(ctx, auth)).source, "usage_api");
	assert.equal(fetch.mock.callCount(), 1);
});

test("model auth failures do not silently retry with provider credentials", async (t) => {
	const missing = process.env.PI_USAGE_MISSING_MODEL_HEADER;
	delete process.env.PI_USAGE_MISSING_MODEL_HEADER;
	t.after(() => { if (missing !== undefined) process.env.PI_USAGE_MISSING_MODEL_HEADER = missing; });
	const { ctx, model } = await runtimeContext("anthropic", "anthropic-messages", { modelHeaders: { "X-Required": "$PI_USAGE_MISSING_MODEL_HEADER" } });
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	const usage = await checkAnthropicUsage(ctx, await getAnthropicAuth(ctx), undefined, model);
	assert.equal(usage.status, "error");
	assert.match(usage.error!, /Model authentication failed/);
	assert.equal(fetch.mock.callCount(), 0);
});

test("model-resolved credentials cannot be rebound to a different origin", async () => {
	const { ctx, model, baseUrl } = await runtimeContext("demo", "openai-completions", {
		modelBaseUrl: "https://foreign.example/v1", modelHeaders: { "X-Foreign-Key": "secret" },
	});
	await assert.rejects(resolveProbeAuth(ctx, "demo", {
		id: model.id, api: "openai-completions", endpoint: `${baseUrl}/chat/completions`,
	}, { apiKey: "provider-key", baseUrl }), /different credential origin/);
});

test("model-auth resolution rejects API changes instead of sending the wrong payload", async () => {
	const { ctx, model, baseUrl } = await runtimeContext("demo", "openai-responses");
	await assert.rejects(resolveProbeAuth(ctx, "demo", {
		id: model.id, api: "openai-completions", endpoint: `${baseUrl}/chat/completions`,
	}, { apiKey: "provider-key", baseUrl }), /Configured API changed/);
});

async function sharedOpenCodeContext(t: TestContext, target: "opencode" | "opencode-go", modelHeaders?: Record<string, string>, api: SubscriptionProbeApi = "openai-completions") {
	const oldKey = process.env.OPENCODE_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	t.after(() => {
		if (oldKey === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = oldKey;
	});
	const source = target === "opencode" ? "opencode-go" : "opencode";
	const baseUrls = { opencode: "https://opencode.ai/zen/v1", "opencode-go": "https://opencode.ai/zen/go/v1" };
	const setup = await runtimeContext(target, api, {
		baseUrl: baseUrls[target], apiKey: null,
		modelHeaders: modelHeaders ?? { "X-Route": "model-route", "X-Model-Secret": "model-secret" },
	});
	setup.runtime.registerProvider(source, {
		baseUrl: baseUrls[source], apiKey: "shared-key", models: [],
		headers: { Authorization: "Bearer shared-key", "X-Shared": "required", "X-Route": "shared-route" },
	});
	const config = getSubscriptionProviderConfig("opencode")!;
	const auth = target === "opencode-go" ? await getOpenCodeAuth(setup.ctx) : await getSubscriptionAuth(setup.ctx, config);
	assert.ok(auth);
	assert.equal(auth.fallbackProvider, source);
	const check = () => target === "opencode-go"
		? checkOpenCodeGoUsage(setup.ctx, auth, {}, undefined, setup.model)
		: checkSubscriptionProviderUsage(setup.ctx, config, auth, undefined, setup.model);
	return { ...setup, source, auth, check };
}

for (const target of ["opencode", "opencode-go"] as const) {
	test(`real ${target} probes retain explicitly shared credentials and model routing`, async (t) => {
		const { baseUrl, model, check } = await sharedOpenCodeContext(t, target);
		const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
			assert.equal(String(url), `${baseUrl}/chat/completions`);
			assert.equal(init.redirect, "error");
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), "Bearer shared-key");
			assert.equal(headers.get("x-shared"), "required");
			assert.equal(headers.get("x-route"), "model-route");
			assert.equal(headers.get("x-model-secret"), "model-secret");
			assert.equal(JSON.parse(String(init.body)).model, model.id);
			return new Response(null, { status: 200 });
		});
		assert.equal((await check()).status, "available");
		assert.equal(fetch.mock.callCount(), 1);
	});
}

const modelHeaderAuthCases: Array<{ label: string; headers: Record<string, string> }> = [
	{ label: "bearer Authorization", headers: { aUtHoRiZaTiOn: "Bearer model-token" } },
	{ label: "Basic Authorization", headers: { AUTHORIZATION: "Basic bW9kZWw6c2VjcmV0" } },
	{ label: "x-api-key", headers: { "X-API-Key": "model-key" } },
	{ label: "api-key", headers: { "aPi-KeY": "model-key" } },
	{ label: "explicit dual auth", headers: { Authorization: "Bearer model-token", "x-api-key": "model-key" } },
];

for (const target of ["opencode", "opencode-go"] as const) {
	const apis: SubscriptionProbeApi[] = target === "opencode"
		? ["openai-completions", "openai-responses", "anthropic-messages"]
		: ["openai-completions", "anthropic-messages"];
	for (const api of apis) {
		for (const { label, headers: modelAuthHeaders } of modelHeaderAuthCases) {
			test(`${target}/${api} model ${label} excludes all borrowed credentials`, async (t) => {
				const { runtime, ctx, model, source, baseUrl, check } = await sharedOpenCodeContext(t, target, {
					"X-Route": "model-route", "X-Model-Secret": "model-secret", ...modelAuthHeaders,
				}, api);
				const canonical = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				assert.equal(canonical.ok, true);
				if (canonical.ok) assert.equal(canonical.apiKey, undefined);
				const expectedAuth = new Headers(modelAuthHeaders);
				const leaf = api === "anthropic-messages" ? "messages" : api === "openai-responses" ? "responses" : "chat/completions";
				const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
					assert.equal(String(url), `${baseUrl}/${leaf}`);
					assert.equal(init.method, "POST");
					assert.equal(init.redirect, "error");
					const headers = new Headers(init.headers);
					for (const name of ["authorization", "x-api-key", "api-key"]) {
						assert.equal(headers.get(name), expectedAuth.get(name), `${name} must match canonical model auth`);
					}
					assert.equal(headers.get("x-shared"), null);
					assert.equal(headers.get("x-route"), "model-route");
					assert.equal(headers.get("x-model-secret"), "model-secret");
					assert.equal(JSON.parse(String(init.body)).model, model.id);
					return new Response(null, { status: 200 });
				});
				assert.equal((await check()).status, "available");
				// Once the model has its own auth, the alias is no longer a dependency.
				runtime.unregisterProvider(source);
				assert.equal((await check()).status, "available");
				assert.equal(fetch.mock.callCount(), 2);
			});
		}
	}
}

for (const target of ["opencode", "opencode-go"] as const) {
	test(`${target}/anthropic-messages route-only headers still permit shared auth`, async (t) => {
		const { baseUrl, check } = await sharedOpenCodeContext(t, target, undefined, "anthropic-messages");
		const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
			assert.equal(String(url), `${baseUrl}/messages`);
			const headers = new Headers(init.headers);
			assert.equal(headers.get("x-api-key"), "shared-key");
			assert.equal(headers.get("authorization"), "Bearer shared-key");
			assert.equal(headers.get("x-shared"), "required");
			assert.equal(headers.get("x-route"), "model-route");
			return new Response(null, { status: 200 });
		});
		assert.equal((await check()).status, "available");
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test("model auth deletion markers survive shared-header merging and generated request defaults", async (t) => {
	const { ctx, model, check } = await sharedOpenCodeContext(t, "opencode-go", undefined, "anthropic-messages");
	const canonical = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	assert.ok(canonical.ok);
	t.mock.method(ctx.modelRegistry, "getApiKeyAndHeaders", async () => ({
		...canonical, headers: { ...canonical.headers, Authorization: null, "X-API-Key": null },
	}));
	const fetch = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), null);
		assert.equal(headers.get("x-api-key"), null);
		assert.equal(headers.get("x-shared"), "required");
		assert.equal(headers.get("x-route"), "model-route");
		return new Response(null, { status: 200 });
	});
	assert.equal((await check()).status, "available");
	assert.equal(fetch.mock.callCount(), 1);
});

test("shared OpenCode credentials also work for a selected model absent from the catalog", async (t) => {
	const { runtime, baseUrl, check } = await sharedOpenCodeContext(t, "opencode");
	runtime.unregisterProvider("opencode");
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), `${baseUrl}/chat/completions`);
		assert.equal(new Headers(init.headers).get("authorization"), "Bearer shared-key");
		return new Response(null, { status: 200 });
	});
	assert.equal((await check()).status, "available");
	assert.equal(fetch.mock.callCount(), 1);
});

for (const catalogModel of [true, false]) {
	test(`withdrawn shared credentials are not reused (${catalogModel ? "catalog" : "selected fallback"} model)`, async (t) => {
		const { runtime, source, check } = await sharedOpenCodeContext(t, "opencode");
		if (!catalogModel) runtime.unregisterProvider("opencode");
		runtime.unregisterProvider(source);
		const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
		const result = await check();
		assert.equal(result.status, "error");
		assert.match(result.error!, /Shared provider authentication unavailable/);
		assert.equal(fetch.mock.callCount(), 0);
	});
}

test("shared credentials cannot mask a genuine model-auth resolution error", async (t) => {
	const old = process.env.PI_USAGE_MISSING_SHARED_MODEL_HEADER;
	delete process.env.PI_USAGE_MISSING_SHARED_MODEL_HEADER;
	t.after(() => { if (old !== undefined) process.env.PI_USAGE_MISSING_SHARED_MODEL_HEADER = old; });
	const { check } = await sharedOpenCodeContext(t, "opencode", { "X-Required": "$PI_USAGE_MISSING_SHARED_MODEL_HEADER" });
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	const result = await check();
	assert.equal(result.status, "error");
	assert.match(result.error!, /Model authentication failed/);
	assert.equal(fetch.mock.callCount(), 0);
});

test("a changed shared-provider origin is rejected before a key can be sent", async (t) => {
	const { runtime, source, check } = await sharedOpenCodeContext(t, "opencode");
	runtime.registerProvider(source, { baseUrl: "https://foreign.example/v1", apiKey: "rotated-key", models: [] });
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
	const result = await check();
	assert.equal(result.status, "error");
	assert.match(result.error!, /shared authentication on a different credential origin/);
	assert.equal(fetch.mock.callCount(), 0);
});

test("new target credentials take precedence over an earlier shared fallback", async (t) => {
	const { runtime, source, baseUrl, check } = await sharedOpenCodeContext(t, "opencode");
	runtime.registerProvider("opencode", { ...runtime.getRegisteredProviderConfig("opencode"), apiKey: "target-key" });
	runtime.unregisterProvider(source);
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(String(url), `${baseUrl}/chat/completions`);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer target-key");
		assert.equal(headers.get("x-shared"), null);
		assert.equal(headers.get("x-route"), "model-route");
		return new Response(null, { status: 200 });
	});
	assert.equal((await check()).status, "available");
	assert.equal(fetch.mock.callCount(), 1);
});

test("same-provider credential removal never restores a captured key", async (t) => {
	const { runtime, ctx, model } = await runtimeContext("demo", "openai-completions");
	const config = { provider: "demo", label: "Demo", shortLabel: "Demo" };
	const auth = await getSubscriptionAuth(ctx, config);
	assert.ok(auth);
	assert.equal(auth.fallbackProvider, undefined);
	runtime.registerProvider("demo", { ...runtime.getRegisteredProviderConfig("demo"), apiKey: undefined });
	const fetch = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
		assert.equal(new Headers(init.headers).get("authorization"), null);
		return new Response(null, { status: 401 });
	});
	assert.equal((await checkSubscriptionProviderUsage(ctx, config, auth, undefined, model)).status, "error");
	assert.equal(fetch.mock.callCount(), 1);
});

function accountToken(accountId: unknown): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
	return `header.${payload}.signature`;
}

function storedCodex(access: string, accountId: unknown): void {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": {
		type: "oauth", access, accountId, refresh: "refresh-token", expires: Date.now() + 3_600_000,
	} }));
}

for (const sameToken of [false, true]) {
	test(`Codex uses current JWT account claims over ${sameToken ? "conflicting" : "stale"} stored metadata`, async (t) => {
		const token = accountToken("current-account");
		storedCodex(sameToken ? token : accountToken("old-account"), "old-account");
		const { ctx, baseUrl } = await runtimeContext("openai-codex", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api", apiKey: token,
		});
		const auth = await getCodexToken(ctx);
		assert.ok(auth);
		assert.equal(auth.accountId, "current-account");
		const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0], init: RequestInit) => {
			assert.equal(String(url), `${baseUrl}/wham/usage`);
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), `Bearer ${token}`);
			assert.equal(headers.get("chatgpt-account-id"), "current-account");
			return Response.json({ rate_limit: { primary_window: { used_percent: 17 } } });
		});
		assert.equal((await checkCodexUsage(auth.token, auth.accountId, undefined, auth.baseUrl, auth.headers, ctx)).source, "usage_api");
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test("effective Codex account headers take precedence over JWT and stored metadata", async () => {
	const token = accountToken("jwt-account");
	storedCodex(token, "stored-account");
	const { ctx } = await runtimeContext("openai-codex", "openai-codex-responses", {
		apiKey: token, providerHeaders: { "ChatGPT-Account-Id": "selected-account" },
	});
	assert.equal((await getCodexToken(ctx))?.accountId, "selected-account");
});

test("opaque Codex tokens can use stored account metadata only for the exact active credential", async () => {
	const { ctx } = await runtimeContext("openai-codex", "openai-codex-responses", { apiKey: "opaque-current-token" });
	storedCodex("opaque-current-token", "matching-account");
	assert.equal((await getCodexToken(ctx))?.accountId, "matching-account");
	storedCodex("opaque-old-token", "old-account");
	assert.equal(await getCodexToken(ctx), undefined);
});

test("malformed or empty JWT account claims cannot become Codex request headers", async () => {
	for (const accountId of [null, 17, {}, ["account"], "", "  "]) {
		const { ctx } = await runtimeContext("openai-codex", "openai-codex-responses", { apiKey: accountToken(accountId) });
		assert.equal(await getCodexToken(ctx), undefined);
	}
});

test("invalid stored account metadata is rejected even when the opaque token matches", async () => {
	const { ctx } = await runtimeContext("openai-codex", "openai-codex-responses", { apiKey: "opaque-token" });
	for (const accountId of [null, 17, {}, ["account"], "", "  "]) {
		storedCodex("opaque-token", accountId);
		assert.equal(await getCodexToken(ctx), undefined);
	}
});

test("Codex fallback does not carry an account ID across an unrelated model-token override", async (t) => {
	const { ctx, baseUrl } = await runtimeContext("openai-codex", "openai-codex-responses", {
		baseUrl: "https://chatgpt.com/backend-api", apiKey: accountToken("provider-account"),
		modelHeaders: { Authorization: "Bearer unrelated-opaque-model-token" },
	});
	const auth = await getCodexToken(ctx);
	assert.ok(auth);
	const fetch = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof globalThis.fetch>[0]) => {
		assert.equal(String(url), `${baseUrl}/wham/usage`);
		return new Response(null, { status: 500 });
	});
	const result = await checkCodexUsage(auth.token, auth.accountId, undefined, auth.baseUrl, auth.headers, ctx);
	assert.match(result.error!, /missing a token-bound account ID/);
	assert.equal(fetch.mock.callCount(), 1);
});
