# Print zsh completions for a command line without a terminal, one per line ("value<TAB>description").
# Usage: zsh -f zsh-capture.zsh <command-line> [no-rc]
#
# Uses the zpty technique popularised by Valodim/zsh-capture-completion (MIT): an interactive zsh runs
# in a pseudo terminal, `compadd` is wrapped to print every match, and Tab is sent after the command line.
# The interactive zsh loads the user's ~/.zshenv and ~/.zshrc through a temporary ZDOTDIR so that no
# setup command is typed into the line editor, and HISTFILE is unset so nothing reaches the history file.
zmodload zsh/zpty || exit 1

local line_to_complete=$1
local no_rc=$2
local dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-bang-shell.XXXXXX") || exit 1
trap 'rm -rf -- ${(q)dir}; zpty -d pi_bang 2>/dev/null' EXIT

local user_zdotdir=${ZDOTDIR:-$HOME}

if [[ $no_rc != no-rc ]]; then
  cat >| $dir/.zshenv <<ZSHENV
ZDOTDIR=${(q)user_zdotdir}
[[ -r \$ZDOTDIR/.zshenv ]] && source \$ZDOTDIR/.zshenv
__pi_bang_user_zdotdir=\$ZDOTDIR
ZDOTDIR=${(q)dir}
ZSHENV
fi

cat >| $dir/.zshrc <<ZSHRC
unset HISTFILE
if [[ -n \$__pi_bang_user_zdotdir ]]; then
  ZDOTDIR=\$__pi_bang_user_zdotdir
  [[ -r \$ZDOTDIR/.zshrc ]] && source \$ZDOTDIR/.zshrc
fi
source ${(q)dir}/setup.zsh
ZSHRC

cat >| $dir/setup.zsh <<'SETUP'
unset HISTFILE
PROMPT= RPROMPT= PS2=
unsetopt zle_bracketed_paste 2>/dev/null
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -C -d "${TMPDIR:-/tmp}/pi-bang-shell-zcompdump-$UID"; }
bindkey '^M' undefined
bindkey '^J' undefined
bindkey '^I' complete-word
__pi_bang_null() { print -rn -- $'\0\r\n' }
compprefuncs=( __pi_bang_null )
comppostfuncs=( __pi_bang_null exit )
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' list-separator ''
zstyle ':completion:*' menu no
zmodload zsh/zutil
compadd() {
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
    builtin compadd "$@"
    return $?
  fi
  typeset -a __hits __dscr __tmp
  if (( $@[(I)-d] )); then
    __tmp=${@[$[${@[(i)-d]}+1]]}
    if [[ $__tmp == \(* ]]; then eval "__dscr=$__tmp"; else __dscr=( "${(@P)__tmp}" ); fi
  fi
  builtin compadd -A __hits -D __dscr "$@"
  setopt localoptions norcexpandparam extendedglob
  typeset -A apre hpre hsuf asuf
  zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
  integer dirsuf=0
  if [[ -z $hsuf && "${${@//-default-/}% -# *}" == *-[[:alnum:]]#f* ]]; then dirsuf=1; fi
  [[ -n $__hits ]] || return
  local dsuf dscr i __path
  for i in {1..$#__hits}; do
    __path=$hpre$__hits[$i]
    (( dirsuf )) && [[ -d ${~__path} ]] && dsuf=/ || dsuf=
    (( $#__dscr >= $i )) && dscr=$'\t'${${__dscr[$i]}##$__hits[$i] #} || dscr=
    print -r -- "$IPREFIX$apre$hpre$__hits[$i]$dsuf$hsuf$asuf$dscr"
  done
}
print -r -- __PI_BANG_READY__
SETUP

export ZDOTDIR=$dir
zpty pi_bang zsh -i
local line
while zpty -r pi_bang line; do
  [[ $line == __PI_BANG_READY__* ]] && break
done
zpty -w -n pi_bang "$line_to_complete"$'\t'

integer seen=0
while zpty -r pi_bang line; do
  if [[ $line == *$'\0\r'* ]]; then
    (( seen++ )) && exit 0
    continue
  fi
  line=${line//[$'\r\n']/}
  (( seen )) && [[ -n $line ]] && print -r -- "$line"
done
exit 2
