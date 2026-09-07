import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

function runFixture(name: string, env: Record<string, string> = {}): void {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-usage-refresh-"));
	try {
		// Configuration is captured at import time; use a fresh process for each mode.
		execFileSync(process.execPath, [
			"--import", "tsx", fileURLToPath(new URL(`./test/fixtures/${name}.ts`, import.meta.url)),
		], {
			cwd: new URL(".", import.meta.url),
			env: {
				PATH: process.env.PATH,
				HOME: tempDir,
				PI_CODING_AGENT_DIR: tempDir,
				PI_USAGE_PROACTIVE: "true",
				PI_USAGE_CODEX_RESPONSE_REFRESH: "false",
				PI_USAGE_UI_REFRESH_SEC: "1",
				PI_USAGE_EXPIRED_REFRESH_DEBOUNCE_SEC: "300",
				...env,
			},
			stdio: "pipe",
			timeout: 15_000,
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

for (const proactive of [false, true]) {
	it(`expired-window refresh respects PI_USAGE_PROACTIVE=${proactive} and debounce`, () => {
		runFixture("expired-refresh", { PI_USAGE_PROACTIVE: String(proactive) });
	});
}

it("tracks passive state revisions independently of quota freshness", () => {
	runFixture("passive-revisions", { PI_USAGE_REFRESH_MIN: "1" });
});
