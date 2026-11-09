# pi-shell-bridge

A Pi extension that connects Pi's `!` / `!!` commands to your shell:

- **Tab completion** — on a `!cmd` line, `Tab` asks your shell for completions (commands, subcommands, options, paths, git branches, …) with their descriptions.
- **Autosuggestions** — like fish, typing a `!` command shows the newest matching command from your shell history in grey after the cursor; `→` accepts it.
- **Shell history** — every `!` / `!!` command is appended to the fish, zsh and bash history you already keep, so it shows up in `↑`, `Ctrl+R`, atuin imports and so on.

Commands still run through Pi's built-in bash; this extension only adds completion and history.

## Supported shells

| Shell | Completion | History |
|---|---|---|
| fish | `complete -C` (full fish completions and descriptions) | `history append`, honouring `fish_history` |
| zsh | the zsh completion system, captured through `zsh/zpty` with your `.zshrc` loaded | `print -s` + `fc -AI` into your `HISTFILE`, respecting `EXTENDED_HISTORY` |
| bash | `complete -p` specs, loading [bash-completion](https://github.com/scop/bash-completion) when it is installed | `history -s` + `history -a` into your `HISTFILE`, respecting `HISTTIMEFORMAT` |

Each shell writes its own history file, so locking, timestamps, multi-line commands and zsh's metafied encoding are handled by the shell itself. Helper shells never record their own commands in your history.

## Use

- Type `!git chec` and press `Tab`. A single match is inserted directly; several matches open Pi's completion list. Directories and `--option=` values do not get a trailing space, so you can keep completing.
- Type `!pi` and, if you ran `pi update --extensions` before, ` update --extensions` appears dimmed after the cursor, as in fish. It is only a suggestion: `Enter` runs what you typed. `→`, `End`, `Ctrl+F` or `Ctrl+E` accept the whole suggestion; `Alt+→` or `Alt+F` accept one word. Suggestions come from the launching shell's history file and the `!` commands of the current session, newest first; they appear only while the cursor is at the end of a single-line `!` command and no completion list is open. The keys follow Pi's `tui.editor.cursorRight`, `cursorLineEnd` and `cursorWordRight` keybindings.
- Run any `!` or `!!` command. It is added to the history of each configured shell. Open fish shells see it after `history merge` (or in new sessions); zsh with `SHARE_HISTORY` picks it up automatically.

The shell is started only when you press `Tab`, never on every keystroke. Completion takes roughly 0.1–0.3 s for fish and bash and 0.5–1 s for zsh, depending on your startup files.

## Configure

Defaults work without configuration:

- **completion** `auto`: the shell Pi was launched from (its nearest shell ancestor); if that shell is not supported, `$SHELL`, then the first installed of fish, zsh, bash.
- **history** `auto`: only the shell Pi was launched from, and only when its history file already exists. When Pi is started from an unsupported shell (`nu`, `sh`, `dash`, …) nothing is written; when no shell ancestor exists (Pi launched directly by a terminal or IDE), `$SHELL` is used. zsh without a `HISTFILE` is skipped.

Helper shells run in their own session without a controlling terminal, so interactive startup files (`bash -i`, `zsh -i`) can never take over Pi's terminal, whichever shell Pi was started from.

To change them, create `~/.pi/agent/pi-shell-bridge.json`:

```json
{
  "completion": "zsh",
  "history": ["zsh", "fish"],
  "autosuggest": true,
  "loadUserConfig": true,
  "ignore": ["^export .*TOKEN", "password"]
}
```

| Key | Values | Default |
|---|---|---|
| `completion` | `auto`, `fish`, `zsh`, `bash`, `off` | `auto` |
| `history` | `auto` (launching shell), `off`, or a list of `fish` / `zsh` / `bash` | `auto` |
| `autosuggest` | Fish-style inline suggestions on `!` lines (`true` / `false`) | `true` |
| `loadUserConfig` | Load your shell startup files for completion and to discover `HISTFILE` | `true` |
| `ignore` | Regular expressions; matching commands are not written to history | `[]` |

Environment variables override the file for one Pi launch:

```sh
PI_SHELL_BRIDGE_COMPLETION=bash PI_SHELL_BRIDGE_HISTORY=fish,zsh pi
PI_SHELL_BRIDGE_HISTORY=off pi
PI_SHELL_BRIDGE_AUTOSUGGEST=off pi
```

Autosuggestions replace Pi's input editor with a subclass of `CustomEditor`, keeping every Pi keybinding. If another extension has already replaced the editor, pi-shell-bridge leaves it alone and shows no suggestions; set `"autosuggest": false` to never touch the editor.

Pi trims the command after `!`, so the usual "leading space skips history" convention cannot apply; use `ignore` instead.

## Install

Install the v0.1.4 release from npm:

```sh
pi install npm:@light4/pi-shell-bridge@0.1.4
```

Or install the same release from GitHub: `pi install git:github.com/light4/pi-shell-bridge@v0.1.4`.

Restart Pi or run `/reload` afterwards.

## Install for local development

Pi auto-discovers an extension whose directory contains `index.ts`:

```sh
ln -sfn ~/sources/pi-shell-bridge/src ~/.pi/agent/extensions/pi-shell-bridge
```

Or load it for a single run:

```sh
pi -e ~/sources/pi-shell-bridge/src/index.ts
```

Type-check with:

```sh
pnpm install
pnpm run typecheck
```

## End-to-end tests

`e2e/test_e2e.py` (Python standard library only, run through [uv](https://docs.astral.sh/uv/)) starts real interactive fish, zsh, bash, sh, dash and nu shells in a pseudo terminal, launches `pi` with this extension from each, and checks that Pi stays in the terminal foreground (is never stopped by job control), that `Tab` completes `!` lines and that `!` commands reach the expected history files. Every test uses a temporary `HOME` and Pi agent dir, so your own history and settings are untouched; missing shells are skipped.

```sh
pnpm run test:e2e                              # or: uv run e2e/test_e2e.py
E2E_SHELLS=fish,zsh uv run e2e/test_e2e.py     # only these shells
E2E_EXTENSION=/path/to/src/index.ts PI_BIN=/path/to/pi E2E_VERBOSE=1 uv run e2e/test_e2e.py
```

## Acknowledgements

The zsh capture technique follows [Valodim/zsh-capture-completion](https://github.com/Valodim/zsh-capture-completion) (MIT).

## License

MIT
