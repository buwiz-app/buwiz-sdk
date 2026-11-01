# Buwiz Mini App Protocol: history

[Protocol 1.0](protocol-1.0.md) is the first public version. Four drafts came before it, all before any public
release. On 2026-11-02 the owner renumbered the last of them, 2.1, as **1.0**. 1.0 is 2.1 under its new number,
with nothing taken out.

| Draft     | Date       | What it was                                                                                                                                                                                                                                                                                             |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rox 1.0   | 2026-10-28 | The first protocol, for the Rox app: signed manifests, plugin and session keys, signed bridge calls, permissions, tickets, routines. Every name was Rox's: reserved tools `rox.*`, resources `rox://manifest` and `rox-app://<app>`, `_meta["rox/…"]`, the `rox` bridge, plugin ids `dev.goldcoders.*`. |
| Rox 1.1   | 2026-10-30 | Additions to 1.0: inline card chrome (`rox.actions`, `rox.onAction`, `rox.meta`, `rox.settle`) and resolve `prompt` answers.                                                                                                                                                                            |
| Buwiz 2.0 | 2026-10-31 | Rox 1.1 with every name changed to Buwiz's (`buwiz.*`, `buwiz://`, `buwiz-app://`, `buwiz/…`, `buwiz-session`, `buwiz-call`, ids `app.buwiz.*`, publisher `app.buwiz`), plus first-party native screens (`apps[].native`). A clean cut: no `rox` name was accepted.                                     |
| Buwiz 2.1 | 2026-11-01 | 2.0 plus packages (`plugin.json` with a signed `buwiz` block, files and binaries per platform, GitHub release installs) and accounts (`buwiz.account.set` and `buwiz.account.clear`, `account_required`).                                                                                               |
| **1.0**   | 2026-11-02 | 2.1, renumbered. The first public version.                                                                                                                                                                                                                                                              |

## What a 1.0 host does with each

There is no grace period. A 1.0 host runs `1.0.x` plugins and nothing else.

| A plugin built for | What a 1.0 host does                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Rox 1.0 or 1.1     | Refuses it. It does not answer `buwiz.provision` or serve `buwiz://manifest`. The host says it was made for Rox and to install its 1.0 version. |
| Buwiz 2.0 or 2.1   | Refuses it with `protocol_unsupported` and says to install its 1.0 version. A 2.0 or 2.1 install already on the computer does not start.        |
| 1.0                | Runs it.                                                                                                                                        |

## Moving a plugin to 1.0

From 2.1, change `"protocol": "2.1.0"` to `"1.0.0"` in the manifest and in the package's `buwiz.protocol`, raise
`version`, sign both again and release. From 2.0, do the same; a 2.0 bare binary may keep its
`buwiz-release.json` index. Nothing else on the wire changes. From Rox 1.x, first move to the Buwiz names.
