# Secret loading for tmux-autoname

Research date: 2026-08-21

## Question

How should a TypeScript/Bun tmux daemon load AI provider credentials from
1Password or the operating-system keyring without storing plaintext secrets in
tmux configuration?

## Primary-source findings

### 1Password

- 1Password defines opaque references in the form `op://vault/item/field`.
- `op read` resolves one reference to stdout. `op run` instead injects resolved
  values into a child process environment.
- 1Password recommends least-privilege Service Accounts for automation.
- The official `@1password/sdk` supports desktop authorization and Service
  Accounts, but Bun compatibility is not documented. The Connect SDK requires a
  separately deployed Connect service.

Sources:

- [Load secrets into scripts](https://developer.1password.com/docs/cli/secrets-scripts)
- [Official JavaScript SDK](https://github.com/1Password/onepassword-sdk-js)
- [1Password Connect JavaScript SDK](https://github.com/1Password/connect-sdk-js)

### Linux Secret Service and macOS Keychain

- Secret Service is a user-session D-Bus API. Items are found by non-secret
  attributes; object paths should not be persisted. Locked stores may require a
  prompt or fail when no interactive desktop session is available.
- macOS Keychain exposes structured `SecItem` APIs and may require device unlock
  or user authentication depending on item access controls.
- `secret-tool` and macOS `security` provide practical subprocess access without
  bundling native Node add-ons.
- `keytar` is archived. `@napi-rs/keyring` is maintained, but still requires
  platform-specific native artifacts and Bun compatibility verification.

Sources:

- [Secret Service specification](https://specifications.freedesktop.org/secret-service/latest-single/)
- [libsecret](https://gnome.pages.gitlab.gnome.org/libsecret/)
- [Apple Keychain items](https://developer.apple.com/documentation/security/keychain-items)
- [Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- [Archived keytar repository](https://github.com/atom/node-keytar)
- [keyring-rs](https://github.com/open-source-cooperative/keyring-rs)
- [Bun Node-API compatibility](https://bun.sh/docs/runtime/node-api)

### Mature external-credential protocols

- Git credential helpers receive non-secret context on stdin and return
  credentials on stdout. The protocol includes expiry and erase operations.
- AWS `credential_process` reads structured JSON from stdout and supports an
  optional expiration. AWS warns that arguments may be visible and that stderr
  may be captured in logs.
- Both patterns keep credential acquisition outside the consuming application's
  main configuration and make failure/refresh explicit.

Sources:

- [Git credential helpers](https://git-scm.com/docs/gitcredentials)
- [Git credential protocol](https://git-scm.com/docs/git-credential.html)
- [AWS external process credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sourcing-external.html)

## Recommended v3 design

Configuration stores a tagged reference, never a literal API key:

```json
{
  "apiKey": {
    "source": "onepassword",
    "ref": "op://Private/OpenAI/api-key"
  }
}
```

```json
{
  "apiKey": {
    "source": "keyring",
    "service": "tmux-autoname",
    "account": "openai"
  }
}
```

Implementation adapters:

- 1Password: `op read --no-newline <reference>`.
- Linux: exact-attribute `secret-tool lookup`.
- macOS: exact service/account lookup through `security` initially.
- Explicit environment-variable lookup may be supported for CI and migration.

Use argument arrays rather than a shell. Capture stdout in memory, apply a hard
timeout, and convert errors to safe codes without logging stdout, request
headers, raw provider errors, or secret values. Do not wrap the long-lived
daemon with `op run`; this would keep credentials in its environment.

Do not add a native keyring dependency initially. A generic credential-helper
protocol can follow Git's stdin/stdout design later if users need password
managers beyond the built-in sources.

## Bun-specific requirement

Bun standalone executables can autoload `.env` files. The release build must
disable `.env` and `bunfig.toml` autoloading so changing pane directories cannot
silently import project credentials.

Source: [Bun standalone executables](https://bun.sh/docs/bundler/executables)

