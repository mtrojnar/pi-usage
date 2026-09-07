import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

for (const proactive of [false, true]) {
	it(`expired-window refresh respects PI_USAGE_PROACTIVE=${proactive} and debounce`, () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-usage-expiry-"));
		try {
			// Configuration is captured at import time; use a fresh process for each mode.
			execFileSync(process.execPath, [
				"--import", "tsx", fileURLToPath(new URL("./test/fixtures/expired-refresh.ts", import.meta.url)),
			], {
				cwd: new URL(".", import.meta.url),
				env: {
					PATH: process.env.PATH,
					HOME: tempDir,
					PI_CODING_AGENT_DIR: tempDir,
					PI_USAGE_PROACTIVE: String(proactive),
					PI_USAGE_CODEX_RESPONSE_REFRESH: "false",
					PI_USAGE_UI_REFRESH_SEC: "1",
					PI_USAGE_EXPIRED_REFRESH_DEBOUNCE_SEC: "300",
				},
				stdio: "pipe",
				timeout: 15_000,
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
}
