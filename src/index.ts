// pi-shell-bridge: shell completion and shell history for Pi's `!` / `!!` commands.
//
// - Tab on a `!cmd` line asks fish, zsh or bash for completions, reusing the user's shell setup.
// - Each `!` command is appended to the fish / zsh / bash history files the user keeps.
// Commands still run through Pi's built-in bash; this extension does not change execution.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createShellCompletionProvider } from "./completion.ts";
import { loadConfig, type ShellName } from "./config.ts";
import { appendHistory, resolveCompletionShell, resolveHistoryShells } from "./shells.ts";

export default function piShellBridge(pi: ExtensionAPI): void {
	const { config, error } = loadConfig();
	const ignore = config.ignore.flatMap((pattern) => {
		try {
			return [new RegExp(pattern)];
		} catch {
			return [];
		}
	});
	let historyShells: Promise<ShellName[]> | undefined;
	let cwd = process.cwd();

	const warn = (ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, error: unknown) => {
		try {
			ctx.ui.notify(`pi-shell-bridge: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} catch {
			// The UI may already be gone; never let the bridge take Pi down.
		}
	};
	const shellsForHistory = () =>
		(historyShells ??= resolveHistoryShells(config).catch((): ShellName[] => []));

	pi.on("session_start", async (_event, ctx) => {
		try {
			cwd = ctx.cwd;
			if (error) warn(ctx, error);
			const shell = resolveCompletionShell(config);
			if (shell) {
				ctx.ui.addAutocompleteProvider((current) =>
					createShellCompletionProvider(current, shell, () => cwd, config),
				);
			}
			// Probe history locations in the background so the first command is not delayed.
			void shellsForHistory();
		} catch (caught) {
			warn(ctx, caught);
		}
	});

	pi.on("user_bash", async (event, ctx) => {
		try {
			cwd = event.cwd || cwd;
			const command = event.command.trim();
			if (!command || ignore.some((pattern) => pattern.test(command))) return undefined;
			void shellsForHistory()
				.then((shells) => Promise.allSettled(shells.map((shell) => appendHistory(shell, command, config))))
				.then((results) => {
					const failures = results
						.filter((result): result is PromiseRejectedResult => result.status === "rejected")
						.map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
					if (failures.length > 0) warn(ctx, failures.join("; "));
				})
				.catch((caught: unknown) => warn(ctx, caught));
		} catch (caught) {
			warn(ctx, caught);
		}
		return undefined; // let Pi run the command as usual
	});
}
