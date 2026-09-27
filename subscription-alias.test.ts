/**
 * Provider-ID alias tests.
 * Run with: npm test
 *
 * pi and omp disagree on how some providers are named — pi registers ClinePass
 * as `clinepass`, omp as `cline-pass`. A provider config declares every ID the
 * host may use, and the credential lookup, the model discovery, and the
 * selected-model match must all honour the whole set. Aliasing only the
 * credential resolves a key and then leaves the probe with no model to call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLINEPASS_AUTH_PROVIDER_IDS,
	CLINEPASS_HOST_PROVIDER_ID,
	CLINEPASS_PROVIDER,
} from "./src/clinepass.ts";
import {
	getSubscriptionAuth,
	getSubscriptionCheckModels,
	registryProviderIds,
	type SubscriptionProviderConfig,
} from "./src/subscription-probe.ts";
import { getSubscriptionProviderConfig } from "./src/subscriptions.ts";
import { canonicalProviderName } from "./src/usage-config.ts";
import type { BoundApiKey, SelectedModel, UsageContext } from "./src/types.ts";

const ORIGIN = "https://api.cline.bot/api/v1";

function clinePassConfig(): SubscriptionProviderConfig {
	const config = getSubscriptionProviderConfig(CLINEPASS_PROVIDER);
	assert.ok(config, "ClinePass must be a registered subscription provider");
	return config;
}

interface FakeModel {
	id: string;
	baseUrl: string;
}

/**
 * A registry that knows the given provider IDs and nothing else, recording
 * every lookup so "did this query an ID it should not have" is assertable.
 */
function fakeRegistry(auth: Partial<Record<string, BoundApiKey>>, models: Partial<Record<string, FakeModel[]>>) {
	const lookups: string[] = [];
	return {
		lookups,
		ctx: {
			modelRegistry: {
				getProviderAuth: async (provider: string) => {
					const found = auth[provider];
					return found ? { auth: { apiKey: found.apiKey, baseUrl: found.baseUrl }, source: found.source } : undefined;
				},
				getProvider: (provider: string) => {
					lookups.push(provider);
					const found = models[provider];
					return found
						? {
								baseUrl: ORIGIN,
								getModels: () =>
									found.map((model) => ({
										id: model.id,
										api: "openai-completions",
										baseUrl: model.baseUrl,
										cost: { input: 1, output: 1 },
									})),
							}
						: undefined;
				},
			},
		} as unknown as Pick<UsageContext, "modelRegistry">,
	};
}

// ───────── The alias list itself ─────────

describe("registryProviderIds", () => {
	it("defaults to the canonical provider alone", () => {
		assert.deepEqual(registryProviderIds({ provider: "zai", label: "Z.AI", shortLabel: "ZAI" }), ["zai"]);
	});

	it("puts the canonical ID first, then the aliases, deduplicated", () => {
		assert.deepEqual(
			registryProviderIds({
				provider: "clinepass",
				label: "ClinePass",
				shortLabel: "ClinePass",
				registryProviderIds: ["cline-pass", "clinepass"],
			}),
			["clinepass", "cline-pass"],
		);
	});

	it("covers both host spellings for ClinePass", () => {
		assert.deepEqual([...CLINEPASS_AUTH_PROVIDER_IDS], [CLINEPASS_PROVIDER, CLINEPASS_HOST_PROVIDER_ID]);
		assert.deepEqual(registryProviderIds(clinePassConfig()), [CLINEPASS_PROVIDER, CLINEPASS_HOST_PROVIDER_ID]);
	});
});

// ───────── Credential lookup ─────────

describe("getSubscriptionAuth with a host alias", () => {
	it("resolves the credential from the alias provider ID", async () => {
		const auth = { [CLINEPASS_HOST_PROVIDER_ID]: { apiKey: "host-key", baseUrl: ORIGIN, source: "host" } };
		const { ctx } = fakeRegistry(auth, {});
		assert.deepEqual(await getSubscriptionAuth(ctx, clinePassConfig()), auth[CLINEPASS_HOST_PROVIDER_ID]);
	});

	it("still prefers the canonical provider when the host registers that one", async () => {
		const auth = {
			[CLINEPASS_PROVIDER]: { apiKey: "canonical-key", baseUrl: ORIGIN, source: "canonical" },
			[CLINEPASS_HOST_PROVIDER_ID]: { apiKey: "host-key", baseUrl: ORIGIN, source: "host" },
		};
		const { ctx } = fakeRegistry(auth, {});
		assert.equal((await getSubscriptionAuth(ctx, clinePassConfig()))?.apiKey, "canonical-key");
	});

	it("returns undefined when no spelling carries a credential", async () => {
		const { ctx } = fakeRegistry({}, {});
		assert.equal(await getSubscriptionAuth(ctx, clinePassConfig()), undefined);
	});
});

// ───────── Model discovery ─────────

describe("getSubscriptionCheckModels with a host alias", () => {
	it("discovers models a host registers under the alias", async () => {
		const { ctx } = fakeRegistry({}, { [CLINEPASS_HOST_PROVIDER_ID]: [{ id: "mimo-v2.5", baseUrl: `${ORIGIN}/chat` }] });
		const models = await getSubscriptionCheckModels(clinePassConfig(), undefined, ctx);
		assert.deepEqual(models.map((model) => model.id), ["mimo-v2.5"]);
	});

	it("still discovers models a host registers under the canonical ID", async () => {
		const { ctx } = fakeRegistry({}, { [CLINEPASS_PROVIDER]: [{ id: "mimo-v2.5", baseUrl: `${ORIGIN}/chat` }] });
		const models = await getSubscriptionCheckModels(clinePassConfig(), undefined, ctx);
		assert.deepEqual(models.map((model) => model.id), ["mimo-v2.5"]);
	});

	it("merges the models of every spelling the host registers", async () => {
		const { ctx } = fakeRegistry({}, {
			[CLINEPASS_PROVIDER]: [{ id: "canonical-model", baseUrl: `${ORIGIN}/chat` }],
			[CLINEPASS_HOST_PROVIDER_ID]: [{ id: "host-model", baseUrl: `${ORIGIN}/chat` }],
		});
		const ids = (await getSubscriptionCheckModels(clinePassConfig(), undefined, ctx)).map((model) => model.id);
		assert.deepEqual(ids.sort(), ["canonical-model", "host-model"]);
	});

	it("queries only the canonical ID for a provider that declares no alias", async () => {
		const config = getSubscriptionProviderConfig("zai");
		assert.ok(config);
		const { ctx, lookups } = fakeRegistry({}, { zai: [{ id: "glm-4.5-air", baseUrl: "https://api.z.ai/v1/chat" }] });
		await getSubscriptionCheckModels(config, undefined, ctx);
		assert.deepEqual(lookups, ["zai"]);
	});
});

// ───────── Selected-model matching ─────────

describe("selected-model matching across host aliases", () => {
	const selected = (provider: string): SelectedModel =>
		({ provider, id: `${provider}/live-model`, api: "openai-completions", baseUrl: `${ORIGIN}/chat` }) as SelectedModel;

	it("treats a selected model on the alias as this provider's own", async () => {
		const { ctx } = fakeRegistry({}, {});
		const models = await getSubscriptionCheckModels(clinePassConfig(), selected(CLINEPASS_HOST_PROVIDER_ID), ctx);
		assert.deepEqual(models.map((model) => model.id), [`${CLINEPASS_HOST_PROVIDER_ID}/live-model`]);
	});

	it("still ignores a selected model belonging to a different provider", async () => {
		const { ctx } = fakeRegistry({}, { [CLINEPASS_PROVIDER]: [{ id: "mimo-v2.5", baseUrl: `${ORIGIN}/chat` }] });
		const models = await getSubscriptionCheckModels(clinePassConfig(), selected("opencode"), ctx);
		assert.deepEqual(models.map((model) => model.id), ["mimo-v2.5"]);
	});
});

// ───────── Display settings ─────────

describe("canonicalProviderName", () => {
	it("accepts the host spelling in display settings", () => {
		assert.equal(canonicalProviderName(CLINEPASS_HOST_PROVIDER_ID), CLINEPASS_PROVIDER);
		assert.equal(canonicalProviderName(CLINEPASS_PROVIDER), CLINEPASS_PROVIDER);
		assert.equal(canonicalProviderName("  CLINE-PASS  "), CLINEPASS_PROVIDER);
	});
});
