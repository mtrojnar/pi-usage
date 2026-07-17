import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthApiKeyCredential, AuthJson, CodexOAuthCredential, CopilotOAuthCredential } from "./types.ts";
import { agentDir, resolveConfigValue } from "./config.ts";
import { unrefTimer } from "./http.ts";

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

/**
 * Fetch a provider token via pi's auth storage, allowing pi to refresh an
 * expired OAuth token (with its usual file locking). Bounded by `timeoutMs`
 * so a slow or stuck refresh can never hang the caller — the concern that led
 * `readStoredCredential` to avoid refreshing at all.
 */
export async function refreshProviderToken(provider: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const authPath = authJsonPath();
		if (!fs.existsSync(authPath)) return undefined;
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bounded = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), timeoutMs);
			unrefTimer(timer);
		});
		const refresh = (async () => {
			const runtime = await ModelRuntime.create({
				authPath,
				modelsPath: null,
				allowModelNetwork: false,
			});
			return (await runtime.getAuth(provider))?.auth.apiKey;
		})();
		try {
			return (await Promise.race([refresh, bounded])) ?? undefined;
		} finally {
			if (timer) clearTimeout(timer);
		}
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
