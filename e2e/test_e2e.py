#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""End-to-end tests: real `pi` + this extension, launched from real interactive shells in a pseudo terminal.

Each test starts a shell with job control (fish / zsh / bash / sh / dash / nu) in a pty, inside an isolated
HOME and Pi agent dir, runs `pi -ne --no-session -e <extension>` from it and checks that:

- Pi is not stopped by job control and stays in the terminal's foreground process group
  (regression: `fish: Job 1, 'pi' has stopped`), also with unsupported launching shells;
- Tab on a `!` line completes through the launching shell;
- `!` commands reach the history of the launching shell only (history "auto"), or every configured shell.

Run:  uv run e2e/test_e2e.py            (or: pnpm run test:e2e)
Env:  PI_BIN=<pi executable>  E2E_EXTENSION=<extension entry>  E2E_SHELLS=fish,zsh,...  E2E_VERBOSE=1
"""

from __future__ import annotations

import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = Path(os.environ.get("E2E_EXTENSION", ROOT / "src" / "index.ts")).resolve()
# Skip node_modules/.bin (prepended by `pnpm run`): test the user's installed pi unless PI_BIN says otherwise.
PI = os.environ.get("PI_BIN") or shutil.which(
    "pi",
    path=os.pathsep.join(d for d in os.environ.get("PATH", "").split(os.pathsep) if "node_modules" not in Path(d).parts),
)
ONLY = {name.strip() for name in os.environ.get("E2E_SHELLS", "").split(",") if name.strip()}
VERBOSE = bool(os.environ.get("E2E_VERBOSE"))

ANSI = re.compile(r"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[=>()][0-9A-Za-z]?")
WORKDIR = "pi-e2e-work"
# How fish / bash, sh / zsh report a job stopped by SIGTTIN/SIGTTOU/SIGTSTP.
STOP_MESSAGES = ("has stopped", "Stopped", "suspended")
PI_READY = "No models available"  # startup warning; the sandbox has no provider configured


def which(name: str) -> str | None:
    return shutil.which(name)


def needs(*names: str):
    missing = [name for name in names if not which(name)]
    skipped = [name for name in names if ONLY and name not in ONLY]
    if missing:
        return unittest.skip(f"not installed: {', '.join(missing)}")
    if skipped:
        return unittest.skip(f"excluded by E2E_SHELLS: {', '.join(skipped)}")
    return lambda test: test


class Sandbox:
    """Isolated HOME with an existing history file for fish, zsh and bash."""

    def __init__(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="pi-shell-bridge-e2e-"))
        self.work = self.home / WORKDIR
        self.work.mkdir()
        (self.home / ".pi" / "agent").mkdir(parents=True)
        fish_config = self.home / ".config" / "fish"
        fish_config.mkdir(parents=True)
        (fish_config / "config.fish").write_text("set -g fish_greeting ''\nfunction fish_prompt; echo -n '$ '; end\n")
        (self.home / ".zshrc").write_text("HISTFILE=$HOME/.zsh_history\nSAVEHIST=1000\nHISTSIZE=1000\nPROMPT='$ '\n")
        (self.home / ".bashrc").write_text("PS1='$ '\n")
        self.history = {
            "fish": self.home / ".local" / "share" / "fish" / "fish_history",
            "zsh": self.home / ".zsh_history",
            "bash": self.home / ".bash_history",
        }
        for file in self.history.values():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()

    def env(self, shell_path: str, extra: dict[str, str] | None = None) -> dict[str, str]:
        env = {
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TERM": "xterm-256color",
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "USER": os.environ.get("USER", "e2e"),
            "SHELL": shell_path,
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_DATA_HOME": str(self.home / ".local" / "share"),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_STATE_HOME": str(self.home / ".local" / "state"),
            "PI_CODING_AGENT_DIR": str(self.home / ".pi" / "agent"),
            "PI_OFFLINE": "1",
            "PS1": "$ ",
        }
        if extra:
            env.update(extra)
        return env

    def cleanup(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)


class Terminal:
    """An interactive shell in a pseudo terminal, with job control like a real terminal emulator."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: Path) -> None:
        self.output = ""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child: session leader with the pty as controlling terminal
            try:
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            finally:
                os._exit(127)

    def read(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], min(left, 0.1))
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.output += chunk.decode(errors="replace")

    def text(self) -> str:
        return ANSI.sub("", self.output)

    def expect(self, needle: str, timeout: float = 20, fail_on: tuple[str, ...] = ()) -> None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            text = self.text()
            if needle in text:
                return
            for message in fail_on:
                if message in text:
                    raise AssertionError(f"shell reported {message!r} while waiting for {needle!r}:\n{text[-1500:]}")
            self.read(0.2)
        raise AssertionError(f"timed out waiting for {needle!r}; screen tail:\n{self.text()[-1500:]}")

    def send(self, data: str) -> None:
        os.write(self.fd, data.encode())

    def close(self) -> None:
        for pid in [self.pid, *descendants(self.pid)]:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # Close the master before reaping: macOS keeps a dying process around while its pty output is undrained.
        os.close(self.fd)
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try:
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            time.sleep(0.05)
        if VERBOSE:
            sys.stderr.write(f"\n----- screen -----\n{self.text()[-3000:]}\n")


def process_table() -> list[tuple[int, int, str, str]]:
    output = subprocess.run(
        ["ps", "-A", "-o", "pid=,ppid=,stat=,args="], check=True, text=True, capture_output=True, timeout=10
    ).stdout
    rows = []
    for line in output.splitlines():
        parts = line.split(None, 3)
        if len(parts) >= 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2], parts[3] if len(parts) > 3 else ""))
    return rows


def descendants(root: int) -> list[int]:
    rows = process_table()
    found, frontier = [], [root]
    while frontier:
        parent = frontier.pop()
        for pid, ppid, _, _ in rows:
            if ppid == parent and pid not in found:
                found.append(pid)
                frontier.append(pid)
    return found


class PiSession:
    def __init__(self, test: unittest.TestCase, sandbox: Sandbox, shell: str, argv: list[str], ready: str,
                 env: dict[str, str] | None = None) -> None:
        self.test = test
        self.sandbox = sandbox
        shell_path = which(shell) or shell
        self.term = Terminal([shell_path, *argv], sandbox.env(shell_path, env), sandbox.work)
        test.addCleanup(self.term.close)
        self.term.expect(ready, timeout=15)
        self.term.read(0.5)
        self.term.send(f"{PI} -ne --no-session -e {EXTENSION}\r")
        self.term.expect(PI_READY, timeout=30, fail_on=STOP_MESSAGES)
        self.term.read(3)  # session_start runs the history probes; a stop would happen here

    def pi_process(self) -> tuple[int, str]:
        rows = {pid: (stat, args) for pid, _, stat, args in process_table()}
        for pid in descendants(self.term.pid):
            stat, args = rows.get(pid, ("", ""))
            # Pi sets process.title, so its args read just "pi".
            if os.path.basename(args.split(" ", 1)[0]) == "pi":
                return pid, stat
        self.test.fail(f"pi process not found; screen tail:\n{self.term.text()[-1500:]}")

    def assert_running_in_foreground(self) -> None:
        stats = {pid: stat for pid, _, stat, _ in process_table()}
        stopped = [pid for pid in descendants(self.term.pid) if "T" in stats.get(pid, "")]
        _, stat = self.pi_process()
        screen = self.term.text()
        for message in STOP_MESSAGES:
            self.test.assertNotIn(message, screen, "the launching shell reported Pi as stopped")
        self.test.assertNotIn("T", stat, f"pi is stopped (ps STAT={stat})")
        self.test.assertIn("+", stat, f"pi is not in the terminal foreground process group (ps STAT={stat})")
        self.test.assertEqual(stopped, [], "stopped processes under the launching shell")

    def run_bang(self, marker: str, complete: bool) -> None:
        if complete:
            self.term.send("!ech")
            self.term.read(0.3)
            self.term.send("\t")
            self.term.expect("echo", timeout=15)
            self.term.read(0.5)
            if "!echo " not in self.term.text():  # several matches (zsh: echo, echotc, echoti): accept the first
                self.term.send("\t")
            self.term.expect("!echo ", timeout=15)
            self.term.send(marker)
        else:
            self.term.send(f"!echo {marker}")
        self.term.read(0.3)
        self.term.send("\r")
        self.term.expect(marker, timeout=15)


def wait_for(predicate, timeout: float = 15) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


SHELL_ARGV = {
    "fish": (["-i"], "$ "),
    "zsh": (["-i"], "$ "),
    "bash": (["--rcfile", "{home}/.bashrc", "-i"], "$ "),
    "sh": (["-i"], "$ "),
    "dash": (["-i"], "$ "),
    "nu": (["--no-config-file"], ">"),
}


@unittest.skipUnless(PI, "pi is not installed (set PI_BIN)")
class ShellBridgeE2E(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = Sandbox()
        self.addCleanup(self.sandbox.cleanup)

    def start(self, shell: str, env: dict[str, str] | None = None) -> PiSession:
        argv, ready = SHELL_ARGV[shell]
        argv = [arg.format(home=self.sandbox.home) for arg in argv]
        return PiSession(self, self.sandbox, shell, argv, ready, env)

    def history_contains(self, shell: str, marker: str) -> bool:
        return marker in self.sandbox.history[shell].read_text(errors="replace")

    def check_supported(self, shell: str) -> None:
        session = self.start(shell)
        session.assert_running_in_foreground()
        marker = f"pi-e2e-{shell}-{uuid.uuid4().hex[:8]}"
        session.run_bang(marker, complete=True)
        self.assertTrue(wait_for(lambda: self.history_contains(shell, marker)), f"{marker} not in {shell} history")
        time.sleep(1)
        for other in self.sandbox.history:
            if other != shell:
                self.assertFalse(self.history_contains(other, marker), f"auto mode also wrote {other} history")
        session.assert_running_in_foreground()

    def check_unsupported(self, shell: str) -> None:
        # $SHELL points at a supported shell, but Pi was launched from `shell`: auto must not write any history.
        session = self.start(shell, {"SHELL": which("fish") or which("zsh") or which("bash") or "/bin/sh"})
        session.assert_running_in_foreground()
        marker = f"pi-e2e-{shell}-{uuid.uuid4().hex[:8]}"
        session.run_bang(marker, complete=False)
        time.sleep(2)
        for name in self.sandbox.history:
            self.assertFalse(self.history_contains(name, marker), f"{shell} launch wrote {name} history")
        session.assert_running_in_foreground()

    @needs("fish")
    def test_fish(self) -> None:
        self.check_supported("fish")

    @needs("zsh")
    def test_zsh(self) -> None:
        self.check_supported("zsh")

    @needs("bash")
    def test_bash(self) -> None:
        self.check_supported("bash")

    @needs("fish", "zsh", "bash")
    def test_fish_with_all_histories(self) -> None:
        """Interactive zsh/bash probes started from Pi under fish used to stop Pi (SIGTTIN/SIGTTOU)."""
        session = self.start("fish", {"PI_SHELL_BRIDGE_HISTORY": "fish,zsh,bash"})
        session.assert_running_in_foreground()
        marker = f"pi-e2e-all-{uuid.uuid4().hex[:8]}"
        session.run_bang(marker, complete=True)
        for name in ("fish", "zsh", "bash"):
            self.assertTrue(wait_for(lambda: self.history_contains(name, marker)), f"{marker} not in {name} history")
        session.assert_running_in_foreground()

    @needs("sh")
    def test_unsupported_sh(self) -> None:
        self.check_unsupported("sh")

    @needs("dash")
    def test_unsupported_dash(self) -> None:
        self.check_unsupported("dash")

    @needs("nu")
    def test_unsupported_nu(self) -> None:
        self.check_unsupported("nu")


if __name__ == "__main__":
    unittest.main(verbosity=2)
