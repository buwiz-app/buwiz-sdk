# Testing a plugin: `buwiz-plugin-test`

`packages/conformance/bin/buwiz-plugin-test.mjs` runs the plugin-side checks of the
spec's Appendix C against one plugin and prints a checklist with the ID of
each check. It spawns your plugin the way Buwiz Bot does and starts a host
in its own process to exercise it, on an in-memory database, a file keystore
in a temp directory and a trust file written for the run. It opens no port,
never reads Buwiz Bot's data directory and never touches the login Keychain.

## Set up

The tools live in the SDK's `packages/conformance` and run on Node 22.13 or
newer (the runner uses `node:sqlite`). In a checkout of this repo:

```sh
bun install
```

That installs the two things the runner needs, `esbuild` and the MCP SDK.

Run the commands as scripts of the repo's root (`bun run buwiz-plugin-test --help`,
`bun run buwiz-sign-manifest …`; a script runs in the repo root, so give paths
absolute or relative to it), or call the files with `node`, from any directory:

```sh
node --disable-warning=ExperimentalWarning <sdk>/packages/conformance/bin/buwiz-plugin-test.mjs …
node <sdk>/packages/conformance/src/v1/sign-manifest.mjs …
```

`<sdk>` is the checkout. The rest of this page says `buwiz-plugin-test` and
`buwiz-sign-manifest` for those two.

## Run it

```sh
# once: a local test key (0600 file; never a release key)
buwiz-plugin-test --keygen ~/.config/buwiz/test.key

# sign what the plugin serves with the test key, then test
buwiz-plugin-test --command node --args hello-world/server.mjs \
  --sign-with ~/.config/buwiz/test.key

# or test a manifest you signed yourself (buwiz-sign-manifest --key-file)
buwiz-plugin-test --command node --args hello-world/server.mjs \
  --manifest /tmp/hello.signed.json --key-file ~/.config/buwiz/test.key
```

| Option                   | Meaning                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--command <cmd>`        | The program to spawn (stdio only).                                                                                                                                                           |
| `--args <arg>`           | One argument; repeat for more, or pass a JSON array. Relative paths are from the directory you run in.                                                                                       |
| `--env KEY=VAL`          | An environment variable for the plugin; repeat for more.                                                                                                                                     |
| `--sign-with <key file>` | Read the manifest the plugin serves, fill each app's fingerprint from the source it serves, sign with this key.                                                                              |
| `--key-id <id>`          | With `--sign-with`: the `publisher.key_id` to sign under (default: the manifest's).                                                                                                          |
| `--manifest <file>`      | A manifest you signed. Trusted with `--key-file`, else with the trust file `BUWIZ_TRUST_FILE` names (see [Trust](#trust)); with neither the run stops.                                       |
| `--key-file <key file>`  | With `--manifest`: the key it was signed with.                                                                                                                                               |
| `--manifest-env NAME`    | The variable that tells the plugin where its signed manifest is (default `BUWIZ_PLUGIN_MANIFEST`, which the template reads).                                                                 |
| `--first-party`          | Mark this run's own trusted key first-party, as a first-party publisher's is: what a manifest with native screens (`apps[].native`) needs. Not with `BUWIZ_TRUST_FILE`, whose store says it. |
| `--json`                 | Print `{plugin, trust, rows: [{id, what, status, note}], ok}` instead of the checklist.                                                                                                      |
| `--keygen <file>`        | Write a new test key (0600) and print its public key.                                                                                                                                        |

Exit status: 0 when nothing failed, 1 when a check failed, 2 for a usage error.

## Trust

By default a run makes its own trust store: it trusts your key under the
manifest's `publisher.key_id` and puts your plugin's id on the approved list,
for that run only. That checks the protocol, not whether a given Buwiz Bot would
accept the plugin.

Set `BUWIZ_TRUST_FILE` to a trust store (`{v: 1, publishers: {<key id>: {publisher,
alg, public_key, first_party?}}, approved_plugins: [{id, publisher_key_id}]}`; the SDK
ships none) and the run uses it as it is, the way Buwiz Bot does. The key must be that
store's key under the manifest's key id, and the plugin's id must be on its
`approved_plugins` under that key id. Otherwise MAN-01 fails with the
host's own message (`… is not a trusted publisher key`, `… is not on the
approved list for key …`). Use a test key id of your own (`--key-id`) in a
store of your own; never put a test key under a release key id.

Native screens (`apps[].native`) are built into Buwiz Bot and are for
first-party plugins only. Run such a plugin with `--first-party` to trust
your key as a first-party one for that run. A native screen serves no
source, so its APP rows check it instead: APP-01 that it is native only and
its screen id is 1 to 64 of `a-z 0-9 . _ -`, APP-02 that its `abi` is one
the host runs, APP-03 that the key is first-party; APP-04 is skipped.

The checklist's third line says which it was, for example
`trust: BUWIZ_TRUST_FILE /tmp/trust.json: key example-test-01 trusted,
com.example.notes approved`.

## What it checks

| ID             | Check                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAN-01         | The manifest is signed by the trusted key; the signature verifies over JCS.                                                                                                                                                        |
| MAN-02         | A byte changed in the manifest fails verification.                                                                                                                                                                                 |
| MAN-03         | The manifest is a JSON object (I-JSON).                                                                                                                                                                                            |
| MAN-04         | `protocol` is 1.0.x; `version` is semver.                                                                                                                                                                                          |
| MAN-05         | `needs` absent or `[]`.                                                                                                                                                                                                            |
| MAN-06         | `permissions` hold only known keys.                                                                                                                                                                                                |
| MAN-07, MAN-08 | Every grammar and limit ([manifest.md](manifest.md)).                                                                                                                                                                              |
| MAN-10         | Every tool starts with `<short>_`; every tool the manifest names exists.                                                                                                                                                           |
| MAN-11, MAN-12 | No built-in command name; no unknown routine keys.                                                                                                                                                                                 |
| MAN-15         | A tool that declares `buwiz/press` with `approved: true` can take the AI's press: its name passes the rule of spec 16.6, `effect` is `post` or `close`, and `describe` names a tool.                                               |
| MAN-16         | A tool's `buwiz/audience`, when present, is an array (spec 16.5).                                                                                                                                                                  |
| APP-01         | Each app's source is one `text/x-nsh-tsx` content, at most 512 KiB, whose fingerprint matches; the host's own source check passes too.                                                                                             |
| APP-02         | Each app compiles as TSX and has a default export.                                                                                                                                                                                 |
| APP-03         | Each app imports only `nsh`, `nsh/base`, `buwiz`.                                                                                                                                                                                  |
| APP-04         | Each app uses no `fetch`, `XMLHttpRequest`, `WebSocket` or web storage.                                                                                                                                                            |
| RSV-01         | A tool called before `buwiz.provision` fails; provision answers `{ok, manifest_sha256}` of the served manifest, twice with the same key.                                                                                           |
| RSV-02         | `buwiz.session.open` refuses an unknown app, a wrong `perms_sha256` and `not_after` past 8 h with `invalid_args`.                                                                                                                  |
| RSV-03         | The certificate is exactly the request, signed with the provisioned key over JCS; the seed never appears in stderr.                                                                                                                |
| RSV-04         | `buwiz.ticket.resolve` answers `{valid: false}` for an unknown ticket, and only `{valid, title}` for one the plugin issued.                                                                                                        |
| RSV-05         | `buwiz.session.close` and `buwiz.uninstall` answer `ok: true`; an unknown `buwiz.*` is `-32601`; the host's uninstall runs.                                                                                                        |
| LCY-01         | The host's install gate passes: provision, verify, `tools/list`.                                                                                                                                                                   |
| BRG-03         | A session opens per app with tools and the host verifies its certificate; one signed call per tool in `permissions.tools` reaches the plugin and is answered (an `isError` answer counts: the call went through).                  |
| BRG-04         | The same envelope sent again is `replayed`.                                                                                                                                                                                        |
| BRG-06         | An envelope signed by another key is `bad_signature`.                                                                                                                                                                              |
| BRG-20         | A `buwiz/badge` a tool's result carries is well formed (spec 16.4): an app of the plugin, a known dot, text of at most 8 characters on one line, a ticket of the grammar. The host drops a malformed one, and the runner names it. |
| INV-04         | Each scope's resolve, with `complete` true and false, answers a spec 15.2 shape within its caps (checked on the raw answer, before the host would cap it); an attachable scope resolves a chosen completion to a token.            |
| INV-05         | Each command's resolve, for a bare command and for `sdk-probe`, answers a 15.2 shape; an `open` names one of this plugin's apps with valid props.                                                                                  |
| INV-10         | Each `prompt` a resolve answers: a command's, not a scope's; text not only spaces and line breaks, at most 4000 characters; the host passes it unchanged. Listed only when a resolve answered `prompt`.                            |

The calls send `{}` as arguments, and the values `""` (commands only: a
bare command, where a starter flow answers) and `sdk-probe` to resolve
tools. Keep side effects behind explicit arguments (P5) and these calls are
harmless.

Every call the runner signs is the person's (`actor: "person"`). It does not send the
AI's press (`actor: "agent"`, `press`, `buwiz/press` opt-in, spec 16.6), so it does not
check how your plugin handles a press record or refuses a write that is not the person's.
Nor does it call a tool as a generated widget (`origin: "widget"`, spec 16.5). Test those
with your own calls to the tool, carrying the `_meta["buwiz/caller"]` of spec 16.1.

Not checked here: everything only Buwiz Bot can show (consent, the sandbox, storage,
placement; the host rows of Appendix C.2 to C.8), MAN-09 (it needs other installs),
and the review items of [security.md](security.md).

## Signing a manifest

`buwiz-sign-manifest` fills each named app's fingerprint from its source and
signs the manifest (spec 5.2, 11.2). It reads no trust file.

```sh
buwiz-sign-manifest manifest.json --key-file publisher.key --app hello=hello.tsx --out signed.json
```

`--key-file` takes a 0600 file holding a base64url seed. The seed is never
printed. Without `--out` the signed manifest goes to stdout. For a local test
key use `buwiz-plugin-test --keygen`.

## In the SDK's suites

`packages/conformance/test/` runs the runner on a minimal plugin built with
`@buwiz/sdk/plugin`, which it passes. Two controls pass on purpose, so a
runner that fails everything cannot pass the suite: a plugin that refuses any
protocol but 1.0.0 (the runner provisions with the host's protocol), and a
plugin that offers its attachable scope a ticket (INV-04 resolves it).

It also runs copies of a plugin that each break one rule, and the runner fails
each by check ID and leaves every other row passing:

- a plugin that answers before `buwiz.provision` (RSV-01), signs a session
  certificate with another key (RSV-03, BRG-03) or writes its key to stderr
  (RSV-03, LCY-01);
- an app that calls `fetch` (APP-04) or imports outside `nsh`, `nsh/base`
  and `buwiz` (APP-03);
- a blank prompt, a prompt over 4000 characters and a scope that answers a
  prompt (INV-10), and an attachable scope that offers no ticket (INV-04
  skipped);
- a manifest of another protocol (MAN-04), a native-only plugin without
  `--first-party`, and `--first-party` with `BUWIZ_TRUST_FILE`;
- a trust file that does not approve the plugin.

A native-only plugin under `--first-party` and a trust file that approves the
plugin pass.

It also checks that the limits tables of [manifest.md](manifest.md),
[bridge.md](bridge.md) and section 24 of the specification state the numbers
the runner's host enforces, that the two command-line tools start through a
symlinked folder, that a plugin with more tools than fit in one second is
paced, that the manifest signer's output verifies with the SDK's own code, and
that the runner's canonical JSON and ed25519 code give the SDK's answers on
`vectors/`.

Section numbers such as spec 4.1 refer to the
[mini app protocol 1.0 specification](https://github.com/buwiz-app/buwiz-sdk/blob/main/docs/protocol-1.0.md).
