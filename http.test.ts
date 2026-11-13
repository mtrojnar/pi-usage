import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSameOrigin, fetchSameOriginWithTimeout, fetchWithTimeout } from "./src/http.ts";

type RoutedFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface MockBridge {
	version?: number;
	fetchForOrigin?: (origin: string) => RoutedFetch | undefined;
	fetchForProvider?: (provider: string) => RoutedFetch | undefined;
	resolveForOrigin?: (origin: string) => { matched: boolean; url: string | null } | undefined;
	status?: () => { disabled: boolean; allProxy: string | null };
}

type BridgeGlobal = { __piProxyRouter?: MockBridge };

function installBridge(bridge: MockBridge | undefined): () => void {
	const holder = globalThis as BridgeGlobal;
	const saved = holder.__piProxyRouter;
	if (bridge === undefined) delete holder.__piProxyRouter;
	else holder.__piProxyRouter = bridge;
	return () => {
		if (saved === undefined) delete holder.__piProxyRouter;
		else holder.__piProxyRouter = saved;
	};
}

const ORIGIN = "https://api.example.test";
const url = `${ORIGIN}/v1/usage`;

test("without the bridge, requests use the default fetch pipeline", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	const calls: Array<{ url: string; init: RequestInit }> = [];
	t.mock.method(globalThis, "fetch", async (requestUrl: string, init: RequestInit) => {
		calls.push({ url: requestUrl, init });
		return new Response("ok");
	});

	const response = await fetchSameOrigin(url, ORIGIN, { method: "GET" });
	assert.equal(response.status, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, url);
	assert.equal(calls[0].init.redirect, "error");
});

test("a routed origin uses the bridge fetch and keeps redirect error", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	const seenOrigins: string[] = [];
	const seen: Array<{ url: string; init: RequestInit }> = [];
	const bridge: MockBridge = {
		version: 1,
		fetchForOrigin: (origin) => {
			seenOrigins.push(origin);
			return async (requestUrl, init) => {
				seen.push({ url: requestUrl, init: init ?? {} });
				return new Response("routed");
			};
		},
		resolveForOrigin: () => ({ matched: true, url: "http://proxy.example.test:7890" }),
		status: () => ({ disabled: false, allProxy: null }),
	};
	installBridge(bridge);
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("default pipeline must not be used");
	});

	const response = await fetchSameOriginWithTimeout(url, `${ORIGIN}/v1`, { method: "GET" });
	assert.equal(await response.text(), "routed");
	// The bridge receives the credential base URL and normalizes the origin itself.
	assert.deepEqual(seenOrigins, [`${ORIGIN}/v1`]);
	assert.equal(seen[0].init.redirect, "error");
});

test("an unmatched rule falls back to the default pipeline", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	installBridge({
		version: 1,
		fetchForOrigin: () => undefined,
		fetchForProvider: () => undefined,
	});
	let defaultCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		defaultCalls += 1;
		return new Response("direct");
	});

	const response = await fetchSameOrigin(url, ORIGIN, {});
	assert.equal(await response.text(), "direct");
	assert.equal(defaultCalls, 1);
});

test("a throwing bridge degrades to the default pipeline", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	installBridge({
		version: 1,
		fetchForOrigin: () => {
			throw new Error("Unsupported proxy URL: ftp://x");
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response("fallback"));

	const response = await fetchSameOrigin(url, ORIGIN, {});
	assert.equal(await response.text(), "fallback");
});

test("provider routes resolve through fetchForProvider", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	const seenProviders: string[] = [];
	installBridge({
		version: 1,
		fetchForOrigin: () => undefined,
		fetchForProvider: (provider) => {
			seenProviders.push(provider);
			return async () => new Response("provider route");
		},
	});
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("default pipeline must not be used");
	});

	const response = await fetchWithTimeout("https://dashboard.example.test/go", {}, undefined, { provider: "opencode-go" });
	assert.equal(await response.text(), "provider route");
	assert.deepEqual(seenProviders, ["opencode-go"]);
});

test("routed failures are annotated with the resolved proxy", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	const failure = new TypeError("fetch failed");
	installBridge({
		version: 1,
		fetchForOrigin: () => async () => {
			throw failure;
		},
		resolveForOrigin: () => ({ matched: true, url: "http://proxy.example.test:7890" }),
		status: () => ({ disabled: false, allProxy: null }),
	});

	await assert.rejects(
		fetchSameOrigin(url, ORIGIN, {}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "fetch failed (via http://proxy.example.test:7890)");
			assert.equal((error as { cause?: unknown }).cause, failure);
			return true;
		},
	);
});

test("allproxy and provider failures describe the route generically", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	installBridge({
		version: 1,
		fetchForOrigin: () => async () => {
			throw new Error("boom");
		},
		resolveForOrigin: () => undefined,
		status: () => ({ disabled: false, allProxy: "socks5h://127.0.0.1:7890" }),
	});

	await assert.rejects(
		fetchSameOrigin(url, ORIGIN, {}),
		/fetch failed|boom \(via socks5h:\/\/127\.0\.0\.1:7890\)/,
	);
});

test("abort errors pass through the routed path unannotated", async (t) => {
	const restore = installBridge(undefined);
	t.after(restore);
	const abortError = new Error("This operation was aborted");
	abortError.name = "AbortError";
	installBridge({
		version: 1,
		fetchForOrigin: () => async () => {
			throw abortError;
		},
	});

	await assert.rejects(fetchSameOrigin(url, ORIGIN, {}), (error: unknown) => error === abortError);
});

test("credential origin binding still applies before any routing", async () => {
	const restore = installBridge(undefined);
	try {
		installBridge({
			version: 1,
			fetchForOrigin: () => async () => new Response("should not run"),
		});
		await assert.rejects(
			fetchSameOrigin("https://other.example.test/v1/usage", ORIGIN, {}),
			/Refusing credentialed request/,
		);
	} finally {
		restore();
	}
});
