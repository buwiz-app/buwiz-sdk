#!/usr/bin/env bash
# tools/check-all.sh — every gate, both halves: Rust (fmt, clippy, tests)
# and TypeScript (oxlint, oxfmt, tsc, tests). Both halves run vectors/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n== %s\n' "$*"; }

step "cargo fmt --check"
cargo fmt --all --check
step "cargo clippy"
cargo clippy --all-targets --quiet -- -D warnings
step "cargo test"
cargo test --quiet

step "bun install"
bun install --frozen-lockfile --silent
step "oxlint, oxfmt, tsc"
bun run --silent check
step "bun test"
bun test

printf '\nall gates passed\n'
