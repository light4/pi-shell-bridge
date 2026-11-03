import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { BangShellConfig, ShellName } from "./config.ts";
import { completeWith } from "./shells.ts";

const MAX_ITEMS = 200;

/** Text after `!` / `!!` and before the cursor, or undefined outside a bash-mode line. */
export function bangCommandBeforeCursor(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	if (cursorLine !== 0) return undefined;
	const match = (lines[0] ?? "").slice(0, cursorCol).match(/^\s*!!?(.*)$/s);
	return match?.[1]?.trimStart();
}

/** The word being completed: everything after the last unescaped, unquoted whitespace. */
export function currentWord(command: string): string {
	let start = 0;
	let quote: string | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === "\\" && quote !== "'") {
			index++;
		} else if (quote) {
			if (char === quote) quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/.test(char)) {
			start = index + 1;
		}
	}
	return command.slice(start);
}

export function applyShellCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	value: string,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] ?? "";
	const before = line.slice(0, cursorCol - prefix.length);
	const after = line.slice(cursorCol);
	// Keep completing inside directories and `--option=` values; otherwise finish the word.
	const suffix = /[/=:]$/.test(value) || /^\s/.test(after) ? "" : " ";
	const next = [...lines];
	next[cursorLine] = before + value + suffix + after;
	return { lines: next, cursorLine, cursorCol: before.length + value.length + suffix.length };
}

export function createBangCompletionProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
	shell: ShellName,
	getCwd: () => string,
	config: BangShellConfig,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const command = bangCommandBeforeCursor(lines, cursorLine, cursorCol);
			// Spawn a shell only on an explicit Tab (force), never on every keystroke.
			if (command === undefined || !options.force) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const completions = await completeWith(pi, shell, command, getCwd(), config, options.signal);
			if (options.signal.aborted || completions.length === 0) return null;
			const items: AutocompleteItem[] = completions.slice(0, MAX_ITEMS).map((completion) => ({
				value: completion.value,
				label: completion.value,
				description: completion.description,
			}));
			return { items, prefix: currentWord(command) };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (bangCommandBeforeCursor(lines, cursorLine, cursorCol) === undefined) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return applyShellCompletion(lines, cursorLine, cursorCol, item.value, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (bangCommandBeforeCursor(lines, cursorLine, cursorCol) !== undefined) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
