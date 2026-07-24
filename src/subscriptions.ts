import type { SubscriptionProbeModel } from "./types.ts";
import type { SubscriptionProviderConfig } from "./subscription-probe.ts";
import { KIMI_CODING_USAGE_URL } from "./config.ts";
import { parseKimiUsagePayload } from "./kimi.ts";

function model(
	id: string,
	api: SubscriptionProbeModel["api"],
	endpoint: string,
	costRank: number,
): SubscriptionProbeModel {
	return { id, api, endpoint, costRank };
}

const OPENCODE_ZEN_MODELS: SubscriptionProbeModel[] = [
	model("big-pickle", "openai-completions", "https://opencode.ai/zen/v1/chat/completions", 0),
	model("deepseek-v4-flash-free", "openai-completions", "https://opencode.ai/zen/v1/chat/completions", 1),
	model("gpt-5-nano", "openai-responses", "https://opencode.ai/zen/v1/responses", 2),
	model("claude-haiku-4-5", "anthropic-messages", "https://opencode.ai/zen/v1/messages", 3),
];

export const SUBSCRIPTION_PROVIDERS: SubscriptionProviderConfig[] = [
	{
		provider: "opencode",
		label: "OpenCode Zen",
		shortLabel: "Zen",
		authProviderIds: ["opencode", "opencode-go"],
		envKeys: ["OPENCODE_API_KEY"],
		supportedApis: ["openai-completions", "openai-responses", "anthropic-messages"],
		preferredModelIds: ["big-pickle", "deepseek-v4-flash-free", "gpt-5-nano", "claude-haiku-4-5"],
		documentedModels: OPENCODE_ZEN_MODELS,
		quotaHeaderPrefixes: ["opencode"],
	},
	{
		provider: "kimi-coding",
		label: "Kimi Coding",
		shortLabel: "Kimi",
		envKeys: ["KIMI_API_KEY"],
		supportedApis: ["anthropic-messages"],
		preferredModelIds: ["k2p7", "kimi-for-coding", "kimi-k2-thinking"],
		quotaHeaderPrefixes: ["kimi-coding", "kimi"],
		usageApi: { url: KIMI_CODING_USAGE_URL, parse: parseKimiUsagePayload },
	},
	{
		provider: "zai",
		label: "Z.AI",
		shortLabel: "Z.AI",
		envKeys: ["ZAI_API_KEY"],
		supportedApis: ["openai-completions"],
		preferredModelIds: ["glm-4.5-air", "glm-5-turbo", "glm-5.1"],
		quotaHeaderPrefixes: ["zai"],
	},
	{
		provider: "zai-coding-cn",
		label: "Z.AI Coding CN",
		shortLabel: "Z.AI CN",
		envKeys: ["ZAI_CODING_CN_API_KEY"],
		supportedApis: ["openai-completions"],
		preferredModelIds: ["glm-4.5-air", "glm-5-turbo", "glm-5.1"],
		quotaHeaderPrefixes: ["zai-coding-cn", "zai"],
	},
	{
		provider: "xiaomi-token-plan-ams",
		label: "Xiaomi Token Plan AMS",
		shortLabel: "Xiaomi AMS",
		envKeys: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
		supportedApis: ["openai-completions"],
		preferredModelIds: ["mimo-v2-omni", "mimo-v2.5", "mimo-v2-pro"],
		quotaHeaderPrefixes: ["xiaomi-token-plan-ams", "xiaomi"],
	},
	{
		provider: "xiaomi-token-plan-cn",
		label: "Xiaomi Token Plan CN",
		shortLabel: "Xiaomi CN",
		envKeys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
		supportedApis: ["openai-completions"],
		preferredModelIds: ["mimo-v2-omni", "mimo-v2.5", "mimo-v2-pro"],
		quotaHeaderPrefixes: ["xiaomi-token-plan-cn", "xiaomi"],
	},
	{
		provider: "xiaomi-token-plan-sgp",
		label: "Xiaomi Token Plan SGP",
		shortLabel: "Xiaomi SGP",
		envKeys: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
		supportedApis: ["openai-completions"],
		preferredModelIds: ["mimo-v2-omni", "mimo-v2.5", "mimo-v2-pro"],
		quotaHeaderPrefixes: ["xiaomi-token-plan-sgp", "xiaomi"],
	},
];

const SUBSCRIPTION_PROVIDER_MAP = new Map(SUBSCRIPTION_PROVIDERS.map((config) => [config.provider, config]));

export function getSubscriptionProviderConfig(provider: string | undefined): SubscriptionProviderConfig | undefined {
	return provider ? SUBSCRIPTION_PROVIDER_MAP.get(provider) : undefined;
}
