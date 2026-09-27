/**
 * Read-only access to the agent credential database.
 *
 * pi stores credentials in `<agentDir>/auth.json`. omp 18.3 and later replaced
 * that file with a SQLite database at `<agentDir>/agent.db`, table
 * `auth_credentials`:
 *
 *   id, provider, credential_type, data, disabled_cause, identity_key,
 *   created_at, updated_at
 *
 * `data` holds the same JSON the old `auth.json` entry held, minus `type` —
 * the `credential_type` column carries that instead — so a row projects onto
 * pi's credential shapes without translation. A non-null `disabled_cause`
 * marks a credential the user removed, which is the database equivalent of a
 * deleted `auth.json` entry and is skipped here for the same reason.
 *
 * Nothing in this module throws: the store is optional, may be locked by a
 * running agent, and may be reshaped by a future host, so every failure mode
 * degrades to "no credential" rather than taking the status line down.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthApiKeyCredential, CodexOAuthCredential, CopilotOAuthCredential } from "./types.ts";

/** SQLite credential database kept beside `auth.json` by newer agents. */
export const AGENT_DB_FILE = "agent.db";

/** The credential table. Read-only; pi-usage never writes to an agent store. */
const CREDENTIALS_TABLE = "auth_credentials";

/**
 * `disabled_cause IS NULL` is the "still usable" filter: a row the user
 * deleted keeps its data but is not a live credential.
 */
const SELECT_CREDENTIAL =
	`SELECT provider, credential_type, data FROM ${CREDENTIALS_TABLE} WHERE disabled_cause IS NULL AND provider = ?`;

/** Credential types pi-usage knows how to use. Anything else is ignored. */
const KNOWN_TYPES = ["api_key", "oauth"] as const;

export type AgentDbCredential = AuthApiKeyCredential | CodexOAuthCredential | CopilotOAuthCredential;

/** One `auth_credentials` row, as read. Fields are untrusted. */
export interface AuthCredentialsRow {
	provider?: unknown;
	credential_type?: unknown;
	data?: unknown;
}

/**
 * Project one `auth_credentials` row onto pi's credential shape.
 *
 * Returns undefined for an unrecognized `credential_type`, a non-string or
 * unparsable `data`, or a payload that is not a JSON object, so an unexpected
 * schema reads as "no credential" instead of a malformed one.
 */
export function parseAgentDbCredential(row: AuthCredentialsRow): AgentDbCredential | undefined {
	const type = row.credential_type;
	if (typeof type !== "string" || !KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number])) return undefined;
	if (typeof row.data !== "string") return undefined;

	let data: unknown;
	try {
		data = JSON.parse(row.data);
	} catch {
		return undefined;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;

	// `type` last: the column is authoritative, and a payload carrying its own
	// stale `type` must not override it.
	return { ...(data as Record<string, unknown>), type } as AgentDbCredential;
}

/**
 * Read one provider's credential from `<dir>/agent.db`.
 *
 * Returns undefined when the database is absent, holds no usable row for the
 * provider, or cannot be read at all — including on runtimes without
 * `node:sqlite`, which is why the import is lazy.
 */
export async function readAgentDbCredential(
	dir: string,
	provider: string,
): Promise<AgentDbCredential | undefined> {
	const dbPath = path.join(dir, AGENT_DB_FILE);
	if (!fs.existsSync(dbPath)) return undefined;

	try {
		// node:sqlite postdates the oldest runtime pi-usage supports, and a
		// missing optional builtin must not break module load.
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const row = db.prepare(SELECT_CREDENTIAL).get(provider) as AuthCredentialsRow | undefined;
			return row ? parseAgentDbCredential(row) : undefined;
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}
