/**
 * Wrap-around selector tests for pi-usage.
 * Run with: npm test
 *
 * Covers pi-usage-l9h: modulo navigation, initial selection, confirm/cancel,
 * and the ui.custom() fallback in wrapSelect.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { WrapSelectorComponent, wrapSelect } from "./src/wrap-select.ts";
import type { UsageContext } from "./src/types.ts";

initTheme();

const stubKeybindings = { matches: () => false };

function harness(options: string[], initialIndex = 0): { component: WrapSelectorComponent; selected: Array<string | undefined> } {
	const selected: Array<string | undefined> = [];
	const component = new WrapSelectorComponent(
		"title",
		options,
		(option) => { selected.push(option); },
		() => { selected.push(undefined); },
		undefined,
		stubKeybindings,
		initialIndex,
	);
	return { component, selected };
}

function indexOf(component: WrapSelectorComponent): number {
	return (component as unknown as { selectedIndex: number }).selectedIndex;
}

describe("WrapSelectorComponent", () => {
	it("wraps down past the last row and up past the first", () => {
		const { component } = harness(["a", "b", "c"]);
		assert.equal(indexOf(component), 0);
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput("j");
		assert.equal(indexOf(component), 0);
		component.handleInput("k");
		assert.equal(indexOf(component), 2);
		component.handleInput("k");
		assert.equal(indexOf(component), 1);
	});

	it("starts on the requested initial index, clamped", () => {
		assert.equal(indexOf(harness(["a", "b"], 1).component), 1);
		assert.equal(indexOf(harness(["a", "b"], 99).component), 1);
		assert.equal(indexOf(harness(["a", "b"], -5).component), 0);
	});

	it("confirms the wrapped selection and cancels cleanly", () => {
		const first = harness(["a", "b"]);
		first.component.handleInput("k");
		first.component.handleInput("\n");
		assert.deepEqual(first.selected, ["b"]);
		const second = harness(["a", "b"]);
		second.component.handleInput("escape-does-not-match");
		assert.deepEqual(second.selected, []);
	});

	it("ignores navigation with no options", () => {
		const { component, selected } = harness([]);
		component.handleInput("j");
		component.handleInput("k");
		component.handleInput("\n");
		assert.deepEqual(selected, []);
	});

	it("shows the contextual hint for the highlighted row", () => {
		const selected: Array<string | undefined> = [];
		const component = new WrapSelectorComponent(
			"title",
			["a", "b"],
			(option) => { selected.push(option); },
			() => { selected.push(undefined); },
			undefined,
			stubKeybindings,
			0,
			["first hint", "second hint"],
			(hint) => `[${hint}]`,
		);
		const hintText = (): string => {
			const children = (component as unknown as { children: Array<{ render(width: number): string[] }> }).children;
			return children.map((child) => child.render(80).join("\n")).join("\n");
		};
		assert.match(hintText(), /\[first hint\]/);
		component.handleInput("j");
		assert.match(hintText(), /\[second hint\]/);
		component.handleInput("j");
		assert.match(hintText(), /\[first hint\]/);
	});

	it("adds no hint line without hints", () => {
		const { component } = harness(["a"]);
		const children = (component as unknown as { children: unknown[] }).children;
		assert.equal(children.length, 9);
	});
});

describe("wrapSelect", () => {
	function ctxWith(custom: unknown): { ctx: UsageContext; selectCalls: string[] } {
		const selectCalls: string[] = [];
		const ctx = {
			ui: {
				select: async (_title: string, _options: string[]) => {
					selectCalls.push(_title);
					return undefined;
				},
				custom,
			},
		} as unknown as UsageContext;
		return { ctx, selectCalls };
	}

	it("returns undefined without options and never opens a dialog", async () => {
		const { ctx, selectCalls } = ctxWith(async () => "a");
		assert.equal(await wrapSelect(ctx, "title", []), undefined);
		assert.deepEqual(selectCalls, []);
	});

	it("falls back to ui.select() when custom dialogs throw", async () => {
		const { ctx, selectCalls } = ctxWith(async () => { throw new Error("print mode"); });
		assert.equal(await wrapSelect(ctx, "title", ["a"]), undefined);
		assert.deepEqual(selectCalls, ["title"]);
	});

	it("resolves the custom dialog result and ignores non-strings", async () => {
		const ok = ctxWith(async () => "b");
		assert.equal(await wrapSelect(ok.ctx, "title", ["a", "b"], "b"), "b");
		const cancelled = ctxWith(async () => undefined);
		assert.equal(await wrapSelect(cancelled.ctx, "title", ["a"]), undefined);
		assert.deepEqual(cancelled.selectCalls, []);
	});
});
