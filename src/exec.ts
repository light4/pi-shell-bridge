import { spawn } from "node:child_process";

export interface RunOptions {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Run a helper shell in its own session (setsid) with no controlling terminal.
 *
 * Interactive shells (`bash -i`, `zsh -i`) enable job control and move themselves into the terminal's
 * foreground process group. Started with Pi's controlling terminal, they push Pi into the background and
 * Pi is stopped by SIGTTIN/SIGTTOU ("fish: Job 1, 'pi' has stopped"). A new session has no terminal to take.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ stdout, stderr: (error as Error).message, code: 1, killed });
			return;
		}

		const kill = () => {
			if (killed || child.pid === undefined) return;
			killed = true;
			try {
				process.kill(-child.pid, "SIGKILL"); // whole process group, including zpty children
			} catch {
				child.kill("SIGKILL");
			}
		};
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ stdout, stderr, code, killed });
		};

		if (options.signal?.aborted) kill();
		else options.signal?.addEventListener("abort", kill, { once: true });
		if (options.timeout && options.timeout > 0) timer = setTimeout(kill, options.timeout);

		child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
		child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
		child.on("error", (error) => {
			stderr += error.message;
			finish(1);
		});
		child.on("close", (code) => finish(code ?? 1));
	});
}
