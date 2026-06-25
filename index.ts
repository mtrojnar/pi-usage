/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex (5hr & weekly) and OpenCode Go usage limits at startup.
 * Displays a startup report by default; persistent widget is opt-in.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionUIContext,
	Theme,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ───────── Types ─────────

interface CodexUsage {
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

type GoModelStatus = "available" | "rate_limited" | "credits_error" | "error" | "no_key";
type GoProbeApi = "openai-completions" | "anthropic-messages";

interface AuthApiKeyCredential {
	type?: "api_key";
	key?: string;
}

interface CodexOAuthCredential {
	type?: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

type AuthJson = Record<string, AuthApiKeyCredential | CodexOAuthCredential | undefined>;

interface GoCheckModel {
	id: string;
	api: GoProbeApi;
	endpoint: string;
	costRank: number;
}

interface OpenCodeGoUsage {
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

interface OpenCodeGoQuotaConfig {
	workspaceId: string;
	authCookie: string;
	source: string;
}

interface OpenCodeGoQuotaConfigState {
	config?: OpenCodeGoQuotaConfig;
	error?: string;
}

interface OpenCodeGoQuotaResult {
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

type RefreshTrigger = "startup" | "manual" | "auto";

interface UsageContext {
	hasUI: boolean;
	cwd: string;
	ui: ExtensionUIContext;
	isProjectTrusted?(): boolean;
}

// ───────── Config ─────────

const WIDGET_ID = "pi-usage";
const USAGE_WIDGET_FLAG = "usage-widget";
const NO_USAGE_WIDGET_FLAG = "no-usage-widget";
const USAGE_CONFIG_FILE = "pi-usage.json";
const USAGE_WIDGET_HELP = `Widget disabled. Enable: add {"showWidget": true} to ${USAGE_CONFIG_FILE} or run with --${USAGE_WIDGET_FLAG}.`;
const CHECK_TIMEOUT_MS = 15_000;
const BODY_READ_TIMEOUT_MS = CHECK_TIMEOUT_MS;
const MAX_BODY_BYTES = 512_000;
const AUTO_REFRESH_MINUTES = parseEnvInt("PI_USAGE_REFRESH_MIN", 30);
const CODEX_PROBE_MODEL = "gpt-5.4-mini";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_QUOTA_CONFIG_FILE = path.join("opencode-quota", "opencode-go.json");
const OPENCODE_GO_DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace";
const OPENAI_CODEX_PROVIDER = "openai-codex";

// OpenCode Go publishes a fixed dollar limit, but no public usage/balance API.
// These are used only as the probe fallback when the installed pi model registry
// does not yet include a documented Go model.
const DOCUMENTED_GO_MODELS: GoCheckModel[] = [
	{ id: "qwen3.5-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 1 },
	{ id: "minimax-m2.5", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 2 },
	{ id: "minimax-m2.7", api: "anthropic-messages", endpoint: "https://opencode.ai/zen/go/v1/messages", costRank: 3 },
	{ id: "qwen3.6-plus", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 4 },
	{ id: "mimo-v2-omni", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 5 },
	{ id: "kimi-k2.5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 6 },
	{ id: "glm-5", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 7 },
	{ id: "kimi-k2.6", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 8 },
	{ id: "mimo-v2-pro", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 9 },
	{ id: "glm-5.1", api: "openai-completions", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", costRank: 10 },
];

const GO_COLOR_MAP: Record<GoModelStatus, ThemeColor> = {
	available: "success",
	rate_limited: "warning",
	credits_error: "error",
	error: "warning",
	no_key: "dim",
};

const GO_STATUS_TEXT: Record<GoModelStatus, string> = {
	available: "available",
	rate_limited: "rate limited",
	credits_error: "credits exhausted",
	error: "error",
	no_key: "no key",
};

// ───────── Helpers ─────────

function parseEnvInt(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			console.warn(`pi-usage: unrecognized boolean "${value.trim()}" in config`);
			return undefined;
	}
}

function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR || "~/.pi/agent";
	return dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

function authJsonPath(): string {
	return path.join(agentDir(), "auth.json");
}

function usageConfigPath(): string {
	return path.join(agentDir(), USAGE_CONFIG_FILE);
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function parseBoolSetting(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return parseBoolValue(value);
	return undefined;
}

function widgetSettingFromConfig(config: Record<string, unknown> | undefined): boolean | undefined {
	if (!config) return undefined;
	return parseBoolSetting(config.showWidget) ?? parseBoolSetting(config.widget);
}

function readUsageWidgetSetting(ctx?: UsageContext): boolean | undefined {
	let value = widgetSettingFromConfig(readJsonObject(usageConfigPath()));
	const isProjectTrusted = typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted();
	if (isProjectTrusted) {
		const projectValue = widgetSettingFromConfig(readJsonObject(path.join(ctx.cwd, ".pi", USAGE_CONFIG_FILE)));
		if (projectValue !== undefined) value = projectValue;
	}
	return value;
}

function parseAuthJson(content: string | undefined): AuthJson {
	return content ? JSON.parse(content) as AuthJson : {};
}

function readAuthJson(): AuthJson | undefined {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		return parseAuthJson(fs.readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}
}

function dedupe(list: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function configPathCandidates(fileName: string): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	const explicit = process.env.OPENCODE_GO_QUOTA_CONFIG?.trim();
	if (explicit) candidates.push(explicit);

	const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
	if (xdgConfig) candidates.push(path.join(xdgConfig, "opencode", fileName));
	candidates.push(path.join(home, ".config", "opencode", fileName));

	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
		candidates.push(path.join(appData, "opencode", fileName));
		candidates.push(path.join(localAppData, "opencode", fileName));
	} else if (process.platform === "darwin") {
		candidates.push(path.join(home, "Library", "Application Support", "opencode", fileName));
	}

	return dedupe(candidates);
}

function validatePrivateConfigFile(configPath: string): string | undefined {
	if (process.platform === "win32") return undefined;

	const stats = fs.statSync(configPath);
	if (!stats.isFile()) return `${configPath} must be a regular file`;
	if ((stats.mode & 0o077) !== 0) {
		return `${configPath} contains an auth cookie and must not be accessible by group or others; set mode 0600`;
	}
	return undefined;
}

function getOpenCodeGoQuotaConfig(): OpenCodeGoQuotaConfigState {
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId || authCookie) {
		if (workspaceId && authCookie) {
			return { config: { workspaceId, authCookie, source: "env" } };
		}
		return {
			error: "OpenCode Go quota env needs both OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE",
		};
	}

	for (const configPath of configPathCandidates(OPENCODE_GO_QUOTA_CONFIG_FILE)) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const permissionError = validatePrivateConfigFile(configPath);
			if (permissionError) return { error: permissionError };

			const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
				workspaceId?: unknown;
				authCookie?: unknown;
			};
			const fileWorkspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
			const fileAuthCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
			if (!fileWorkspaceId || !fileAuthCookie) {
				return { error: `${configPath} needs workspaceId and authCookie` };
			}
			return {
				config: {
					workspaceId: fileWorkspaceId,
					authCookie: fileAuthCookie,
					source: configPath,
				},
			};
		} catch (e: unknown) {
			return {
				error: `${configPath}: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	return {};
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function resolveConfigValue(config: string): string | undefined {
	// Treat value as env var name, fall back to literal string.
	const resolved = process.env[config];
	return resolved !== undefined ? resolved : config;
}

async function getCodexToken(): Promise<{ token: string; accountId: string } | undefined> {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;

		// Let pi own OAuth refresh, locking, and auth.json permissions.
		const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
		const authStorage = AuthStorage.create(authPath);
		const token = await authStorage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
		if (!token) return undefined;

		const codex = authStorage.get(OPENAI_CODEX_PROVIDER) as CodexOAuthCredential | undefined;
		const accountId = codex?.accountId ?? extractAccountId(token);
		if (!accountId) return undefined;
		return { token, accountId };
	} catch {
		return undefined;
	}
}

function getOpenCodeApiKey(): string | undefined {
	const auth = readAuthJson();
	const goKey = getAuthApiKey(auth, "opencode-go");
	if (goKey) return goKey;
	const zenKey = getAuthApiKey(auth, "opencode");
	if (zenKey) return zenKey;
	return process.env.OPENCODE_API_KEY;
}

function getAuthApiKey(auth: AuthJson | undefined, provider: string): string | undefined {
	const credential = auth?.[provider] as AuthApiKeyCredential | undefined;
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	return resolveConfigValue(credential.key);
}

function truncate(text: string, maxLen: number): string {
	return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}h`;
	return `${Math.round(seconds / 86400 * 10) / 10}d`;
}

function formatResetTime(unixTsSec: number): string {
	const diff = unixTsSec * 1000 - Date.now();
	if (diff <= 0) return "now";
	return formatDuration(diff / 1000);
}

function progressBar(percent: number, width: number = 20): string {
	const filled = Math.round((Math.min(percent, 100) / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

function usageColor(percent: number): ThemeColor {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function parseHeaderNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseHeaderBool(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
}

async function readResponseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => {});
	}, BODY_READ_TIMEOUT_MS);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			chunks.push(value);
			totalBytes += value.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				throw new Error(`Response body exceeded ${MAX_BODY_BYTES} byte limit`);
			}
		}
	} finally {
		clearTimeout(timeout);
		try { reader.releaseLock(); } catch { /* ignore */ }
	}

	if (timedOut) throw new Error("Response body read timed out");

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function readResponseJson<T>(response: Response): Promise<T> {
	return JSON.parse(await readResponseText(response)) as T;
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch { /* ignore */ }
}

function statusIcon(status: GoModelStatus): string {
	switch (status) {
		case "available": return "✓";
		case "rate_limited": return "⏳";
		case "credits_error": return "✗";
		case "error": return "⚠";
		case "no_key": return "—";
	}
}

interface OpenAIUsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface OpenAIUsageResponse {
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

type CodexUsageApiResult =
	| { success: true; usage: CodexUsage }
	| { success: false; error: string };

function windowUsedPercent(window: OpenAIUsageWindow | null | undefined): number {
	return clampPercent(Number(window?.used_percent ?? 0));
}

function windowMinutes(window: OpenAIUsageWindow | null | undefined, fallback: number): number {
	const seconds = Number(window?.limit_window_seconds);
	return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : fallback;
}

function windowResetAfterSeconds(window: OpenAIUsageWindow | null | undefined): number {
	const seconds = Number(window?.reset_after_seconds);
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

function windowResetAt(window: OpenAIUsageWindow | null | undefined): number {
	const resetAt = Number(window?.reset_at);
	if (Number.isFinite(resetAt) && resetAt > 0) return Math.round(resetAt);
	const resetAfter = windowResetAfterSeconds(window);
	return resetAfter > 0 ? Math.round(Date.now() / 1000) + resetAfter : 0;
}

// ───────── Codex Usage Check ─────────

async function checkCodexUsageFromUsageApi(token: string, accountId: string): Promise<CodexUsageApiResult> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(OPENAI_USAGE_URL, {
				headers: {
					"Authorization": `Bearer ${token}`,
					"ChatGPT-Account-Id": accountId,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			let detail = `HTTP ${response.status}`;
			try {
				const body = await readResponseText(response);
				detail = truncate(body, 160) || detail;
			} catch { /* ignore */ }
			return { success: false, error: `OpenAI usage API: ${detail}` };
		}

		const data = await readResponseJson<OpenAIUsageResponse>(response);
		const primary = data.rate_limit?.primary_window;
		if (!primary) {
			return { success: false, error: "OpenAI usage API: no primary quota window" };
		}

		const secondary = data.rate_limit?.secondary_window;
		const codeReview = data.code_review_rate_limit?.primary_window;
		const usage: CodexUsage = {
			planType: data.plan_type ?? "unknown",
			activeLimit: data.rate_limit?.limit_reached ? "rate_limited" : "normal",
			primaryUsedPercent: windowUsedPercent(primary),
			secondaryUsedPercent: windowUsedPercent(secondary),
			codeReviewUsedPercent: codeReview ? windowUsedPercent(codeReview) : undefined,
			primaryWindowMinutes: windowMinutes(primary, 300),
			secondaryWindowMinutes: windowMinutes(secondary, 10080),
			codeReviewWindowMinutes: codeReview ? windowMinutes(codeReview, 0) : undefined,
			primaryResetAfterSeconds: windowResetAfterSeconds(primary),
			secondaryResetAfterSeconds: windowResetAfterSeconds(secondary),
			codeReviewResetAfterSeconds: codeReview ? windowResetAfterSeconds(codeReview) : undefined,
			primaryResetAt: windowResetAt(primary),
			secondaryResetAt: windowResetAt(secondary),
			codeReviewResetAt: codeReview ? windowResetAt(codeReview) : undefined,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: Boolean(data.credits?.has_credits),
			creditsBalance: data.credits?.balance ?? "",
			creditsUnlimited: Boolean(data.credits?.unlimited),
			source: "usage_api",
		};
		return { success: true, usage };
	} catch (e: unknown) {
		return {
			success: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function checkCodexUsageWithProbe(token: string, accountId: string): Promise<CodexUsage> {
	const baseUrl = "https://chatgpt.com/backend-api/codex/responses";

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

		const response = await fetch(baseUrl, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				"Content-Type": "application/json",
				"OpenAI-Beta": "responses=experimental",
				"accept": "text/event-stream",
				"originator": "pi-usage",
				"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
			},
			body: JSON.stringify({
				model: CODEX_PROBE_MODEL,
				instructions: "Reply with just: ok",
				input: [{ type: "message", role: "user", content: "hi" }],
				store: false,
				stream: true,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const getHeader = (name: string): string | undefined =>
			response.headers.get(name) ?? undefined;

		if (response.ok) {
			await cancelResponseBody(response);

			return {
				planType: getHeader("x-codex-plan-type") ?? "unknown",
				activeLimit: getHeader("x-codex-active-limit") ?? "unknown",
				primaryUsedPercent: parseHeaderNumber(getHeader("x-codex-primary-used-percent"), 0),
				secondaryUsedPercent: parseHeaderNumber(getHeader("x-codex-secondary-used-percent"), 0),
				primaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-primary-window-minutes"), 300),
				secondaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-secondary-window-minutes"), 10080),
				primaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-primary-reset-after-seconds"), 0),
				secondaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0),
				primaryResetAt: parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0),
				secondaryResetAt: parseHeaderNumber(getHeader("x-codex-secondary-reset-at"), 0),
				primaryOverSecondaryLimitPercent: parseHeaderNumber(getHeader("x-codex-primary-over-secondary-limit-percent"), 0),
				creditsHasCredits: parseHeaderBool(getHeader("x-codex-credits-has-credits")),
				creditsBalance: getHeader("x-codex-credits-balance") ?? "",
				creditsUnlimited: parseHeaderBool(getHeader("x-codex-credits-unlimited")),
				source: "probe",
			};
		}

		// 429 = rate limited
		if (response.status === 429) {
			let resetAt = parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0);
			try {
				const body = await readResponseText(response);
				const parsed = JSON.parse(body);
				resetAt = parsed?.error?.resets_at ?? resetAt;
			} catch { /* ignore */ }

			return {
				planType: getHeader("x-codex-plan-type") ?? "unknown",
				activeLimit: getHeader("x-codex-active-limit") ?? "rate_limited",
				primaryUsedPercent: parseHeaderNumber(getHeader("x-codex-primary-used-percent"), 100),
				secondaryUsedPercent: parseHeaderNumber(getHeader("x-codex-secondary-used-percent"), 100),
				primaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-primary-window-minutes"), 300),
				secondaryWindowMinutes: parseHeaderNumber(getHeader("x-codex-secondary-window-minutes"), 10080),
				primaryResetAfterSeconds: parseHeaderNumber(
					getHeader("x-codex-primary-reset-after-seconds"),
					resetAt ? Math.max(0, Math.round(resetAt - Date.now() / 1000)) : 0,
				),
				secondaryResetAfterSeconds: parseHeaderNumber(getHeader("x-codex-secondary-reset-after-seconds"), 0),
				primaryResetAt: resetAt,
				secondaryResetAt: parseHeaderNumber(getHeader("x-codex-secondary-reset-at"), 0),
				primaryOverSecondaryLimitPercent: parseHeaderNumber(getHeader("x-codex-primary-over-secondary-limit-percent"), 0),
				creditsHasCredits: parseHeaderBool(getHeader("x-codex-credits-has-credits")),
				creditsBalance: getHeader("x-codex-credits-balance") ?? "",
				creditsUnlimited: parseHeaderBool(getHeader("x-codex-credits-unlimited")),
				source: "probe",
				error: "Rate limited (429)",
			};
		}

		// Other errors
		let errorMsg = `HTTP ${response.status}`;
		try {
			const body = await readResponseText(response);
			const parsed = JSON.parse(body);
			errorMsg = parsed?.error?.message ?? parsed?.detail ?? errorMsg;
		} catch { /* ignore */ }

		return {
			planType: "unknown",
			activeLimit: "error",
			primaryUsedPercent: 0,
			secondaryUsedPercent: 0,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			source: "probe",
			error: errorMsg,
		};
	} catch (e: unknown) {
		return {
			planType: "unknown",
			activeLimit: "error",
			primaryUsedPercent: 0,
			secondaryUsedPercent: 0,
			primaryWindowMinutes: 300,
			secondaryWindowMinutes: 10080,
			primaryResetAfterSeconds: 0,
			secondaryResetAfterSeconds: 0,
			primaryResetAt: 0,
			secondaryResetAt: 0,
			primaryOverSecondaryLimitPercent: 0,
			creditsHasCredits: false,
			creditsBalance: "",
			creditsUnlimited: false,
			source: "probe",
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function checkCodexUsage(token: string, accountId: string): Promise<CodexUsage> {
	const usageApiResult = await checkCodexUsageFromUsageApi(token, accountId);
	if (usageApiResult.success) {
		return usageApiResult.usage;
	}

	const probeResult = await checkCodexUsageWithProbe(token, accountId);
	if (probeResult.error && probeResult.activeLimit === "error") {
		probeResult.error = `${usageApiResult.error}; fallback probe: ${probeResult.error}`;
	}
	return probeResult;
}

// ───────── OpenCode Go Usage Check ─────────

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

function parseOpenCodeGoUsageWindow(
	html: string,
	key: "rolling" | "weekly" | "monthly",
): { usedPercent: number; remainingPercent: number; resetAfterSeconds: number; resetAt: number } | undefined {
	const objectMatch = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`).exec(html);
	const body = objectMatch?.[1];
	if (!body) return undefined;

	const usageMatch = /usagePercent:(\d+(?:\.\d+)?)/.exec(body);
	if (!usageMatch) return undefined;

	const usedPercent = clampPercent(Number(usageMatch[1]));
	const resetMatch = /resetInSec:(\d+(?:\.\d+)?)/.exec(body);
	const resetAfterSeconds = resetMatch ? Math.max(0, Math.round(Number(resetMatch[1]))) : 0;
	return {
		usedPercent,
		remainingPercent: clampPercent(100 - usedPercent),
		resetAfterSeconds,
		resetAt: resetAfterSeconds > 0 ? Math.round(Date.now() / 1000) + resetAfterSeconds : 0,
	};
}

function parseOpenCodeGoDashboardUsage(html: string): Omit<OpenCodeGoQuotaResult, "configured" | "source"> | undefined {
	const rolling = parseOpenCodeGoUsageWindow(html, "rolling");
	const weekly = parseOpenCodeGoUsageWindow(html, "weekly");
	const monthly = parseOpenCodeGoUsageWindow(html, "monthly");
	if (!rolling && !weekly && !monthly) return undefined;

	return {
		rollingUsedPercent: rolling?.usedPercent,
		rollingRemainingPercent: rolling?.remainingPercent,
		rollingResetAfterSeconds: rolling?.resetAfterSeconds,
		rollingResetAt: rolling?.resetAt,
		weeklyUsedPercent: weekly?.usedPercent,
		weeklyRemainingPercent: weekly?.remainingPercent,
		weeklyResetAfterSeconds: weekly?.resetAfterSeconds,
		weeklyResetAt: weekly?.resetAt,
		monthlyUsedPercent: monthly?.usedPercent,
		monthlyRemainingPercent: monthly?.remainingPercent,
		monthlyResetAfterSeconds: monthly?.resetAfterSeconds,
		monthlyResetAt: monthly?.resetAt,
	};
}

async function fetchOpenCodeGoQuota(config: OpenCodeGoQuotaConfig): Promise<OpenCodeGoQuotaResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

	try {
		const response = await fetch(
			`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`,
			{
				headers: {
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Cookie": `auth=${config.authCookie}`,
					"User-Agent": `pi-usage (${os.platform()} ${os.release()}; ${os.arch()})`,
				},
				signal: controller.signal,
			},
		);

		if (!response.ok) {
			return {
				configured: true,
				source: config.source,
				error: `OpenCode Go quota dashboard returned HTTP ${response.status}`,
			};
		}

		const html = await readResponseText(response);
		const parsed = parseOpenCodeGoDashboardUsage(html);
		if (!parsed) {
			return {
				configured: true,
				source: config.source,
				error: "OpenCode Go quota data was not found in the dashboard response",
			};
		}

		return {
			configured: true,
			source: config.source,
			...parsed,
		};
	} catch (e: unknown) {
		return {
			configured: true,
			source: config.source,
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function checkOpenCodeGoQuota(state: OpenCodeGoQuotaConfigState): Promise<OpenCodeGoQuotaResult> {
	if (state.error) {
		return { configured: false, error: state.error };
	}
	if (!state.config) {
		return { configured: false };
	}
	return fetchOpenCodeGoQuota(state.config);
}

function resolveModelEndpoint(baseUrl: string, api: GoProbeApi): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		if (normalized.endsWith("/messages")) return normalized;
		if (normalized.endsWith("/v1")) return `${normalized}/messages`;
		return `${normalized}/v1/messages`;
	}
	if (normalized.endsWith("/chat/completions")) return normalized;
	if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
	return `${normalized}/v1/chat/completions`;
}

async function getOpenCodeGoCheckModels(): Promise<GoCheckModel[]> {
	const modelsById = new Map<string, GoCheckModel>();
	for (const model of DOCUMENTED_GO_MODELS) {
		modelsById.set(model.id, model);
	}
	try {
		const { getModels } = await import("@mariozechner/pi-ai");
		for (const model of getModels("opencode-go")) {
			if (modelsById.has(model.id)) continue;
			const api: GoProbeApi = (model.api as string) === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
			const cost = model.cost ?? {};
			const rawRank = (cost.input ?? 0) + (cost.output ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
			const costRank = Number.isFinite(rawRank) ? rawRank : 9999;
			modelsById.set(model.id, {
				id: model.id,
				api,
				endpoint: resolveModelEndpoint(model.baseUrl, api),
				costRank,
			});
		}
	} catch {
		// pi-ai not available — use only documented models
	}
	return Array.from(modelsById.values()).sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const body = await readResponseText(response);
		const parsed = JSON.parse(body);
		return parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? fallback;
	} catch {
		return fallback;
	}
}

function isPerModelUnavailable(status: number, message: string): boolean {
	if (status === 400 || status === 404 || status === 422) return true;
	return /model.*(disabled|not.*found|unsupported|unavailable)|disabled.*model/i.test(message);
}

function isGlobalGoLimit(message: string): boolean {
	if (/error from provider/i.test(message)) return false;
	return /insufficient.*(credit|balance|fund)|balance.*insufficient|credits? exhausted|opencode.*(quota|limit)|go.*(quota|limit)|subscription.*(quota|limit)/i.test(message);
}

async function probeOpenCodeGoModel(apiKey: string, model: GoCheckModel, signal: AbortSignal): Promise<Response> {
	if (model.api === "anthropic-messages") {
		return fetch(model.endpoint, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
				stream: false,
			}),
			signal,
		});
	}

	return fetch(model.endpoint, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model.id,
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		}),
		signal,
	});
}

async function checkOpenCodeGoModels(apiKey: string | undefined): Promise<OpenCodeGoUsage> {
	if (!apiKey) {
		return {
			available: false,
			status: "no_key",
		};
	}

	const models = await getOpenCodeGoCheckModels();
	let checkedModels = 0;
	let lastRateLimit: { model: string; message: string } | undefined;
	let lastUnavailable: { model: string; message: string } | undefined;

	try {
		for (const model of models) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
			checkedModels += 1;

			let response: Response;
			try {
				response = await probeOpenCodeGoModel(apiKey, model, controller.signal);
			} finally {
				clearTimeout(timeout);
			}

			if (response.ok) {
				await cancelResponseBody(response);
				return {
					available: true,
					status: "available",
					workingModel: model.id,
					rateLimitedModel: lastRateLimit?.model,
					checkedModels,
					totalModels: models.length,
				};
			}

			if (response.status === 429) {
				const errorMsg = await readErrorMessage(response, "Rate limited");
				lastRateLimit = { model: model.id, message: errorMsg };

				if (isGlobalGoLimit(errorMsg)) {
					return {
						available: false,
						status: "rate_limited",
						rateLimitedModel: model.id,
						checkedModels,
						totalModels: models.length,
						errorMessage: errorMsg,
					};
				}
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				const errorMsg = await readErrorMessage(response, "Authentication error");
				const status: GoModelStatus = /credit|balance|quota|insufficient/i.test(errorMsg)
					? "credits_error"
					: "error";
				return {
					available: false,
					status,
					checkedModels,
					totalModels: models.length,
					errorMessage: errorMsg,
				};
			}

			const errorMsg = await readErrorMessage(response, `HTTP ${response.status}`);
			if (isPerModelUnavailable(response.status, errorMsg)) {
				lastUnavailable = { model: model.id, message: errorMsg };
				continue;
			}

			return {
				available: false,
				status: "error",
				checkedModels,
				totalModels: models.length,
				errorMessage: `${model.id}: ${errorMsg}`,
			};
		}

		if (lastRateLimit) {
			return {
				available: false,
				status: "rate_limited",
				rateLimitedModel: lastRateLimit.model,
				checkedModels,
				totalModels: models.length,
				errorMessage: lastRateLimit.message,
			};
		}

		const suffix = lastUnavailable ? ` Last: ${lastUnavailable.model}: ${lastUnavailable.message}` : "";
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			errorMessage: `No documented Go models were available.${suffix}`,
		};
	} catch (e: unknown) {
		return {
			available: false,
			status: "error",
			checkedModels,
			totalModels: models.length,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function checkOpenCodeGoUsage(
	apiKey: string | undefined,
	quotaState: OpenCodeGoQuotaConfigState,
): Promise<OpenCodeGoUsage> {
	const quotaCheck = await checkOpenCodeGoQuota(quotaState);
	if (
		quotaCheck.rollingUsedPercent !== undefined ||
		quotaCheck.weeklyUsedPercent !== undefined ||
		quotaCheck.monthlyUsedPercent !== undefined
	) {
		const quotaExhausted = (
			quotaCheck.rollingUsedPercent !== undefined && quotaCheck.rollingUsedPercent >= 100
		) || (
			quotaCheck.weeklyUsedPercent !== undefined && quotaCheck.weeklyUsedPercent >= 100
		) || (
			quotaCheck.monthlyUsedPercent !== undefined && quotaCheck.monthlyUsedPercent >= 100
		);
		return {
			available: !quotaExhausted,
			status: quotaExhausted ? "rate_limited" : "available",
			quotaConfigured: quotaCheck.configured,
			quotaSource: quotaCheck.source,
			rollingUsedPercent: quotaCheck.rollingUsedPercent,
			rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
			rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
			rollingResetAt: quotaCheck.rollingResetAt,
			weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
			weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
			weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
			weeklyResetAt: quotaCheck.weeklyResetAt,
			monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
			monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
			monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
			monthlyResetAt: quotaCheck.monthlyResetAt,
		};
	}

	const modelCheck = await checkOpenCodeGoModels(apiKey);

	return {
		...modelCheck,
		quotaConfigured: quotaCheck.configured,
		quotaSource: quotaCheck.source,
		rollingUsedPercent: quotaCheck.rollingUsedPercent,
		rollingRemainingPercent: quotaCheck.rollingRemainingPercent,
		rollingResetAfterSeconds: quotaCheck.rollingResetAfterSeconds,
		rollingResetAt: quotaCheck.rollingResetAt,
		weeklyUsedPercent: quotaCheck.weeklyUsedPercent,
		weeklyRemainingPercent: quotaCheck.weeklyRemainingPercent,
		weeklyResetAfterSeconds: quotaCheck.weeklyResetAfterSeconds,
		weeklyResetAt: quotaCheck.weeklyResetAt,
		monthlyUsedPercent: quotaCheck.monthlyUsedPercent,
		monthlyRemainingPercent: quotaCheck.monthlyRemainingPercent,
		monthlyResetAfterSeconds: quotaCheck.monthlyResetAfterSeconds,
		monthlyResetAt: quotaCheck.monthlyResetAt,
		quotaError: quotaCheck.error,
	};
}

// ───────── Widget Rendering ─────────

function renderCodexWindows(codex: CodexUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];
	if (codex.error && codex.activeLimit === "error") {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(`${fmt("error", "✗ Codex")} ${fmt("dim", "— " + codex.error)}`);
		return lines;
	}

	const planLabel = codex.planType !== "unknown" ? ` (${codex.planType})` : "";
	const limitLabel = codex.activeLimit !== "unknown" && codex.activeLimit !== "normal"
		? ` [${codex.activeLimit}]`
		: "";

	const p5 = codex.primaryUsedPercent;
	const p5Window = codex.primaryWindowMinutes === 300 ? "5hr" : `${codex.primaryWindowMinutes / 60}h`;
	const p5Reset = codex.primaryResetAt > 0
		? ` resets ${formatResetTime(codex.primaryResetAt)}`
		: codex.primaryResetAfterSeconds > 0
			? ` resets in ${formatDuration(codex.primaryResetAfterSeconds)}`
			: "";
	const pW = codex.secondaryUsedPercent;
	const pWReset = codex.secondaryResetAt > 0
		? ` resets ${formatResetTime(codex.secondaryResetAt)}`
		: codex.secondaryResetAfterSeconds > 0
			? ` resets in ${formatDuration(codex.secondaryResetAfterSeconds)}`
			: "";

	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt("accent", "Codex")}${fmt("dim", planLabel + limitLabel)}`);

	if (useColor) {
		const p5Color = usageColor(p5);
		const pWColor = usageColor(pW);
		const p5Bar = progressBar(p5);
		const pWBar = progressBar(pW);
		lines.push(`  ${p5Window}  ${fmt(p5Color, p5Bar)} ${fmt(p5Color, `${p5.toFixed(0)}%`)}${fmt("dim", p5Reset)}`);
		lines.push(`  week  ${fmt(pWColor, pWBar)} ${fmt(pWColor, `${pW.toFixed(0)}%`)}${fmt("dim", pWReset)}`);
	} else {
		lines.push(`  ${p5Window}  ${progressBar(p5)} ${p5.toFixed(0)}%${p5Reset}`);
		lines.push(`  week  ${progressBar(pW)} ${pW.toFixed(0)}%${pWReset}`);
	}

	if (codex.codeReviewUsedPercent !== undefined) {
		const pC = codex.codeReviewUsedPercent;
		const pCReset = codex.codeReviewResetAt
			? ` resets ${formatResetTime(codex.codeReviewResetAt)}`
			: codex.codeReviewResetAfterSeconds
				? ` resets in ${formatDuration(codex.codeReviewResetAfterSeconds)}`
				: "";
		if (useColor) {
			const pCColor = usageColor(pC);
			const pCBar = progressBar(pC);
			lines.push(`  review ${fmt(pCColor, pCBar)} ${fmt(pCColor, `${pC.toFixed(0)}%`)}${fmt("dim", pCReset)}`);
		} else {
			lines.push(`  review ${progressBar(pC)} ${pC.toFixed(0)}%${pCReset}`);
		}
	}

	if (codex.creditsHasCredits && codex.creditsBalance) {
		lines.push(`  ${fmt("dim", `credits: ${codex.creditsBalance}`)}`);
	}
	if (codex.primaryOverSecondaryLimitPercent > 0) {
		lines.push(`  ${fmt("warning", `⚠ 5hr exceeds weekly allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
	}

	return lines;
}

function renderGoWindows(go: OpenCodeGoUsage, fmt: (color: ThemeColor, text: string) => string, useColor: boolean): string[] {
	const lines: string[] = [];

	const icon = statusIcon(go.status);
	const goColor = GO_COLOR_MAP[go.status];
	lines.push(fmt("dim", "─".repeat(40)));
	lines.push(`${fmt(goColor, `${icon} OpenCode Go`)} ${fmt("dim", "— " + GO_STATUS_TEXT[go.status])}`);

	const goWindows = [
		{
			label: "rolling", used: go.rollingUsedPercent, remaining: go.rollingRemainingPercent,
			resetAt: go.rollingResetAt, resetAfterSeconds: go.rollingResetAfterSeconds,
		},
		{
			label: "week", used: go.weeklyUsedPercent, remaining: go.weeklyRemainingPercent,
			resetAt: go.weeklyResetAt, resetAfterSeconds: go.weeklyResetAfterSeconds,
		},
		{
			label: "month", used: go.monthlyUsedPercent, remaining: go.monthlyRemainingPercent,
			resetAt: go.monthlyResetAt, resetAfterSeconds: go.monthlyResetAfterSeconds,
		},
	];
	for (const w of goWindows) {
		if (w.used === undefined) continue;
		const reset = w.resetAt
			? ` resets ${formatResetTime(w.resetAt)}`
			: w.resetAfterSeconds !== undefined
				? ` resets in ${formatDuration(w.resetAfterSeconds)}`
				: "";
		const remaining = w.remaining !== undefined
			? ` / ${w.remaining.toFixed(0)}% left`
			: "";
		if (useColor) {
			const windowColor = usageColor(w.used);
			const windowBar = progressBar(w.used);
			lines.push(`  ${w.label.padEnd(7)} ${fmt(windowColor, windowBar)} ${fmt(windowColor, `${w.used.toFixed(0)}% used`)}${fmt("dim", remaining + reset)}`);
		} else {
			lines.push(`  ${w.label.padEnd(7)} ${progressBar(w.used)} ${w.used.toFixed(0)}% used${remaining}${reset}`);
		}
	}

	if (go.quotaError) lines.push(`  ${fmt("dim", `quota: ${truncate(go.quotaError, 80)}`)}`);
	if (go.workingModel) lines.push(`  ${fmt("dim", `working: ${go.workingModel}`)}`);
	if (go.checkedModels && go.totalModels) lines.push(`  ${fmt("dim", `checked: ${go.checkedModels}/${go.totalModels} Go models`)}`);
	if (go.rateLimitedModel) lines.push(`  ${fmt("warning", `limited: ${go.rateLimitedModel}`)}`);
	const goError = go.errorMessage || go.error;
	if (goError) lines.push(`  ${fmt("dim", truncate(goError, 80))}`);

	return lines;
}

function buildUsageWidget(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	theme: Theme,
	loading: boolean,
): Text {
	if (loading) {
		return new Text(theme.fg("muted", "⚡ Checking usage limits..."), 0, 0);
	}

	const lines: string[] = [];
	const fmt = (color: ThemeColor, text: string) => theme.fg(color, text);

	lines.push(theme.bold(fmt("accent", "⚡ Usage Limits")));

	if (codex) {
		lines.push(...renderCodexWindows(codex, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "Codex — not configured"));
	}

	if (go) {
		lines.push(...renderGoWindows(go, fmt, true));
	} else {
		lines.push(fmt("dim", "─".repeat(40)));
		lines.push(fmt("dim", "OpenCode Go — not configured"));
	}

	return new Text(lines.join("\n"), 0, 0);
}

function buildStartupUsageMessage(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	includeHelp: boolean,
): string {
	const lines: string[] = [];
	const fmt = (_color: ThemeColor, text: string) => text;

	lines.push("⚡ Usage Limits");

	if (codex) {
		lines.push(...renderCodexWindows(codex, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("Codex — not configured");
	}

	if (go) {
		lines.push(...renderGoWindows(go, fmt, false));
	} else {
		lines.push("─".repeat(40));
		lines.push("OpenCode Go — not configured");
	}

	if (includeHelp) {
		lines.push("─".repeat(40));
		lines.push(USAGE_WIDGET_HELP);
	}

	return lines.join("\n");
}

// ───────── Status Line ─────────

function footerResetDuration(resetAt?: number, resetAfterSeconds?: number): string | undefined {
	if (resetAt !== undefined && resetAt > 0) return formatResetTime(resetAt);
	if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) return formatDuration(resetAfterSeconds);
	return undefined;
}

function footerUsageColor(usedPercent: number): "dim" | "accent" | "warning" | "error" {
	const rounded = Math.round(clampPercent(usedPercent));
	if (rounded >= 100) return "error";
	if (rounded >= 81) return "warning";
	if (rounded >= 51) return "accent";
	return "dim";
}

function footerWindowSummary(
	usedPercent: number,
	theme: Theme,
	resetAt?: number,
	resetAfterSeconds?: number,
	suffix: string = "",
): string {
	const reset = footerResetDuration(resetAt, resetAfterSeconds);
	const rounded = Math.round(clampPercent(usedPercent));
	const used = `${rounded}%${suffix}`;
	const text = reset ? `${used}/${reset}` : used;
	return theme.fg(footerUsageColor(usedPercent), text);
}

function codexFooterSummary(codex: CodexUsage, theme: Theme): string {
	return [
		footerWindowSummary(codex.primaryUsedPercent, theme, codex.primaryResetAt, codex.primaryResetAfterSeconds),
		footerWindowSummary(codex.secondaryUsedPercent, theme, codex.secondaryResetAt, codex.secondaryResetAfterSeconds),
	].join(theme.fg("dim", ","));
}

function goFooterSummary(go: OpenCodeGoUsage, theme: Theme): string {
	const quotaParts: string[] = [];
	if (go.rollingUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.rollingUsedPercent, theme, go.rollingResetAt, go.rollingResetAfterSeconds, "r"));
	}
	if (go.weeklyUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.weeklyUsedPercent, theme, go.weeklyResetAt, go.weeklyResetAfterSeconds, "w"));
	}
	if (go.monthlyUsedPercent !== undefined) {
		quotaParts.push(footerWindowSummary(go.monthlyUsedPercent, theme, go.monthlyResetAt, go.monthlyResetAfterSeconds, "m"));
	}
	return quotaParts.length > 0 ? quotaParts.join(theme.fg("dim", ",")) : theme.fg("dim", statusIcon(go.status));
}

function updateFooterStatus(ctx: UsageContext, codex: CodexUsage | undefined, go: OpenCodeGoUsage | undefined): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;
	const dim = (text: string) => theme.fg("dim", text);
	const parts: string[] = [];
	if (codexUsageHasData(codex)) {
		const limited = codex.activeLimit === "rate_limited" ? " limited" : "";
		parts.push(`${dim(`Codex${limited}:`)}${codexFooterSummary(codex, theme)}`);
	}
	if (go) {
		parts.push(`${dim("Go:")}${goFooterSummary(go, theme)}`);
	}
	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `${dim("⚡ ")}${parts.join(dim(" │ "))}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

function codexUsageHasData(codex: CodexUsage | undefined): codex is CodexUsage & { error: undefined } {
	return codex !== undefined && codex.error === undefined && codex.activeLimit !== "error";
}

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag(USAGE_WIDGET_FLAG, {
		description: "Display pi-usage as a persistent widget above the editor",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(NO_USAGE_WIDGET_FLAG, {
		description: "Disable the pi-usage persistent widget for this run",
		type: "boolean",
		default: false,
	});

	let codexUsage: CodexUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: UsageContext | undefined;

	function isUsageWidgetEnabled(ctx: UsageContext): boolean {
		if (pi.getFlag(NO_USAGE_WIDGET_FLAG) === true) return false;
		if (pi.getFlag(USAGE_WIDGET_FLAG) === true) return true;
		return readUsageWidgetSetting(ctx) ?? false;
	}

	async function refreshUsage(ctx: UsageContext, trigger: RefreshTrigger = "manual"): Promise<void> {
		if (isLoading) {
			if (ctx.hasUI) ctx.ui.notify("Usage check already in progress", "info");
			return;
		}
		isLoading = true;
		currentCtx = ctx;

		const showWidget = isUsageWidgetEnabled(ctx);
		const showStartupReport = !showWidget && trigger !== "auto";

		// Show loading state
		if (ctx.hasUI) {
			if (showWidget) {
				ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) =>
					buildUsageWidget(codexUsage, goUsage, theme, true),
				);
			} else {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				if (showStartupReport) ctx.ui.notify("⚡ Checking usage limits...", "info");
			}
		}

		const checks: Promise<void>[] = [];

		// Check Codex
		const codexAuth = await getCodexToken();
		if (codexAuth) {
			checks.push(
				checkCodexUsage(codexAuth.token, codexAuth.accountId).then((result) => {
					codexUsage = result;
				}),
			);
		}

		// Check OpenCode Go
		const goKey = getOpenCodeApiKey();
		const goQuotaState = getOpenCodeGoQuotaConfig();
		if (goKey || goQuotaState.config || goQuotaState.error) {
			checks.push(
				checkOpenCodeGoUsage(goKey, goQuotaState).then((result) => {
					goUsage = result;
				}),
			);
		} else {
			goUsage = undefined;
		}

		// Run checks in parallel
		await Promise.allSettled(checks);

		isLoading = false;

		// Update display with results
		if (ctx.hasUI) {
			const showWidgetAfterRefresh = isUsageWidgetEnabled(ctx);
			if (showWidgetAfterRefresh) {
				ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) =>
					buildUsageWidget(codexUsage, goUsage, theme, false),
				);
			} else {
				ctx.ui.setWidget(WIDGET_ID, undefined);
				if (trigger !== "auto") {
					ctx.ui.notify(buildStartupUsageMessage(codexUsage, goUsage, true), "info");
				}
			}

			// Footer status
			updateFooterStatus(ctx, codexUsage, goUsage);
		}
	}

	// ── Startup check + auto-refresh ──
	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		if (event.reason === "startup" || event.reason === "reload") {
			// Small delay to let TUI settle
			setTimeout(() => refreshUsage(ctx, "startup").catch(() => {}), 500);
		}
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentCtx) refreshUsage(currentCtx, "auto").catch(() => {});
		}, AUTO_REFRESH_MINUTES * 60 * 1000);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show Codex & OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});
}
