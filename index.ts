/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex (5hr & weekly) and OpenCode Go usage limits at startup
 * and displays a clean summary widget above the editor.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY env var
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getModels } from "@mariozechner/pi-ai";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ───────── Types ─────────

interface CodexUsage {
	planType: string;
	activeLimit: string;
	primaryUsedPercent: number;      // 5hr window
	secondaryUsedPercent: number;    // weekly window
	primaryWindowMinutes: number;
	secondaryWindowMinutes: number;
	primaryResetAfterSeconds: number;
	secondaryResetAfterSeconds: number;
	primaryResetAt: number;          // unix timestamp seconds
	secondaryResetAt: number;
	primaryOverSecondaryLimitPercent: number;
	creditsHasCredits: boolean;
	creditsBalance: string;
	creditsUnlimited: boolean;
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
	errorMessage?: string;
	error?: string;
}

// ───────── Config ─────────

const WIDGET_ID = "pi-usage";
const CHECK_TIMEOUT_MS = 15_000;
const AUTO_REFRESH_MINUTES = parseEnvInt("PI_USAGE_REFRESH_MIN", 30);
const CODEX_REFRESH_SKEW_MS = 60_000;
const CODEX_PROBE_MODEL = "gpt-5.4-mini";

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

// ───────── Helpers ─────────

function parseEnvInt(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authJsonPath(): string {
	return path.join(os.homedir(), ".pi/agent/auth.json");
}

function readAuthJson(): AuthJson | undefined {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthJson;
	} catch {
		return undefined;
	}
}

function writeAuthJson(auth: AuthJson): void {
	const authPath = authJsonPath();
	fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");
	try {
		fs.chmodSync(authPath, 0o600);
	} catch { /* best effort on platforms without POSIX permissions */ }
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
	if (config.startsWith("!")) {
		try {
			return execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return process.env[config] || config;
}

async function getCodexToken(): Promise<{ token: string; accountId: string } | undefined> {
	try {
		const auth = readAuthJson();
		if (!auth) return undefined;
		const codex = auth["openai-codex"] as CodexOAuthCredential | undefined;
		if (!codex?.access) return undefined;

		if (codex.refresh && (!codex.expires || Date.now() + CODEX_REFRESH_SKEW_MS >= codex.expires)) {
			const refreshed = await refreshOpenAICodexToken(codex.refresh);
			const accountId = typeof refreshed.accountId === "string"
				? refreshed.accountId
				: extractAccountId(refreshed.access);
			if (!accountId) return undefined;
			auth["openai-codex"] = { type: "oauth", ...refreshed, accountId };
			writeAuthJson(auth);
			return { token: refreshed.access, accountId };
		}

		const accountId = codex.accountId ?? extractAccountId(codex.access);
		if (!accountId) return undefined;
		return { token: codex.access, accountId };
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

function usageColor(percent: number): string {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function parseHeaderNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseHeaderBool(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
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

// ───────── Codex Usage Check ─────────

async function checkCodexUsage(token: string, accountId: string): Promise<CodexUsage> {
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
				max_output_tokens: 4,
				store: false,
				stream: true,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const getHeader = (name: string): string | undefined =>
			response.headers.get(name) ?? undefined;

		if (response.ok) {
			// Consume the body to complete the stream
			try {
				const reader = response.body?.getReader();
				if (reader) {
					while (true) {
						const { done } = await reader.read();
						if (done) break;
					}
					reader.releaseLock();
				}
			} catch { /* stream already ended or aborted */ }

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
			};
		}

		// 429 = rate limited
		if (response.status === 429) {
			let resetAt = parseHeaderNumber(getHeader("x-codex-primary-reset-at"), 0);
			try {
				const body = await response.text();
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
				error: "Rate limited (429)",
			};
		}

		// Other errors
		let errorMsg = `HTTP ${response.status}`;
		try {
			const body = await response.text();
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
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// ───────── OpenCode Go Usage Check ─────────

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

function getOpenCodeGoCheckModels(): GoCheckModel[] {
	const modelsById = new Map<string, GoCheckModel>();
	for (const model of DOCUMENTED_GO_MODELS) {
		modelsById.set(model.id, model);
	}
	for (const model of getModels("opencode-go")) {
		if (modelsById.has(model.id)) continue;
		const api = model.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
		const costRank = model.cost.input + model.cost.output + model.cost.cacheRead + model.cost.cacheWrite;
		modelsById.set(model.id, {
			id: model.id,
			api,
			endpoint: resolveModelEndpoint(model.baseUrl, api),
			costRank,
		});
	}
	return Array.from(modelsById.values()).sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
	try {
		const body = await response.text();
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

async function checkOpenCodeGoUsage(apiKey: string): Promise<OpenCodeGoUsage> {
	const models = getOpenCodeGoCheckModels();
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
				try { await response.text(); } catch { /* ignore */ }
				return {
					available: true,
					status: "available",
					workingModel: model.id,
					checkedModels,
					totalModels: models.length,
				};
			}

			if (response.status === 429) {
				const errorMsg = await readErrorMessage(response, "Rate limited");
				lastRateLimit = { model: model.id, message: errorMsg };

				// Global quota/usage limits apply across Go models, so probing more models
				// would just burn time and noise.
				if (/insufficient|quota|usage|limit|balance|credit/i.test(errorMsg)) {
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

// ───────── Widget Rendering ─────────

function buildUsageWidget(
	codex: CodexUsage | undefined,
	go: OpenCodeGoUsage | undefined,
	theme: any,
	loading: boolean,
): Text {
	if (loading) {
		return new Text(theme.fg("muted", "⚡ Checking usage limits..."), 0, 0);
	}

	const lines: string[] = [];
	const sep = "─";

	// Header
	lines.push(theme.bold(theme.fg("accent", "⚡ Usage Limits")));

	// ── Codex ──
	if (codex) {
		if (codex.error && codex.activeLimit === "error") {
			lines.push(theme.fg("dim", sep.repeat(40)));
			lines.push(`${theme.fg("error", "✗ Codex")} ${theme.fg("dim", "— " + codex.error)}`);
		} else {
			const planLabel = codex.planType !== "unknown" ? ` (${codex.planType})` : "";
			const limitLabel = codex.activeLimit !== "unknown" ? ` [${codex.activeLimit}]` : "";

			// 5hr window
			const p5 = codex.primaryUsedPercent;
			const p5Color = usageColor(p5);
			const p5Bar = progressBar(p5);
			const p5Window = codex.primaryWindowMinutes === 300 ? "5hr" : `${codex.primaryWindowMinutes / 60}h`;
			const p5Reset = codex.primaryResetAt > 0
				? ` resets ${formatResetTime(codex.primaryResetAt)}`
				: codex.primaryResetAfterSeconds > 0
					? ` resets in ${formatDuration(codex.primaryResetAfterSeconds)}`
					: "";

			// Weekly window
			const pW = codex.secondaryUsedPercent;
			const pWColor = usageColor(pW);
			const pWBar = progressBar(pW);
			const pWReset = codex.secondaryResetAt > 0
				? ` resets ${formatResetTime(codex.secondaryResetAt)}`
				: codex.secondaryResetAfterSeconds > 0
					? ` resets in ${formatDuration(codex.secondaryResetAfterSeconds)}`
					: "";

			lines.push(theme.fg("dim", sep.repeat(40)));
			lines.push(`${theme.fg("accent", "Codex")}${theme.fg("dim", planLabel + limitLabel)}`);
			lines.push(
				`  ${p5Window}  ${theme.fg(p5Color, p5Bar)} ${theme.fg(p5Color, `${p5.toFixed(0)}%`)}${theme.fg("dim", p5Reset)}`,
			);
			lines.push(
				`  week  ${theme.fg(pWColor, pWBar)} ${theme.fg(pWColor, `${pW.toFixed(0)}%`)}${theme.fg("dim", pWReset)}`,
			);

			// Credits info
			if (codex.creditsHasCredits && codex.creditsBalance) {
				lines.push(`  ${theme.fg("dim", `credits: ${codex.creditsBalance}`)}`);
			}
			if (codex.primaryOverSecondaryLimitPercent > 0) {
				lines.push(`  ${theme.fg("warning", `⚠ 5hr exceeds weekly allocation: ${codex.primaryOverSecondaryLimitPercent}%`)}`);
			}
		}
	} else {
		lines.push(theme.fg("dim", sep.repeat(40)));
		lines.push(theme.fg("dim", "Codex — not configured"));
	}

	// ── OpenCode Go ──
	if (go) {
		lines.push(theme.fg("dim", sep.repeat(40)));
		const icon = statusIcon(go.status);
		const goColorMap: Record<GoModelStatus, string> = {
			available: "success",
			rate_limited: "warning",
			credits_error: "error",
			error: "warning",
			no_key: "dim",
		};
		const goColor = goColorMap[go.status];
		const statusText: Record<GoModelStatus, string> = {
			available: "available",
			rate_limited: "rate limited",
			credits_error: "credits exhausted",
			error: "error",
			no_key: "no key",
		};
		lines.push(`${theme.fg(goColor, `${icon} OpenCode Go`)} ${theme.fg("dim", "— " + statusText[go.status])}`);
		if (go.workingModel) {
			lines.push(`  ${theme.fg("dim", `working: ${go.workingModel}`)}`);
		}
		if (go.checkedModels && go.totalModels) {
			lines.push(`  ${theme.fg("dim", `checked: ${go.checkedModels}/${go.totalModels} Go models`)}`);
		}
		if (go.rateLimitedModel) {
			lines.push(`  ${theme.fg("warning", `limited: ${go.rateLimitedModel}`)}`);
		}
		if (go.errorMessage) {
			lines.push(`  ${theme.fg("dim", go.errorMessage.substring(0, 80))}`);
		}
		if (go.error) {
			lines.push(`  ${theme.fg("dim", go.error.substring(0, 80))}`);
		}
	} else {
		lines.push(theme.fg("dim", sep.repeat(40)));
		lines.push(theme.fg("dim", "OpenCode Go — not configured"));
	}

	return new Text(lines.join("\n"), 0, 0);
}

// ───────── Status Line ─────────

function updateFooterStatus(ctx: any, codex: CodexUsage | undefined, go: OpenCodeGoUsage | undefined): void {
	if (!ctx.hasUI) return;

	const parts: string[] = [];
	if (codexUsageHasData(codex)) {
		parts.push(`Codex:${codex!.primaryUsedPercent.toFixed(0)}%/${codex!.secondaryUsedPercent.toFixed(0)}%`);
	}
	if (go) {
		parts.push(`Go:${go.available ? "✓" : "⏳"}`);
	}
	if (parts.length > 0) {
		ctx.ui.setStatus("pi-usage", `⚡ ${parts.join(" │ ")}`);
	} else {
		ctx.ui.setStatus("pi-usage", undefined);
	}
}

function codexUsageHasData(codex: CodexUsage | undefined): codex is CodexUsage & { error: undefined } {
	return codex !== undefined && codex.error === undefined && codex.activeLimit !== "error";
}

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	let codexUsage: CodexUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: any;

	async function refreshUsage(ctx: any): Promise<void> {
		if (isLoading) return;
		isLoading = true;
		currentCtx = ctx;

		// Show loading state
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(codexUsage, goUsage, theme, true),
			);
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
		if (goKey) {
			checks.push(
				checkOpenCodeGoUsage(goKey).then((result) => {
					goUsage = result;
				}),
			);
		}

		// Run checks in parallel
		await Promise.allSettled(checks);

		isLoading = false;

		// Update widget with results
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) =>
				buildUsageWidget(codexUsage, goUsage, theme, false),
			);

			// Footer status
			updateFooterStatus(ctx, codexUsage, goUsage);

			// Quick notification
			const parts: string[] = [];
			if (codexUsageHasData(codexUsage)) {
				parts.push(`Codex 5hr:${codexUsage!.primaryUsedPercent.toFixed(0)}% week:${codexUsage!.secondaryUsedPercent.toFixed(0)}%`);
			} else if (codexUsage?.error) {
				parts.push(`Codex: ✗ ${codexUsage.error.substring(0, 30)}`);
			}
			if (goUsage) {
				parts.push(`Go: ${goUsage.available ? "✓" : "⏳"}`);
			}
			if (parts.length > 0) {
				ctx.ui.notify(`⚡ ${parts.join(" │ ")}`, "info");
			}
		}
	}

	// ── Startup check ──
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "reload") {
			// Small delay to let TUI settle
			setTimeout(() => refreshUsage(ctx), 500);
		}
	});

	// ── Auto-refresh ──
	pi.on("session_start", async (_event, ctx) => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentCtx) refreshUsage(currentCtx).catch(() => {});
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
			await refreshUsage(ctx);
		},
	});
}
