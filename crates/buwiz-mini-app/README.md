# buwiz-mini-app (coming)

The native-screen half of the SDK: Rust screens built into the Buwiz Bot (first-party publishers only), in place of
TSX. The Bot's team owns it. It is being written in `buwiz-bot/buwiz-bot` as `crates/buwiz-mini-app` (branch
`mini/native-screens`) and moves here, with its history, once its API settles. Until then this folder holds no code.

The shape, as sketched (the final names land with the crate):

- a plugin's screens crate exports `pub fn screens() -> &'static [ScreenDef]`;
- `ScreenDef { id, abi, build: fn(Bridge) -> Root }`, where `id` is the manifest's `apps[].native.screen` (e.g.
  `hello.home`) and `abi` is `1`, matching `apps[].native.abi`;
- `Bridge` is one cheap clone per open and mirrors the TSX `buwiz` global: `props`, `viewport`, `fit`, `actions` and
  `on_action`, `meta`, `settle`, `call(tool, args)`, `open`, `ticket_title`, with the permission-gated ones
  (`storage`, `attach`, `pick_file`, `copy`, `preview`) as `Option`s;
- failures are `BuwizError`.

The Bot compiles each first-party screens crate in, pinned by git rev, and keys its registry by plugin id, screen
id and abi.
