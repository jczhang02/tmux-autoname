# Backlog

Features recorded for later. Not yet designed or scheduled.

## tmux-palette integration

When [tmux-palette](https://github.com/eduwass/tmux-palette) is installed,
expose the tmux-autoname commands in it: set a title, clear the Window,
restore automatic naming, show status, and open the picker.

Facts checked against tmux-palette on 2026-09-27:

- User configuration lives in `~/.config/tmux-palette/`.
- The main palette merges its built-in items with one user file,
  `commands.json` (`src/userConfig.ts`). There is no drop-in directory, so
  adding items to the main palette means editing a file the user owns.
- A custom palette is its own file, `palettes/<name>.json`, which can list
  inline `items` or pull items from the main palette with `from` and
  `fromCategory`. It opens with `bin/tmux-palette.sh <name>` or a key binding.
- Item actions support `tmux`, `shell`, and `popup` commands.

Open questions:

- Detection: check for the TPM plugin directory, a `@palette-key` option, or
  `~/.config/tmux-palette/`?
- Placement: ship a separate `palettes/tmux-autoname.json` that we own, or
  add items to the user's `commands.json`, which is invasive and has to be
  idempotent?
- Timing: write on every plugin load, or only through an explicit
  `tmux-autoname install-palette` command?
- `set` needs text input. Can a palette item open `command-prompt`, or should
  it reuse the existing key binding?
