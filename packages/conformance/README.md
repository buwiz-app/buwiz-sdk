# Buwiz conformance tools and the Node plugin template

This package holds two developer tools, `buwiz-plugin-test` (the conformance
runner) and `buwiz-sign-manifest`, and a plain Node plugin to start from. The
runner starts the host it exercises your plugin with (`src/`); that host is
internal to the runner, not an API. A mini app in Rust or TypeScript starts
from a template (`mini-rs`, `mini-tsx`) instead; this page is for the Node
plugin and for anyone who runs the tools.

The tools need Node 22.13 or newer and the two dependencies of this package:
run `bun install` in the SDK's root once. The commands below are the root's
scripts (`bun run buwiz-plugin-test …`, `bun run buwiz-sign-manifest …`), which
run in the SDK's root; or run the files with `node` from anywhere (see
[testing.md](../../docs/testing.md#set-up)).

Build a plugin for mini app protocol 1.0
([the spec](../../docs/protocol-1.0.md)): an MCP server that
ships apps into Buwiz Bot. Read [the overview](../../docs/overview.md) first
(one page), then follow these ten steps. Paths are from the SDK's root.

1. **Copy the template** next to it, so its one import
   (`../lib/buwiz-plugin.mjs`) still resolves:

   ```sh
   cp -R packages/conformance/template packages/conformance/hello-world
   ```

2. **Rename it.** In `manifest.json` set `id` (reverse DNS, e.g.
   `com.example.notes`), `short` (2 to 16 lowercase letters and digits,
   e.g. `notes`), `title`, `description`, and start `version` at `0.1.0`. Every
   tool name must start with `<short>_` ([docs/manifest.md](../../docs/manifest.md)).

3. **Write your tools** in `server.mjs`: each is
   `{name, description, inputSchema, annotations, _meta?, run(args, caller)}`
   (`_meta` declares a tool's audience and the AI's press: spec 16.5 and 16.6).
   Answer with `ok(data)` or `fail(code, message)`. Mark read-only tools
   `readOnlyHint: true`. Check every ticket argument against your own store
   ([docs/security.md](../../docs/security.md), P1).

4. **Write the resolve tool** for your commands and scopes: it answers
   `choices`, `open`, `token`, `prompt` (a command's starter text for the
   message field) or `error`, with tickets from
   `tickets.issue(subject)` instead of raw identifiers
   ([docs/bridge.md](../../docs/bridge.md#resolve-tools)).

5. **Write the app** (`hello.tsx` → `<id>.tsx`): a default-exported
   component that imports only `nsh`, `nsh/base` and `buwiz`, reads
   `buwiz.props`, calls your tools with `buwiz.call`, and sizes itself from
   `buwiz.viewport`. List it in `startPlugin({apps})` and in the manifest's
   `apps[]`, and grant it exactly the tools it calls in `permissions.tools`.

6. **Make a local test key** (once; it is not a release key):

   ```sh
   bun run buwiz-plugin-test --keygen ~/.config/buwiz/test.key
   ```

7. **Compute fingerprints and sign** for local tests. `sign-manifest.mjs`
   fills each app's `fingerprint` from its source and signs the result:

   ```sh
   bun run buwiz-sign-manifest packages/conformance/hello-world/manifest.json \
     --key-file ~/.config/buwiz/test.key \
     --app hello=packages/conformance/hello-world/hello.tsx --out /tmp/hello.signed.json
   ```

8. **Run the test runner** until every line passes
   ([docs/testing.md](../../docs/testing.md)):

   ```sh
   bun run buwiz-plugin-test --command node --args packages/conformance/hello-world/server.mjs \
     --manifest /tmp/hello.signed.json --key-file ~/.config/buwiz/test.key
   ```

   (`--sign-with ~/.config/buwiz/test.key` instead of `--manifest … --key-file …`
   does step 7 for you on every run. To check your plugin against a real
   trust store, its key id and approved list included, set `BUWIZ_TRUST_FILE`:
   see [testing.md](../../docs/testing.md#trust).)

9. **Go through the security checklist** ([docs/security.md](../../docs/security.md)):
   the runner checks provisioning, certificates, key hygiene and ticket titles;
   authorization (P1), side effects (P5, P6) and text (P9) are yours to review.

10. **Release.** Sign the manifest with your publisher key (a 0600 key file,
    the key id in the manifest's `publisher.key_id`), and have the host's
    trust store list that key and your plugin id:

    ```sh
    bun run buwiz-sign-manifest packages/conformance/hello-world/manifest.json \
      --key-file publisher.key --app hello=packages/conformance/hello-world/hello.tsx \
      --out packages/conformance/hello-world/manifest.json
    ```

    The signed `manifest.json` ships beside `server.mjs`, which serves it when
    `BUWIZ_PLUGIN_MANIFEST` is unset. Any change to an app's source or to the
    manifest needs a new `version` and a new signature.

## What is where

| Path                        | What                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template/server.mjs`       | The plugin: one tool (`hello_greet`), one resolve tool (`hello_resolve`) for the `/hello` command and the attachable `@hello:friend` scope, tickets                          |
| `template/hello.tsx`        | The app: full screen and inline 360×160                                                                                                                                      |
| `template/manifest.json`    | The unsigned manifest (an example publisher and key id: use your own); fingerprints are placeholders until step 7                                                            |
| `lib/buwiz-plugin.mjs`      | `startPlugin`, `ticketStore`, `ok`, `fail`: the reserved tools of spec 10, done once                                                                                         |
| `bin/buwiz-plugin-test.mjs` | The test runner                                                                                                                                                              |
| `src/v1/sign-manifest.mjs`  | The manifest signer; `src/` also holds the host the runner starts to exercise your plugin                                                                                    |
| `test/`                     | The package's tests (the SDK's own gates run them)                                                                                                                           |
| `../../docs/`               | [overview](../../docs/overview.md), [manifest](../../docs/manifest.md), [bridge](../../docs/bridge.md), [security](../../docs/security.md), [testing](../../docs/testing.md) |

11. **Make cards fast** ([docs/performance.md](../../docs/performance.md)): render
    answer cards from their snapshot props, keep module top levels empty and
    sources small, declare the inline size, and read Buwiz Bot's `mini v1 timing:`
    log to see where an open's time goes.
