# Buwiz SDK

Build mini apps for the Buwiz Bot. A mini app is a plugin: a stdio MCP server the Bot spawns, with a signed
manifest, tools the model and apps call, and screens the Bot shows full screen or inline in the chat. It speaks
**Mini App Protocol 2.0**, and only 2.0.

This SDK is the part every mini app shares. You write your manifest, your tools and your screens; the SDK does the
protocol: MCP over stdio, the reserved `buwiz.*` tools (provision, session certificates, ticket titles,
uninstall), the caller checks before any tool of yours runs, tickets, canonical JSON and ed25519 signing, the
shared command line, and a test harness.

To start a new mini app, don't start here: use a template, which already depends on this SDK.

- [`buwiz-app/mini-rs`](https://github.com/buwiz-app/mini-rs): a mini app in Rust, with native Rust screens.
- [`buwiz-app/mini-tsx`](https://github.com/buwiz-app/mini-tsx): a mini app in TypeScript, with TSX screens.

## What is here

| Path                 | What                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `crates/plugin/`     | The plugin half in Rust (crate `buwiz-plugin`): `Plugin`, `Server`, `cli::main`, `Tickets`, `manifest`, `testing::Harness` |
| `crates/app/`        | Native screens in Rust (crate `buwiz-app`), first-party only: `ScreenDef`, `Bridge`, `Host`, `root`                        |
| `packages/plugin/`   | The same in TypeScript (`@buwiz/sdk/plugin`): `Plugin`, `Server`, `main`, `Tickets`, `Harness`, the manifest's types       |
| `packages/app/`      | Types for TSX screens (`@buwiz/sdk/app`): the `buwiz` bridge                                                               |
| `vectors/`           | Canonical JSON and signing vectors both halves reproduce byte for byte (`jcs.json` is the Bot's own)                       |
| `tools/check-all.sh` | Every gate, both halves                                                                                                    |

## Native screens

`crates/app` (crate `buwiz-app`) is the native-screen half in Rust: `ScreenDef` and `Bridge` (the `buwiz` global of
`packages/app`), for nsh screens compiled into the Bot in place of TSX (first-party publishers only). A Bot without
the screen a manifest names shows "this screen needs a newer Buwiz Bot" when it opens. Its README says how a
plugin's screens crate uses it.

## Use it

**Rust.** Pin the crate by commit:

```toml
[dependencies]
buwiz-plugin = { git = "https://github.com/buwiz-app/buwiz-sdk", rev = "<commit>" }
```

```rust
use buwiz_plugin::{Args, Caller, Plugin, Tool, ok};

impl Plugin for Notes {
    const ID: &'static str = "app.buwiz.notes";
    const NAME: &'static str = "notes-mini-app";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");
    const RELEASE_KEY_ID: &'static str = "gc-2026-01";

    fn manifest(key_id: &str) -> Value { /* json!({ "protocol": buwiz_plugin::PROTOCOL, … }) */ }
    fn tools(&self) -> Vec<Tool> { /* notes_* */ }
    fn call(&mut self, tool: &str, args: &Args, caller: &Caller) -> Value { /* ok(…) or fail(code, message) */ }
    fn ticket_title(&mut self, ticket: &str) -> Option<String> { /* a title, never the subject */ }
    fn uninstall(&mut self) { /* forget tickets and subjects */ }
}

fn main() -> ExitCode {
    buwiz_plugin::cli::main(|| Ok(Notes::open()?))
}
```

**TypeScript (Bun).** Pin the package by commit:

```json
"dependencies": { "@buwiz/sdk": "github:buwiz-app/buwiz-sdk#<commit>" }
```

```ts
import { type Plugin, main, ok } from "@buwiz/sdk/plugin";

class Notes implements Plugin {
  readonly id = "app.buwiz.notes";
  // name, version, releaseKeyId, manifest(), appSource(), tools(), call(), ticketTitle(), uninstall()
}

process.exit(await main(new Notes()));
```

Both give the same command line:

```
<binary> mcp                       speak MCP on stdio (what the Bot spawns)
<binary> manifest [--key-id <id>]  print the unsigned manifest as JCS text, for signing
<binary> app-source <id>           print a TSX app's source exactly as served
```

A running plugin serves the signed manifest named by `BUWIZ_PLUGIN_MANIFEST`, else `<plugin id>.manifest.json`
next to the executable. Without either it serves the unsigned manifest, and the Bot refuses the plugin.

## What the server checks for you

Before a tool of yours runs:

- nothing but `buwiz.provision` runs until provision succeeds;
- an app's call comes from an open this process certified for that app, and names a tool in that app's
  `permissions.tools`;
- a resolve and a routine's query only read (`read_only` / `readOnly` tools);
- a routine's turn only reads, or calls a write its routine declares in `writes`.

What stays yours: checking every ticket an argument carries against your own subjects (P1), keeping side effects
behind explicit arguments (P5), and user-facing text that carries no subject data (P9).

## The protocol

The rules every field and call follows are the Bot's: the manifest's fields and limits, the bridge, the security
checklist (P1 to P10) and what the conformance runner checks. Read them in
[`buwiz-bot/buwiz-bot` `server/sdk/mini-app/docs/`](https://github.com/buwiz-bot/buwiz-bot/tree/main/server/sdk/mini-app/docs).
Conformance runs the Bot's own `buwiz-plugin-test` against your built plugin; each template's
`tools/bot/conformance.sh` does it.

## Develop

`tools/check-all.sh` runs every gate. The two halves change together: a change to one half's behavior is made in
the other in the same commit, with the shared vectors or tests to prove it.
