import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SHELLS, type BangShellConfig, type ShellName } from "./config.ts";

const MARKER = "__PI_BANG_SHELL_READY__";
const COMPLETE_TIMEOUT_MS = 5_000;
const HISTORY_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

const BASH_COMPLETE_SCRIPT = fileURLToPath(new URL("./bash-complete.bash", import.meta.url));
const ZSH_CAPTURE_SCRIPT = fileURLToPath(new URL("./zsh-capture.zsh", import.meta.url));

export interface Completion {
	value: string;
	description?: string;
}

interface HistoryTarget {
	file: string;
	/** bash: HISTTIMEFORMAT value (undefined when unset); zsh: "1" when EXTENDED_HISTORY is set. */
	format?: string;
}

const binaryCache = new Map<ShellName, boolean>();

export function isInstalled(shell: ShellName): boolean {
	const cached = binaryCache.get(shell);
	if (cached !== undefined) return cached;
	const found = (process.env.PATH ?? "").split(delimiter).some((dir) => {
		if (!dir) return false;
		try {
			accessSync(join(dir, shell), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	binaryCache.set(shell, found);
	return found;
}

export function resolveCompletionShell(config: BangShellConfig): ShellName | undefined {
	if (config.completion === "off") return undefined;
	if (config.completion !== "auto") return isInstalled(config.completion) ? config.completion : undefined;
	const login = basename(process.env.SHELL ?? "");
	const ordered = [login, ...SHELLS].filter((name): name is ShellName => (SHELLS as readonly string[]).includes(name));
	return ordered.find(isInstalled);
}

function afterMarker(stdout: string): string[] {
	const index = stdout.lastIndexOf(`${MARKER}\n`);
	const body = index === -1 ? "" : stdout.slice(index + MARKER.length + 1);
	return body.split("\n").map((line) => line.replace(/\r$/, ""));
}

export function parseCompletions(lines: string[]): Completion[] {
	const byValue = new Map<string, Completion>();
	for (const line of lines) {
		if (!line.trim()) continue;
		const tab = line.indexOf("\t");
		const value = tab === -1 ? line : line.slice(0, tab);
		const description = tab === -1 ? undefined : line.slice(tab + 1).trim() || undefined;
		const existing = byValue.get(value);
		if (!existing) byValue.set(value, { value, description });
		else if (!existing.description && description) existing.description = description;
	}
	return [...byValue.values()];
}

/** Ask a shell to complete `commandLine` (text before the cursor) in `cwd`. */
export async function completeWith(
	pi: ExtensionAPI,
	shell: ShellName,
	commandLine: string,
	cwd: string,
	config: BangShellConfig,
	signal: AbortSignal,
): Promise<Completion[]> {
	const options = { cwd, signal, timeout: COMPLETE_TIMEOUT_MS };
	let result: ExecResult;
	let lines: string[];
	switch (shell) {
		case "fish": {
			const args = config.loadUserConfig ? [] : ["--no-config"];
			result = await pi.exec(
				"fish",
				[...args, "-c", `echo ${MARKER}; complete -C -- "$argv[1]"`, commandLine],
				options,
			);
			lines = afterMarker(result.stdout);
			break;
		}
		case "bash": {
			const args = config.loadUserConfig ? ["-i"] : ["--norc", "--noprofile"];
			result = await pi.exec("bash", [...args, BASH_COMPLETE_SCRIPT, commandLine, MARKER], options);
			lines = afterMarker(result.stdout);
			break;
		}
		case "zsh": {
			const args = [ZSH_CAPTURE_SCRIPT, commandLine];
			if (!config.loadUserConfig) args.push("no-rc");
			result = await pi.exec("zsh", ["-f", ...args], options);
			lines = result.stdout.split("\n");
			break;
		}
	}
	if (result.killed) return [];
	return parseCompletions(lines);
}

const targetCache = new Map<ShellName, Promise<HistoryTarget | undefined>>();

function fileExists(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** Detect EXTENDED_HISTORY (": <epoch>:<duration>;command") from the tail of an existing zsh history file. */
function sniffZshExtended(file: string): boolean {
	if (!fileExists(file)) return false;
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, 4096);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			return /^: \d+:\d+;/m.test(buffer.toString("latin1"));
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

async function probeHistoryTarget(
	pi: ExtensionAPI,
	shell: ShellName,
	config: BangShellConfig,
): Promise<HistoryTarget | undefined> {
	const home = homedir();
	switch (shell) {
		case "fish": {
			// fish owns its history file format and location (fish_history); `history append` handles both.
			const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
			return { file: join(dataHome, "fish", "fish_history") };
		}
		case "bash": {
			let file = process.env.HISTFILE || join(home, ".bash_history");
			let format: string | undefined = process.env.HISTTIMEFORMAT;
			if (config.loadUserConfig) {
				const result = await pi.exec(
					"bash",
					["-i", "-c", `printf '%s\\n' ${MARKER} "$HISTFILE" "\${HISTTIMEFORMAT-__unset__}"`],
					{ cwd: home, timeout: PROBE_TIMEOUT_MS },
				);
				const [histfile, timeFormat] = afterMarker(result.stdout);
				if (histfile) file = histfile;
				if (timeFormat !== undefined) format = timeFormat === "__unset__" ? undefined : timeFormat;
			}
			return { file, format };
		}
		case "zsh": {
			// zsh has no default HISTFILE: without one the user does not keep history.
			let file = process.env.HISTFILE;
			let format: string | undefined;
			if (config.loadUserConfig) {
				const result = await pi.exec(
					"zsh",
					["-i", "-c", `print -rl -- ${MARKER} "$HISTFILE"; [[ -o extendedhistory ]] && print 1 || print 0`],
					{ cwd: home, timeout: PROBE_TIMEOUT_MS },
				);
				const [histfile, extended] = afterMarker(result.stdout);
				if (histfile) file = histfile;
				format = extended;
			}
			if (!file) return undefined;
			format ??= sniffZshExtended(file) ? "1" : "0";
			return { file, format };
		}
	}
}

function historyTarget(pi: ExtensionAPI, shell: ShellName, config: BangShellConfig): Promise<HistoryTarget | undefined> {
	let target = targetCache.get(shell);
	if (!target) {
		target = probeHistoryTarget(pi, shell, config).catch(() => undefined);
		targetCache.set(shell, target);
	}
	return target;
}

/** Resolve which shells receive history; probes run once per Pi process. */
export async function resolveHistoryShells(pi: ExtensionAPI, config: BangShellConfig): Promise<ShellName[]> {
	if (config.history === "off") return [];
	const candidates = (config.history === "auto" ? [...SHELLS] : config.history).filter(isInstalled);
	const resolved = await Promise.all(
		candidates.map(async (shell) => {
			const target = await historyTarget(pi, shell, config);
			if (!target) return undefined;
			// In auto mode only write to shells the user already keeps history for.
			return config.history !== "auto" || existsSync(target.file) ? shell : undefined;
		}),
	);
	return resolved.filter((shell): shell is ShellName => shell !== undefined);
}

/** Append one command to a shell's history using that shell's own history writer. */
export async function appendHistory(
	pi: ExtensionAPI,
	shell: ShellName,
	command: string,
	config: BangShellConfig,
): Promise<void> {
	const target = await historyTarget(pi, shell, config);
	if (!target) return;
	const options = { timeout: HISTORY_TIMEOUT_MS };
	let result: ExecResult;
	switch (shell) {
		case "fish": {
			// --no-config disables history persistence, so fish must load its normal configuration.
			result = await pi.exec("fish", ["-c", 'history append -- "$argv[1]"', command], options);
			break;
		}
		case "bash": {
			result = await pi.exec(
				"bash",
				[
					"--norc",
					"--noprofile",
					"-c",
					'HISTFILE=$1; if [ "$2" != __unset__ ]; then HISTTIMEFORMAT=$2; fi; set -o history; history -s -- "$3"; history -a',
					"pi-bang-shell",
					target.file,
					target.format ?? "__unset__",
					command,
				],
				options,
			);
			break;
		}
		case "zsh": {
			// Interactive (-i) so history is active; HISTFILE is unset afterwards so exit does not rewrite the file.
			result = await pi.exec(
				"zsh",
				[
					"-f",
					"-i",
					"-c",
					'[[ $2 == 1 ]] && setopt extended_history; HISTFILE=$1; HISTSIZE=100; SAVEHIST=1000000; print -s -- "$3"; fc -AI; unset HISTFILE',
					"pi-bang-shell",
					target.file,
					target.format ?? "0",
					command,
				],
				options,
			);
			break;
		}
	}
	if (result.code !== 0 || result.killed) {
		throw new Error(`${shell}: ${result.stderr.trim() || (result.killed ? "timed out" : `exit ${result.code}`)}`);
	}
}
