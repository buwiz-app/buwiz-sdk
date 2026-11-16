#!/usr/bin/env bash
# tools/check-all.sh — every gate, both halves: Rust (fmt, clippy, tests)
# and TypeScript (oxlint, oxfmt, tsc, tests). Both halves run vectors/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() { printf '\n== %s\n' "$*"; }

step "placeholder key ids only"
# The guides and examples name the placeholder example-key-01. A key id of the
# gc-YYYY-NN form is a real publisher's and belongs to a Bot's trust list.
if git grep -nE '(^|[^a-z0-9-])gc-[0-9]{4}-[0-9]{2}([^0-9]|$)' -- . ':!tools/check-all.sh'; then
  printf 'a real publisher key id is named above; use example-key-01\n' >&2
  exit 1
fi

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
