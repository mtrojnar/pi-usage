import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenCodeGoQuotaConfigState, UsageContext } from "./types.ts";

// ───────── Constants ─────────

export const WIDGET_ID = "pi-usage";
export const USAGE_WIDGET_FLAG = "usage-widget";
export const NO_USAGE_WIDGET_FLAG = "no-usage-widget";
export const USAGE_CONFIG_FILE = "pi-usage.json";
export const USAGE_WIDGET_HELP = `Widget disabled. Enable: add {"showWidget": true} to ${USAGE_CONFIG_FILE} or run with --${USAGE_WIDGET_FLAG}.`;
export const CHECK_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 512_000;
export const CODEX_PROBE_MODEL = "gpt-5.4-mini";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const KIMI_CODING_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
export const OPENCODE_GO_QUOTA_CONFIG_FILE = path.join("opencode-quota", "opencode-go.json");
export const OPENCODE_GO_DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENCODE_GO_PROVIDER = "opencode-go";
export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_PROBE_MODEL = "claude-haiku-4-5";
export const GITHUB_COPILOT_PROVIDER = "github-copilot";
export const GITHUB_COPILOT_PROBE_MODEL = "gpt-5.4-nano";
export const AUTO_REFRESH_MINUTES = parseEnvInt("PI_USAGE_REFRESH_MIN", 30);
export const UI_REFRESH_SECONDS = parseEnvInt("PI_USAGE_UI_REFRESH_SEC", 60);
export const PROACTIVE_REFRESH_ENABLED = parseEnvBool("PI_USAGE_PROACTIVE", true);
export const CODEX_RESPONSE_REFRESH_ENABLED = parseEnvBool("PI_USAGE_CODEX_RESPONSE_REFRESH", PROACTIVE_REFRESH_ENABLED);
export const CODEX_RESPONSE_REFRESH_SECONDS = parseEnvInt("PI_USAGE_CODEX_RESPONSE_REFRESH_SEC", 60);

// ───────── Env / Config Helpers ─────────

export function parseEnvInt(name: string, fallback: number): number {
	const parsed = parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseEnvBool(name: string, fallback: boolean): boolean {
	return parseBoolValue(process.env[name]) ?? fallback;
}

export function parseBoolValue(value: string | undefined): boolean | undefined {
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

export function agentDir(): string {
	const dir = (process.env.PI_CODING_AGENT_DIR || "~/.pi/agent").trim();
	if (!dir) return path.join(os.homedir(), ".pi", "agent");
	if (dir.startsWith("~")) return path.join(os.homedir(), dir.slice(1));
	return path.resolve(dir);
}

export function usageConfigPath(): string {
	return path.join(agentDir(), USAGE_CONFIG_FILE);
}

export function readJsonObject(filePath: string): Record<string, unknown> | undefined {
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

export function parseBoolSetting(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return parseBoolValue(value);
	return undefined;
}

export function widgetSettingFromConfig(config: Record<string, unknown> | undefined): boolean | undefined {
	if (!config) return undefined;
	return parseBoolSetting(config.showWidget) ?? parseBoolSetting(config.widget);
}

export function readUsageWidgetSetting(ctx?: UsageContext): boolean | undefined {
	let value = widgetSettingFromConfig(readJsonObject(usageConfigPath()));
	const isProjectTrusted = typeof ctx?.isProjectTrusted === "function" && ctx.isProjectTrusted();
	if (isProjectTrusted) {
		const projectValue = widgetSettingFromConfig(readJsonObject(path.join(ctx.cwd, ".pi", USAGE_CONFIG_FILE)));
		if (projectValue !== undefined) value = projectValue;
	}
	return value;
}

export function dedupe(list: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

export function configPathCandidates(fileName: string): string[] {
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

export function validatePrivateConfigFile(configPath: string): string | undefined {
	if (process.platform === "win32") return undefined;

	const stats = fs.statSync(configPath);
	if (!stats.isFile()) return `${path.basename(configPath)} must be a regular file`;
	if ((stats.mode & 0o077) !== 0) {
		return `${path.basename(configPath)} contains an auth cookie and must not be accessible by group or others; set mode 0600`;
	}
	return undefined;
}

export function getOpenCodeGoQuotaConfig(): OpenCodeGoQuotaConfigState {
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
				return { error: `${path.basename(configPath)} needs workspaceId and authCookie` };
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
				error: `${path.basename(configPath)}: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	return {};
}

export function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

export function resolveConfigValue(config: string): string | undefined {
	// Treat value as env var name, fall back to literal string.
	const resolved = process.env[config];
	return resolved !== undefined ? resolved : config;
}
