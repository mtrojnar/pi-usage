import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { GoModelStatus } from "./types.ts";

// ───────── Formatting Helpers ─────────

export function truncate(text: string, maxLen: number): string {
	return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

export function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}h`;
	return `${Math.round(seconds / 86400 * 10) / 10}d`;
}

export function formatResetTime(unixTsSec: number): string {
	const diff = unixTsSec * 1000 - Date.now();
	if (diff <= 0) return "now";
	return formatDuration(diff / 1000);
}

export function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

export function progressBar(percent: number, width: number = 20): string {
	const filled = Math.round((clampPercent(percent) / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

export function usageColor(percent: number): ThemeColor {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

export function parseHeaderNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseHeaderBool(value: string | undefined): boolean {
	return value?.toLowerCase() === "true";
}

export function statusIcon(status: GoModelStatus): string {
	switch (status) {
		case "available": return "✓";
		case "rate_limited": return "⏳";
		case "credits_error": return "✗";
		case "error": return "⚠";
		case "no_key": return "—";
	}
}
