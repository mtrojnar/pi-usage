/**
 * Unit tests for the agent credential database reader.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentDbCredential, readAgentDbCredential } from "./src/agent-db.ts";
import { readStoredCredential } from "./src/auth.ts";

// ───────── Fixtures ─────────

/** The subset of omp's `auth_credentials` schema that pi-usage reads. */
const CREATE_TABLE = `CREATE TABLE auth_credentials (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	provider TEXT NOT NULL,
	credential_type TEXT NOT NULL,
	data TEXT NOT NULL,
	disabled_cause TEXT DEFAULT NULL,
	identity_key TEXT DEFAULT NULL,
	created_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0
)`;

interface FixtureRow {
	provider: string;
	credentialType: string;
	data: unknown;
	disabledCause?: string | null;
}

/** Write an agent.db into `dir`, creating the directory when needed. */
async function writeAgentDb(dir: string, rows: FixtureRow[]): Promise<void> {
	const { DatabaseSync } = await import("node:sqlite");
	fs.mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(path.join(dir, "agent.db"));
	try {
		db.exec(CREATE_TABLE);
		const insert = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?)",
		);
		for (const row of rows) {
			insert.run(
				row.provider,
				row.credentialType,
				typeof row.data === "string" ? row.data : JSON.stringify(row.data),
				row.disabledCause ?? null,
			);
		}
	} finally {
		db.close();
	}
}

/** Run `body` with the agent dir pointed at a fresh temp directory. */
async function withAgentDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-agentdb-"));
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		return await body(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ───────── Row projection ─────────

describe("parseAgentDbCredential", () => {
	it("projects an api_key row, taking type from the column", () => {
		const credential = parseAgentDbCredential({
			provider: "cline-pass",
			credential_type: "api_key",
			data: JSON.stringify({ key: "sk_test", source: "login" }),
		});
		assert.deepEqual(credential, { type: "api_key", key: "sk_test", source: "login" });
	});

	it("projects an oauth row with its expiry and account", () => {
		const expires = Date.now() + 60_000;
		const credential = parseAgentDbCredential({
			provider: "openai-codex",
			credential_type: "oauth",
			data: JSON.stringify({ access: "access-token", refresh: "refresh-token", expires, accountId: "acct" }),
		});
		assert.deepEqual(credential, {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires,
			accountId: "acct",
		});
	});

	it("preserves provider-specific fields the payload carries", () => {
		const credential = parseAgentDbCredential({
			provider: "github-copilot",
			credential_type: "oauth",
			data: JSON.stringify({ access: "a", enterpriseUrl: "https://example.test" }),
		});
		assert.equal((credential as { enterpriseUrl?: string }).enterpriseUrl, "https://example.test");
	});

	it("lets the column override a type claimed by the payload", () => {
		const credential = parseAgentDbCredential({
			provider: "openai-codex",
			credential_type: "oauth",
			data: JSON.stringify({ type: "api_key", access: "a" }),
		});
		assert.equal(credential?.type, "oauth");
	});

	it("rejects an unrecognized credential type", () => {
		assert.equal(
			parseAgentDbCredential({ credential_type: "hardware_token", data: JSON.stringify({ key: "k" }) }),
			undefined,
		);
	});

	it("rejects unparsable, non-string, and non-object payloads", () => {
		assert.equal(parseAgentDbCredential({ credential_type: "api_key", data: "{not json" }), undefined);
		assert.equal(parseAgentDbCredential({ credential_type: "api_key", data: 42 }), undefined);
		assert.equal(parseAgentDbCredential({ credential_type: "api_key", data: "null" }), undefined);
		assert.equal(parseAgentDbCredential({ credential_type: "api_key", data: "[1,2]" }), undefined);
		assert.equal(parseAgentDbCredential({ credential_type: "api_key" }), undefined);
	});
});

// ───────── Reading the store ─────────

describe("readAgentDbCredential", () => {
	it("reads a live credential", async () => {
		await withAgentDir(async (dir) => {
			await writeAgentDb(dir, [
				{ provider: "openai-codex", credentialType: "oauth", data: { access: "live-token" } },
			]);
			assert.deepEqual(await readAgentDbCredential(dir, "openai-codex"), {
				type: "oauth",
				access: "live-token",
			});
		});
	});

	it("skips a credential the user deleted", async () => {
		await withAgentDir(async (dir) => {
			await writeAgentDb(dir, [
				{ provider: "opencode-zen", credentialType: "api_key", data: { key: "sk" }, disabledCause: "deleted by user" },
			]);
			assert.equal(await readAgentDbCredential(dir, "opencode-zen"), undefined);
		});
	});

	it("returns undefined for a provider the store does not hold", async () => {
		await withAgentDir(async (dir) => {
			await writeAgentDb(dir, [{ provider: "cline-pass", credentialType: "api_key", data: { key: "sk" } }]);
			assert.equal(await readAgentDbCredential(dir, "anthropic"), undefined);
		});
	});

	it("returns undefined when there is no database", async () => {
		await withAgentDir(async (dir) => {
			assert.equal(await readAgentDbCredential(dir, "openai-codex"), undefined);
		});
	});

	it("returns undefined when the file is not a database", async () => {
		await withAgentDir(async (dir) => {
			fs.writeFileSync(path.join(dir, "agent.db"), "not a sqlite file");
			assert.equal(await readAgentDbCredential(dir, "openai-codex"), undefined);
		});
	});

	it("returns undefined when the database has no credential table", async () => {
		await withAgentDir(async (dir) => {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(path.join(dir, "agent.db"));
			db.exec("CREATE TABLE unrelated (id INTEGER)");
			db.close();
			assert.equal(await readAgentDbCredential(dir, "openai-codex"), undefined);
		});
	});
});

// ───────── Precedence against auth.json ─────────

describe("readStoredCredential with an agent credential database", () => {
	it("prefers the database over a stale auth.json", async () => {
		await withAgentDir(async (dir) => {
			await writeAgentDb(dir, [
				{ provider: "openai-codex", credentialType: "oauth", data: { access: "from-db" } },
			]);
			// An auth.json left behind by another agent, holding a dead token.
			fs.writeFileSync(
				path.join(dir, "auth.json"),
				JSON.stringify({ "openai-codex": { type: "oauth", access: "stale", expires: Date.now() - 1 } }),
			);
			assert.deepEqual(await readStoredCredential("openai-codex"), { type: "oauth", access: "from-db" });
		});
	});

	it("falls back to auth.json for a provider the database does not hold", async () => {
		await withAgentDir(async (dir) => {
			await writeAgentDb(dir, [
				{ provider: "openai-codex", credentialType: "oauth", data: { access: "from-db" } },
			]);
			fs.writeFileSync(
				path.join(dir, "auth.json"),
				JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant" } }),
			);
			assert.deepEqual(await readStoredCredential("anthropic"), { type: "api_key", key: "sk-ant" });
		});
	});

	it("falls back to auth.json when there is no database", async () => {
		await withAgentDir(async (dir) => {
			fs.writeFileSync(
				path.join(dir, "auth.json"),
				JSON.stringify({ "openai-codex": { type: "oauth", access: "from-json" } }),
			);
			assert.deepEqual(await readStoredCredential("openai-codex"), { type: "oauth", access: "from-json" });
		});
	});

	it("returns undefined when neither store holds the provider", async () => {
		await withAgentDir(async (dir) => {
			fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
			assert.equal(await readStoredCredential("openai-codex"), undefined);
		});
	});
});
