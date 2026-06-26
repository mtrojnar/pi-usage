/**
 * pi-usage — Usage limit checker for pi coding agent
 *
 * Checks Codex (5hr & weekly) and OpenCode Go usage limits at startup.
 * Displays a startup report by default; persistent widget is opt-in.
 *
 * Also provides `/usage` command to refresh on demand.
 *
 * Setup:
 *   Codex:        Uses OAuth token from pi's auth.json (same as openai-codex provider)
 *   OpenCode Go:  Uses OPENCODE_API_KEY for model probes, plus optional
 *                 OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE for quota
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { CodexUsage, OpenCodeGoUsage, RefreshTrigger, UsageContext } from "./src/types.ts";
import {
	AUTO_REFRESH_MINUTES,
	NO_USAGE_WIDGET_FLAG,
	USAGE_WIDGET_FLAG,
	WIDGET_ID,
	getOpenCodeGoQuotaConfig,
	readUsageWidgetSetting,
} from "./src/config.ts";
import { getCodexToken, checkCodexUsage } from "./src/codex.ts";
import { getOpenCodeApiKey, checkOpenCodeGoUsage } from "./src/opencode-go.ts";
import {
	buildStartupUsageMessage,
	buildUsageWidget,
	updateFooterStatus,
} from "./src/render.ts";

// ───────── Extension ─────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag(USAGE_WIDGET_FLAG, {
		description: "Display pi-usage as a persistent widget above the editor",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(NO_USAGE_WIDGET_FLAG, {
		description: "Disable the pi-usage persistent widget for this run",
		type: "boolean",
		default: false,
	});

	let codexUsage: CodexUsage | undefined;
	let goUsage: OpenCodeGoUsage | undefined;
	let isLoading = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: UsageContext | undefined;

	function isUsageWidgetEnabled(ctx: UsageContext): boolean {
		if (pi.getFlag(NO_USAGE_WIDGET_FLAG) === true) return false;
		if (pi.getFlag(USAGE_WIDGET_FLAG) === true) return true;
		return readUsageWidgetSetting(ctx) ?? false;
	}

	async function refreshUsage(ctx: UsageContext, trigger: RefreshTrigger = "manual"): Promise<void> {
		if (isLoading) {
			if (ctx.hasUI) ctx.ui.notify("Usage check already in progress", "info");
			return;
		}
		isLoading = true;
		currentCtx = ctx;

		try {
			const showWidget = isUsageWidgetEnabled(ctx);
			const showStartupReport = !showWidget && trigger !== "auto";

			// Show loading state
			if (ctx.hasUI) {
				if (showWidget) {
					ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) =>
						buildUsageWidget(codexUsage, goUsage, theme, true),
					);
				} else {
					ctx.ui.setWidget(WIDGET_ID, undefined);
					if (showStartupReport) ctx.ui.notify("⚡ Checking usage limits...", "info");
				}
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
			const goQuotaState = getOpenCodeGoQuotaConfig();
			if (goKey || goQuotaState.config || goQuotaState.error) {
				checks.push(
					checkOpenCodeGoUsage(goKey, goQuotaState).then((result) => {
						goUsage = result;
					}),
				);
			} else {
				goUsage = undefined;
			}

			// Run checks in parallel
			await Promise.allSettled(checks);

			// Update display with results
			if (ctx.hasUI) {
				const showWidgetAfterRefresh = isUsageWidgetEnabled(ctx);
				if (showWidgetAfterRefresh) {
					ctx.ui.setWidget(WIDGET_ID, (_tui: unknown, theme: Theme) =>
						buildUsageWidget(codexUsage, goUsage, theme, false),
					);
				} else {
					ctx.ui.setWidget(WIDGET_ID, undefined);
					if (trigger !== "auto") {
						ctx.ui.notify(buildStartupUsageMessage(codexUsage, goUsage, true), "info");
					}
				}

				// Footer status
				updateFooterStatus(ctx, codexUsage, goUsage);
			}
		} finally {
			isLoading = false;
		}
	}

	function startAutoRefreshTimer(ctx: UsageContext): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentCtx) refreshUsage(currentCtx, "auto").catch(() => {});
		}, AUTO_REFRESH_MINUTES * 60 * 1000);
	}

	// ── Startup check + auto-refresh ──
	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		if (event.reason === "startup" || event.reason === "reload") {
			// Block /usage during startup delay to avoid duplicate checks
			isLoading = true;
			// Small delay to let TUI settle, then refresh; start autorefresh timer only after first check
			setTimeout(() => {
				isLoading = false;
				refreshUsage(ctx, "startup").catch(() => {}).then(() => {
					startAutoRefreshTimer(ctx);
				});
			}, 500);
		} else {
			startAutoRefreshTimer(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		currentCtx = undefined;
	});

	// ── /usage command ──
	pi.registerCommand("usage", {
		description: "Refresh and show Codex & OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			await refreshUsage(ctx, "manual");
		},
	});
}

// ───────── Re-exported for testing ─────────

export { clampPercent, formatDuration, formatResetTime, parseHeaderBool, parseHeaderNumber, progressBar, statusIcon, truncate, usageColor } from "./src/format.ts";
export { dedupe, parseBoolValue, parseEnvInt, resolveConfigValue } from "./src/config.ts";
export { windowMinutes, windowResetAfterSeconds, windowResetAt, windowUsedPercent } from "./src/codex.ts";
export { footerResetDuration, footerUsageColor } from "./src/render.ts";
export { isGlobalGoLimit, isPerModelUnavailable, resolveModelEndpoint } from "./src/opencode-go.ts";
