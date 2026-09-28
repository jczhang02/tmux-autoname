# tmux-autoname zsh integration. Source this from your .zshrc.
#
# tmux has no hook for "the foreground program changed" or "cwd changed",
# so without this file the window name only updates on tmux's own
# window/pane/session events (new window, pane focus change, split,
# session create, client attach). This closes that gap: it re-syncs the
# current pane's window right after a command starts, right before the
# next prompt, and on every `cd`, so the Activity and Area stay accurate
# as you actually work. See docs/adr/0005-restore-deterministic-naming.md.
#
# Every sync below is backgrounded and disowned with zsh's `&!`, so it
# never slows down the prompt and never prints a job-control message.

if [ -n "${TMUX_PANE:-}" ]; then
  _tmux_autoname_bin() {
    if [ -n "${TMUX_AUTONAME_BIN:-}" ]; then
      printf '%s' "$TMUX_AUTONAME_BIN"
    else
      printf 'tmux-autoname'
    fi
  }

  _tmux_autoname_sync_soon() {
    local bin
    bin=$(_tmux_autoname_bin)
    (sleep 0.3; "$bin" sync -t "$TMUX_PANE" >/dev/null 2>&1) &!
  }

  _tmux_autoname_sync_now() {
    local bin
    bin=$(_tmux_autoname_bin)
    ("$bin" sync -t "$TMUX_PANE" >/dev/null 2>&1) &!
  }

  autoload -Uz add-zsh-hook

  _tmux_autoname_preexec() {
    _tmux_autoname_sync_soon
  }

  _tmux_autoname_precmd() {
    _tmux_autoname_sync_now
  }

  _tmux_autoname_chpwd() {
    _tmux_autoname_sync_now
  }

  add-zsh-hook preexec _tmux_autoname_preexec
  add-zsh-hook precmd _tmux_autoname_precmd
  add-zsh-hook chpwd _tmux_autoname_chpwd
fi
