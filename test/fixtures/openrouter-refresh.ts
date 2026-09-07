import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionEvent, ExtensionHandler, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import usageExtension from "../../index.ts";

const proactive = process.env.PI_USAGE_PROACTIVE === "true";
mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.UTC(2026, 0, 31, 23, 59, 58) });
const handlers = new Map<string, unknown>();
let command: RegisteredCommand["handler"] | undefined;
let configured = true;
let requests = 0;
let footer = "";
let widget = "";
const lookups: string[] = [];

globalThis.fetch = async (url, init) => {
	assert.equal(init?.body, undefined);
	requests++;
	if (String(url).endsWith("/credits")) return new Response(null, { status: 403 });
	assert.equal(String(url), "https://openrouter.ai/api/v1/key");
	return Response.json({ data: { usage_daily: 3.42, limit: 25, limit_remaining: 18.7, limit_reset: "monthly" } });
};
const pi = {
	registerFlag() {},
	getFlag: (name: string) => name === "usage-widget",
	on: (event: string, handler: unknown) => { handlers.set(event, handler); },
	registerCommand: (_name, options) => { command = options.handler; },
} satisfies Pick<ExtensionAPI, "registerFlag" | "getFlag" | "on" | "registerCommand">;
usageExtension(pi as unknown as ExtensionAPI);
const ctx = {
	hasUI: true,
	ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setWidget: (_id: string, lines: string[] | undefined) => { widget = lines?.join("\n") ?? ""; },
		setStatus: (_id: string, text: string | undefined) => { footer = text ?? ""; },
		notify() {},
	},
	modelRegistry: {
		getProviderAuth: async (provider: string) => {
			lookups.push(provider);
			return configured && provider === "openrouter"
				? { auth: { apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1" } } : undefined;
		},
	},
} as unknown as ExtensionCommandContext;
async function emit<E extends ExtensionEvent>(event: E) {
	await (handlers.get(event.type) as ExtensionHandler<E>)(event, ctx);
}
try {
	await emit({ type: "session_start", reason: "new" });
	assert.ok(command);
	await command("", ctx);
	assert.equal(requests, 2);
	assert.match(footer, /OpenRouter:\$3.42\/d,\$6.30\/\$25\//);
	assert.match(widget, /key: [█░]+/);
	lookups.length = 0;
	mock.timers.tick(2000);
	await setImmediate();
	assert.equal(requests, proactive ? 4 : 2);
	assert.deepEqual(lookups, proactive ? ["openrouter"] : []);
	if (!proactive) assert.match(footer, /OpenRouter:--\/d,--\/\$25/);
	mock.timers.tick(1000);
	await setImmediate();
	assert.equal(requests, proactive ? 4 : 2);
	configured = false;
	await command("", ctx);
	assert.doesNotMatch(footer, /OpenRouter/);
	assert.doesNotMatch(widget, /OpenRouter/);
} finally {
	await emit({ type: "session_shutdown", reason: "quit" });
	mock.timers.reset();
}
