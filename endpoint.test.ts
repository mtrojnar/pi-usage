import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { checkAnthropicUsageFromUsageApi } from "./src/anthropic.ts";
import { checkCodexUsageFromUsageApi } from "./src/codex.ts";
import { checkCopilotUsage } from "./src/copilot.ts";
import { CHECK_TIMEOUT_MS, MAX_BODY_BYTES } from "./src/config.ts";
import { readErrorMessage } from "./src/http.ts";
import { parseKimiUsagePayload } from "./src/kimi.ts";
import { checkOpenCodeGoUsage } from "./src/opencode-go.ts";
import { checkSubscriptionUsageApi } from "./src/subscription-probe.ts";
import type { UsageContext } from "./src/types.ts";

const realFetch = globalThis.fetch;
const ctx = { modelRegistry: { getProvider: () => undefined } } as unknown as Pick<UsageContext, "modelRegistry">;
const kimiConfig = {
	provider: "kimi-coding", label: "Kimi Coding", shortLabel: "Kimi",
	usageApi: { url: "https://api.kimi.com/coding/v1/usages", parse: parseKimiUsagePayload },
};
const kimiAuth = { apiKey: "test-key", baseUrl: "https://api.kimi.com/coding" };

interface Endpoint {
	name: string;
	body: string;
	check: (signal?: AbortSignal) => Promise<{ success: boolean; error?: string }>;
}
const jsonEndpoints: Endpoint[] = [
	{
		name: "Codex", body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 12 } } }),
		check: (signal) => checkCodexUsageFromUsageApi("test-token", "test-account", signal),
	},
	{
		name: "Anthropic", body: JSON.stringify({ five_hour: { utilization: 12 } }),
		check: (signal) => checkAnthropicUsageFromUsageApi("test-token", signal),
	},
	{
		name: "Kimi", body: JSON.stringify({ usage: { limit: "100", used: "12" } }),
		check: (signal) => checkSubscriptionUsageApi(kimiConfig, kimiAuth, signal),
	},
];
const endpoints: Endpoint[] = [...jsonEndpoints, {
	name: "OpenCode Go",
	body: "rollingUsage:$R[1]={usagePercent:12,resetInSec:60}",
	check: async (signal) => {
		const usage = await checkOpenCodeGoUsage(ctx, undefined, {
			config: { workspaceId: "test-workspace", authCookie: "test-cookie", source: "test" },
		}, signal);
		return { success: usage.available, error: usage.error ?? usage.quotaError };
	},
}];

for (const endpoint of endpoints) {
	describe(`${endpoint.name} endpoint contract`, () => {
		afterEach(() => { globalThis.fetch = realFetch; mock.timers.reset(); });

		it("accepts a complete valid response", async () => {
			globalThis.fetch = async (_url, init) => {
				assert.equal(init?.redirect, "error");
				assert.ok(init?.signal);
				return new Response(endpoint.body);
			};
			assert.equal((await endpoint.check()).success, true);
		});

		it("reports HTTP failures", async () => {
			globalThis.fetch = async () => new Response("HTTP 500", { status: 500 });
			const result = await endpoint.check();
			assert.equal(result.success, false);
			assert.match(result.error ?? "", /500/);
		});

		it("does not fetch with an already-aborted signal", async () => {
			let requests = 0;
			globalThis.fetch = async () => { requests++; return new Response(endpoint.body); };
			const controller = new AbortController();
			controller.abort();
			const result = await endpoint.check(controller.signal);
			assert.equal(result.success, false);
			assert.equal(requests, 0);
		});

		it("aborts requests that stall before response headers", async () => {
			mock.timers.enable({ apis: ["setTimeout"] });
			let requestSignal: AbortSignal | undefined;
			globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
				requestSignal = init?.signal ?? undefined;
				assert.ok(requestSignal);
				requestSignal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
			});
			const pending = endpoint.check();
			await setImmediate();
			mock.timers.tick(CHECK_TIMEOUT_MS);
			const result = await pending;
			assert.equal(requestSignal?.aborted, true);
			assert.equal(result.success, false);
			assert.match(result.error ?? "", /aborted/);
		});

		for (const termination of ["timeout", "abort"] as const) {
			it(`rejects a valid but incomplete body on ${termination}`, async () => {
				mock.timers.enable({ apis: ["setTimeout"] });
				let cancelled = false;
				globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
					start(controller) { controller.enqueue(new TextEncoder().encode(endpoint.body)); },
					cancel() { cancelled = true; },
				}));
				const controller = new AbortController();
				const pending = endpoint.check(controller.signal);
				await setImmediate();
				if (termination === "timeout") mock.timers.tick(CHECK_TIMEOUT_MS);
				else controller.abort();
				const result = await pending;
				assert.equal(cancelled, true);
				assert.equal(result.success, false, "partial data must not be accepted after cancellation");
				assert.match(result.error ?? "", termination === "timeout" ? /timed out/ : /aborted/);
			});
		}

		it("rejects oversized response bodies", async () => {
			globalThis.fetch = async () => new Response("x".repeat(MAX_BODY_BYTES + 1));
			const result = await endpoint.check();
			assert.equal(result.success, false);
			assert.match(result.error ?? "", /exceeded.*byte limit/);
		});

		it("rejects actual HTTP redirects without contacting the target", async () => {
			const paths: string[] = [];
			const server = createServer((request, response) => {
				paths.push(request.url ?? "");
				response.setHeader("Connection", "close");
				if (request.url === "/target") response.end(endpoint.body);
				else { response.writeHead(302, { Location: "/target" }); response.end(); }
			});
			await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
			try {
				const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/start`;
				// Route only the mocked request to loopback; never contact a provider.
				globalThis.fetch = async (_url, init) => realFetch(url, init);
				assert.equal((await endpoint.check()).success, false);
				assert.deepEqual(paths, ["/start"]);
			} finally {
				await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			}
		});
	});
}

for (const endpoint of jsonEndpoints) {
	describe(`${endpoint.name} JSON validation`, () => {
		afterEach(() => { globalThis.fetch = realFetch; });
		for (const body of ["{", "null", "[]", "true", '"text"', "{}"]) {
			it(`rejects unusable payload ${body}`, async () => {
				globalThis.fetch = async () => new Response(body);
				assert.equal((await endpoint.check()).success, false);
			});
		}
	});
}

describe("quota field validation", () => {
	afterEach(() => { globalThis.fetch = realFetch; });
	for (const value of [null, false, true, "", " ", "NaN", [], {}, [12]]) {
		it(`does not coerce ${JSON.stringify(value)} into usage`, async () => {
			globalThis.fetch = async () => Response.json({ rate_limit: { primary_window: { used_percent: value } } });
			assert.equal((await jsonEndpoints[0].check()).success, false);
			globalThis.fetch = async () => Response.json({ five_hour: { utilization: value } });
			assert.equal((await jsonEndpoints[1].check()).success, false);
			globalThis.fetch = async () => Response.json({ usage: { limit: 100, used: value } });
			assert.equal((await jsonEndpoints[2].check()).success, false);
		});
	}
	for (const value of [0, "0", 12, "12"]) {
		it(`accepts a valid numeric value ${JSON.stringify(value)}`, async () => {
			globalThis.fetch = async () => Response.json({ rate_limit: { primary_window: { used_percent: value } } });
			assert.equal((await jsonEndpoints[0].check()).success, true);
			globalThis.fetch = async () => Response.json({ five_hour: { utilization: value } });
			assert.equal((await jsonEndpoints[1].check()).success, true);
			globalThis.fetch = async () => Response.json({ usage: { limit: 100, used: value } });
			assert.equal((await jsonEndpoints[2].check()).success, true);
		});
	}

	it("ignores malformed optional Codex windows and metadata", async () => {
		globalThis.fetch = async () => Response.json({
			plan_type: {},
			rate_limit: { primary_window: { used_percent: 12 }, secondary_window: [], limit_reached: "false" },
			code_review_rate_limit: { primary_window: { used_percent: null } },
			credits: { has_credits: "false", unlimited: {}, balance: {} },
		});
		const result = await checkCodexUsageFromUsageApi("token", "account");
		assert.ok(result.success);
		assert.equal(result.usage.primaryUsedPercent, 12);
		assert.equal(result.usage.secondaryUsedPercent, undefined);
		assert.equal(result.usage.codeReviewUsedPercent, undefined);
		assert.equal(result.usage.planType, "unknown");
		assert.equal(result.usage.rateLimited, false);
		assert.equal(result.usage.creditsHasCredits, false);
		assert.equal(result.usage.creditsUnlimited, false);
		assert.equal(result.usage.creditsBalance, "");
	});

	it("preserves a valid Anthropic window when optional fields are malformed", async () => {
		globalThis.fetch = async () => Response.json({ five_hour: { utilization: 12, resets_at: {} }, seven_day: [] });
		const result = await checkAnthropicUsageFromUsageApi("token");
		assert.ok(result.success);
		assert.equal(result.usage.fiveHour?.utilizationPercent, 12);
		assert.equal(result.usage.fiveHour?.resetAt, undefined);
		assert.equal(result.usage.weekly, undefined);
	});

	it("tolerates malformed Kimi sub-windows without inventing quota data", () => {
		for (const limits of [null, {}, "bad", [null, false, {}, { window: {}, detail: {} }]]) {
			assert.equal(parseKimiUsagePayload({ limits }), undefined);
			assert.equal(parseKimiUsagePayload({ usage: { limit: 100, used: 12 }, limits })?.weekly?.usedPercent, 12);
		}
		assert.equal(parseKimiUsagePayload({ usage: { resetTime: "2030-01-01T00:00:00Z" } }), undefined);
		assert.equal(parseKimiUsagePayload({ usage: { limit: 100, used: 12, resetTime: {} } })?.weekly?.resetAt, undefined);
	});
});

describe("probe error JSON validation", () => {
	afterEach(() => { globalThis.fetch = realFetch; });
	it("uses an HTTP fallback when error fields are not strings", async () => {
		for (const value of [null, false, 12, {}, []]) {
			const body = { error: { message: value }, message: value, detail: value };
			assert.equal(await readErrorMessage(Response.json(body), "HTTP 500"), "HTTP 500");
			globalThis.fetch = async () => Response.json(body, { status: 500 });
			const usage = await checkCopilotUsage(ctx, { token: "test-token", source: "test", baseUrl: "https://api.githubcopilot.com" });
			assert.equal(usage.status, "error");
			assert.match(usage.errorMessage ?? "", /HTTP 500/);
		}
	});
});
