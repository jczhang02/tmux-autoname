# tmux-autoname zsh integration. Source this from your .zshrc.
#
# tmux has no hook for "the foreground program changed" or "cwd changed".
# This re-syncs the pane's window 0.3 s after a command starts, before each
# prompt, and on every `cd`, so the name and icon follow what you run.
# See docs/adr/0006-rewrite-with-icons.md.
#
# Every sync is backgrounded and disowned with `&!`: it never slows the
# prompt and never prints a job-control message.

if [[ -n ${TMUX_PANE:-} ]]; then
  typeset -g _tmux_autoname_delayed_pid= _tmux_autoname_delayed_at=
  # The bin of this file's own checkout. The loader also exports
  # TMUX_AUTONAME_BIN into tmux's global environment, but the shell of a new
  # server's first pane starts before the loader runs and never gets it.
  typeset -g _tmux_autoname_bin=${TMUX_AUTONAME_BIN:-${${(%):-%x}:A:h:h}/bin/tmux-autoname}
  # A copy of this file outside a checkout uses tmux-autoname on PATH.
  [[ -x $_tmux_autoname_bin ]] || _tmux_autoname_bin=tmux-autoname

  _tmux_autoname_sync() {
    ("$_tmux_autoname_bin" sync -t "$TMUX_PANE" >/dev/null 2>&1) &!
  }

  _tmux_autoname_preexec() {
    (sleep 0.3; exec "$_tmux_autoname_bin" sync -t "$TMUX_PANE" >/dev/null 2>&1) &!
    _tmux_autoname_delayed_pid=$! _tmux_autoname_delayed_at=$SECONDS
  }

  _tmux_autoname_precmd() {
    # A command that ended within the delay must not let its delayed sync
    # land after this one and bring back the finished program's name. Only
    # a recent pid is killed: an old one may belong to another process now.
    if [[ -n $_tmux_autoname_delayed_pid ]] &&
      (( SECONDS - _tmux_autoname_delayed_at < 5 )); then
      kill $_tmux_autoname_delayed_pid 2>/dev/null
    fi
    _tmux_autoname_delayed_pid=
    _tmux_autoname_sync
  }

  _tmux_autoname_chpwd() { _tmux_autoname_sync }

  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _tmux_autoname_preexec
  add-zsh-hook precmd _tmux_autoname_precmd
  add-zsh-hook chpwd _tmux_autoname_chpwd
fi
