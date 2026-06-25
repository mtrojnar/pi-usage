import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

// ───────── Types ─────────

export interface CodexUsage {
	planType: string;
	activeLimit: string;
	primaryUsedPercent: number;      // 5hr window
	secondaryUsedPercent: number;    // weekly window
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
	source?: "usage_api" | "probe";
	error?: string;
}

export type GoModelStatus = "available" | "rate_limited" | "credits_error" | "error" | "no_key";
export type GoProbeApi = "openai-completions" | "anthropic-messages";

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

export type AuthJson = Record<string, AuthApiKeyCredential | CodexOAuthCredential | undefined>;

export interface GoCheckModel {
	id: string;
	api: GoProbeApi;
	endpoint: string;
	costRank: number;
}

export interface OpenCodeGoUsage {
	available: boolean;
	status: GoModelStatus;
	workingModel?: string;
	rateLimitedModel?: string;
	checkedModels?: number;
	totalModels?: number;
	quotaConfigured?: boolean;
	quotaSource?: string;
	rollingUsedPercent?: number;
	rollingRemainingPercent?: number;
	rollingResetAfterSeconds?: number;
	rollingResetAt?: number;
	weeklyUsedPercent?: number;
	weeklyRemainingPercent?: number;
	weeklyResetAfterSeconds?: number;
	weeklyResetAt?: number;
	monthlyUsedPercent?: number;
	monthlyRemainingPercent?: number;
	monthlyResetAfterSeconds?: number;
	monthlyResetAt?: number;
	quotaError?: string;
	errorMessage?: string;
	error?: string;
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
	rollingUsedPercent?: number;
	rollingRemainingPercent?: number;
	rollingResetAfterSeconds?: number;
	rollingResetAt?: number;
	weeklyUsedPercent?: number;
	weeklyRemainingPercent?: number;
	weeklyResetAfterSeconds?: number;
	weeklyResetAt?: number;
	monthlyUsedPercent?: number;
	monthlyRemainingPercent?: number;
	monthlyResetAfterSeconds?: number;
	monthlyResetAt?: number;
	error?: string;
}

export type RefreshTrigger = "startup" | "manual" | "auto";

export interface UsageContext {
	hasUI: boolean;
	cwd: string;
	ui: ExtensionUIContext;
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
