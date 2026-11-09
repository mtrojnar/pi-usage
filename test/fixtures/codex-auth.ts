import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionEvent, ExtensionHandler, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import usageExtension from "../../index.ts";

mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_000 });
const handlers = new Map<string, unknown>();
let command: RegisteredCommand["handler"] | undefined;
let footer = "";
let widget = "";
let requests = 0;
let pendingResponse: Promise<Response> | undefined;
let requestSignal: AbortSignal | undefined;
const auth = { auth: {
	baseUrl: "https://chatgpt.com/backend-api",
	headers: { Authorization: "Bearer opaque-token", "ChatGPT-Account-Id": "account", "X-Gateway": "required" },
} };
let authResult: Promise<typeof auth | undefined> = Promise.resolve(auth);
const pi = {
	registerFlag() {},
	getFlag: (name: string) => name === "usage-widget",
	on: (event: string, handler: unknown) => {
		handlers.set(event, handler);
		return () => { handlers.delete(event); };
	},
	registerCommand: (_name, options) => { command = options.handler; },
} satisfies Pick<ExtensionAPI, "registerFlag" | "getFlag" | "on" | "registerCommand">;
usageExtension(pi as unknown as ExtensionAPI);
const ctx = {
	hasUI: true,
	model: { provider: "openai-codex", id: "codex-test" },
	ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setWidget: (_id: string, lines: string[] | undefined) => { widget = lines?.join("\n") ?? ""; },
		setStatus: (_id: string, text: string | undefined) => { footer = text ?? ""; },
		notify() {},
	},
	modelRegistry: {
		find: () => undefined,
		getProviderAuth: (provider: string) => provider === "openai-codex" ? authResult : Promise.resolve(undefined),
		getProvider: () => undefined,
	},
} as unknown as ExtensionCommandContext;
globalThis.fetch = async (url, init) => {
	requests++;
	assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
	const headers = new Headers(init?.headers);
	assert.equal(headers.get("authorization"), "Bearer opaque-token");
	assert.equal(headers.get("chatgpt-account-id"), "account");
	assert.equal(headers.get("x-gateway"), "required");
	requestSignal = init?.signal ?? undefined;
	if (pendingResponse) return pendingResponse;
	return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } } });
};
async function emit<E extends ExtensionEvent>(event: E): Promise<void> {
	const handler = handlers.get(event.type) as ExtensionHandler<E> | undefined;
	assert.ok(handler);
	await handler(event, ctx);
}
async function passive(percent: number): Promise<void> {
	await emit({ type: "after_provider_response", status: 200, headers: { "x-codex-primary-used-percent": String(percent) } });
}
async function activity(): Promise<void> {
	await emit({ type: "message_end", message: {
		role: "assistant", provider: "openai-codex", api: "openai-codex-responses", model: "codex-test",
		content: [], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} });
	mock.timers.tick(1000);
	await setImmediate();
}
try {
	assert.ok(command);
	await command("", ctx);
	assert.match(footer, /Codex:42%/);
	assert.equal(requests, 1);

	authResult = Promise.resolve(undefined);
	await command("", ctx);
	assert.doesNotMatch(footer, /Codex/);
	assert.doesNotMatch(widget, /Codex/);
	assert.equal(requests, 1, "missing auth must not send requests");

	await passive(55);
	let finishAuth!: (value: undefined) => void;
	authResult = new Promise((resolve) => { finishAuth = resolve; });
	const refresh = command("", ctx);
	await setImmediate();
	await passive(65);
	finishAuth(undefined);
	await refresh;
	assert.match(footer, /Codex:65%/, "manual cleanup must not erase newer passive state");

	await emit({ type: "session_start", reason: "new" });
	authResult = Promise.resolve(undefined);
	await activity();
	assert.doesNotMatch(footer, /Codex/, "scheduled missing auth must clear cached usage too");
	assert.doesNotMatch(widget, /Codex/);

	await passive(55);
	authResult = new Promise((resolve) => { finishAuth = resolve; });
	await activity();
	await passive(65);
	finishAuth(undefined);
	await setImmediate();
	assert.match(footer, /Codex:65%/, "scheduled cleanup must not erase newer passive state");

	authResult = Promise.resolve(auth);
	await activity();
	assert.match(footer, /Codex:42%/);
	assert.equal(requests, 2, "scheduled refresh must forward resolved authentication headers");

	let finishResponse!: (response: Response) => void;
	pendingResponse = new Promise((resolve) => { finishResponse = resolve; });
	await activity();
	assert.equal(requests, 3);
	authResult = Promise.resolve(undefined);
	await command("", ctx);
	assert.equal(requestSignal?.aborted, true, "logout must cancel a previously authenticated scheduled request");
	finishResponse(Response.json({ rate_limit: { primary_window: { used_percent: 42 } } }));
	await setImmediate();
	assert.doesNotMatch(footer, /Codex/, "a late scheduled result must not restore logged-out data");
	assert.doesNotMatch(widget, /Codex/);
} finally {
	await emit({ type: "session_shutdown", reason: "quit" });
	mock.timers.reset();
}
