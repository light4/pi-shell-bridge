import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SHELLS = ["fish", "zsh", "bash"] as const;
export type ShellName = (typeof SHELLS)[number];

export interface ShellBridgeConfig {
	/** Completion backend for `!` lines: a shell name, "auto" ($SHELL first) or "off". */
	completion: ShellName | "auto" | "off";
	/** Shells whose history receives `!` commands: "auto" (shells with an existing history file), "off" or a list. */
	history: ShellName[] | "auto" | "off";
	/** Fish-style inline suggestions from the launching shell's history on `!` lines. */
	autosuggest: boolean;
	/** Load the user's shell startup files (aliases, custom completions, HISTFILE). */
	loadUserConfig: boolean;
	/** Regular expressions; matching commands are not written to history. */
	ignore: string[];
}

export const DEFAULT_CONFIG: ShellBridgeConfig = {
	completion: "auto",
	history: "auto",
	autosuggest: true,
	loadUserConfig: true,
	ignore: [],
};

export function configPath(): string {
	return join(getAgentDir(), "pi-shell-bridge.json");
}

function isShell(value: unknown): value is ShellName {
	return typeof value === "string" && (SHELLS as readonly string[]).includes(value);
}

function parseCompletion(value: unknown): ShellBridgeConfig["completion"] | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "auto" || normalized === "off" || isShell(normalized) ? normalized : undefined;
}

function parseHistory(value: unknown): ShellBridgeConfig["history"] | undefined {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "auto" || normalized === "off") return normalized;
		value = normalized.split(",");
	}
	if (!Array.isArray(value)) return undefined;
	const shells = value.map((item) => (typeof item === "string" ? item.trim().toLowerCase() : item)).filter(isShell);
	return [...new Set(shells)];
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	return undefined;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ShellBridgeConfig {
	const object = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		completion:
			parseCompletion(env.PI_SHELL_BRIDGE_COMPLETION) ?? parseCompletion(object.completion) ?? DEFAULT_CONFIG.completion,
		history: parseHistory(env.PI_SHELL_BRIDGE_HISTORY) ?? parseHistory(object.history) ?? DEFAULT_CONFIG.history,
		autosuggest:
			parseBoolean(env.PI_SHELL_BRIDGE_AUTOSUGGEST) ?? parseBoolean(object.autosuggest) ?? DEFAULT_CONFIG.autosuggest,
		loadUserConfig:
			typeof object.loadUserConfig === "boolean" ? object.loadUserConfig : DEFAULT_CONFIG.loadUserConfig,
		ignore: Array.isArray(object.ignore) ? object.ignore.filter((item): item is string => typeof item === "string") : [],
	};
}

export function loadConfig(): { config: ShellBridgeConfig; error?: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const message = code === "ENOENT" ? undefined : `${configPath()}: ${(error as Error).message}`;
		return { config: parseConfig(undefined), error: message };
	}
	return { config: parseConfig(raw) };
}
