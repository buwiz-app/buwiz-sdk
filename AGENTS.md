# AGENTS.md

The Buwiz SDK: the shared half of every Buwiz Bot mini app, in Rust (`crates/plugin`, the crate `buwiz-plugin`) and TypeScript
(`packages/plugin`, `packages/app`). The README says what each part is and how a mini app uses it.

## Invariants

1. **Two halves, one behavior.** The Rust crate and the TypeScript package expose the same API under each
   language's names and answer every request identically. A change to one half is made to the other in the same
   commit, with a test in each (`crates/plugin/tests/server.rs` and `packages/plugin/test/server.test.ts`
   run the same cases).
2. **The bytes are the Bot's.** Canonical JSON, signatures, fingerprints and digests must equal the broker's.
   `vectors/` is the proof: `jcs.json` is copied unchanged from the Bot (`server/test/fixtures/jcs-vectors.json`),
   and `signing.json` holds outputs both halves reproduce. Change a vector only when the Bot's changes.
3. **One protocol version.** The SDK implements 2.0 and refuses everything else. When the protocol moves, the SDK
   moves; it carries no shims for older names or versions.
4. **Standalone.** Nothing imports from the Bot's repo. The Bot's docs are linked, not copied.
5. **Secrets stay put.** A provisioned seed is never logged, printed, serialized or put in an error, and nothing
   logs tool arguments or subjects (P4). The TypeScript server writes a tool's thrown error to stderr only under
   `BUWIZ_PLUGIN_DEBUG=1`.
6. **Rust and TypeScript folders match.** `crates/<part>` beside `packages/<part>` (`plugin`, and `app` when the
   native-screen crate arrives); the published Rust names carry the `buwiz-` prefix that `@buwiz/sdk` gives the
   TypeScript ones. `crates/app` is the Bot team's to write.

## Gates

`tools/check-all.sh` passes before every commit: `cargo fmt --check`, `cargo clippy --all-targets -D warnings`,
`cargo test`, then `bun run check` (oxlint, oxfmt, tsc) and `bun test`.

A change that ships goes to the templates too: bump the SDK rev in `buwiz-app/mini-rs` and `buwiz-app/mini-tsx`
and run their gates, conformance included.
