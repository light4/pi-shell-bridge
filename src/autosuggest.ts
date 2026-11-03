// Fish-style autosuggestions for `!` lines: the newest matching history command is drawn dimmed after the
// cursor. It is not part of the editor text; → / End / Ctrl+F accept it, Alt+→ / Alt+F accept one word.

import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, renderFakeCursor, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HistoryIndex } from "./history.ts";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

const END_CURSOR = renderFakeCursor(" ");
const BANG_LINE = /^(\s*!!?\s*)(.*)$/s;

/** The command typed after `!` / `!!`, or undefined when the text is not a bash-mode line. */
export function bangCommand(text: string): string | undefined {
	const match = text.match(BANG_LINE);
	return match ? match[2] : undefined;
}

/** The first word of a suggestion, with the whitespace before it (fish: Alt+→). */
export function firstWord(suffix: string): string {
	return suffix.match(/^\s*\S+/)?.[0] ?? suffix;
}

/**
 * Replace the end-of-line fake cursor and the padding after it with `suffix`: the cursor sits on the
 * first suggested character, the rest is styled with `dim`. Lines without that cursor are returned unchanged.
 */
export function drawSuggestion(line: string, suffix: string, paddingX: number, dim: (text: string) => string): string {
	const at = line.lastIndexOf(END_CURSOR);
	if (at === -1) return line;
	const after = line.slice(at + END_CURSOR.length);
	if (!/^ *$/.test(after)) return line;
	const room = 1 + Math.max(0, after.length - paddingX); // the cursor cell plus the padding up to the margin
	const shown = truncateToWidth(suffix, room, "");
	const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(shown)];
	const head = graphemes[0]?.segment;
	if (!head || visibleWidth(head) !== 1) return line; // keep the one-cell cursor layout intact
	const rest = shown.slice(head.length);
	const used = visibleWidth(shown);
	return line.slice(0, at) + renderFakeCursor(dim(head)) + dim(rest) + " ".repeat(Math.max(0, after.length + 1 - used));
}

export class AutosuggestEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keys: KeybindingsManager,
		private readonly commands: HistoryIndex,
		private readonly dim: (text: string) => string,
	) {
		super(tui, theme, keys);
	}

	/** The suggested completion of the current line, when the cursor is at the end of a single-line `!` command. */
	suggestion(): string | undefined {
		if (this.isShowingAutocomplete()) return undefined;
		const lines = this.getLines();
		if (lines.length !== 1) return undefined;
		const cursor = this.getCursor();
		if (cursor.line !== 0 || cursor.col !== lines[0].length) return undefined;
		const command = bangCommand(lines[0]);
		return command === undefined ? undefined : this.commands.suggest(command);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		try {
			const suffix = this.suggestion();
			if (!suffix) return lines;
			const index = lines.findIndex((line) => line.includes(END_CURSOR));
			if (index !== -1) lines[index] = drawSuggestion(lines[index], suffix, this.getPaddingX(), this.dim);
		} catch {
			// Never break the editor over a suggestion.
		}
		return lines;
	}

	override handleInput(data: string): void {
		const suffix = this.acceptable(data);
		if (suffix) {
			this.insertTextAtCursor(suffix);
			return;
		}
		super.handleInput(data);
	}

	private acceptable(data: string): string | undefined {
		const keys = this.keys;
		const whole = keys.matches(data, "tui.editor.cursorRight") || keys.matches(data, "tui.editor.cursorLineEnd");
		const word = keys.matches(data, "tui.editor.cursorWordRight");
		if (!whole && !word) return undefined;
		const suffix = this.suggestion();
		if (!suffix) return undefined;
		return whole ? suffix : firstWord(suffix);
	}
}

export function autosuggestEditorFactory(history: HistoryIndex, dim: (text: string) => string): EditorFactory {
	return (tui, theme, keybindings) => new AutosuggestEditor(tui, theme, keybindings, history, dim);
}
