import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// ───────── Types ─────────

export interface CodexUsage {
	planType: string;
	activeLimit: string;
	primaryUsedPercent?: number;     // 5hr window
	secondaryUsedPercent?: number;   // weekly window
	codeReviewUsedPercent?: number;
	primaryWindowMinutes: number;
	secondaryWindowMinutes: number;
	codeReviewWindowMinutes?: number;
	primaryResetAfterSeconds: number;
	secondaryResetAfterSeconds: number;
	codeReviewResetAfterSeconds?: number;
	primaryResetAt: number;          // unix timestamp seconds
	secondaryResetAt: number;
	codeReviewResetAt?: number;
	primaryOverSecondaryLimitPercent: number;
	creditsHasCredits: boolean;
	creditsBalance: string;
	creditsUnlimited: boolean;
	source?: "usage_api" | "probe" | "headers";
	error?: string;
}

export type GoModelStatus = "available" | "rate_limited" | "credits_error" | "error" | "no_key";
export type SubscriptionProbeApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type GoProbeApi = Extract<SubscriptionProbeApi, "openai-completions" | "anthropic-messages">;

export type AnthropicAuthType = "oauth" | "api_key";

export interface AnthropicAuth {
	token: string;
	type: AnthropicAuthType;
	source: string;
}

export interface AuthApiKeyCredential {
	type?: "api_key";
	key?: string;
}

export interface CodexOAuthCredential {
	type?: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

export interface CopilotOAuthCredential extends CodexOAuthCredential {
	enterpriseUrl?: string;
	availableModelIds?: string[];
}

export type AuthJson = Record<string, AuthApiKeyCredential | CodexOAuthCredential | undefined>;

export interface SubscriptionProbeModel {
	id: string;
	api: SubscriptionProbeApi;
	endpoint: string;
	costRank: number;
	headers?: Record<string, string>;
}

export interface GoCheckModel extends SubscriptionProbeModel {
	api: GoProbeApi;
}

export interface CopilotAuth {
	token: string;
	source: string;
	baseUrl: string;
	enterpriseDomain?: string;
	availableModelIds?: string[];
}

export interface CopilotRateLimitWindow {
	limit?: number;
	remaining?: number;
	used?: number;
	usedPercent?: number;
	remainingPercent?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
	resource?: string;
}

export type CopilotUsageWindowKey = "requests" | "premiumRequests";

export interface CopilotUsage {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	availableModels?: number;
	source?: "probe" | "headers";
	requests?: CopilotRateLimitWindow;
	premiumRequests?: CopilotRateLimitWindow;
	retryAfterSeconds?: number;
	retryResetAt?: number;
	errorMessage?: string;
	error?: string;
}

export interface AnthropicUsageWindow {
	utilizationPercent: number;   // 0..100 of the plan window
	resetAfterSeconds?: number;
	resetAt?: number;             // unix timestamp seconds
	status?: string;              // "allowed" | "allowed_warning" | "rejected"
}

export interface AnthropicUsage {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	authType?: AnthropicAuthType;
	source?: "usage_api" | "probe" | "headers";
	fiveHour?: AnthropicUsageWindow;   // 5-hour subscription window
	weekly?: AnthropicUsageWindow;     // 7-day subscription window
	retryAfterSeconds?: number;
	retryResetAt?: number;
	errorMessage?: string;
	error?: string;
}

export interface SubscriptionQuotaWindow {
	usedPercent?: number;
	remainingPercent?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
}

export interface SubscriptionUsage {
	provider: string;
	label: string;
	shortLabel: string;
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	quotaSource?: string;
	rolling?: SubscriptionQuotaWindow;
	weekly?: SubscriptionQuotaWindow;
	monthly?: SubscriptionQuotaWindow;
	retryAfterSeconds?: number;
	retryResetAt?: number;
	source?: "probe" | "headers";
	errorMessage?: string;
	error?: string;
}

export interface OpenCodeGoUsage extends SubscriptionUsage {
	/** Dashboard quota fetch/parse failure, shown alongside probe results. */
	quotaError?: string;
}

export interface OpenCodeGoQuotaConfig {
	workspaceId: string;
	authCookie: string;
	source: string;
}

export interface OpenCodeGoQuotaConfigState {
	config?: OpenCodeGoQuotaConfig;
	error?: string;
}

export interface OpenCodeGoQuotaResult {
	configured: boolean;
	source?: string;
	rolling?: SubscriptionQuotaWindow;
	weekly?: SubscriptionQuotaWindow;
	monthly?: SubscriptionQuotaWindow;
	error?: string;
}

export type RefreshTrigger = "startup" | "manual" | "auto";

/** Cached usage of every provider, as consumed by the report/widget/footer renderers. */
export interface UsageSnapshot {
	codex?: CodexUsage;
	anthropic?: AnthropicUsage;
	copilot?: CopilotUsage;
	go?: OpenCodeGoUsage;
	subscriptions: SubscriptionUsage[];
}

export interface SelectedModel {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
}

export interface UsageContext {
	hasUI: boolean;
	cwd: string;
	ui: ExtensionUIContext;
	model?: SelectedModel;
	isProjectTrusted?(): boolean;
}

export interface OpenAIUsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface OpenAIUsageResponse {
	plan_type?: string;
	rate_limit?: {
		limit_reached?: boolean;
		primary_window?: OpenAIUsageWindow | null;
		secondary_window?: OpenAIUsageWindow | null;
	} | null;
	code_review_rate_limit?: {
		primary_window?: OpenAIUsageWindow | null;
	} | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		balance?: string | null;
	} | null;
}

export type CodexUsageApiResult =
	| { success: true; usage: CodexUsage }
	| { success: false; error: string };
