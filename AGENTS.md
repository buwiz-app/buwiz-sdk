# AGENTS.md

The Buwiz SDK: the shared half of every Buwiz Bot mini app, in Rust (`crates/plugin`, the crate `buwiz-plugin`; `crates/app`,
the crate `buwiz-app`) and TypeScript (`packages/plugin`, `packages/app`). The README says what each part is and how a
mini app uses it.

## Invariants

1. **Two halves, one behavior.** The Rust crate and the TypeScript package expose the same API under each
   language's names and answer every request identically. A change to one half is made to the other in the same
   commit, with a test in each (`crates/plugin/tests/server.rs` and `packages/plugin/test/server.test.ts`
   run the same cases).
2. **The bytes are the Bot's.** Canonical JSON, signatures, fingerprints and digests must equal the broker's.
   `vectors/` is the proof: `jcs.json` is copied unchanged from the Bot (`server/test/fixtures/jcs-vectors.json`),
   and `signing.json` holds outputs both halves reproduce. Change a vector only when the Bot's changes.
3. **One protocol version.** The SDK implements 1.0 (`docs/protocol-1.0.md`) and refuses everything else. When the
   protocol moves, the SDK moves; it carries no shims for older names or versions (2.0 and 2.1 were the
   pre-release numbering of 1.0).
4. **Tokens stay in memory.** An account token the host pushes (`buwiz.account.set`) lives in memory only: never
   logged, written, put in an answer or shown by `Debug`, `JSON.stringify` or `console.log`.
5. **Standalone.** Nothing imports from the Bot's repo. The Bot's docs are linked, not copied.
6. **Secrets stay put.** A provisioned seed is never logged, printed, serialized or put in an error, and nothing
   logs tool arguments or subjects (P4). The TypeScript server writes a tool's thrown error to stderr only under
   `BUWIZ_PLUGIN_DEBUG=1`.
7. **Rust and TypeScript folders match.** `crates/<part>` beside `packages/<part>` (`plugin`, `app`); the published
   Rust names carry the `buwiz-` prefix that `@buwiz/sdk` gives the TypeScript ones. `crates/app` is the `buwiz`
   bridge of `packages/app` in Rust, for native screens; it depends on nsh (pinned by rev, to the commit the Bot's
   submodule is on) and on nothing of the Bot's, and the Bot team owns its API.

## Gates

`tools/check-all.sh` passes before every commit: `cargo fmt --check`, `cargo clippy --all-targets -D warnings`,
`cargo test`, then `bun run check` (oxlint, oxfmt, tsc) and `bun test`.

A change that ships goes to the templates too: bump the SDK rev in `buwiz-app/mini-rs` and `buwiz-app/mini-tsx`
and run their gates, conformance included.
