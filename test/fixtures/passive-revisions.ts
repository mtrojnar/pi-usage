import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionEvent, ExtensionHandler, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import usageExtension from "../../index.ts";

mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_000 });
const handlers = new Map<string, unknown>();
let command: RegisteredCommand["handler"] | undefined;
const widgets: string[][] = [];
const auth = { auth: { apiKey: "test-key", baseUrl: "https://api.kimi.com/coding" }, source: "test" };
let authResult: Promise<typeof auth | undefined> = Promise.resolve(auth);
let finishResponse!: (response: Response) => void;
const response = new Promise<Response>((resolve) => { finishResponse = resolve; });
let requests = 0;
globalThis.fetch = async () => {
	requests++;
	return requests === 1 ? response : Response.json({ usage: { limit: 100, used: 10 } });
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
	model: { provider: "kimi-coding", id: "kimi-for-coding" },
	ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setWidget: (_id: string, lines: string[] | undefined) => { if (lines) widgets.push(lines); },
		setStatus() {}, notify() {},
	},
	modelRegistry: {
		getProviderAuth: (provider: string) => provider === "kimi-coding" ? authResult : Promise.resolve(undefined),
		getProvider: () => undefined,
	},
} as unknown as ExtensionCommandContext;
async function emit<E extends ExtensionEvent>(event: E): Promise<void> {
	const handler = handlers.get(event.type) as ExtensionHandler<E> | undefined;
	assert.ok(handler);
	await handler(event, ctx);
}
function text(): string { return widgets.at(-1)?.join("\n") ?? ""; }

try {
	await emit({ type: "session_start", reason: "new" });
	await emit({ type: "after_provider_response", status: 429, headers: {} });
	assert.ok(command);
	const refresh = command("", ctx);
	await setImmediate();
	assert.equal(requests, 1);
	mock.timers.tick(30_000);
	await emit({ type: "after_provider_response", status: 200, headers: {} });
	assert.match(text(), /Kimi Coding.*available/);
	finishResponse(new Response("usage request failed", { status: 500 }));
	await refresh;
	assert.match(text(), /Kimi Coding.*available/, "late failure must not overwrite passive recovery");
	assert.doesNotMatch(text(), /usage request failed/);

	// The bare response at 30s changed state but must not defer the 60s check.
	mock.timers.tick(30_000);
	await setImmediate();
	assert.equal(requests, 2, "availability updates must not extend quota freshness");
	assert.match(text(), /10%/);

	// An unavailable auth result must likewise not remove newer passive data.
	let finishAuth!: (value: undefined) => void;
	authResult = new Promise((resolve) => { finishAuth = resolve; });
	const unavailableRefresh = command("", ctx);
	await setImmediate();
	await emit({ type: "after_provider_response", status: 200, headers: {} });
	finishAuth(undefined);
	await unavailableRefresh;
	assert.match(text(), /Kimi Coding.*available/);
	assert.match(text(), /10%/);
} finally {
	await emit({ type: "session_shutdown", reason: "quit" });
	mock.timers.reset();
}
