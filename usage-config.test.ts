/**
 * Refresh interval and usage-config command tests for pi-usage.
 * Run with: npm test
 *
 * Covers pi-usage-7qp (JSON-configurable refresh intervals) and pi-usage-mpc
 * (/usage-config command): precedence, parsing, persistence, and handler.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_REFRESH_MINUTES,
	UI_REFRESH_SECONDS,
	effectiveRefreshMinutes,
	effectiveUiRefreshSeconds,
	jsonPositiveInt,
	readJsonObject,
	usageConfigPath,
} from "./src/config.ts";
import {
	applyOrderPosition,
	applyUsageConfigChange,
	canonicalUsageConfigKey,
	knownMenuProviders,
	menuProviderEntries,
	normalizeUsageConfigValue,
	orderRows,
	orderRowValue,
	parseUsageConfigArgs,
	resetUsageConfigFile,
	toggleInList,
	toggleRows,
	toggleRowValue,
	usageConfigKeyKind,
	usageMenuRowValues,
	USAGE_MENU_KEYS,
} from "./src/usage-config.ts";
import usageExtension from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DISPLAY_PREFS } from "./src/types.ts";
import type { UsageContext } from "./src/types.ts";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_USAGE_REFRESH_MIN", "PI_USAGE_UI_REFRESH_SEC"] as const;
const savedEnv: Record<string, string | undefined> = {};
let tempDir = "";

function saveEnv(): void {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

function useAgentDir(): string {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-config-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	return tempDir;
}

function writeGlobalConfig(config: Record<string, unknown>): void {
	fs.writeFileSync(path.join(tempDir, "pi-usage.json"), JSON.stringify(config));
}

// ───────── jsonPositiveInt ─────────

describe("jsonPositiveInt", () => {
	it("accepts positive integers and digit strings", () => {
		assert.equal(jsonPositiveInt(5), 5);
		assert.equal(jsonPositiveInt("15"), 15);
		assert.equal(jsonPositiveInt(" 7 "), 7);
	});

	it("rejects non-positive, non-integer, and non-numeric values", () => {
		assert.equal(jsonPositiveInt(0), undefined);
		assert.equal(jsonPositiveInt(-3), undefined);
		assert.equal(jsonPositiveInt(2.5), undefined);
		assert.equal(jsonPositiveInt(""), undefined);
		assert.equal(jsonPositiveInt("abc"), undefined);
		assert.equal(jsonPositiveInt("3.5"), undefined);
		assert.equal(jsonPositiveInt(true), undefined);
		assert.equal(jsonPositiveInt(undefined), undefined);
	});
});

// ───────── pi-usage-7qp: effective intervals ─────────

describe("effectiveRefreshMinutes and effectiveUiRefreshSeconds", () => {
	afterEach(() => {
		restoreEnv();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("returns built-in defaults with no env or file", () => {
		saveEnv();
		delete process.env.PI_USAGE_REFRESH_MIN;
		delete process.env.PI_USAGE_UI_REFRESH_SEC;
		useAgentDir();
		assert.equal(effectiveRefreshMinutes(), AUTO_REFRESH_MINUTES);
		assert.equal(effectiveUiRefreshSeconds(), UI_REFRESH_SECONDS);
	});

	it("reads JSON values when env is unset", () => {
		saveEnv();
		delete process.env.PI_USAGE_REFRESH_MIN;
		delete process.env.PI_USAGE_UI_REFRESH_SEC;
		useAgentDir();
		writeGlobalConfig({ refreshMinutes: 5, uiRefreshSeconds: 20 });
		assert.equal(effectiveRefreshMinutes(), 5);
		assert.equal(effectiveUiRefreshSeconds(), 20);
	});

	it("lets explicit env vars win over JSON", () => {
		saveEnv();
		useAgentDir();
		writeGlobalConfig({ refreshMinutes: 5, uiRefreshSeconds: 20 });
		process.env.PI_USAGE_REFRESH_MIN = "45";
		process.env.PI_USAGE_UI_REFRESH_SEC = "90";
		assert.equal(effectiveRefreshMinutes(), 45);
		assert.equal(effectiveUiRefreshSeconds(), 90);
	});

	it("ignores invalid JSON values", () => {
		saveEnv();
		delete process.env.PI_USAGE_REFRESH_MIN;
		delete process.env.PI_USAGE_UI_REFRESH_SEC;
		useAgentDir();
		writeGlobalConfig({ refreshMinutes: 0, uiRefreshSeconds: "soon" });
		assert.equal(effectiveRefreshMinutes(), AUTO_REFRESH_MINUTES);
		assert.equal(effectiveUiRefreshSeconds(), UI_REFRESH_SECONDS);
	});
});

// ───────── pi-usage-mpc: arg parsing ─────────

describe("parseUsageConfigArgs", () => {
	it("parses menu, show, set, and unset forms", () => {
		assert.deepEqual(parseUsageConfigArgs(""), { action: "menu", local: false });
		assert.deepEqual(parseUsageConfigArgs("--local"), { action: "menu", local: true });
		assert.deepEqual(parseUsageConfigArgs("show"), { action: "show", local: false });
		assert.deepEqual(parseUsageConfigArgs("show --local"), { action: "show", local: true });
		assert.deepEqual(parseUsageConfigArgs("set hideUnconfiguredProviders true"), {
			action: "set", key: "hideunconfiguredproviders", value: "true", local: false,
		});
		assert.deepEqual(parseUsageConfigArgs("set visibleProviders codex, clinepass -l"), {
			action: "set", key: "visibleproviders", value: "codex, clinepass", local: true,
		});
		assert.deepEqual(parseUsageConfigArgs("unset go"), {
			action: "unset", key: "go", local: false,
		});
	});

	it("rejects malformed input", () => {
		for (const args of ["set", "set showWidget", "unset", "bogus"]) {
			const parsed = parseUsageConfigArgs(args);
			assert.equal(parsed.action, "error", args);
		}
		// Multi-word values parse as set; value validation rejects them later.
		const parsed = parseUsageConfigArgs("set showWidget true extra");
		assert.equal(parsed.action, "set");
		if (parsed.action === "set") {
			assert.ok("error" in normalizeUsageConfigValue(parsed.key, parsed.value));
		}
	});
});

// ───────── pi-usage-mpc: config file round-trip ─────────

describe("usage config file persistence", () => {
	afterEach(() => {
		restoreEnv();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("resolves the global config path under the agent dir", () => {
		saveEnv();
		useAgentDir();
		assert.equal(usageConfigPath(), path.join(tempDir, "pi-usage.json"));
		assert.equal(readJsonObject(usageConfigPath()), undefined);
	});

	it("sets and unsets keys while preserving others", () => {
		saveEnv();
		useAgentDir();
		const file = usageConfigPath();
		applyUsageConfigChange(file, { type: "set", key: "hideUnconfiguredProviders", value: true });
		applyUsageConfigChange(file, { type: "set", key: "visibleProviders", value: ["codex"] });
		assert.deepEqual(readJsonObject(file), { hideUnconfiguredProviders: true, visibleProviders: ["codex"] });
		applyUsageConfigChange(file, { type: "unset", key: "visibleProviders" });
		assert.deepEqual(readJsonObject(file), { hideUnconfiguredProviders: true });
	});
});

// ───────── /usage-config handler ─────────

describe("usage-config command", () => {
	let handler: ((args: string, ctx: UsageContext) => Promise<void>) | undefined;
	let notifications: string[];
	let statuses: Array<string | undefined>;

	function ctxOver(trusted: boolean, cwd: string): UsageContext {
		return {
			hasUI: true,
			cwd,
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				setWidget: () => {},
				setStatus: (_id: string, status: string | undefined) => { statuses.push(status); },
				notify: (message: string) => { notifications.push(message); },
			},
			isProjectTrusted: () => trusted,
		} as unknown as UsageContext;
	}

	function activate(): void {
		notifications = [];
		statuses = [];
		const pi = {
			registerFlag: () => {},
			getFlag: () => false,
			on: () => {},
			registerCommand: (name: string, command: { handler: typeof handler }) => {
				if (name === "usage-config") handler = command.handler;
			},
		};
		usageExtension(pi as unknown as ExtensionAPI);
		assert.ok(handler);
	}

	afterEach(() => {
		restoreEnv();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	it("shows effective settings", async () => {
		saveEnv();
		useAgentDir();
		writeGlobalConfig({ hideUnconfiguredProviders: true });
		activate();
		await handler!("show", ctxOver(false, tempDir));
		const report = notifications.join("\n");
		assert.match(report, /hideUnconfiguredProviders = true/);
		assert.match(report, /showStatusLine = true/);
		assert.match(report, /refreshMinutes = \d+/);
	});

	describe("interactive menu", () => {
		function menuCtx(selectQueue: Array<string | undefined>, inputQueue: Array<string | undefined>, confirmQueue: boolean[]): UsageContext {
			return {
				hasUI: true,
				cwd: tempDir,
				ui: {
					theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
					setWidget: () => {},
					setStatus: (_id: string, status: string | undefined) => { statuses.push(status); },
					notify: (message: string) => { notifications.push(message); },
					select: async (_title: string, _options: string[]) => selectQueue.shift(),
					// Route the wrap-around selector through the same queue.
					custom: async () => selectQueue.shift(),
					input: async (_title: string, _placeholder?: string) => inputQueue.shift(),
					confirm: async (_title: string, _message: string) => confirmQueue.shift() ?? false,
				},
				isProjectTrusted: () => false,
			} as unknown as UsageContext;
		}

	it("edits a boolean through marked option selection", async () => {
		saveEnv();
		useAgentDir();
		activate();
		await handler!("", menuCtx(["compactWidget = false", "● true", "Done"], [], []));
		assert.deepEqual(readJsonObject(usageConfigPath()), { compactWidget: true });
		assert.match(notifications.join("\n"), /Set compactWidget = true/);
	});

	it("edits a provider list through tickboxes", async () => {
		saveEnv();
		useAgentDir();
		activate();
		await handler!("", menuCtx(["visibleProviders = (all)", "[ ] Codex", "[ ] ClinePass", "Done"], [], []));
		assert.deepEqual(readJsonObject(usageConfigPath()), { visibleProviders: ["openai-codex", "clinepass"] });
		assert.match(notifications.join("\n"), /Set visibleProviders = openai-codex, clinepass/);
	});

	it("edits provider order through position numbers", async () => {
		saveEnv();
		useAgentDir();
		activate();
		await handler!("", menuCtx(["providerOrder = (default)", "[—] ClinePass", "Done"], ["1"], []));
		assert.deepEqual(readJsonObject(usageConfigPath()), { providerOrder: ["clinepass"] });
		assert.match(notifications.join("\n"), /Set providerOrder = clinepass/);
	});

		it("rejects invalid typed input without writing", async () => {
			saveEnv();
			useAgentDir();
			activate();
			await handler!("", menuCtx(["refreshMinutes = 30", "Done"], ["soon"], []));
			assert.equal(fs.existsSync(usageConfigPath()), false);
			assert.match(notifications.join("\n"), /positive integer/);
		});

		it("resets to defaults after confirmation", async () => {
			saveEnv();
			useAgentDir();
			writeGlobalConfig({ showWidget: true, compactWidget: true });
			activate();
			await handler!("", menuCtx(["Reset to defaults", "Done"], [], [true]));
			assert.deepEqual(readJsonObject(usageConfigPath()), {});
			assert.match(notifications.join("\n"), /Reset global pi-usage settings to defaults/);
		});

		it("leaves everything untouched on dismiss or decline", async () => {
			saveEnv();
			useAgentDir();
			writeGlobalConfig({ showWidget: true });
			activate();
			await handler!("", menuCtx([undefined], [], []));
			await handler!("", menuCtx(["Reset to defaults", "Done"], [], [false]));
			assert.deepEqual(readJsonObject(usageConfigPath()), { showWidget: true });
		});
	});

	it("sets, reports, and unsets keys in the global file", async () => {
		saveEnv();
		useAgentDir();
		activate();
		const ctx = ctxOver(false, tempDir);
		await handler!("set compactWidget true", ctx);
		assert.deepEqual(readJsonObject(usageConfigPath()), { compactWidget: true });
		assert.match(notifications.join("\n"), /Set compactWidget = true/);
		await handler!("set visibleProviders codex, clinepass", ctx);
		assert.deepEqual(readJsonObject(usageConfigPath()), {
			compactWidget: true,
			visibleProviders: ["codex", "clinepass"],
		});
		await handler!("unset compactWidget", ctx);
		assert.deepEqual(readJsonObject(usageConfigPath()), { visibleProviders: ["codex", "clinepass"] });
	});

	it("rejects bad input without touching the file", async () => {
		saveEnv();
		useAgentDir();
		activate();
		const ctx = ctxOver(false, tempDir);
		await handler!("set showWidget maybe", ctx);
		await handler!("set bogus 1", ctx);
		await handler!("unset bogus", ctx);
		assert.equal(fs.existsSync(usageConfigPath()), false);
		assert.equal(notifications.length, 3);
	});

	it("refuses --local in untrusted projects and honors it when trusted", async () => {
		saveEnv();
		useAgentDir();
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-local-"));
		try {
			activate();
			await handler!("set showWidget true --local", ctxOver(false, projectDir));
			assert.match(notifications.join("\n"), /only after the project is trusted/);
			await handler!("set showWidget true --local", ctxOver(true, projectDir));
			assert.deepEqual(
				readJsonObject(path.join(projectDir, ".pi", "pi-usage.json")),
				{ showWidget: true },
			);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("notes the reload requirement for interval keys", async () => {
		saveEnv();
		useAgentDir();
		activate();
		await handler!("set refreshMinutes 5", ctxOver(false, tempDir));
		assert.deepEqual(readJsonObject(usageConfigPath()), { refreshMinutes: 5 });
		assert.match(notifications.join("\n"), /Takes effect after reload/);
	});
});

// ───────── value normalization ─────────

describe("normalizeUsageConfigValue", () => {
	it("accepts booleans, lists, and positive integers", () => {
		assert.deepEqual(normalizeUsageConfigValue("showwidget", "true"), { value: true });
		assert.deepEqual(normalizeUsageConfigValue("compactwidget", "off"), { value: false });
		assert.deepEqual(normalizeUsageConfigValue("visibleproviders", "Codex, clinepass"), {
			value: ["codex", "clinepass"],
		});
		assert.deepEqual(normalizeUsageConfigValue("refreshminutes", "5"), { value: 5 });
	});

	it("rejects unknown keys and bad values", () => {
		assert.ok("error" in normalizeUsageConfigValue("bogus", "1"));
		assert.ok("error" in normalizeUsageConfigValue("showwidget", "maybe"));
		assert.ok("error" in normalizeUsageConfigValue("refreshminutes", "0"));
		assert.ok("error" in normalizeUsageConfigValue("uirefreshseconds", "soon"));
	});

	it("maps keys to canonical camelCase", () => {
		assert.equal(canonicalUsageConfigKey("hideunconfiguredproviders"), "hideUnconfiguredProviders");
		assert.equal(canonicalUsageConfigKey("refreshminutes"), "refreshMinutes");
	});
});

describe("menu provider helpers", () => {
	it("lists known providers in report order", () => {
		const ids = knownMenuProviders().map((provider) => provider.id);
		assert.deepEqual(ids.slice(0, 3), ["openai-codex", "anthropic", "github-copilot"]);
		assert.ok(ids.includes("clinepass"));
		assert.equal(ids.at(-1), "openrouter");
	});

	it("appends unknown configured values for removal", () => {
		const entries = menuProviderEntries(["codex", "future-provider"]);
		assert.ok(entries.some((provider) => provider.id === "openai-codex"));
		assert.ok(entries.some((provider) => provider.id === "future-provider"));
	});

	it("toggles tickbox rows canonically", () => {
		const all = ["openai-codex", "clinepass"];
		assert.deepEqual(toggleRows(all, ["codex"]), ["[x] openai-codex", "[ ] clinepass"]);
		assert.equal(toggleRowValue("[x] openai-codex"), "openai-codex");
		assert.deepEqual(toggleInList(["codex"], all, "openai-codex"), []);
		assert.deepEqual(toggleInList([], all, "clinepass"), ["clinepass"]);
	});

	it("numbers order rows and moves entries by position", () => {
		const entries = [{ id: "openai-codex", label: "Codex" }, { id: "clinepass", label: "ClinePass" }];
		assert.deepEqual(orderRows(entries, ["clinepass"]), ["[—] Codex", "[1] ClinePass"]);
		assert.equal(orderRowValue("[1] ClinePass"), "ClinePass");
		assert.deepEqual(applyOrderPosition([], entries, "clinepass", 1), ["clinepass"]);
		assert.deepEqual(applyOrderPosition(["clinepass", "openai-codex"], entries, "codex", 1), ["openai-codex", "clinepass"]);
		assert.deepEqual(applyOrderPosition(["clinepass"], entries, "clinepass", undefined), []);
		assert.deepEqual(applyOrderPosition([], entries, "clinepass", 99), ["clinepass"]);
	});
});

describe("usageMenuRowValues", () => {
	it("covers every menu key with a concrete value", () => {
		const values = usageMenuRowValues(DEFAULT_DISPLAY_PREFS, false);
		for (const key of USAGE_MENU_KEYS) {
			assert.ok(values[key] !== undefined && values[key] !== "undefined", key);
		}
		assert.equal(values.quotaDisplay, "used");
		assert.deepEqual(usageMenuRowValues({ ...DEFAULT_DISPLAY_PREFS, quotaDisplay: "remaining" }, true).quotaDisplay, "remaining");
	});

	afterEach(() => {
		restoreEnv();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});
});

describe("usageConfigKeyKind and resetUsageConfigFile", () => {
	it("classifies keys for menu editing", () => {
		assert.equal(usageConfigKeyKind("showwidget"), "bool");
		assert.equal(usageConfigKeyKind("visibleproviders"), "list");
		assert.equal(usageConfigKeyKind("refreshminutes"), "int");
		assert.equal(usageConfigKeyKind("bogus"), undefined);
	});

	it("removes managed keys while preserving unknown ones", () => {
		saveEnv();
		useAgentDir();
		const file = usageConfigPath();
		writeGlobalConfig({ showWidget: true, refreshMinutes: 5, futureKey: "keep" });
		assert.deepEqual(resetUsageConfigFile(file), { futureKey: "keep" });
	});

	afterEach(() => {
		restoreEnv();
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});
});
