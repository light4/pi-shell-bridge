import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SHELLS, type ShellBridgeConfig, type ShellName } from "./config.ts";
import { type RunResult, run } from "./exec.ts";

const MARKER = "__PI_SHELL_BRIDGE_READY__";
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

function asShell(name: string | undefined): ShellName | undefined {
	const normalized = basename(name ?? "").replace(/^-/, ""); // login shells show up as "-zsh"
	return (SHELLS as readonly string[]).includes(normalized) ? (normalized as ShellName) : undefined;
}

const MAX_ANCESTORS = 16;
/** Interactive shells we recognise as "the shell Pi was launched from", supported or not. */
const KNOWN_SHELLS = new Set([
	...SHELLS,
	"sh", "dash", "ash", "ksh", "mksh", "oksh", "pdksh", "csh", "tcsh", "nu", "xonsh", "elvish",
	"pwsh", "powershell", "ion", "oil", "osh", "ysh", "murex", "rc", "es", "yash", "posh",
]);

export interface LaunchingShell {
	/** Executable name of the nearest shell ancestor, e.g. "fish" or "nu"; undefined when none was found. */
	name?: string;
	/** The same shell when pi-shell-bridge supports it. */
	shell?: ShellName;
}

let launchingShell: LaunchingShell | undefined;

/** The nearest shell ancestor of this Pi process, i.e. the shell Pi was started from. Never throws. */
export function detectLaunchingShell(): LaunchingShell {
	if (launchingShell) return launchingShell;
	launchingShell = {};
	let pid = process.ppid;
	try {
		for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
			const output = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			}).trim();
			const match = output.match(/^(\d+)\s+(.+)$/);
			if (!match) break;
			const name = basename(match[2].trim()).replace(/^-/, "");
			if (KNOWN_SHELLS.has(name)) {
				launchingShell = { name, shell: asShell(name) };
				break;
			}
			pid = Number(match[1]);
		}
	} catch {
		// `ps` missing or failing: behave as if no launching shell was found.
	}
	return launchingShell;
}

/**
 * The shell `auto` refers to: the shell Pi was launched from. Only when no shell ancestor is found
 * (e.g. Pi started directly by a terminal or IDE) does $SHELL stand in. An unsupported launching shell
 * (nu, sh, …) yields undefined.
 */
export function autoShell(): ShellName | undefined {
	const launching = detectLaunchingShell();
	const shell = launching.name ? launching.shell : asShell(process.env.SHELL);
	return shell && isInstalled(shell) ? shell : undefined;
}

export function resolveCompletionShell(config: ShellBridgeConfig): ShellName | undefined {
	if (config.completion === "off") return undefined;
	if (config.completion !== "auto") return isInstalled(config.completion) ? config.completion : undefined;
	// Completion only runs on Tab and never touches history, so any installed shell is a fine fallback.
	const login = asShell(process.env.SHELL);
	return autoShell() ?? (login && isInstalled(login) ? login : undefined) ?? SHELLS.find(isInstalled);
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
	shell: ShellName,
	commandLine: string,
	cwd: string,
	config: ShellBridgeConfig,
	signal: AbortSignal,
): Promise<Completion[]> {
	const options = { cwd, signal, timeout: COMPLETE_TIMEOUT_MS };
	let result: RunResult;
	let lines: string[];
	switch (shell) {
		case "fish": {
			const args = config.loadUserConfig ? [] : ["--no-config"];
			result = await run(
				"fish",
				[...args, "-c", `echo ${MARKER}; complete -C -- "$argv[1]"`, commandLine],
				options,
			);
			lines = afterMarker(result.stdout);
			break;
		}
		case "bash": {
			const args = config.loadUserConfig ? ["-i"] : ["--norc", "--noprofile"];
			result = await run("bash", [...args, BASH_COMPLETE_SCRIPT, commandLine, MARKER], options);
			lines = afterMarker(result.stdout);
			break;
		}
		case "zsh": {
			const args = [ZSH_CAPTURE_SCRIPT, commandLine];
			if (!config.loadUserConfig) args.push("no-rc");
			result = await run("zsh", ["-f", ...args], options);
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
	shell: ShellName,
	config: ShellBridgeConfig,
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
				const result = await run(
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
				const result = await run(
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

function historyTarget(shell: ShellName, config: ShellBridgeConfig): Promise<HistoryTarget | undefined> {
	let target = targetCache.get(shell);
	if (!target) {
		target = probeHistoryTarget(shell, config).catch(() => undefined);
		targetCache.set(shell, target);
	}
	return target;
}

/** The history file of `shell` (probed once per Pi process), or undefined when it keeps none. */
export async function historyFile(shell: ShellName, config: ShellBridgeConfig): Promise<string | undefined> {
	return (await historyTarget(shell, config))?.file;
}

/** The shell whose history feeds autosuggestions: the launching shell, else the first configured history shell. */
export function suggestionShell(config: ShellBridgeConfig): ShellName | undefined {
	return autoShell() ?? (Array.isArray(config.history) ? config.history.find(isInstalled) : undefined);
}

/** Resolve which shells receive history; probes run once per Pi process. */
export async function resolveHistoryShells(config: ShellBridgeConfig): Promise<ShellName[]> {
	if (config.history === "off") return [];
	const auto = autoShell();
	const candidates = config.history === "auto" ? (auto ? [auto] : []) : config.history.filter(isInstalled);
	const resolved = await Promise.all(
		candidates.map(async (shell) => {
			const target = await historyTarget(shell, config);
			if (!target) return undefined;
			// In auto mode only write to the launching shell, and only when the user keeps history for it.
			return config.history !== "auto" || existsSync(target.file) ? shell : undefined;
		}),
	);
	return resolved.filter((shell): shell is ShellName => shell !== undefined);
}

/** Append one command to a shell's history using that shell's own history writer. */
export async function appendHistory(
	shell: ShellName,
	command: string,
	config: ShellBridgeConfig,
): Promise<void> {
	const target = await historyTarget(shell, config);
	if (!target) return;
	const options = { timeout: HISTORY_TIMEOUT_MS };
	let result: RunResult;
	switch (shell) {
		case "fish": {
			// --no-config disables history persistence, so fish must load its normal configuration.
			result = await run("fish", ["-c", 'history append -- "$argv[1]"', command], options);
			break;
		}
		case "bash": {
			result = await run(
				"bash",
				[
					"--norc",
					"--noprofile",
					"-c",
					'HISTFILE=$1; if [ "$2" != __unset__ ]; then HISTTIMEFORMAT=$2; fi; set -o history; history -s -- "$3"; history -a',
					"pi-shell-bridge",
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
			result = await run(
				"zsh",
				[
					"-f",
					"-i",
					"-c",
					'[[ $2 == 1 ]] && setopt extended_history; HISTFILE=$1; HISTSIZE=100; SAVEHIST=1000000; print -s -- "$3"; fc -AI; unset HISTFILE',
					"pi-shell-bridge",
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
