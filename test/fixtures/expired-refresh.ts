import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionEvent,
	ExtensionHandler,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import usageExtension from "../../index.ts";

const proactive = process.env.PI_USAGE_PROACTIVE === "true";
mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_501 });
const handlers = new Map<string, unknown>();
let command: RegisteredCommand["handler"] | undefined;
let requests = 0;
let zaiRequests = 0;
const authLookups: string[] = [];
const widgets: string[][] = [];

globalThis.fetch = async (url) => {
	if (String(url) === "https://api.z.ai/v1/chat/completions") {
		zaiRequests++;
		return new Response(null, { status: 200 });
	}
	assert.equal(String(url), "https://api.kimi.com/coding/v1/usages");
	requests++;
	return Response.json({ usage: { limit: 100, used: 32, resetTime: "2026-01-01T00:00:00Z" } });
};

const pi = {
	registerFlag() {},
	getFlag: (name: string) => name === "usage-widget",
	on: (event: string, handler: unknown) => { handlers.set(event, handler); },
	registerCommand: (_name, options) => { command = options.handler; },
} satisfies Pick<ExtensionAPI, "registerFlag" | "getFlag" | "on" | "registerCommand">;
usageExtension(pi as unknown as ExtensionAPI);

// Only the context members used by the extension are needed in this fixture.
const ctx = {
	hasUI: true,
	model: { provider: "kimi-coding", id: "kimi-for-coding" },
	ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setWidget: (_id: string, lines: string[] | undefined) => { if (lines) widgets.push(lines); },
		setStatus() {}, notify() {},
	},
	modelRegistry: {
		getProviderAuth: async (provider: string) => {
			authLookups.push(provider);
			const baseUrl = provider === "kimi-coding" ? "https://api.kimi.com/coding"
				: provider === "zai" ? "https://api.z.ai/v1" : undefined;
			return baseUrl ? { auth: { apiKey: "test-key", baseUrl }, source: "test" } : undefined;
		},
		getProvider: (provider: string) => provider === "zai" ? {
			getModels: () => [{ id: "glm-test", api: "openai-completions", baseUrl: "https://api.z.ai/v1", cost: {} }],
		} : undefined,
	},
} as unknown as ExtensionCommandContext;

async function emit<E extends ExtensionEvent>(event: E): Promise<void> {
	const handler = handlers.get(event.type) as ExtensionHandler<E> | undefined;
	assert.ok(handler, `Missing handler for ${event.type}`);
	await handler(event, ctx);
}

async function tick(ms: number): Promise<void> {
	mock.timers.tick(ms);
	// setImmediate is not mocked: drain the refresh's promise chain before asserting.
	await setImmediate();
}

function widgetText(): string {
	assert.ok(widgets.length > 0);
	return widgets.at(-1)!.join("\n");
}

try {
	// A new session starts timers without the unrelated startup request.
	await emit({ type: "session_start", reason: "new" });
	await tick(1000);
	assert.equal(requests, 0);
	await emit({ type: "after_provider_response", status: 200, headers: {
		"x-kimi-rolling-used-percent": "100",
		"x-kimi-rolling-reset-at": String(Math.floor(Date.now() / 1000) + 2),
	} });
	// This display tick falls 499ms before reset. Rounding to seconds used to
	// trigger a refresh here while the renderer still showed an unexpired window.
	await tick(1000);
	assert.equal(requests, 0, "no refresh before the reset boundary");
	assert.match(widgetText(), /100%/);
	assert.doesNotMatch(widgetText(), /stale/);

	const rendersBefore = widgets.length;
	await tick(1000);
	assert.ok(widgets.length > rendersBefore, "display still re-renders cached data");
	assert.match(widgetText(), /stale/);
	assert.doesNotMatch(widgetText(), /refreshing/);
	assert.equal(requests, proactive ? 1 : 0, "expired windows respect proactive mode");
	assert.equal(zaiRequests, 0, "Kimi expiry must not probe unrelated configured providers");
	assert.deepEqual(authLookups, proactive ? ["kimi-coding"] : [], "only expired providers resolve auth");

	// Another provider expires during Kimi's debounce interval. Its check must
	// run independently, without repeating the Kimi check.
	ctx.model = { ...ctx.model!, provider: "zai", id: "glm-test" };
	await emit({ type: "after_provider_response", status: 200, headers: {
		"x-zai-rolling-used-percent": "50",
		"x-zai-rolling-reset-at": String(Math.floor(Date.now() / 1000) - 1),
	} });
	await tick(1000);
	assert.equal(requests, proactive ? 1 : 0, "no duplicate request during debounce");
	assert.equal(zaiRequests, proactive ? 1 : 0, "providers have independent expiry debounces");
	await tick(300000);
	assert.equal(requests, proactive ? 2 : 0, "debounce expiry respects proactive mode");
	assert.ok(command);
	await command("", ctx);
	assert.equal(requests, proactive ? 3 : 1, "manual refresh remains available");
	assert.equal(zaiRequests, proactive ? 2 : 1, "manual refresh still checks every configured provider");
} finally {
	await emit({ type: "session_shutdown", reason: "quit" });
	mock.timers.reset();
}
