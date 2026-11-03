# Print bash completions for the command line in $1, one per line.
# Run as: bash -i bash-complete.bash <command-line> [marker]   (loads ~/.bashrc)
# Everything printed before the marker comes from user startup files and is ignored by the caller.
# `bash -i` records script lines in history; never let them reach the user's history file.
set +o history
unset HISTFILE
__pi_shell_bridge_line=$1
printf '%s\n' "${2:-__PI_SHELL_BRIDGE_READY__}"

__pi_shell_bridge_print() {
	local item
	while IFS= read -r item; do
		[[ -z $item ]] && continue
		if [[ $item != */ && -d ${item/#\~/$HOME} ]]; then item+=/; fi
		printf '%s\n' "$item"
	done
}

# Load bash-completion when the user's startup files did not.
if ! declare -F _comp_load >/dev/null && ! declare -F _completion_loader >/dev/null; then
	for __pi_shell_bridge_bc in \
		"${BASH_COMPLETION_PATH:-}" \
		"$HOME/.nix-profile/share/bash-completion/bash_completion" \
		"/etc/profiles/per-user/$USER/share/bash-completion/bash_completion" \
		/run/current-system/sw/share/bash-completion/bash_completion \
		/opt/homebrew/share/bash-completion/bash_completion \
		/usr/local/share/bash-completion/bash_completion \
		/usr/share/bash-completion/bash_completion \
		/etc/bash_completion; do
		if [[ -n $__pi_shell_bridge_bc && -r $__pi_shell_bridge_bc ]]; then
			# shellcheck disable=SC1090
			source "$__pi_shell_bridge_bc" >/dev/null 2>&1
			break
		fi
	done
fi

COMP_LINE=$__pi_shell_bridge_line
COMP_POINT=${#COMP_LINE}
COMP_TYPE=9
COMP_KEY=9
read -ra COMP_WORDS <<<"$COMP_LINE"
if [[ -z $COMP_LINE || $COMP_LINE =~ [[:space:]]$ ]]; then COMP_WORDS+=(""); fi
COMP_CWORD=$((${#COMP_WORDS[@]} - 1))
__pi_shell_bridge_cur=${COMP_WORDS[COMP_CWORD]}

if ((COMP_CWORD == 0)); then
	compgen -A command -A alias -A function -A builtin -A keyword -- "$__pi_shell_bridge_cur" | sort -u
	exit 0
fi

__pi_shell_bridge_cmd=${COMP_WORDS[0]}
__pi_shell_bridge_spec=$(complete -p -- "$__pi_shell_bridge_cmd" 2>/dev/null)
if [[ -z $__pi_shell_bridge_spec ]]; then
	if declare -F _comp_load >/dev/null; then
		_comp_load -- "$__pi_shell_bridge_cmd" >/dev/null 2>&1
	elif declare -F _completion_loader >/dev/null; then
		_completion_loader "$__pi_shell_bridge_cmd" >/dev/null 2>&1
	fi
	__pi_shell_bridge_spec=$(complete -p -- "$__pi_shell_bridge_cmd" 2>/dev/null)
fi

if [[ $__pi_shell_bridge_spec =~ [[:space:]]-F[[:space:]]+([^[:space:]]+) ]]; then
	COMPREPLY=()
	"${BASH_REMATCH[1]}" "$__pi_shell_bridge_cmd" "$__pi_shell_bridge_cur" "${COMP_WORDS[COMP_CWORD - 1]}" >/dev/null 2>&1
	if ((${#COMPREPLY[@]} > 0)); then
		printf '%s\n' "${COMPREPLY[@]}" | __pi_shell_bridge_print
		exit 0
	fi
elif [[ -n $__pi_shell_bridge_spec ]]; then
	__pi_shell_bridge_opts=${__pi_shell_bridge_spec#complete }
	__pi_shell_bridge_opts=${__pi_shell_bridge_opts% *}
	eval "compgen $__pi_shell_bridge_opts -- \"\$__pi_shell_bridge_cur\"" 2>/dev/null | __pi_shell_bridge_print
	exit 0
fi

compgen -f -- "$__pi_shell_bridge_cur" | __pi_shell_bridge_print
