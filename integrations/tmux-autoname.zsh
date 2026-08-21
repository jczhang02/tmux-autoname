#!/usr/bin/env zsh

if [[ -z "${TMUX_PANE:-}" ]]; then
  return 0
fi

typeset -g _TMUX_AUTONAME_BIN="${TMUX_AUTONAME_BIN:-tmux-autoname}"
typeset -g _TMUX_AUTONAME_COMMAND=""

_tmux_autoname_send() {
  { command "$_TMUX_AUTONAME_BIN" emit "$@" >/dev/null 2>&1 } &!
}

_tmux_autoname_preexec() {
  local words
  words=( ${(z)1} )
  _TMUX_AUTONAME_COMMAND="${words[1]:t}"
  _tmux_autoname_send \
    --source zsh \
    --kind command_started \
    --pane "$TMUX_PANE" \
    --command-name "$_TMUX_AUTONAME_COMMAND"
}

_tmux_autoname_precmd() {
  local command_status=$?
  if [[ -n "$_TMUX_AUTONAME_COMMAND" ]]; then
    _tmux_autoname_send \
      --source zsh \
      --kind command_finished \
      --pane "$TMUX_PANE" \
      --command-name "$_TMUX_AUTONAME_COMMAND" \
      --exit-code "$command_status"
    _TMUX_AUTONAME_COMMAND=""
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook -d preexec _tmux_autoname_preexec 2>/dev/null
add-zsh-hook -d precmd _tmux_autoname_precmd 2>/dev/null
add-zsh-hook preexec _tmux_autoname_preexec
add-zsh-hook precmd _tmux_autoname_precmd
