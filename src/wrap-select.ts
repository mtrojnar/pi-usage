/**
 * Wrap-around selector for /usage-config menus.
 *
 * Pi's built-in extension selector clamps the cursor at the first and last
 * row. This subclasses the publicly exported ExtensionSelectorComponent with
 * modulo navigation and an initial selection, presented through ui.custom().
 * Where custom dialogs are unavailable the caller falls back to ui.select().
 */
import {
	ExtensionSelectorComponent,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { UsageContext } from "./types.ts";

interface SelectorInternals {
	options: string[];
	selectedIndex: number;
	onSelectCallback: (option: string) => void;
	onCancelCallback: () => void;
	onToggleToolsExpanded?: () => void;
	titleText: { constructor: new (text?: string, paddingX?: number, paddingY?: number) => HintNode };
	updateList(): void;
}

interface HintNode {
	setText(text: string): void;
}

function internals(component: ExtensionSelectorComponent): SelectorInternals {
	return component as unknown as SelectorInternals;
}

type KeyMatcher = Pick<KeybindingsManager, "matches">;

export class WrapSelectorComponent extends ExtensionSelectorComponent {
	private keybindings: KeyMatcher;
	private hints: string[];
	private styleHint: (hint: string) => string;
	private hintNode?: HintNode;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts: { tui?: unknown; timeout?: number } | undefined,
		keybindings: KeyMatcher,
		initialIndex = 0,
		hints: string[] = [],
		styleHint: (hint: string) => string = (hint) => hint,
	) {
		super(title, options, onSelect, onCancel, opts as never);
		this.keybindings = keybindings;
		this.hints = hints;
		this.styleHint = styleHint;
		const inner = internals(this);
		inner.selectedIndex = options.length === 0
			? 0
			: Math.min(Math.max(initialIndex, 0), options.length - 1);
		inner.updateList();
		if (hints.length > 0) {
			// Splice a hint line between the option list and the key hints.
			// Container.children is public; Text is reached through the
			// title node's constructor so no pi-tui import is needed.
			this.hintNode = new inner.titleText.constructor("", 1, 0);
		this.children.splice(this.children.length - 3, 0, this.hintNode as never);
			this.updateHint();
		}
	}

	private updateHint(): void {
		if (!this.hintNode) return;
		const hint = this.hints[internals(this).selectedIndex] ?? "";
		this.hintNode.setText(hint ? this.styleHint(hint) : "");
	}

	override handleInput(keyData: string): void {
		const inner = internals(this);
		const count = inner.options.length;
		const matches = (id: string): boolean => {
			try {
				return this.keybindings.matches(keyData, id as Parameters<KeyMatcher["matches"]>[1]);
			} catch {
				return false;
			}
		};
		if (matches("app.tools.expand")) {
			inner.onToggleToolsExpanded?.();
		} else if ((matches("tui.select.up") || keyData === "k") && count > 0) {
			inner.selectedIndex = (((inner.selectedIndex - 1) % count) + count) % count;
			inner.updateList();
			this.updateHint();
		} else if ((matches("tui.select.down") || keyData === "j") && count > 0) {
			inner.selectedIndex = (inner.selectedIndex + 1) % count;
			inner.updateList();
			this.updateHint();
		} else if (matches("tui.select.confirm") || keyData === "\n") {
			const selected = inner.options[inner.selectedIndex];
			if (selected !== undefined) inner.onSelectCallback(selected);
		} else if (matches("tui.select.cancel")) {
			inner.onCancelCallback();
		}
	}
}

/**
 * Show a selector with wrap-around navigation, starting on initialValue when
 * given. Hints (parallel to options) render a contextual explanation line
 * for the highlighted row. Falls back to ui.select() only when custom
 * dialogs are unavailable.
 */
export async function wrapSelect(
	ctx: UsageContext,
	title: string,
	options: string[],
	initialValue?: string,
	hints: string[] = [],
): Promise<string | undefined> {
	if (options.length === 0) return undefined;
	const initialIndex = initialValue === undefined ? 0 : Math.max(0, options.indexOf(initialValue));
	try {
		const result = await ctx.ui.custom<string | undefined>(
			(tui, theme, keybindings, done) => new WrapSelectorComponent(
				title,
				options,
				(option) => done(option),
				() => done(undefined),
				{ tui },
				keybindings,
				initialIndex,
				hints,
				(hint) => theme.fg("dim", `ⓘ ${hint}`),
			),
		);
		return typeof result === "string" ? result : undefined;
	} catch {
		return ctx.ui.select(title, options);
	}
}
