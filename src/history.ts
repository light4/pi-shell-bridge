import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { ShellName } from "./config.ts";

/** Read at most this much from the end of a history file. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Re-check the history file's mtime at most this often. */
const RECHECK_MS = 1_000;

function readTail(file: string): Buffer {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, MAX_READ_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer;
	} finally {
		closeSync(fd);
	}
}

/** Undo zsh's metafication: 0x83 (Meta) followed by a byte XOR 0x20. */
export function unmetafy(buffer: Buffer): Buffer {
	if (!buffer.includes(0x83)) return buffer;
	const out = Buffer.alloc(buffer.length);
	let length = 0;
	for (let index = 0; index < buffer.length; index++) {
		const byte = buffer[index];
		if (byte === 0x83 && index + 1 < buffer.length) out[length++] = buffer[++index] ^ 0x20;
		else out[length++] = byte;
	}
	return out.subarray(0, length);
}

/** fish_history: YAML-like `- cmd: <escaped>` entries, oldest first. */
export function parseFish(text: string): string[] {
	const commands: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("- cmd: ")) continue;
		commands.push(line.slice(7).replace(/\\(\\|n)/g, (_match, char: string) => (char === "n" ? "\n" : "\\")));
	}
	return commands;
}

/** zsh history (plain or EXTENDED_HISTORY), oldest first; continuation lines end with a backslash. */
export function parseZsh(text: string): string[] {
	const commands: string[] = [];
	let pending: string | undefined;
	for (const raw of text.split("\n")) {
		let line = raw;
		if (pending === undefined) {
			const extended = line.match(/^: \d+:\d+;(.*)$/s);
			if (extended) line = extended[1];
			pending = "";
		}
		if (line.endsWith("\\")) {
			pending += `${line.slice(0, -1)}\n`;
			continue;
		}
		pending += line;
		if (pending) commands.push(pending);
		pending = undefined;
	}
	if (pending) commands.push(pending.replace(/\n$/, ""));
	return commands;
}

/** bash history, oldest first; `#<epoch>` lines are HISTTIMEFORMAT timestamps. */
export function parseBash(text: string): string[] {
	return text.split("\n").filter((line) => line.length > 0 && !/^#\d{9,}$/.test(line));
}

export function parseHistory(shell: ShellName, buffer: Buffer): string[] {
	switch (shell) {
		case "fish":
			return parseFish(buffer.toString("utf8"));
		case "zsh":
			return parseZsh(unmetafy(buffer).toString("utf8"));
		case "bash":
			return parseBash(buffer.toString("utf8"));
	}
}

/** Only single-line commands without control characters can be drawn inline. */
const UNSUGGESTABLE = /[\u0000-\u001f\u007f]/;

/** Single-line commands, newest first, without duplicates. */
function newestFirst(commands: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (let index = commands.length - 1; index >= 0; index--) {
		const command = commands[index].trim();
		if (!command || UNSUGGESTABLE.test(command) || seen.has(command)) continue;
		seen.add(command);
		result.push(command);
	}
	return result;
}

/**
 * Commands for fish-style autosuggestions: `!` commands of this Pi session first, then the shell's history file.
 * The file is re-read only when its mtime changes, so lookups stay cheap enough for every keystroke.
 */
export class HistoryIndex {
	private session: string[] = [];
	private fromFile: string[] = [];
	private shell: ShellName | undefined;
	private file: string | undefined;
	private mtimeMs = -1;
	private checkedAt = 0;
	private cache: { prefix: string; version: number; suffix: string | undefined } | undefined;
	private version = 0;

	setSource(shell: ShellName | undefined, file: string | undefined): void {
		this.shell = shell;
		this.file = file;
		this.mtimeMs = -1;
		this.checkedAt = 0;
		this.refresh();
	}

	/** Record a `!` command run in this session (shown before the file catches up). */
	remember(command: string): void {
		const trimmed = command.trim();
		if (!trimmed || UNSUGGESTABLE.test(trimmed)) return;
		this.session = [trimmed, ...this.session.filter((item) => item !== trimmed)];
		this.version++;
	}

	private refresh(): void {
		const now = Date.now();
		if (!this.shell || !this.file || now - this.checkedAt < RECHECK_MS) return;
		this.checkedAt = now;
		try {
			const mtimeMs = statSync(this.file).mtimeMs;
			if (mtimeMs === this.mtimeMs) return;
			this.mtimeMs = mtimeMs;
			this.fromFile = newestFirst(parseHistory(this.shell, readTail(this.file)));
		} catch {
			this.fromFile = [];
		}
		this.version++;
	}

	/** The text that completes `prefix` to the newest matching command, or undefined. */
	suggest(prefix: string): string | undefined {
		if (!prefix.trim()) return undefined;
		this.refresh();
		if (this.cache?.prefix === prefix && this.cache.version === this.version) return this.cache.suffix;
		let suffix: string | undefined;
		for (const list of [this.session, this.fromFile]) {
			const match = list.find((command) => command.length > prefix.length && command.startsWith(prefix));
			if (match) {
				suffix = match.slice(prefix.length);
				break;
			}
		}
		this.cache = { prefix, version: this.version, suffix };
		return suffix;
	}
}
