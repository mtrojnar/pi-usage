/**
 * Pure helpers for the /usage-config command: argument parsing, value
 * validation, and pi-usage.json persistence. Side-effect-free except for the
 * file writes in applyUsageConfigChange.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveRefreshMinutes, effectiveUiRefreshSeconds, parseBoolSetting, providerNameList, readJsonObject } from "./config.ts";
import { SUBSCRIPTION_PROVIDERS } from "./subscriptions.ts";
import type { ProviderDisplayPrefs } from "./types.ts";

export type UsageConfigAction =
	| { action: "menu"; local: boolean }
	| { action: "show"; local: boolean }
	| { action: "set"; key: string; value: string; local: boolean }
	| { action: "unset"; key: string; local: boolean }
	| { action: "error"; message: string };

export const USAGE_CONFIG_KEYS = [
	"showwidget",
	"showstatusline",
	"hideunconfiguredproviders",
	"compactwidget",
	"visibleproviders",
	"hiddenproviders",
	"providerorder",
	"refreshminutes",
	"uirefreshseconds",
	"quotadisplay",
] as const;

const BOOL_KEYS = new Set(["showwidget", "showstatusline", "hideunconfiguredproviders", "compactwidget"]);
const LIST_KEYS = new Set(["visibleproviders", "hiddenproviders", "providerorder"]);
const INT_KEYS = new Set(["refreshminutes", "uirefreshseconds"]);
const OPTION_CHOICES: Record<string, string[]> = {
	quotadisplay: ["used", "remaining"],
};

/** Short aliases accepted anywhere a provider ID is accepted in display settings. */
const PROVIDER_ALIASES: Record<string, string> = {
	codex: "openai-codex",
	claude: "anthropic",
	copilot: "github-copilot",
	go: "opencode-go",
	zen: "opencode",
	kimi: "kimi-coding",
};

/** Canonicalize a provider ID, label, or alias for display-setting comparison. */
export function canonicalProviderName(value: string): string {
	const normalized = value.trim().toLowerCase();
	return PROVIDER_ALIASES[normalized] ?? normalized;
}

export interface MenuProvider {
	id: string;
	label: string;
}

/**
 * Every provider the menu can offer, in report order: first-party checks,
 * then the subscription registry, then OpenRouter accounting.
 */
export function knownMenuProviders(): MenuProvider[] {
	return [
		{ id: "openai-codex", label: "Codex" },
		{ id: "anthropic", label: "Claude" },
		{ id: "github-copilot", label: "Copilot" },
		...SUBSCRIPTION_PROVIDERS.map((config) => ({ id: config.provider, label: config.shortLabel })),
		{ id: "openrouter", label: "OpenRouter" },
	];
}

/**
 * Menu entries for a provider list: every known provider plus any custom
 * values already in the config (preserved verbatim so they can be removed).
 */
export function menuProviderEntries(current: string[]): MenuProvider[] {
	const known = knownMenuProviders();
	const entries = [...known];
	for (const value of current) {
		if (!known.some((provider) => canonicalProviderName(provider.id) === canonicalProviderName(value))) {
			entries.push({ id: value, label: value });
		}
	}
	return entries;
}

/** Tickbox rows for a toggle loop; selection compares canonically. */
export function toggleRows(all: string[], selected: string[]): string[] {
	const active = new Set(selected.map(canonicalProviderName));
	return all.map((name) => `${active.has(canonicalProviderName(name)) ? "[x]" : "[ ]"} ${name}`);
}

/** Strip the tickbox prefix from a toggle row. */
export function toggleRowValue(row: string): string {
	return row.replace(/^\[(?:x| )\] /, "");
}

/** Toggle a value in a selection, keeping the order of the full list. */
export function toggleInList(selected: string[], all: string[], value: string): string[] {
	const canon = canonicalProviderName(value);
	const entry = all.find((name) => canonicalProviderName(name) === canon) ?? value;
	const next = selected.some((name) => canonicalProviderName(name) === canon)
		? selected.filter((name) => canonicalProviderName(name) !== canon)
		: [...selected, entry];
	return all.filter((name) => next.some((other) => canonicalProviderName(other) === canonicalProviderName(name)));
}

/** Numbered order rows (`[n] Label`, unordered as `[—] Label`) for every entry. */
export function orderRows(entries: MenuProvider[], order: string[]): string[] {
	return entries.map((provider) => {
		const position = order.findIndex((name) => canonicalProviderName(name) === canonicalProviderName(provider.id));
		return `[${position >= 0 ? position + 1 : "—"}] ${provider.label}`;
	});
}

/** Strip the position prefix from an order row. */
export function orderRowValue(row: string): string {
	return row.replace(/^\[(?:\d+|—)\] /, "");
}

/**
 * Move a provider to a 1-based position (clamped), or remove it when
 * position is undefined. Unknown providers resolve through the entry list.
 */
export function applyOrderPosition(order: string[], entries: MenuProvider[], value: string, position: number | undefined): string[] {
	const canon = canonicalProviderName(value);
	const entry = order.find((name) => canonicalProviderName(name) === canon)
		?? entries.find((provider) => canonicalProviderName(provider.id) === canon)?.id
		?? value;
	const rest = order.filter((name) => canonicalProviderName(name) !== canon);
	if (position === undefined) return rest;
	const at = Math.min(Math.max(position, 1), rest.length + 1) - 1;
	return [...rest.slice(0, at), entry, ...rest.slice(at)];
}

/** Canonical JSON key for a case-insensitive user-supplied key. */
const CANONICAL_KEYS: Record<string, string> = {
	showwidget: "showWidget",
	showstatusline: "showStatusLine",
	hideunconfiguredproviders: "hideUnconfiguredProviders",
	compactwidget: "compactWidget",
	visibleproviders: "visibleProviders",
	hiddenproviders: "hiddenProviders",
	providerorder: "providerOrder",
	refreshminutes: "refreshMinutes",
	uirefreshseconds: "uiRefreshSeconds",
	quotadisplay: "quotaDisplay",
};

const USAGE_TEXT = [
	"Usage: /usage-config [show] | set <key> <value> | unset <key> [--local]",
	`Keys: ${USAGE_CONFIG_KEYS.join(", ")}`,
].join("\n");

/** Value kind of a lowercase config key, for menu editing. */
export function usageConfigKeyKind(key: string): "bool" | "list" | "int" | "option" | undefined {
	if (BOOL_KEYS.has(key)) return "bool";
	if (LIST_KEYS.has(key)) return "list";
	if (INT_KEYS.has(key)) return "int";
	if (key in OPTION_CHOICES) return "option";
	return undefined;
}

/** Allowed values for an option key (lowercase), or undefined. */
export function usageConfigOptions(key: string): string[] | undefined {
	return OPTION_CHOICES[key];
}

/** Parse raw /usage-config arguments into an action. Keys are lowercased. */
export function parseUsageConfigArgs(rawArgs: string): UsageConfigAction {
	const tokens = rawArgs.trim().split(/\s+/).filter((token) => token.length > 0);
	let local = false;
	const rest = tokens.filter((token) => {
		if (token === "--local" || token === "-l") {
			local = true;
			return false;
		}
		return true;
	});
	if (rest.length === 0) {
		return { action: "menu", local };
	}
	if (rest.length === 1 && rest[0].toLowerCase() === "show") {
		return { action: "show", local };
	}
	const [verb, key, ...valueParts] = rest;
	if (verb.toLowerCase() === "set" && key && valueParts.length >= 1) {
		return { action: "set", key: key.toLowerCase(), value: valueParts.join(" "), local };
	}
	if (verb.toLowerCase() === "unset" && key && valueParts.length === 0) {
		return { action: "unset", key: key.toLowerCase(), local };
	}
	return { action: "error", message: USAGE_TEXT };
}

/**
 * Validate and normalize a raw value for a config key.
 * Returns the JSON-ready value or an error message.
 */
export function normalizeUsageConfigValue(key: string, rawValue: string): { value: unknown } | { error: string } {
	if (!USAGE_CONFIG_KEYS.includes(key as (typeof USAGE_CONFIG_KEYS)[number])) {
		return { error: `Unknown key \"${key}\". ${USAGE_TEXT}` };
	}
	if (BOOL_KEYS.has(key)) {
		const parsed = parseBoolSetting(rawValue);
		if (parsed === undefined) return { error: `Invalid boolean \"${rawValue}\" — use true or false.` };
		return { value: parsed };
	}
	if (LIST_KEYS.has(key)) {
		return { value: providerNameList(rawValue) };
	}
	const choices = OPTION_CHOICES[key];
	if (choices) {
		const match = choices.find((choice) => choice === rawValue.trim().toLowerCase());
		if (match === undefined) return { error: `Invalid value "${rawValue}" — ${CANONICAL_KEYS[key]} must be one of: ${choices.join(", ")}.` };
		return { value: match };
	}
	if (INT_KEYS.has(key)) {
		const trimmed = rawValue.trim();
		if (!/^\d+$/.test(trimmed) || parseInt(trimmed, 10) < 1) {
			return { error: `Invalid value \"${rawValue}\" — ${CANONICAL_KEYS[key]} must be a positive integer.` };
		}
		return { value: parseInt(trimmed, 10) };
	}
	return { error: `Unknown key \"${key}\". ${USAGE_TEXT}` };
}

/** Canonical (camelCase) JSON key for a validated lowercase key. */
export function canonicalUsageConfigKey(key: string): string {
	return CANONICAL_KEYS[key] ?? key;
}

/**
 * Apply a set/unset change to a pi-usage.json file, preserving other keys.
 * Creates parent directories as needed. Returns the resulting file content.
 */
export function applyUsageConfigChange(
	filePath: string,
	change: { type: "set"; key: string; value: unknown } | { type: "unset"; key: string },
): Record<string, unknown> {
	const current = readJsonObject(filePath) ?? {};
	if (change.type === "set") {
		current[change.key] = change.value;
	} else {
		delete current[change.key];
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
	return current;
}

/** All canonical JSON keys managed by /usage-config. */
export const MANAGED_USAGE_CONFIG_KEYS = Object.values(CANONICAL_KEYS);

/** Keys offered by the interactive menu, in display order. */
export const USAGE_MENU_KEYS = [
	"showWidget",
	"showStatusLine",
	"hideUnconfiguredProviders",
	"compactWidget",
	"quotaDisplay",
	"visibleProviders",
	"hiddenProviders",
	"providerOrder",
	"refreshMinutes",
	"uiRefreshSeconds",
] as const;

/** Current display values for every interactive menu row (never undefined). */
export function usageMenuRowValues(display: ProviderDisplayPrefs, widget: boolean): Record<string, string> {
	return {
		showWidget: JSON.stringify(widget),
		showStatusLine: JSON.stringify(display.showStatusLine),
		hideUnconfiguredProviders: JSON.stringify(display.hideUnconfiguredProviders),
		compactWidget: JSON.stringify(display.compactWidget),
		quotaDisplay: display.quotaDisplay,
		visibleProviders: display.visibleProviders.join(", ") || "(all)",
		hiddenProviders: display.hiddenProviders.join(", ") || "(none)",
		providerOrder: display.providerOrder.join(", ") || "(default)",
		refreshMinutes: String(effectiveRefreshMinutes()),
		uiRefreshSeconds: String(effectiveUiRefreshSeconds()),
	};
}

/**
 * Reset to defaults: remove every managed key from a pi-usage.json file,
 * preserving unknown keys. Returns the remaining file content.
 */
export function resetUsageConfigFile(filePath: string): Record<string, unknown> {
	const current = readJsonObject(filePath) ?? {};
	for (const key of MANAGED_USAGE_CONFIG_KEYS) delete current[key];
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);
	return current;
}
