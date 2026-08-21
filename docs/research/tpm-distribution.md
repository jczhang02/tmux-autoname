# TPM distribution decision

Date: 2026-08-21

## Official TPM behavior

- TPM executes every executable `*.tmux` file in an installed plugin directory.
  The entry file therefore needs a shebang and executable bit. See the
  [plugin-author guide](https://github.com/tmux-plugins/tpm/blob/master/docs/how_to_create_plugin.md)
  and [loader source](https://github.com/tmux-plugins/tpm/blob/master/scripts/source_plugins.sh).
- Installation clones the declared Git repository; updates run Git pull and
  update submodules. TPM provides no documented build or post-install hook. See
  [install_plugins.sh](https://github.com/tmux-plugins/tpm/blob/master/scripts/install_plugins.sh)
  and [update_plugin.sh](https://github.com/tmux-plugins/tpm/blob/master/scripts/update_plugin.sh).
- TPM documents `owner/repository#branch`, but the default branch gives users
  the simplest install and update path. See the
  [TPM README](https://github.com/tmux-plugins/tpm#installation).

## Decision

Keep Bun as an explicit runtime requirement and commit one Bun-targeted
JavaScript bundle to the default branch.

```sh
bun build src/cli.ts --target=bun --minify --outfile dist/tmux-autoname.js
```

The bundle contains application and npm dependency code, so TPM users do not
run `bun install` or compile anything. The checked-in `bin/tmux-autoname`
launcher executes the bundle with the user's Bun runtime. Local measurement:

| Artifact | Size |
|---|---:|
| Bun JavaScript bundle | 1.66 MB |
| Current Bun standalone executable | 91.8 MB logical / 51 MB disk |

The default TPM flow becomes:

```tmux
set -g @plugin 'jczhang02/tmux-autoname'
run '~/.tmux/plugins/tpm/tpm'
```

After `prefix + I`, the cloned plugin is immediately runnable. `prefix + U`
pulls the matching source, bundle, and launcher together.

## Required implementation

1. Add a deterministic `build:tpm` command and track
   `dist/tmux-autoname.js` in Git.
2. Make `bin/tmux-autoname` prefer that bundle. Retain the TypeScript fallback
   only for a maintainer checkout.
3. Make CI regenerate the bundle and fail when the committed artifact is stale.
4. Add the standard TPM installation snippet to the README; keep manual clone
   as the development installation path.
5. Include a build version in daemon `ping`. When a newly sourced launcher sees
   an older daemon, replace it gracefully so `prefix + U` takes effect without
   restarting the tmux server.
6. Test installation from a clean cloned repository with Bun present and no
   `node_modules` directory.

## Deferred alternative

Bun can produce standalone executables for Linux and macOS on x64 and arm64,
and these need no Bun installation. See the
[official executable and cross-compilation documentation](https://bun.sh/docs/bundler/executables).
Adopt release assets plus fixed-version SHA-256 verification only if removing
the Bun runtime requirement becomes a product goal. Doing that now would add a
platform downloader, cache, locking, checksums, macOS signing, atomic upgrades,
and failure recovery to avoid a dependency that is already explicit.

Do not commit four standalone binaries to the plugin branch: their size makes
every TPM clone and update unnecessarily expensive.
