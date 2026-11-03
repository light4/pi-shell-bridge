# pi-shell-bridge

A Pi extension that connects Pi's `!` / `!!` commands to your shell:

- **Tab completion** — on a `!cmd` line, `Tab` asks your shell for completions (commands, subcommands, options, paths, git branches, …) with their descriptions.
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
- Run any `!` or `!!` command. It is added to the history of each configured shell. Open fish shells see it after `history merge` (or in new sessions); zsh with `SHARE_HISTORY` picks it up automatically.

The shell is started only when you press `Tab`, never on every keystroke. Completion takes roughly 0.1–0.3 s for fish and bash and 0.5–1 s for zsh, depending on your startup files.

## Configure

Defaults work without configuration:

- **completion** `auto`: the shell named by `$SHELL` when supported, otherwise the first installed of fish, zsh, bash.
- **history** `auto`: every installed shell whose history file already exists. zsh without a `HISTFILE` is skipped.

To change them, create `~/.pi/agent/pi-shell-bridge.json`:

```json
{
  "completion": "zsh",
  "history": ["zsh", "fish"],
  "loadUserConfig": true,
  "ignore": ["^export .*TOKEN", "password"]
}
```

| Key | Values | Default |
|---|---|---|
| `completion` | `auto`, `fish`, `zsh`, `bash`, `off` | `auto` |
| `history` | `auto`, `off`, or a list of `fish` / `zsh` / `bash` | `auto` |
| `loadUserConfig` | Load your shell startup files for completion and to discover `HISTFILE` | `true` |
| `ignore` | Regular expressions; matching commands are not written to history | `[]` |

Environment variables override the file for one Pi launch:

```sh
PI_SHELL_BRIDGE_COMPLETION=bash PI_SHELL_BRIDGE_HISTORY=fish,zsh pi
PI_SHELL_BRIDGE_HISTORY=off pi
```

Pi trims the command after `!`, so the usual "leading space skips history" convention cannot apply; use `ignore` instead.

## Install

```sh
pi install git:github.com/light4/pi-shell-bridge@v0.1.0
```

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

## Acknowledgements

The zsh capture technique follows [Valodim/zsh-capture-completion](https://github.com/Valodim/zsh-capture-completion) (MIT).

## License

MIT
