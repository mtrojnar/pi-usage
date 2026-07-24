import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthApiKeyCredential, AuthJson, CodexOAuthCredential, CopilotOAuthCredential, UsageContext } from "./types.ts";
import { agentDir, resolveConfigValue } from "./config.ts";

// ───────── pi auth.json Access ─────────

export type StoredCredential = AuthApiKeyCredential | CodexOAuthCredential | CopilotOAuthCredential;

export function authJsonPath(): string {
	return path.join(agentDir(), "auth.json");
}

export function parseAuthJson(content: string | undefined): AuthJson {
	return content ? JSON.parse(content) as AuthJson : {};
}

export function readAuthJson(): AuthJson | undefined {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		return parseAuthJson(fs.readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Read a provider credential via pi's auth storage without triggering an
 * OAuth refresh. Refresh may perform unbounded provider I/O; pi refreshes
 * tokens during normal model use.
 */
export async function readStoredCredential(provider: string): Promise<StoredCredential | undefined> {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		const { readStoredCredential: readPiStoredCredential } = await import("@earendil-works/pi-coding-agent");
		return readPiStoredCredential(provider, authPath) as StoredCredential | undefined;
	} catch {
		return undefined;
	}
}

/** Resolve effective provider auth through pi's session-owned v0.82 model runtime. */
export async function resolveProviderAuth(
	ctx: Pick<UsageContext, "modelRegistry">,
	provider: string,
): Promise<{ apiKey: string; baseUrl?: string; source?: string } | undefined> {
	try {
		const resolved = await ctx.modelRegistry.getProviderAuth(provider);
		if (!resolved) return undefined;
		const apiKey = resolved.auth.apiKey?.trim();
		return apiKey ? { apiKey, baseUrl: resolved.auth.baseUrl, source: resolved.source } : undefined;
	} catch {
		return undefined;
	}
}

/** Access token from an OAuth credential, unless it is missing or expired. */
export function oauthAccessToken(credential: StoredCredential | undefined): string | undefined {
	if (credential?.type !== "oauth" || !credential.access) return undefined;
	if (typeof credential.expires === "number" && Date.now() >= credential.expires) return undefined;
	return credential.access;
}

/** Resolved API key from an api_key credential (env-var indirection supported). */
export function apiKeyFromCredential(credential: StoredCredential | AuthApiKeyCredential | undefined): string | undefined {
	if (credential?.type !== "api_key" || !credential.key) return undefined;
	return resolveConfigValue(credential.key)?.trim() || undefined;
}

/** First non-empty value among the given environment variables. */
export function envApiKey(...names: string[]): { key: string; source: string } | undefined {
	for (const name of names) {
		const key = process.env[name]?.trim();
		if (key) return { key, source: name };
	}
	return undefined;
}
