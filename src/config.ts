import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SHELLS = ["fish", "zsh", "bash"] as const;
export type ShellName = (typeof SHELLS)[number];

export interface BangShellConfig {
	/** Completion backend for `!` lines: a shell name, "auto" ($SHELL first) or "off". */
	completion: ShellName | "auto" | "off";
	/** Shells whose history receives `!` commands: "auto" (shells with an existing history file), "off" or a list. */
	history: ShellName[] | "auto" | "off";
	/** Load the user's shell startup files (aliases, custom completions, HISTFILE). */
	loadUserConfig: boolean;
	/** Regular expressions; matching commands are not written to history. */
	ignore: string[];
}

export const DEFAULT_CONFIG: BangShellConfig = {
	completion: "auto",
	history: "auto",
	loadUserConfig: true,
	ignore: [],
};

export function configPath(): string {
	return join(getAgentDir(), "pi-bang-shell.json");
}

function isShell(value: unknown): value is ShellName {
	return typeof value === "string" && (SHELLS as readonly string[]).includes(value);
}

function parseCompletion(value: unknown): BangShellConfig["completion"] | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "auto" || normalized === "off" || isShell(normalized) ? normalized : undefined;
}

function parseHistory(value: unknown): BangShellConfig["history"] | undefined {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "auto" || normalized === "off") return normalized;
		value = normalized.split(",");
	}
	if (!Array.isArray(value)) return undefined;
	const shells = value.map((item) => (typeof item === "string" ? item.trim().toLowerCase() : item)).filter(isShell);
	return [...new Set(shells)];
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): BangShellConfig {
	const object = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		completion:
			parseCompletion(env.PI_BANG_SHELL_COMPLETION) ?? parseCompletion(object.completion) ?? DEFAULT_CONFIG.completion,
		history: parseHistory(env.PI_BANG_SHELL_HISTORY) ?? parseHistory(object.history) ?? DEFAULT_CONFIG.history,
		loadUserConfig:
			typeof object.loadUserConfig === "boolean" ? object.loadUserConfig : DEFAULT_CONFIG.loadUserConfig,
		ignore: Array.isArray(object.ignore) ? object.ignore.filter((item): item is string => typeof item === "string") : [],
	};
}

export function loadConfig(): { config: BangShellConfig; error?: string } {
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
