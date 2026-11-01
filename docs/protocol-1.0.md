# Buwiz Mini App Protocol 1.0

Version `1.0.0`. Status: final. Date: 2026-11-02.

This is the complete specification of the protocol between Buwiz Bot (the host) and a mini app (a plugin).
It is written for plugin authors and for host implementers. It consolidates the earlier drafts and
renumbers them; [protocol-history.md](protocol-history.md) says what came before and what a 1.0 host does
with it.

## Contents

1. [Scope](#1-scope)
2. [Terms](#2-terms)
3. [Conformance and versioning](#3-conformance-and-versioning)
4. [Names and grammars](#4-names-and-grammars)
5. [Identity, keys and trust](#5-identity-keys-and-trust)
6. [The manifest](#6-the-manifest)
7. [The package](#7-the-package)
8. [Distribution](#8-distribution)
9. [Lifecycle](#9-lifecycle)
10. [Reserved tools](#10-reserved-tools)
11. [Apps](#11-apps)
12. [Permissions](#12-permissions)
13. [The bridge](#13-the-bridge)
14. [Calls: envelope, checks, replay](#14-calls-envelope-checks-replay)
15. [Commands, scopes, tokens, tickets and links](#15-commands-scopes-tokens-tickets-and-links)
16. [Tool results: `_meta`](#16-tool-results-_meta)
17. [Consent](#17-consent)
18. [Agent integration](#18-agent-integration)
19. [Routines](#19-routines)
20. [Accounts](#20-accounts)
21. [Storage](#21-storage)
22. [Errors, timeouts and restarts](#22-errors-timeouts-and-restarts)
23. [Security requirements](#23-security-requirements)
24. [Limits](#24-limits)

- [Appendix A. Example manifest](#appendix-a-example-manifest)
- [Appendix B. Example plugin.json](#appendix-b-example-pluginjson)

---

## 1. Scope

This protocol defines:

- how a **plugin**, a stdio MCP server, describes itself in a signed **manifest** and, when it ships as a
  folder, in a signed **package** (`plugin.json`);
- how a host finds, verifies, installs, updates and removes a plugin;
- how the host gives the plugin its key and how the plugin certifies each app open;
- how the plugin's **apps** (TSX modules or first-party native screens) are delivered, placed and sandboxed,
  and how they call the plugin through the host **bridge**;
- how every app call is signed and checked before the plugin sees it;
- how slash commands, `@` tokens, links, tool results, the agent, routines and accounts reach the plugin.

Out of scope: the host's internal API between its UI and its broker (described here only by the outcomes it
must produce), the host's storage layout, and shared services between plugins (`needs`, reserved).

The transport is MCP over stdio. A host spawns the plugin process and speaks MCP on its stdin and stdout.
Streamable HTTP and SSE plugins are not part of 1.0.

## 2. Terms

| Term                    | Meaning                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**                | Buwiz Bot: its UI, the app sandbox, the bridge, consent prompts, the chat, and its **broker**, the process that owns plugin processes, install records and plugin keys and checks every call. Where this spec says "the host", either part may do the work unless it names one. |
| **Plugin**              | A stdio MCP server that serves tools, the `buwiz://manifest` resource and its apps' sources. Identified by a plugin id.                                                                                                                                                         |
| **Package**             | A plugin shipped as a folder: `plugin.json` with a signed `buwiz` block, the plugin's binary and its other files (section 7).                                                                                                                                                   |
| **Plugin id**           | A reverse-DNS identifier such as `app.buwiz.notes` (section 4).                                                                                                                                                                                                                 |
| **Short**               | A short alias, unique among enabled plugins, used in `@` tokens, slash qualifiers and as every tool name's prefix, such as `notes`.                                                                                                                                             |
| **App**                 | One screen of a plugin, listed in the manifest: a TSX module served as an MCP resource, or a native screen compiled into the host (first-party only).                                                                                                                           |
| **Open**                | One instance of an app, full screen or inline. Each has an `open_id`: 128 random bits, base64url.                                                                                                                                                                               |
| **Bridge**              | The `buwiz` object the host gives every app. An app reaches nothing else.                                                                                                                                                                                                       |
| **Manifest**            | The JSON document the plugin serves at `buwiz://manifest`, signed by its publisher.                                                                                                                                                                                             |
| **Publisher key**       | An offline ed25519 key that signs manifests, packages and release indexes. The host's trust store lists it.                                                                                                                                                                     |
| **Plugin key**          | An ed25519 key per installed plugin, generated by the host at install. The plugin holds the private half in memory only and uses it to sign session certificates.                                                                                                               |
| **Session key**         | An ed25519 key per open. Its private half never leaves the host's native bridge code. It signs every bridge call.                                                                                                                                                               |
| **Session certificate** | The plugin key's signature over an open's session public key, app and permissions digest.                                                                                                                                                                                       |
| **Fingerprint**         | `sha256:` and the lowercase hex SHA-256 of a TSX app's source bytes as served.                                                                                                                                                                                                  |
| **Ticket**              | An opaque random reference to a **subject** (a customer, a document) that only the plugin can resolve. Used in place of raw identifiers in links, props, tokens and attachments.                                                                                                |
| **Token**               | A reference in chat text: `@short:scope:value`. Its canonical form carries a ticket. Not a credential.                                                                                                                                                                          |
| **JCS**                 | The JSON Canonicalization Scheme, RFC 8785. Every signature in this protocol is over JCS bytes.                                                                                                                                                                                 |
| **First party**         | A publisher key the trust store marks `"first_party": true` (Buwiz's own, publisher `app.buwiz`).                                                                                                                                                                               |

## 3. Conformance and versioning

### 3.1 Language

MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT and MAY are used as described in RFC 2119.

A **plugin conforms** when it meets every MUST for the features it uses. A **host conforms** when it meets every
MUST of this document for every feature it implements, and every MUST of sections 5, 6, 9, 10, 14, 17 and 23
whatever it implements. Text marked _host behaviour_ describes what a host does that a plugin cannot observe
or depend on.

### 3.2 Versions

The protocol is versioned as semver. This document is `1.0.0`.

- A **patch** (`1.0.1`) clarifies; no wire or behaviour rule changes.
- A **minor** (`1.1.0`) adds optional fields, members or values. A host of a newer minor accepts plugins of
  every older minor of the same major.
- A **major** (`2.0.0`) is any breaking change.

A plugin declares the protocol it implements in the manifest's `protocol` and, in a package, in
`buwiz.protocol`: `"1.0.0"`. Both are semver strings.

### 3.3 How a host compares

A host compares the declared `protocol`'s major and minor numbers with its own; the patch and any
prerelease or build part are not compared. A host that implements `1.M` accepts a declared `1.m.p` when
`m <= M`.

A 1.0 host therefore accepts `1.0.x` and nothing else. It MUST refuse, with `protocol_unsupported`:

| Declared                                                                     | Refusal                | What the host says                                                              |
| ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `1.1.0` or a later `1.x`                                                     | `protocol_unsupported` | The plugin needs a Buwiz Bot that supports 1.x.                                 |
| `2.0.x`, `2.1.x` (pre-release numbering, see [history](protocol-history.md)) | `protocol_unsupported` | The plugin was built for a pre-release protocol: install its 1.0 version.       |
| any other major                                                              | `protocol_unsupported` | The plugin needs another Buwiz Bot (older majors: install its current version). |
| not semver                                                                   | `manifest_invalid`     | `protocol: must be a semver string`                                             |

There is no grace period: a 1.0 host runs no 2.0 or 2.1 plugin, even one installed earlier. An install
record whose protocol is not `1.0.x` MUST NOT start; its state is `failed` with `protocol_unsupported` and a
message naming the plugin, its version and protocol, and saying to install its 1.0 version or uninstall it.

A **Rox-era plugin** (the drafts' reserved tools `rox.*`, the resource `rox://manifest`, app entries
`rox-app://…`) MUST be refused even though it may declare `1.0.0` or `1.1.0`. It does not answer
`buwiz.provision` (section 10.2), so the host's gate refuses it. A host SHOULD recognise one (it lists a
`rox.*` tool or `rox://manifest`) and report `protocol_unsupported` with "install its 1.0 version" rather
than a bare `plugin_invalid`.

### 3.4 Unknown fields

- Unknown top-level manifest fields are ignored.
- Unknown keys inside any object that carries an access grant are a refusal (fail closed): `permissions` and
  each object inside it (`open`, `pick_file`, `storage`, `preview`), each `routines[]` entry, its `query` and
  each `reads[]` entry, and `apps[].native`.
- Unknown `plugin.json` fields outside the `buwiz` block are ignored by this protocol (other plugin formats
  use them). Every field of the `buwiz` block is covered by its signature.

## 4. Names and grammars

All expressions are ECMAScript regular expressions over the whole string. Hosts and plugins use the same
ones.

| Name            | Grammar                                                                                    | Other rules                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin id       | `^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62}){2,7}$`                                      | At most 255 characters (3 to 8 labels). Not `buwiz.…`, `com.buwiz.bot` or `com.buwiz.bot.…` (the host's own). Buwiz plugins are `app.buwiz.<name>`. |
| Short           | `^[a-z][a-z0-9]{1,15}$`                                                                    | Unique among enabled plugins. Reserved: `buwiz`, `app`, `chat`, `mcp`, `nsh`, `all`.                                                                |
| Publisher id    | `^[a-z][a-z0-9-]{1,62}(\.[a-z0-9-]{1,62})*$`                                               | Buwiz's own is `app.buwiz`.                                                                                                                         |
| Key id          | `^[a-z0-9][a-z0-9-]{0,63}$`                                                                | Selects a trust-store key, for example `gc-2026-01`.                                                                                                |
| App id          | `^[a-z][a-z0-9-]{0,47}$`                                                                   | Unique within the plugin.                                                                                                                           |
| Command name    | `^[a-z][a-z0-9-]{0,31}$`                                                                   | Unique within the plugin. Not a built-in command (`status`).                                                                                        |
| Scope name      | `^[a-z][a-z0-9-]{0,31}$`                                                                   | Unique within the plugin.                                                                                                                           |
| Routine id      | `^[a-z][a-z0-9-]{0,47}$`                                                                   | Unique within the plugin.                                                                                                                           |
| Tool name       | `^[a-z][a-z0-9_]{0,62}$`                                                                   | Starts with `<short>_`, for example `notes_list`.                                                                                                   |
| Reserved tool   | `^buwiz\.[a-z.]+$`                                                                         | Host-to-plugin tools (section 10). Never shown to the model or callable by apps.                                                                    |
| Prop key        | `^[a-zA-Z][a-zA-Z0-9_]{0,31}$`                                                             | Every key at every depth of props.                                                                                                                  |
| Ticket          | `^tkt_[0-9A-HJKMNP-TV-Z]{26}$`                                                             | Crockford base32, 130 random bits. Opaque.                                                                                                          |
| Native screen   | `^[a-z0-9._-]{1,64}$`                                                                      | For example `books.ledger`.                                                                                                                         |
| Account id      | `^[a-z][a-z0-9-]{0,31}$`                                                                   | Unique within the package.                                                                                                                          |
| Account label   | 1 to 60 of `A-Z a-z 0-9 . _ @ + -`, a letter or digit first                                | Default `default`.                                                                                                                                  |
| Canonical token | `^@([a-z][a-z0-9]{1,15}):([a-z][a-z0-9-]{0,31}):(tkt_[0-9A-HJKMNP-TV-Z]{26})$`             | What the host stores and sends to the model.                                                                                                        |
| Typed token     | `(?<![\w@.])@([a-z][a-z0-9]{1,15}):([a-z][a-z0-9-]{0,31}):(\S*)`                           | What the composer parses. The value may be empty or any run of non-space characters.                                                                |
| Slash command   | `^/(?:([a-z][a-z0-9]{1,15}):)?([a-z][a-z0-9-]{0,31})(?:\s+(.*))?$`                         | Group 1 the short qualifier, 2 the command, 3 the argument text.                                                                                    |
| App link        | `buwiz://app/<plugin id>/<app id>[?ticket=<ticket>][&props=<percent-encoded JSON object>]` | Section 15.6.                                                                                                                                       |
| Install path    | Segments of `[A-Za-z0-9._-]{1,100}` joined by `/`                                          | At most 256 characters; no `.` or `..` segment, no leading `/`.                                                                                     |
| Release asset   | `[A-Za-z0-9._-]{1,100}`                                                                    | Not `.` or `..`.                                                                                                                                    |
| Platform        | `<os>-<arch>`, Rust's `std::env::consts` names                                             | For example `macos-aarch64`, `linux-x86_64`.                                                                                                        |

Resource URIs: the manifest is `buwiz://manifest`; a TSX app's source is `buwiz-app://<app id>`.

### 4.1 Slash namespacing

1. Built-in commands (`/status`) always win for the unqualified name.
2. A plugin command `/name` is reachable unqualified when exactly one enabled plugin declares `name` and no
   built-in has it.
3. Otherwise it is reachable only as `/<short>:name`. The composer lists every candidate.
4. `/<short>:name` always works for an enabled plugin.
5. Install shows a warning when the new plugin would make an unqualified command ambiguous ("/name is also a
   command of <id>; it will need /<short>:name").

## 5. Identity, keys and trust

### 5.1 The trust store

The host ships a trust store:

```json
{
  "publishers": {
    "gc-2026-01": { "alg": "ed25519", "publisher": "app.buwiz", "public_key": "<b64url, 32 bytes>", "first_party": true }
  },
  "approved_plugins": [{ "id": "app.buwiz.notes", "publisher_key_id": "gc-2026-01" }]
}
```

- `publishers` maps a key id to an ed25519 public key (base64url without padding, 32 bytes), the publisher id
  it belongs to, and whether it is first party. An entry that is not `alg: "ed25519"` with a well-formed key
  is ignored.
- `approved_plugins` lists the `(plugin id, publisher key id)` pairs the host installs. A plugin not on the
  list for the key that signed it cannot be installed, and no text of it reaches the model (section 18.3).
- A missing or unreadable store trusts nothing. The host reads it at every verification, so a changed store
  counts at the next spawn.

### 5.2 Publisher signatures

Three documents are signed by a publisher key: the manifest (section 6), the package's `plugin.json`
(section 7) and the release index `buwiz-release.json` (section 8.3). The rule is the same for each:

- `signature` is `{"alg": "ed25519", "key_id": "<key id>", "value": "<b64url, 64 bytes>"}`.
- `key_id` equals the document's `publisher.key_id`, which names a trust-store key.
- When the trust-store key names a publisher, the document's `publisher.id` MUST equal it.
- The signature is ed25519 over the JCS bytes of the document with its `signature` member removed (for a
  package: `buwiz.signature` removed, the rest of `plugin.json` kept).
- A signed object carries numbers only as safe integers (`|n| <= 2^53 - 1`, no fraction or exponent form);
  a signer refuses any other number.
- `value` is base64url without padding (86 characters).

Because each TSX app's fingerprint is inside the manifest, the manifest's signature covers app source too.
Because every file's SHA-256 is inside the package block, the package signature covers every file of the
folder, binaries included.

### 5.3 First party

A first-party publisher key may ship **native screens** (section 11.3). Its inline answer cards mount without a
click (section 16.2). Nothing else differs.

### 5.4 The plugin key

| Step      | Who                            | Rule                                                                                                                         |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Generate  | Host, at install               | A fresh ed25519 key per plugin id per install, from the OS CSPRNG. An update keeps the installed key.                        |
| Store     | Host                           | The private seed in the OS's secure store (the macOS Keychain), keyed by plugin id; the public key in the install record.    |
| Provision | Host to plugin, on every spawn | The first tool call on the plugin's stdin: `buwiz.provision` (section 10.2). Never argv, environment, files or app messages. |
| Hold      | Plugin                         | In memory only. It MUST NOT log, persist or echo the seed.                                                                   |
| Use       | Plugin                         | To sign session certificates only.                                                                                           |
| Verify    | Host                           | Certificates verify with the public key in the install record.                                                               |

The host scans the plugin's stderr for the seed, in base64url and in standard base64. A plugin that writes it
is stopped and marked `failed` with `plugin_invalid` ("the plugin wrote its key to stderr"); the line is
redacted in the plugin's log. A missing key at spawn is `plugin_invalid` ("the plugin key is missing; reinstall").

### 5.5 Sessions

Every open gets a session:

1. The host makes a session key pair and an `open_id`, and computes the app's permissions digest:
   `sha256(JCS(permissions))` as lowercase hex, `{}` when the app has none.
2. The host checks the open request: plugin and app ids by grammar, `open_id` 16 bytes of base64url, `ks_pub`
   32 bytes, `perms_sha256` 64 lowercase hex, `not_after` a safe integer in the next 8 hours (unix ms), and an
   `open_id` not already open. The plugin must be installed, enabled and running (else `plugin_unavailable`)
   and have the app (else `not_found`), and the digest MUST be the installed app's (else `invalid_args`).
3. The host calls `buwiz.session.open` (section 10.3). The plugin answers a certificate:

   ```
   cert = { "v": 1, "typ": "buwiz-session", "plugin": "<plugin id>", "app": "<app id>",
            "open_id": "<open_id>", "ks_pub": "<b64url>", "perms_sha256": "<hex>", "not_after": <unix ms> }
   cert_sig = Ed25519Sign(plugin key, JCS(cert))
   ```

4. The host checks that `cert` has `v: 1`, `typ: "buwiz-session"` and every other field equal to the request,
   and that `cert_sig` verifies with the install record's plugin key. Otherwise the open is refused with
   `plugin_bad_signature` and the plugin is marked `failed`. A plugin that answers `-32601` is marked `failed`
   with `plugin_invalid`.

A session ends at the earliest of: the open closes (`buwiz.session.close`), `not_after` passes, the plugin
restarts (a new generation), the plugin is updated, disabled or uninstalled. A host MAY open a session ahead
of a card it is about to mount; an unused pre-opened session is closed within 60 seconds.

## 6. The manifest

### 6.1 Delivery

- The plugin serves the manifest as the resource `buwiz://manifest`: UTF-8 JSON, at most 256 KiB, listed in
  `resources/list` and readable with `resources/read`. The host takes the first text content.
- `resources/list` and `resources/read` MUST work before `buwiz.provision`: on a first spawn the host reads
  the manifest's `id` to know which plugin it provisions. Only tools are gated by provision.
- The host verifies the manifest on every spawn, after provision, and again on every
  `notifications/resources/list_changed`.
- The manifest the plugin serves is the signed one. The template SDK reads it from the file named by
  `BUWIZ_PLUGIN_MANIFEST`, else `<plugin id>.manifest.json` next to the executable.

### 6.2 Verification order

A host verifies in this order and stops at the first failure. Each failure names the field's path in its
message (`apps[1].inline.width: must be 240 to 960`).

1. Size: at most 256 KiB, else `manifest_invalid`.
2. Parse as I-JSON (no duplicate keys, valid UTF-8); the value MUST be an object. Else `manifest_invalid`.
3. `protocol` (section 3.3), else `protocol_unsupported` or `manifest_invalid`. `version` semver, at most 32
   characters, else `manifest_invalid`.
4. `publisher` fields (section 6.4); `publisher.key_id` in the trust store; `publisher.id` the key's
   publisher; `id` approved for that key; `signature` well formed and verifying (section 5.2). Else
   `manifest_invalid`.
5. `needs` absent or `[]`, else `not_supported`.
6. Every field's grammar and limit (sections 6.3 to 6.9), else `manifest_invalid`.
7. A native screen only under a first-party key (section 11.3), else `manifest_invalid`.

Then, against the running plugin:

8. `tools/list`: every tool except reserved ones follows the tool grammar and starts with `<short>_`; every
   tool the manifest names (each `commands[].resolve`, `scopes[].resolve`, `routines[].query.tool`,
   `apps[].permissions.tools[]`) is in the list; every `routines[].writes[]` tool is in the list and not
   `readOnlyHint: true`. Else `manifest_invalid`.
9. `buwiz.provision`'s `manifest_sha256` equals the sha256 of the JCS bytes of the verified manifest
   (signature included). Else `manifest_invalid`.
10. The plugin id is not installed under another publisher key, and `short` is not used by another enabled
    plugin. Else `manifest_invalid`.
11. Against the install record (section 9.4): the same hash runs; a different hash under the same version is
    `manifest_changed`; a different version is `update_available` and waits for the person.

### 6.3 Top-level fields

| Field         | Type   | Req | Rule                                                                                                                      |
| ------------- | ------ | --- | ------------------------------------------------------------------------------------------------------------------------- |
| `protocol`    | string | yes | `"1.0.0"` (section 3).                                                                                                    |
| `id`          | string | yes | Plugin id (section 4). Must be approved for the publisher key.                                                            |
| `short`       | string | yes | Short (section 4).                                                                                                        |
| `version`     | string | yes | Semver, at most 32 characters. Raise it on every release.                                                                 |
| `title`       | string | yes | 1 to 60 characters.                                                                                                       |
| `description` | string | no  | At most 300 characters. Shown at install; never sent to the model.                                                        |
| `icon`        | string | no  | 1 to 2048 characters: the URI of a PNG or SVG resource the plugin serves. A host MAY decline to show an icon over 64 KiB. |
| `publisher`   | object | yes | Section 6.4.                                                                                                              |
| `signature`   | object | yes | Section 5.2.                                                                                                              |
| `commands`    | array  | no  | At most 32. Section 6.5.                                                                                                  |
| `scopes`      | array  | no  | At most 16. Section 6.6.                                                                                                  |
| `routines`    | array  | no  | At most 8. Section 6.7.                                                                                                   |
| `apps`        | array  | no  | At most 16. Section 6.8.                                                                                                  |
| `needs`       | array  | no  | Reserved for shared services. Absent or `[]`; anything else is refused with `not_supported`.                              |

Character counts are Unicode code points unless a rule says bytes.

### 6.4 `publisher`

| Field    | Req | Rule                                                                            |
| -------- | --- | ------------------------------------------------------------------------------- |
| `id`     | yes | Publisher id grammar. Equals the trust-store key's publisher when it names one. |
| `key_id` | yes | Key id grammar; a key in the trust store.                                       |
| `name`   | yes | 1 to 80 characters. Shown at install ("<title> <version> by <name>").           |

### 6.5 `commands[]`

| Field         | Req | Rule                                                                      |
| ------------- | --- | ------------------------------------------------------------------------- |
| `name`        | yes | Command grammar; not `status`; unique.                                    |
| `description` | yes | At most 200 characters (may be empty). Shown in the command popup.        |
| `args`        | no  | Hint text such as `[ticket]`, at most 120 characters.                     |
| `resolve`     | yes | One of the plugin's tools (`<short>_…`): the resolve tool (section 15.2). |

### 6.6 `scopes[]`

| Field         | Req | Rule                                                                                                                                                 |
| ------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes | Scope grammar; unique.                                                                                                                               |
| `description` | yes | At most 120 characters (may be empty). Its first word, without trailing punctuation and lower-cased, is the noun in the agent's "this <noun>" lines. |
| `resolve`     | yes | One of the plugin's tools.                                                                                                                           |
| `attach`      | no  | Boolean, default false: whether tokens of this scope may be attached to a chat.                                                                      |
| `hint`        | no  | At most 1500 characters. Added to the system prompt when the scope is in play (section 18.3).                                                        |

### 6.7 `routines[]`

A routine is a template: on a schedule or a webhook, the host runs one of the plugin's tools to find new
items and runs an agent prompt for each. Section 19 says how. A routine carries access grants, so it takes no
key but these.

| Field         | Req | Rule                                                                                                                                                                                                                             |
| ------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes | Routine id grammar; unique.                                                                                                                                                                                                      |
| `name`        | yes | 1 to 80 characters.                                                                                                                                                                                                              |
| `description` | yes | At most 300 characters.                                                                                                                                                                                                          |
| `every_s`     | yes | Integer, 60 to 86400.                                                                                                                                                                                                            |
| `query`       | yes | `{tool, field, args?}` and no other key. `tool`: one of the plugin's tools. `field`: 1 to 64 characters, the string field of the tool's `structuredContent` that holds the search text. `args`: an object passed to the tool.    |
| `prompt`      | yes | 1 to 4000 characters. The agent prompt run for each new item.                                                                                                                                                                    |
| `reads`       | no  | At most 4 entries `{plugin, tools}` and no other key: `plugin` a plugin id, `tools` 1 to 8 tool names; at most 8 tools across all entries. Read-only tools of another plugin the routine may use; the person approves them once. |
| `writes`      | no  | At most 8 of the plugin's own tools that change data, each once, never a reserved tool. The routine's turn may call them without asking. Each must be in `tools/list` and not `readOnlyHint: true`.                              |
| `params`      | no  | The settings one instance of the routine runs with (section 19.2).                                                                                                                                                               |

### 6.8 `apps[]`

Each app is a TSX app (`entry`, `mime`, `sdk`, `fingerprint`, all required) or a native screen (`native`),
never both and never neither.

| Field         | Type   | Req       | Rule                                                                                              |
| ------------- | ------ | --------- | ------------------------------------------------------------------------------------------------- |
| `id`          | string | yes       | App id grammar; unique.                                                                           |
| `title`       | string | yes       | 1 to 60 characters. Window, card and link title.                                                  |
| `description` | string | yes       | At most 300 characters. Not sent to the model.                                                    |
| `entry`       | string | TSX       | Exactly `buwiz-app://<id>`.                                                                       |
| `mime`        | string | TSX       | `text/x-nsh-tsx`.                                                                                 |
| `sdk`         | string | TSX       | `"1"`: the nsh surface major the import table follows (section 11.2).                             |
| `fingerprint` | string | TSX       | `sha256:` and 64 lowercase hex: the source's fingerprint (section 11.2).                          |
| `native`      | object | native    | `{"screen": "<native screen>", "abi": 1}` and no other key. First-party keys only (section 11.3). |
| `props`       | object | no        | The props schema (section 11.5). Its top-level `type` is `"object"`.                              |
| `placement`   | array  | yes       | `["full"]`, `["inline"]` or `["full", "inline"]`. The first entry is the default.                 |
| `inline`      | object | if inline | Section 6.9.                                                                                      |
| `permissions` | object | no        | What the app may reach (section 12). Absent means nothing.                                        |

### 6.9 `apps[].inline`

| Field        | Req | Rule                                                                                              |
| ------------ | --- | ------------------------------------------------------------------------------------------------- |
| `width`      | yes | Integer, 240 to 960 (points).                                                                     |
| `height`     | yes | Integer, 96 to 800: the first frame's height.                                                     |
| `min_width`  | no  | Integer, 240 to `width`.                                                                          |
| `min_height` | no  | Integer, 96 to `height`. Default 120. The least height `buwiz.fit` sets.                          |
| `max_height` | no  | Integer, `height` to 800. Default 640. The most height `buwiz.fit` sets.                          |
| `resizable`  | no  | Boolean.                                                                                          |
| `wait_ready` | no  | Boolean. The card keeps a placeholder over the app until it calls `buwiz.ready()` (section 13.4). |

The host clamps every size to these ranges and to the chat column.

### 6.10 The install review

At install and update the host shows the person what the manifest grants, from the manifest alone:

- "<title> <version> by <publisher name>" and the description;
- each app with its title and placements ("full screen", "inline 480×320"), and under it one line per
  permission: "Can call N <title> tools: …", "Can open: <app titles>", "Can open in your browser (asks each
  time): <origins>", "Can attach: <scope nouns>", "Can read files: .xlsx, .csv up to 25 MB[, several at once]",
  "Storage: 1 MB", "Copy to clipboard", "Show print previews (static pages, no scripts)";
- each routine's reads ("Routine '<name>' reads via <plugin title>: <tools>"), writes ("Routine '<name>' may
  change <title> data without asking: <tools>") and params ("Routine '<name>' runs per chat with its own
  settings: <names>");
- for a package: its skills and its accounts, `required` ones offered as "Sign in after install"
  (section 20);
- any command ambiguity warning (section 4.1).

## 7. The package

A plugin MAY ship as a **package**: a folder with `plugin.json` at its root, the plugin's binary and any other
files. The `plugin.json` format is shared with other plugin systems; Buwiz reads the fields below and one
signed block, `buwiz`. A plugin that ships as a bare binary uses the release index instead (section 8.3).

### 7.1 Layout

```
plugin.json                    the plugin manifest, with the signed buwiz block
bin/notes-mini-app             this platform's binary
skills/weekly-review/SKILL.md  any other file, listed in buwiz.files
```

### 7.2 `plugin.json`

At most 1 MiB, I-JSON, an object.

| Field                              | Req | Rule                                                                                                                                                               |
| ---------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                             | no  | The plugin's name in other plugin systems.                                                                                                                         |
| `version`                          | yes | Equals `buwiz.version`.                                                                                                                                            |
| `description`, `author`, `license` | no  | As other plugin systems use them.                                                                                                                                  |
| `mcpServers`                       | yes | An object of server entries. The one `buwiz.server` names is the mini app; other entries are plain connectors of the same plugin.                                  |
| `skills`                           | no  | A path or a list of paths of skill folders; default `skills/`. Each listed file `<root>/<name>/SKILL.md` is a skill named `<name>`, described by its front matter. |
| `buwiz`                            | yes | The signed block, section 7.3.                                                                                                                                     |

The mini app's `mcpServers` entry MUST be a stdio server: no `url`, `type` or `transport` absent or
`"stdio"`, a non-empty `command`, `args` (if present) an array of strings and `env` (if present) an object of
strings. In `command`, `args` and `env` values the host replaces `${PLUGIN_ROOT}` (and its other names,
`${CLAUDE_PLUGIN_ROOT}` and `${CURSOR_PLUGIN_ROOT}`) with the install folder's absolute path.

### 7.3 The `buwiz` block

| Field       | Req | Rule                                                                                                                                                                  |
| ----------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`  | yes | `"1.0.0"`; compared as section 3.3.                                                                                                                                   |
| `id`        | yes | Plugin id. Equals the served manifest's `id`.                                                                                                                         |
| `short`     | yes | Short. Equals the served manifest's `short`.                                                                                                                          |
| `version`   | yes | Semver. Equals the served manifest's `version` and `plugin.json`'s `version`.                                                                                         |
| `server`    | yes | The `mcpServers` key of the mini app.                                                                                                                                 |
| `accounts`  | no  | At most 8 accounts (section 20.1).                                                                                                                                    |
| `files`     | no  | An object: install path → `{asset, sha256}`. Every file of the folder except `plugin.json` and the binaries. At most 256 files, 50 MiB together. Never `plugin.json`. |
| `binaries`  | yes | An object: platform → `{path, asset, sha256}`. Each binary at most 200 MiB, installed at `path` with mode 0755. A `path` is never `plugin.json` or a listed file.     |
| `publisher` | yes | `{id, key_id}`: as the manifest's.                                                                                                                                    |
| `signature` | yes | Section 5.2, over all of `plugin.json` without `buwiz.signature`.                                                                                                     |

`asset` is a release asset name (section 4); `sha256` is 64 lowercase hex of the file's bytes; `path` is an
install path.

The signature covers the mini app's command line, its skills list and every hash, so nothing in the folder
can change without a new signature. The served `buwiz://manifest` keeps its own signature, and both are
checked.

### 7.4 What the host checks

- At install: `plugin.json` parses and its block is well formed; protocol; trust and approval of
  `(buwiz.id, buwiz.publisher.key_id)`; the signature; a `binaries` entry for this platform (else
  `not_supported`, "<id> has no build for <platform>"); each listed file and this platform's binary present
  with its SHA-256 (else `manifest_invalid`, "<path> does not match plugin.json's sha256"). Then the spawn and
  the gate of section 9.1, and the served manifest's `id`, `short` and `version` equal to the block's (else
  `manifest_invalid`).
- At every spawn: `plugin.json` is verified again (the trust store may have changed) and the served manifest is
  checked against it again.

Errors in a block are `manifest_invalid` with a `plugin.json:` prefix, except a reserved account provider
(`not_supported`) and an unsupported protocol (`protocol_unsupported`).

## 8. Distribution

### 8.1 GitHub releases

A host installs a mini app from a GitHub release named by `https://github.com/<owner>/<repo>`,
`https://github.com/<owner>/<repo>/releases/tag/<tag>` or `<owner>/<repo>`. Without a tag it takes the
repository's latest release.

- Downloads are https only, following at most 5 redirects.
- A release with an asset named `plugin.json` is a **package** (section 8.2). Otherwise it MUST have
  `buwiz-release.json`, the index of a **bare binary** (section 8.3).
- Files land in the host's data folder at `v1/apps/<id>/<version>/`, staged in a temporary folder and moved
  into place with a rename. A complete folder already there is reused.
- What comes out is a spawn spec for the review (section 9.1). Nothing is installed until the person
  approves the review. When the agent asks to install (`app_install`), the host posts the review as a card in
  the chat; only the person's Install installs.

### 8.2 A package release

Release assets are flat (GitHub asset names have no `/`): `plugin.json`, each `buwiz.files[].asset` and each
`buwiz.binaries[].asset`.

1. Fetch `plugin.json` (at most 1 MiB) and verify it (section 7.4) with a binary for this platform.
2. Download each listed file (50 MiB together at most) and this platform's binary (200 MiB at most); check each
   SHA-256; write each at its `path`; set the binary's mode to 0755.
3. Write `plugin.json` beside them.
4. The spawn spec is `mcpServers[buwiz.server]` with `${PLUGIN_ROOT}` expanded.

### 8.3 A bare binary: `buwiz-release.json`

The older form: a signed index of the manifest and one binary per platform.

```json
{
  "v": 1,
  "id": "app.buwiz.notes",
  "version": "1.2.0",
  "publisher": { "key_id": "gc-2026-01" },
  "manifest": { "asset": "manifest.signed.json", "sha256": "<64 hex>" },
  "binaries": {
    "macos-aarch64": { "asset": "notes-mini-app-macos-aarch64", "sha256": "<64 hex>" }
  },
  "run": { "args": ["mcp"], "env": { "BUWIZ_PLUGIN_MANIFEST": "{manifest}" } },
  "needs_env": [{ "key": "NOTES_TOKEN", "label": "Notes token", "secret": true }],
  "signature": { "alg": "ed25519", "key_id": "gc-2026-01", "value": "<b64url>" }
}
```

| Field              | Req | Rule                                                                                                                     |
| ------------------ | --- | ------------------------------------------------------------------------------------------------------------------------ |
| `v`                | yes | `1`.                                                                                                                     |
| `id`               | yes | Plugin id, approved for the key.                                                                                         |
| `version`          | yes | Semver.                                                                                                                  |
| `publisher.key_id` | yes | A trust-store key.                                                                                                       |
| `manifest`         | yes | `{asset, sha256}`: the signed manifest.                                                                                  |
| `binaries`         | yes | Platform → `{asset, sha256}`. This platform's MUST be present ("no build for <platform>").                               |
| `run.args`         | no  | Strings.                                                                                                                 |
| `run.env`          | no  | Name → string. `{manifest}` becomes the manifest file's path and `{dir}` the install folder's; nothing else is expanded. |
| `needs_env`        | no  | `[{key, label?, secret?}]`: settings the person fills in before the plugin starts.                                       |
| `signature`        | yes | Section 5.2, over the index without `signature`.                                                                         |

The index is at most 1 MiB. The host downloads the manifest (at most 1 MiB, stored as `manifest.signed.json`)
and the binary (at most 200 MiB, stored under its asset name, mode 0755), checks both SHA-256s, and checks
that the manifest's `id`, `version` and `publisher.key_id` equal the index's. The spawn spec is the binary with
`run.args` and the expanded `run.env`.

## 9. Lifecycle

### 9.1 The gate

Every spawn passes the same gate, in order:

1. Spawn the process over stdio and initialize MCP.
2. On a first spawn, read `buwiz://manifest` for its `id`.
3. `buwiz.provision` (section 10.2), 5 seconds. A refusal, a timeout or `-32601` is `plugin_invalid`
   ("buwiz.provision failed: …"). An answer without `ok: true` and a 64-hex `manifest_sha256` is
   `plugin_invalid`.
4. `resources/list` lists `buwiz://manifest` (else `manifest_invalid`); read and verify it (section 6.2).
5. `tools/list` and its checks (section 6.2 step 8).
6. The provision hash equals the verified manifest's (section 6.2 step 9).
7. The stderr scan found no seed (section 5.4).

A process that does not start or answer counts as a crash and restarts (section 22.3). A plugin that answered
with something invalid is `failed` and does not loop.

### 9.2 Inspect and review

Before an install or update the host runs the gate on a temporary spawn with a fresh, throw-away key, checks
section 6.2 step 10, and shows the review (section 6.10) with the update facts: from and to version, whether
it is a downgrade or the same version, and the permissions added. Nothing is stored. The review is tied to
the manifest's hash.

### 9.3 Install

On the person's Install:

1. The host spawns again and checks that the plugin serves the reviewed manifest (else `manifest_invalid`, "the
   plugin serves a manifest other than the one reviewed; inspect it again").
2. It generates the plugin key, stores it, spawns under it and passes the gate.
3. For a package, it pushes accounts (section 20.3).
4. It records the install: plugin id, short, spawn spec, version, protocol, publisher key id, plugin public key,
   manifest and its hash, the tool list, and for a package its folder and skills.
5. The plugin is `running`. Its commands and scopes join the composer; its tools join the agent's surface.

### 9.4 Update and the permission diff

An update is an install of an installed id.

- Same manifest hash: nothing changes.
- Same version, different manifest: refused with `manifest_changed`.
- Lower version: refused with `invalid_args` (`details.reason: "downgrade"`) unless the person chose "Install
  older version".
- **Permission diff.** Every permission the new manifest grants that the installed one did not needs the
  person's consent; a removed one does not. The diff compares, per app id: each added tool, open app, external
  origin and attach scope; `pick_file` newly granted, or a new extension, a larger `max_bytes` or `multiple`
  newly true; `storage` newly granted or a larger quota; `copy` newly true; `preview` newly granted or a
  larger `max_bytes`; and, per routine id, each added `reads` tool and each added `writes` tool. Without
  consent the update is refused with `consent_declined` (`details.reason: "permissions_added"`, `details.added`:
  the lines), and the old version stays.
- The update keeps the plugin key. The host stops the running process (calls in flight fail
  `plugin_restarted`), ends every open of the plugin, spawns the new version under the stored key, checks it
  serves the reviewed manifest, and records it. Attachments and storage stay.

A running plugin that starts serving a manifest with a new version (it was replaced in place) is not run: its
state is `update_available` until the person installs the update.

### 9.5 Disable and enable

- **Disable**: end every open, stop the process. Commands, scopes and tools leave the composer and the agent's
  surface. Links, pins and attachments say "<title> is disabled" and are not sent to the model. Storage, keys,
  tickets and accounts stay.
- **Enable**: check section 6.2 step 10 again, then spawn through the gate. No review unless permissions
  changed.

### 9.6 Uninstall

In this order:

1. `buwiz.uninstall` (best effort, 5 seconds). A plugin that is not running is spawned for it when its key is
   present.
2. End every open (`buwiz.session.close`).
3. Stop the process. Delete the plugin key.
4. Delete the plugin's accounts: tokens, records, refresh timers and pending sign-ins.
5. Delete the install folder `v1/apps/<id>/`.
6. Remove the install record and free the short.
7. Remove every pin, attachment and library item of the plugin, and its apps' storage.

A link that still names the plugin opens a "not installed" notice and does nothing else.

## 10. Reserved tools

### 10.1 Rules

Reserved tools are MCP tools named `buwiz.*` that the host calls on the plugin. A plugin MUST answer the ones it
must implement, MAY leave out the optional ones, and MUST answer any other `buwiz.*` name with the MCP error
`-32601` (method not found). They are never on the model's surface, never callable from an app, and need not be
in `tools/list`.

A plugin refuses with a tool result `isError: true` whose `structuredContent` (or first text, as JSON) is
`{code, message}`; the host takes `code` (default `invalid_args`) and at most 200 characters of `message`.
Each reserved call has a 5-second limit.

| Tool                                       | Needed                                  | On `-32601`                                                                                         |
| ------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `buwiz.provision`                          | MUST                                    | `plugin_invalid`; the plugin does not start.                                                        |
| `buwiz.session.open`                       | MUST when the plugin has apps           | `plugin_invalid`; the plugin is `failed`.                                                           |
| `buwiz.session.close`                      | MAY                                     | Ignored.                                                                                            |
| `buwiz.ticket.resolve`                     | SHOULD                                  | Titles are unavailable (`not_supported`).                                                           |
| `buwiz.uninstall`                          | SHOULD                                  | Ignored.                                                                                            |
| `buwiz.account.set`, `buwiz.account.clear` | MUST when the package declares accounts | `plugin_invalid` ("<id> does not implement buwiz.account.set"); the plugin is stopped and `failed`. |

### 10.2 `buwiz.provision`

The first tool call after every spawn. Until it succeeds the plugin MUST refuse every other tool.

Arguments:

```json
{ "protocol": "1.0.0", "plugin": "app.buwiz.notes", "key": { "alg": "ed25519", "seed": "<b64url, 32 bytes>" }, "pub": "<b64url, 32 bytes>" }
```

Answer: `{"ok": true, "manifest_sha256": "<64 hex>"}`, the SHA-256 of the JCS bytes of the manifest it serves.

- The plugin refuses (`invalid_args`) a `plugin` other than its own id, a malformed key, and a second provision
  with a different key. Provision with the same key again is idempotent.
- `protocol` is the host's protocol. A plugin MAY ignore it; the host decides compatibility from the manifest.

### 10.3 `buwiz.session.open`

Arguments: `{"app", "open_id", "ks_pub", "perms_sha256", "not_after"}` as in section 5.5.

Answer: `{"cert": {…}, "cert_sig": "<b64url, 64 bytes>"}` (section 5.5). The plugin refuses (`invalid_args`)
an unknown app, a digest that is not `sha256(JCS(permissions))` of that app in the manifest it serves, and a
`not_after` in the past or more than 8 hours ahead.

### 10.4 `buwiz.session.close`

Arguments: `{"open_id": "<id>"}`. Answer: `{"ok": true}`. Best effort; sent only while the plugin runs.

### 10.5 `buwiz.ticket.resolve`

Arguments: `{"ticket": "tkt_…"}`. Answer: `{"valid": true, "title": "<display title>"}` or `{"valid": false}`.
A title only, never the subject or any identifier. The host keeps at most 120 characters of `title`; any
other answer counts as `valid: false`.

### 10.6 `buwiz.uninstall`

Arguments: `{}`. Answer: `{"ok": true}` after the plugin deletes its tickets and subjects.

### 10.7 `buwiz.account.set` and `buwiz.account.clear`

Section 20.3.

## 11. Apps

### 11.1 Placement

- **Full**: the app fills the chat's full-screen stack, titled `apps[].title`.
- **Inline**: a card in the chat, `inline.width` by `inline.height`, clamped to the ranges of section 6.9 and
  to the column, under a header with the title and Open (full screen). The card takes the heights the app
  reports with `buwiz.fit` (section 13.4). An inline app may hand the host its card's footer buttons, header
  status and settled line (section 13.6).
- An open asks for a placement the app declares; without one it takes the first.
- **Theme**: the host renders every app in its own appearance setting, not the OS's, and switches open apps
  live. Apps style every colour for light and dark.

### 11.2 TSX apps

- Source: `resources/read` on `entry` returns exactly one content, with `text`; its `mimeType`, if present,
  equals `apps[].mime`. Else `plugin_invalid`. UTF-8, at most 512 KiB (else `result_too_large`).
- Fingerprint: `"sha256:" + hex(SHA-256(source bytes))`, over the bytes exactly as returned. A source whose
  fingerprint differs from the manifest's does not load (`fingerprint_mismatch`: "This app's code does not match
  its signed manifest. Update the plugin.").
- The module's **default export** is a function component with no required arguments; the host mounts it.
- Imports: only `nsh` (reactive and UI primitives of the nsh SDK major `sdk` names), `nsh/base` and `buwiz`
  (the bridge; also the global `buwiz`). Any other specifier fails with `unsupported_import`.
- The app has no network, file, process, clipboard or engine-storage access: `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `localStorage` and `sessionStorage` are undefined. Data comes from `buwiz.call`.
- Budgets: load (compile and first render) 10 s, one JS call 2 s, heap 256 MB, stack 4 MB.
- _Host behaviour:_ a host may cache an app's compiled module keyed by plugin id, app id, signed fingerprint
  and host build; every open still runs the module compiled from the source the signed manifest names.

### 11.3 Native screens

A first-party plugin MAY ship an app as a native screen: Rust code compiled into the host and drawn by nsh,
named in the manifest by `native: {"screen": "<id>", "abi": 1}`.

- A manifest with a native screen under a key the trust store does not mark first-party is refused
  (`manifest_invalid`: "native screens are for first-party plugins only; ship the app as a TSX screen").
- A native screen has no `entry`, `mime`, `sdk`, `fingerprint` or source; reading it is `not_supported`.
- It runs only when this host build has a screen of that plugin id with that `screen` and `abi`. A host
  without it shows "this screen needs a newer Buwiz Bot" when it opens.
- It gets the same bridge, permissions, signing, limits, pacing and card chrome as a TSX app; `abi` 1 is the
  bridge of section 13. The SDK's `buwiz-app` crate is that bridge in Rust.

### 11.4 Errors shown to the person

| Condition              | Shown                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Compile error          | "Could not open <title>: <first line of the error> (line N)". Source is not shown.    |
| Fingerprint mismatch   | "This app's code does not match its signed manifest. Update the plugin." Not retried. |
| Unsupported import     | "<title> uses <specifier>, which this Buwiz Bot does not support."                    |
| Budget trip            | "<title> stopped: it took too long." or "… ran out of memory.", with Reload.          |
| Uncaught runtime error | "<title> stopped: <message, at most 200 characters>.", with Reload and Close.         |
| Plugin not running     | "<plugin title> is not running. Retry"                                                |
| Native screen missing  | "this screen needs a newer Buwiz Bot"                                                 |

### 11.5 Props

`buwiz.props` is a read-only object the host gives an open: the props of the link, token, pin, resolve or tool
result that opened it.

- At most 8 KiB as JCS, depth at most 8, arrays at most 100 items, every key the prop-key grammar.
- Validated against `apps[].props`, a subset of JSON Schema: `type` (`object`, `array`, `string`, `number`,
  `integer`, `boolean`, `null`), `properties` (at most 16 per object), `required` (names of `properties`),
  `items`, `enum` (scalars), `maxLength` (0 to 512), `minimum`, `maximum` (integers). Anything else in a props
  schema is refused at verification. Props that fail are not opened (`invalid_args`).
- When an open carries a ticket and its props have no `ticket`, the host sets `props.ticket` to it if the
  schema declares `ticket`. The host adds nothing else.
- Props MUST NOT carry raw identifiers the person would not otherwise see; use a ticket.

## 12. Permissions

`apps[].permissions` declares what one app may reach. Every key is optional; an unknown key is a refusal. The
host compiles it into the app's sandbox: a method not granted is **absent** from the bridge (`undefined`), not
present and failing. A host MUST NOT share one app's policy with another.

| Key         | Value                                                           | Limits                                                                                 | Grants                          |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `tools`     | Tool names of this plugin, never reserved                       | At most 64                                                                             | `buwiz.call` (when non-empty)   |
| `open`      | `{apps?: [app ids of this plugin], external?: [https origins]}` | apps 16, external 8                                                                    | `buwiz.open`                    |
| `attach`    | Scope names whose scope has `attach: true`                      | At most 16                                                                             | `buwiz.attach` (when non-empty) |
| `pick_file` | `{extensions?: [".xlsx", …], max_bytes, multiple?}`             | extensions 16, each `^\.[a-z0-9]{1,16}$`; `max_bytes` 1 to 52428800 (50 MiB), required | `buwiz.pickFile`                |
| `storage`   | `{quota_bytes?}`                                                | 1 to 10485760 (10 MiB); default 1048576 (1 MiB)                                        | `buwiz.storage`                 |
| `copy`      | Boolean                                                         |                                                                                        | `buwiz.copy` (when true)        |
| `preview`   | `{max_bytes?}` or `{}`                                          | 1 to 8388608 (8 MiB); default 8 MiB                                                    | `buwiz.preview`                 |

An external origin is exactly `https://host[:port]`, with no path or trailing slash.

Always present, with no permission: `buwiz.props`, `buwiz.app`, `buwiz.viewport`, `buwiz.ticket.title`,
`buwiz.fit`, `buwiz.ready`, `buwiz.actions`, `buwiz.onAction`, `buwiz.meta` and `buwiz.settle`. Each of these
reads only what the app already holds or changes only its own card.

The **permissions digest** is `sha256(JCS(permissions))` in lowercase hex, `{}` when absent. It binds a
session certificate to the permissions the person approved.

## 13. The bridge

### 13.1 Surface

```ts
interface Buwiz {
  readonly props: Readonly<Record<string, Json>>; // 11.5
  readonly app: { plugin: string; app: string; version: string; fingerprint: string; protocol: string; sdk: string };
  viewport(): { width: number; height: number; placement: "full" | "inline" }; // a signal
  ticket: { title(ticket: string): Promise<string | null> }; // 13.3
  fit(height: number): void; // 13.4
  ready(): void; // 13.4
  actions(list: Action[]): Promise<void>; // 13.6
  onAction(handler: (id: string) => void): () => void; // 13.6
  meta(meta: { text: string; pill?: boolean } | null): Promise<void>; // 13.6
  settle(text: string): Promise<void>; // 13.6
  call?<T = Json>(tool: string, args?: Record<string, Json>): Promise<T>; // tools
  open?(target: { app: string; props?: Record<string, Json>; ticket?: string } | { url: string }): Promise<void>; // open
  attach?(scope: string, value: string): Promise<{ token: string; title: string; attached: boolean }>; // attach
  pickFile?(options?: { extensions?: string[]; multiple?: boolean }): Promise<PickedFile[]>; // pick_file
  storage?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    keys(): Promise<string[]>;
  }; // storage
  copy?(text: string): Promise<void>; // copy
  preview?(options: { tool: string; args?: Record<string, Json>; title?: string }): Promise<void>; // preview
}
interface Action {
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}
interface PickedFile {
  name: string;
  size: number;
  type: string;
  read(): Promise<Uint8Array>;
}
```

`buwiz.app` gives the plugin id, app id, plugin version, the app's fingerprint, the protocol and the `sdk`;
apps use it instead of any server name. Every rejection is a `BuwizError {code, message, retryable,
details?}` (section 22.1). The identity of a call (plugin, app, open, session key) is the host's, never what the
app sends, so an app cannot speak for another.

### 13.2 `buwiz.call(tool, args)`

| Item        | Rule                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Arguments   | `tool` in `permissions.tools`; `args` a JSON object (default `{}`), at most 256 KiB as JCS.                                 |
| Result      | The tool result's `structuredContent` when present, else its text contents joined with `\n`. `_meta` never reaches the app. |
| Tool error  | `isError: true` rejects `tool_error`; `message` is the first text content, at most 500 characters.                          |
| Size        | A result over 1 MiB (structured content, text, and embedded resources' text or blob) rejects `result_too_large`.            |
| Timeout     | 30 s in the host; the broker's limit to the plugin is 120 s, then MCP cancellation. Rejects `timeout`.                      |
| Concurrency | At most 8 calls in flight per open; more wait in order. At most 20 new calls a second per open; past that `rate_limited`.   |
| Checks      | Section 14.2.                                                                                                               |

Long operations return a job reference and the app polls a tool.

### 13.3 `buwiz.ticket.title(ticket)`

The display title of a ticket the app holds, or `null`. The host calls `buwiz.ticket.resolve`. It returns no
subject. A ticket that breaks the grammar rejects `invalid_args`.

### 13.4 `buwiz.fit(height)` and `buwiz.ready()`

`buwiz.fit(height)` reports an inline app's content height so its card hugs its content.

- `height`: a finite number above 0, in points; anything else throws `invalid_args` at once. Sent rounded up.
- Inline: the card height becomes `height` clamped to `inline.min_height` .. `inline.max_height`. Full screen:
  ignored.
- A post with no answer. A height within 2 points of the one set changes nothing; at most 8 heights a second
  go out per open, and past that the latest waits for the next slot, so the card ends at the last height.
  It does not count against `buwiz.call`'s limits.
- Measure the content's own height, not the frame given; an app that reports its frame never grows.

`buwiz.ready()` says an inline app's data is in. With `inline.wait_ready: true` the card keeps a placeholder
from the mount until `buwiz.ready()` or 3 seconds, whichever comes first. Without it a card is revealed when its
layout settles (at most 1.5 seconds). A post; full screen: ignored.

### 13.5 `buwiz.open`, `buwiz.attach`, `buwiz.pickFile`, `buwiz.copy`, `buwiz.preview`, `buwiz.storage`

**`buwiz.open(target)`** takes `{app, props?, ticket?}` or `{url}` and no other key.

| Target  | Rule                                                                                                                                                              | Consent                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `{app}` | `app` in `permissions.open.apps` (else `permission_denied`) and an app of this plugin (else `not_declared`); props validated; ticket by grammar (`invalid_args`). | None. Pushed on the full-screen stack.                                |
| `{url}` | `https:` only (else `not_supported`); origin in `permissions.open.external` (else `permission_denied`); at most 2048 characters.                                  | Always a dialog naming the URL and the app (else `consent_declined`). |

**`buwiz.attach(scope, value)`**: `scope` in `permissions.attach` with `attach: true`. The host runs the
scope's resolve with `kind: "scope"`, `complete: false` and expects a `token` answer (else `tool_error` or
`internal`). It needs a chat (else `no_chat`) and asks "Attach <title> to this chat?" (else
`consent_declined`). Result: `{token, title, attached}`; attaching the same canonical token again returns
`attached: false`.

**`buwiz.pickFile(options)`**: options take `extensions` and `multiple` only, within the grant (a wider request
rejects `permission_denied`). The host shows the native file dialog; the app never gets a path. A file over
`max_bytes` rejects `quota_exceeded`. Cancel resolves `[]`. `read()` after the open closes rejects `closed`.

**`buwiz.copy(text)`**: copies at most 1 MiB of text to the clipboard.

**`buwiz.preview({tool, args?, title?})`**: a print preview. The host calls one of the app's own tools (in
`permissions.tools`, else `not_declared` and nothing is sent) as `buwiz.call` does, with `"purpose":
"preview"` in the envelope, and shows the document over the app with Print and Close. The document never
reaches the app.

- The tool returns the page as an embedded resource: the first `content` item `{"type": "resource",
  "resource": {"uri", "mimeType": "text/html", "text"}}` (parameters of the MIME type ignored, `text` not
  `blob`). None: `tool_error`.
- The page's text is at most `permissions.preview.max_bytes` (else `result_too_large`).
- The title shown is `title` (at most 120 characters), else `structuredContent.title`, else the app's title.
- The page is static: JavaScript off, no base URL, and before its markup the host adds the policy
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src data:; form-action
  'none'; base-uri 'none'; frame-src 'none'`. Links are not followed.
- A host without a document view rejects `not_supported`.

**`buwiz.storage`**: section 21.

### 13.6 Card chrome: `buwiz.actions`, `buwiz.onAction`, `buwiz.meta`, `buwiz.settle`

An inline card's chrome, drawn by the host in its own style so a plugin's card looks like the host's own.
Each call is checked whatever the placement (a bad one rejects `invalid_args` and changes nothing); a full-screen
open then ignores it. After the open ends each rejects `closed`. They do not count against `buwiz.call`'s
limits.

| Call                      | Rule                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buwiz.actions(list)`     | At most 3 objects `{id, label, primary?, disabled?}`, no other key. `id`: 1 to 64 of `[A-Za-z0-9_.:-]`, unique. `label`: trimmed, 1 to 24 characters, one line (no control characters). At most one `primary`. `[]` removes the footer; each call replaces it. Drawn as pill buttons under the app, right-aligned, the primary first.     |
| `buwiz.onAction(handler)` | A press of an enabled button in the current list calls every handler with its `id`. Returns a function that removes the handler. A handler that is not a function throws `invalid_args`. The press does nothing else; the app does the work with its own tools. Nothing is delivered after the open ends. The model cannot press buttons. |
| `buwiz.meta(meta)`        | `{text, pill?}`, no other key, or `null` to remove. `text`: trimmed, 1 to 32 characters, one line. Dim text after the title, or a pill.                                                                                                                                                                                                   |
| `buwiz.settle(text)`      | `text`: trimmed, 1 to 120 characters, one line. The card collapses to one dim line reading `text`; the app unmounts and its session closes. No undo; a new open is a new card.                                                                                                                                                            |

### 13.7 Events

The host updates `buwiz.viewport` when the open's size or placement changes. When the plugin restarts under an
open, the open's session ends and the host shows "Reconnecting"; the app's calls reject `plugin_restarted`.

## 14. Calls: envelope, checks, replay

### 14.1 The envelope

For every `buwiz.call` and `buwiz.preview` the host builds, in native code:

```json
{
  "v": 1,
  "typ": "buwiz-call",
  "plugin": "app.buwiz.notes",
  "app": "board",
  "open_id": "<b64url, 16 bytes>",
  "tool": "notes_list",
  "args": { "folder": "work" },
  "ts": 1793000000000,
  "nonce": "<b64url, 16 bytes>"
}
```

A preview adds `"purpose": "preview"`; no other `purpose` exists. `sig = Ed25519Sign(session key,
JCS(envelope))`. The host's broker receives `{envelope, sig}`; the session key's private half never leaves the
native bridge. The envelope's numbers are safe integers (section 5.2).

### 14.2 What the broker checks, in order

Before the checks, a body without an envelope object and a string `sig`, or an envelope that is not
JCS-signable, is `invalid_args`.

| #   | Check                                                                                                                                                            | Failure              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | The `open_id` is a registered open whose certificate verifies with the plugin key; its `not_after` is in the future (an expired open is removed).                | `session_invalid`    |
| 2   | `v` is 1, `typ` is `buwiz-call`, and `plugin`, `app`, `open_id` equal the certificate's.                                                                         | `session_invalid`    |
| 3   | `sig` verifies with the certificate's `ks_pub` over JCS(envelope).                                                                                               | `bad_signature`      |
| 4   | `ts` is a safe integer within 60 s of the broker's clock.                                                                                                        | `stale`              |
| 5   | `nonce` is 16 bytes of base64url (else `invalid_args`) and not seen for this open in the window; it is added.                                                    | `replayed`           |
| 6   | The open began under the plugin's current generation.                                                                                                            | `plugin_restarted`   |
| 7   | The app is in the installed manifest, the digest of its installed permissions equals the certificate's `perms_sha256`, and `tool` is in its `permissions.tools`. | `permission_denied`  |
| 8   | The person has not switched `tool` off.                                                                                                                          | `disabled`           |
| 9   | The plugin is enabled and running.                                                                                                                               | `plugin_unavailable` |

Then: a `purpose` other than `"preview"` is `invalid_args`, and `"preview"` from an app without
`permissions.preview` is `permission_denied`; `args` MUST be an object of at most 256 KiB (`invalid_args`); the
tool MUST be in the plugin's current `tools/list` (`not_found`); the rate and concurrency limits of section
13.2 apply. Only then does the broker call the tool, with `_meta["buwiz/caller"]` (section 16.1). Its answer is
checked as section 13.2, with the preview's `max_bytes` in place of 1 MiB for a preview.

### 14.3 Replay and clock

- Nonces are 128 random bits. The seen set keeps a nonce for 5 minutes and at most 10,000 per open, oldest
  evicted. A replay inside the window is check 5; after it, check 4.
- A host clock more than 60 s off makes calls fail `stale`; the host says "Check the computer's date and time".

### 14.4 What the plugin trusts

The plugin trusts the broker, the only process holding its stdin, and MUST NOT accept calls from any other
channel. It MAY re-verify what it is given; it is not required to, because the broker is the gate.

### 14.5 The per-tool switch

A tool the person switched off is off for the agent, for apps (check 8), for resolve (a resolve tool switched
off is `disabled`) and for routines.

## 15. Commands, scopes, tokens, tickets and links

### 15.1 Composer flow

- Typing `@short:scope:` asks the scope's resolve for choices (`complete: true`). A token typed without
  completion is resolved on send (`complete: false`).
- On send each resolved typed token is replaced by its canonical token, so the stored message and the model's
  context carry the ticket, never the typed identifier. The host shows a canonical token as a chip with the
  ticket's title. A token that does not resolve stays as typed, with a warning.
- A message that is only tokens or a single slash command is not sent to the model: the host runs the resolves.

### 15.2 Resolve tools

One tool of the plugin per command or scope (several may share one). Called with
`_meta["buwiz/caller"].origin` `"resolve"`, 10-second limit, and these arguments:

```json
{
  "kind": "command",
  "name": "note",
  "value": "what follows the name",
  "complete": false,
  "context": { "attached": [{ "scope": "folder", "token": "@notes:folder:tkt_…" }] }
}
```

`value` is the text after the command name or after the scope's colon (`""` when none). `context.attached`
lists canonical tokens attached to the chat. The answer is `structuredContent` (or the first text, as JSON) with
one `result`:

| `result`    | Fields                                                      | Host rule                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"choices"` | `choices: [{label, detail?, value}]`                        | First 20 kept; `label` cut to 80, `detail` to 160, `value` to 512 characters. Each needs `label` and `value` (else `plugin_invalid`). `value` replaces the typed text: a ticket.                                                                            |
| `"open"`    | `app`, `props?`, `ticket?`, `title?`, `placement?`, `size?` | As a `buwiz/open` (section 16.2): the plugin's own app, valid props and ticket, a declared placement. `title` cut to 60.                                                                                                                                    |
| `"token"`   | `ticket`, `title`                                           | `ticket` by grammar (else `plugin_invalid`); `title` cut to 60. For a scope the token is `@<short>:<scope>:<ticket>`.                                                                                                                                       |
| `"prompt"`  | `text`                                                      | Commands only. At least one character other than space, tab, CR, LF; at most 4000 characters, refused, not cut (`plugin_invalid`). The host puts it in the composer (the whole draft when empty, else after the draft and a blank line) and never sends it. |
| `"error"`   | `message`                                                   | Cut to 200 characters; shown as a toast.                                                                                                                                                                                                                    |

Any other `result` is `plugin_invalid`. An `isError` answer is shown as `error` with its first text.

### 15.3 Opens from commands and tokens

A command or token the person typed that resolves to `open` opens at once, in the declared placement. A
resolve `open` produced by the agent or a routine is treated as a tool result (section 17).

### 15.4 Tickets

- Issued by the plugin in resolves, tokens and tool results. Random (130 bits), with no subject data, not
  signed.
- The host stores them in attachments, pins, links and messages, and never stores the subject.
- Resolved only by the plugin: `buwiz.ticket.resolve` for a title, and its own tools taking a ticket argument
  for anything else.
- The plugin may revoke a ticket; it then resolves `valid: false`. A plugin key change does not invalidate
  tickets.
- The plugin deletes its ticket map on `buwiz.uninstall`.

### 15.5 Attachments and pins

An attachment is a canonical token with the plugin id, the plugin's major version and title at attach time,
the scope and the chat. Attachments pin the ticket and the plugin major, not an app fingerprint. When the
plugin's major changes the attachment shows "needs update" and is not sent to the model. Pins store `{plugin
id, app id, ticket?, placement}` and open the app's current version. Both go on uninstall.

### 15.6 Links

`buwiz://app/<plugin id>/<app id>[?ticket=<ticket>][&props=<percent-encoded JSON object>]`

- Full plugin and app ids, never the short.
- At most 2048 characters; `props` at most 1024 bytes encoded. Larger state goes behind a ticket.
- A link from outside the host asks for consent (section 17). A link whose ticket resolves `valid: false`
  opens the app with "This item is no longer available".

## 16. Tool results: `_meta`

### 16.1 `buwiz/caller` (host to plugin)

Every `tools/call` to a plugin tool carries `_meta["buwiz/caller"]`:

| `origin`    | Who               | Fields                                                                                                                        |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `"app"`     | A bridge call     | `plugin`, `app`, `open_id`, `ts`                                                                                              |
| `"agent"`   | The model         | `plugin`, `ts`; in a routine's turn calling the routine's own plugin also `routine`, and `instance` and `params` (section 19) |
| `"routine"` | A routine's query | `plugin`, `ts`, `routine`, `instance`, `params`                                                                               |
| `"resolve"` | A resolve tool    | `plugin`, `ts`                                                                                                                |

`ts` is unix ms. The plugin uses it to authorize (section 23.2). The host never shows it to the model.

### 16.2 `buwiz/open` (plugin to host)

A tool result may offer an app:

```json
"_meta": { "buwiz/open": { "app": "board", "props": { "folder": "work" }, "ticket": "tkt_…",
                            "title": "Notes board", "placement": "inline", "size": "small" } }
```

| Field       | Rule                                                                |
| ----------- | ------------------------------------------------------------------- |
| `plugin`    | Optional; if present, this plugin's id (another is `not_declared`). |
| `app`       | One of this plugin's apps (else `not_declared`).                    |
| `props`     | Valid for the app (section 11.5).                                   |
| `ticket`    | Ticket grammar.                                                     |
| `title`     | Cut to 60 characters; default the app's title.                      |
| `placement` | One the app declares; default its first.                            |
| `size`      | `"main"` (default) or `"small"`.                                    |

- Ignored on `isError` results. A malformed one is dropped and logged; the result still reaches the model.
- The host shows a card on the reply with Open (full) or Show (inline); it never opens by itself (section 17).
- **Answer cards.** An inline card from a first-party plugin mounts at once. At most one main card and two small
  cards per answer; more show as one-line links. A card collapses to a chip after 5 of the person's messages.
  By convention `props.snapshot` holds the data the answer was based on and `props.as_of` its time (unix ms):
  the card renders the snapshot with "as of <time>" and Refresh, which reopens it without them to read live.
  A card's buttons that change something run only when the person presses them (`buwiz.call`, origin `app`).

### 16.3 `buwiz/suggest` (plugin to host)

`_meta["buwiz/suggest"]`: an array of `{label, prompt}`. The host keeps the first 3 with a non-empty `label`
and `prompt` (trimmed), cut to 40 and 200 characters, and shows them as chips under the answer; a tap sends
`prompt` as the person's message. Ignored on `isError` results.

### 16.4 `buwiz/audience` (plugin, in `tools/list`)

A tool definition's `_meta["buwiz/audience"]` is an array of audiences. A tool whose array leaves out
`"agent"` (for example `["app"]`) serves apps only: it is not on the model's surface and model calls of it are
refused. Absent means everyone.

### 16.5 Stripping

The host strips `_meta` from every tool result before the model or an app sees it.

## 17. Consent

| Trigger                                                                                          | Consent                                                                                            |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| A `buwiz://app/…` link from the OS or a web page                                                 | A dialog every time: "Open <app title> from <source>?"                                             |
| A tool result's `buwiz/open`, full placement                                                     | A card with Open; nothing opens until pressed.                                                     |
| A tool result's `buwiz/open`, inline placement                                                   | A card with Show; nothing mounts until pressed. A first-party plugin's answer card mounts at once. |
| A resolve `open` from the agent or a routine                                                     | As a tool result.                                                                                  |
| A click on an attachment or a pin                                                                | None.                                                                                              |
| A command or token the person typed, resolving to `open`                                         | None.                                                                                              |
| A command resolving to `prompt`                                                                  | None: nothing is sent.                                                                             |
| `buwiz.open({app})`                                                                              | None.                                                                                              |
| `buwiz.open({url})`, or an `https` URL in a resolve or tool result                               | A dialog every time: "Open <URL> in your browser?"                                                 |
| Any other scheme in plugin output (`http`, `mailto`, `tel`, `file`, `buwiz://` other than `app`) | Refused; never opened.                                                                             |
| `buwiz.attach`                                                                                   | A dialog: "Attach <title> to this chat?"                                                           |
| `buwiz.pickFile`                                                                                 | The native file dialog is the consent.                                                             |

Declining changes nothing: no chat, attachment, pin or open is made before the person agrees.

## 18. Agent integration

### 18.1 Tool naming

A plugin's tools reach the model under their own names (`<short>_<tool>`), with the description
`[<short>] <description>` (approved text, at most 1024 characters). The input schema is the tool's
`inputSchema`, default `{"type": "object", "properties": {}}`.

### 18.2 The surface

A tool is on the model's surface only when all hold:

- its plugin is enabled, running, and approved for its installed publisher key;
- the tool is not reserved, not switched off, and starts with `<short>_`;
- its `buwiz/audience`, if any, includes `"agent"`;
- its name does not start with a built-in prefix (`mcp_`, `office_`, `skill_`, `routine_`, `app_`, `bot_`)
  and is not already taken by another tool;
- in a routine's turn, it is the routine's own plugin's tool or one of the routine's `reads` tools.

The model calls with `origin: "agent"`. A call that fails with `{"code": "account_required", "account": "<id>"}`
is section 20.4.

### 18.3 Approved text

Text from a plugin reaches the model only from a plugin approved for its key, labelled and capped. Heading
markers at a line's start (`# ` to `###### `) are removed; text over its cap is cut at a word boundary and ends
`…[truncated]`.

| Text                       | Source                          | Cap          | Shown as                                                                                |
| -------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Tool description           | `tools/list` `description`      | 1024         | `[<short>] ` prefix                                                                     |
| Server instructions        | MCP `initialize` `instructions` | 4000         | `## Instructions from <title> (approved)`                                               |
| Scope description and hint | `scopes[]`                      | 120 and 1500 | `## Scope: <short>:<scope> (approved plugin <id>)`, when the scope is attached or typed |
| Attachment line            | the attachment                  | title 60     | `Attached: <token> (<title>): <plugin title> tools default to this <noun> here`         |
| Routine prompt             | `routines[].prompt`             | 4000         | The routine's turn                                                                      |

### 18.4 What the agent cannot do

The agent cannot press card buttons, sign in to accounts, install or uninstall a plugin (it posts a card the
person answers), or switch on a routine that needs consent (section 19.3).

## 19. Routines

### 19.1 A run

A manifest routine is a template; what runs is an **instance**: the routine, the chat it reports to, its
params, its trigger and a label. Each instance has its own thread, seen item ids (the last 1000) and state.
On each run the host:

1. Calls `query.tool` with `{...query.args, ...params}` and origin `routine`, and takes the string
   `structuredContent[query.field]` as the search text. An empty string means nothing to do.
2. With `reads`: calls the first tool of the first `reads` entry with `{"query": <search text>}`. Without:
   uses the query tool's own result. Either way `structuredContent.items` is an array of objects with a string
   `id`. A search tool named in `reads` takes `{query, limit?}` and returns `{items: [{id, …}]}`.
3. For each item whose `id` the instance has not seen, runs `prompt` as an agent turn in the instance's thread,
   with the item and the params ("keep to them").

In the turn the model sees the plugin's own tools and the `reads` tools. Of the plugin's own tools it may call
the read-only ones (`readOnlyHint: true`) and the ones the routine lists in `writes`; the host refuses any
other before the plugin sees it. A call to the routine's own plugin carries `routine`, `instance` and `params`
in `buwiz/caller`; calls to a `reads` plugin do not.

### 19.2 `params`

`params` is a small JSON Schema for one instance's settings: `{"type": "object", "properties": {…},
"required"?: […], "additionalProperties"?: false, "description"?}`.

- 1 to 16 properties, each named `^[a-z][a-z0-9_]{0,39}$` and not a key of `query.args`.
- Each property: `type` `string`, `integer`, `number` or `boolean` (with `enum`, `maxLength`, `description`),
  or `array` of one of those (`items`, `maxItems` a positive integer). No other keys; no nested arrays.
- `required` names only declared properties. The schema is at most 4096 bytes.

An instance's params are checked against it when made or changed (unknown keys, wrong types, missing required
keys: `invalid_args`), at most 4096 bytes. A routine without `params` takes `{}`.

### 19.3 Triggers and consent

- `schedule` runs every `every_s` (the instance's own, 60 to 86400, or the routine's).
- `webhook` runs when the instance's secret URL is called. A body `{"items": [{"id": …}, …]}` (at most 100,
  string ids) supplies the items and skips the query; any other body is one normal run. _Host behaviour:_ the
  host keeps only the secret's SHA-256, limits calls to 10 a minute per instance, and answers `202`, `404`
  (unknown, a schedule instance or a wrong secret, alike), `409` (paused), `429` or `400`.
- The person approves a routine's `reads` once. An instance whose routine has `writes`, or reads the person has
  not approved, starts `pending` with a consent card in the chat ("Enable <name> here? It may change <plugin>
  data without asking: <writes>. It reads <plugin>: <tools>."); only the person's Enable switches it on. The
  agent can list, create, update, run and delete instances, but every instance that needs consent waits for
  the card. A routine's own turn gets none of these tools.

## 20. Accounts

A package may declare accounts its plugin needs, such as a Google account. The host signs the person in, keeps
the tokens and pushes the access token to the plugin. Tokens never reach the model, the chat, a log or an app.

### 20.1 Declaring

`buwiz.accounts`: at most 8 objects.

| Field      | Req | Rule                                                                                                                        |
| ---------- | --- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`       | yes | Account id grammar, unique.                                                                                                 |
| `provider` | yes | `google`, or `oauth:<issuer URL>` (https). `buwiz` is reserved for the Buwiz account and refused for now (`not_supported`). |
| `label`    | yes | 1 to 60 characters: what the person signs in to ("Google account").                                                         |
| `scopes`   | no  | At most 16 scope strings, each 1 to 512 characters with no whitespace.                                                      |
| `required` | no  | Boolean, default false. Offered on the install card ("Sign in after install"); the plugin installs without it.              |

### 20.2 Providers and sign-in

Each account may be signed in several times under different labels (default `default`). Sign-in is OAuth 2.0
with PKCE S256 in the system browser and a loopback redirect.

| Provider         | Flow                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google`         | Google's endpoints; scopes plus `openid` and `email`; `access_type=offline`, `prompt=consent`. The client is the person's shared Google client from the host's setup; without one sign-in answers `needs_setup` ("Add your Google client in Setup").     |
| `oauth:<issuer>` | RFC 8414 metadata of the issuer itself (its `issuer` must match, `code` and PKCE `S256` supported), then RFC 7591 registration for the redirect (`token_endpoint_auth_method: "none"`), per sign-in. An issuer that fails these is `plugin_unavailable`. |

The subject shown is the ID token's `email`, else its `sub`. Account states: `none`, `connected`, `expired`.

### 20.3 Pushed tokens

The host pushes; the plugin never asks. The plugin learns account state only from these calls.

`buwiz.account.set`, after provision for each connected account, after each sign-in and after each refresh:

```json
{
  "account": "google",
  "label": "default",
  "provider": "google",
  "subject": "user@example.com",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "access_token": "<token>",
  "token_type": "Bearer",
  "expires_at": 1793525000
}
```

`expires_at` is unix seconds. The refresh token is never sent. Answer: `{"ok": true}`.

`buwiz.account.clear`, after sign-out, removal or a failed refresh: `{"account": "google", "label":
"default"}`. Answer: `{"ok": true}`.

- While the plugin runs the host refreshes each connected account 5 minutes before `expires_at` and pushes
  again. At spawn an account within 5 minutes of expiry is refreshed first. A failed refresh sets `expired`,
  pushes `clear` and shows "Needs sign-in".
- A plugin that declares accounts MUST answer both tools; `-32601` from either stops the plugin with
  `plugin_invalid`. A refusal is logged and does not stop it.
- The plugin keeps tokens in memory only and MUST NOT log them.

### 20.4 `account_required`

A tool that needs an account it does not hold answers `isError: true` with `structuredContent` (or first text)
`{"code": "account_required", "account": "<account id>"}`. When the account is one the package declares, the
host posts one pending sign-in card per chat and account, and tells the model the person must sign in first and
that it cannot sign in for them. Through the bridge the same answer rejects `tool_error`.

## 21. Storage

`buwiz.storage` (with `permissions.storage`) is a private key-value store per app, keyed by plugin id and app
id, owned by the host. The app never names a path.

| Method            | Rule                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(key)`        | The value or `null`.                                                                                                                                                                     |
| `set(key, value)` | Key 1 to 128 characters of `^[A-Za-z0-9._:-]+$` (else `invalid_args`); value a string (else `invalid_args`) of at most 64 KiB (else `quota_exceeded`). Over the quota: `quota_exceeded`. |
| `remove(key)`     |                                                                                                                                                                                          |
| `keys()`          | At most 1000 keys.                                                                                                                                                                       |

Calls run in order per open. Storage survives updates and restarts, stays on the computer (not synced, never
sent to the plugin), and is deleted on uninstall.

## 22. Errors, timeouts and restarts

### 22.1 Codes

Bridge and host-call rejections carry `{code, message, retryable, details?}`; `message` is at most 500
characters.

| Code                                                    | Retryable | Meaning                                                                        |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `permission_denied`                                     | no        | Not in the app's permissions.                                                  |
| `not_declared`                                          | no        | Target not declared (an unknown app, a tool outside `tools` for a preview).    |
| `invalid_args`                                          | no        | Malformed arguments, props failing validation, a downgrade without the choice. |
| `not_found`                                             | no        | No such tool, app, plugin or account.                                          |
| `disabled`                                              | no        | The person switched the tool off.                                              |
| `consent_declined`                                      | no        | The person said no, or an update adds permissions not approved.                |
| `no_chat`                                               | no        | Needs a chat.                                                                  |
| `quota_exceeded`                                        | no        | Storage quota, a storage value, or a file's size.                              |
| `rate_limited`                                          | yes       | Too many calls.                                                                |
| `timeout`                                               | yes       | The time limit passed.                                                         |
| `tool_error`                                            | no        | The tool answered `isError`.                                                   |
| `result_too_large`                                      | no        | Over the result limit.                                                         |
| `plugin_unavailable`                                    | yes       | Not running, or a provider unreachable.                                        |
| `plugin_restarted`                                      | yes       | The plugin restarted during or since the open.                                 |
| `session_invalid`, `bad_signature`, `stale`, `replayed` | no        | Signing failures (section 14.2): a host fault or a clock problem.              |
| `closed`                                                | no        | The open is gone.                                                              |
| `not_supported`                                         | no        | Not in this host, not this platform, or reserved.                              |
| `needs_setup`                                           | no        | A provider needs host setup first.                                             |
| `internal`                                              | yes       | A host fault.                                                                  |

Plugin states and their codes (shown on the plugin's page, not bridge rejections):

| Code                   | Meaning                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_invalid`     | The manifest or package failed parsing, grammar, limits, trust or signature, or the plugin serves a manifest other than the one reviewed. |
| `manifest_changed`     | The manifest changed without a version change.                                                                                            |
| `update_available`     | The plugin serves a newer version than installed; it waits for the person.                                                                |
| `protocol_unsupported` | The plugin's protocol is not this host's (section 3.3).                                                                                   |
| `plugin_bad_signature` | A session certificate failed verification.                                                                                                |
| `plugin_invalid`       | A required reserved tool is missing or broken, or the plugin wrote its key to stderr.                                                     |
| `fingerprint_mismatch` | A TSX app's source does not match its fingerprint.                                                                                        |
| `unsupported_import`   | A TSX app imports outside section 11.2.                                                                                                   |
| `failed`               | Restarted too often.                                                                                                                      |

Tool-result code: `account_required` (section 20.4).

### 22.2 Timeouts

| Operation                                             | Limit                        |
| ----------------------------------------------------- | ---------------------------- |
| Bridge call, host side                                | 30 s                         |
| Broker to plugin `tools/call`                         | 120 s, then MCP cancellation |
| Resolve tool                                          | 10 s                         |
| Each reserved tool                                    | 5 s                          |
| App load / one JS call                                | 10 s / 2 s                   |
| A hung plugin's answer to a ping after a cancellation | 5 s, then it is restarted    |

### 22.3 Crash and restart

| Event                                  | Behaviour                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The process exits or its stdout closes | State `restarting`; calls in flight fail `plugin_restarted`.                                                                               |
| Restart                                | Backoff 1, 2, 4, 8, 16, 32, 60 s (the cap). Each spawn passes the gate (section 9.1). A new generation; the old generation's sessions end. |
| Repeated crashes                       | After 6 restarts in 10 minutes the state is `failed` ("restarted 6 times in 10 minutes"), with Retry. No further automatic restart.        |
| A verification failure                 | `failed` with its code. No restart loop.                                                                                                   |

The plugin's stderr goes to its log (5 MiB, one rotation), never to the person.

## 23. Security requirements

### 23.1 What the host guarantees

| #   | Guarantee                                                                                       | Section  |
| --- | ----------------------------------------------------------------------------------------------- | -------- |
| H1  | An app reaches only the bridge: no network, files, processes or engine storage.                 | 11.2, 12 |
| H2  | Bridge calls stay within the app's declared tools, targets, files and storage.                  | 12, 13   |
| H3  | Every bridge call is signed by a key the app cannot read and checked before the plugin sees it. | 5.5, 14  |
| H4  | Calls from other processes or web pages are refused (no valid signature).                       | 14.2     |
| H5  | Replayed and stale calls are refused.                                                           | 14.3     |
| H6  | A tool switched off stays off for the agent, apps, resolves and routines.                       | 14.5     |
| H7  | A TSX app's code is the code the publisher signed.                                              | 11.2     |
| H8  | Nothing opens an app or a URL without the consent of section 17.                                | 17       |
| H9  | Only approved plugins' text reaches the model, capped and labelled.                             | 18.3     |
| H10 | Links, pins and attachments carry tickets, not raw identifiers.                                 | 15       |
| H11 | A plugin failure does not take the host down.                                                   | 22.3     |
| H12 | Uninstall leaves no key, account, file, pin, attachment or storage behind.                      | 9.6      |
| H13 | A preview document is static and never handed to the app.                                       | 13.5     |
| H14 | Account tokens reach only the plugin, never the model, chat, logs or apps.                      | 20       |

### 23.2 What the plugin MUST do

| #   | Requirement                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Authorize every subject, not only the app: for each ticket or identifier argument, check it is one this caller may use (`buwiz/caller`).                                                                             |
| P2  | Issue tickets as random values and keep the subject map on the plugin's side.                                                                                                                                        |
| P3  | Return only a title from `buwiz.ticket.resolve`.                                                                                                                                                                     |
| P4  | Never log the plugin key, an account token, a subject, tool arguments or `buwiz.provision`'s content.                                                                                                                |
| P5  | Keep side effects (filing, sending, paying) behind an explicit argument or confirmation the model cannot supply alone.                                                                                               |
| P6  | No side effects for `origin: "resolve"` or `"routine"`. In a routine's turn allow a write only when the routine lists it in `writes`, only within the instance's params, and only on evidence the routine was given. |
| P7  | Answer `buwiz.provision` before any other tool; refuse every other tool until it succeeds.                                                                                                                           |
| P8  | Mark read-only tools `readOnlyHint: true`, and only those.                                                                                                                                                           |
| P9  | Keep model text within the caps of section 18.3 and never tell the model to bypass consent.                                                                                                                          |
| P10 | Do not read the host's files or environment, or other plugins' data.                                                                                                                                                 |
| P11 | Keep user-facing messages free of subject data.                                                                                                                                                                      |

## 24. Limits

| Item                                                | Limit                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Manifest                                            | 256 KiB                                                                                   |
| `plugin.json`                                       | 1 MiB                                                                                     |
| Release index, release manifest                     | 1 MiB each                                                                                |
| Package files / one binary                          | 256 files, 50 MiB together / 200 MiB                                                      |
| Install path / asset name                           | 256 / 100 characters                                                                      |
| TSX app source                                      | 512 KiB                                                                                   |
| Plugin id / short / version                         | 255 / 2 to 16 / 32 characters                                                             |
| Tool name                                           | 63 characters                                                                             |
| Title / description                                 | 60 / 300 characters                                                                       |
| Publisher name                                      | 80 characters                                                                             |
| Icon URI                                            | 2048 characters                                                                           |
| Commands / scopes / routines / apps                 | 32 / 16 / 8 / 16                                                                          |
| Command description / args                          | 200 / 120 characters                                                                      |
| Scope description / hint                            | 120 / 1500 characters                                                                     |
| Routine name / description / prompt / `query.field` | 80 / 300 / 4000 / 64 characters                                                           |
| Routine `every_s`                                   | 60 to 86400 s                                                                             |
| Routine `reads` / `writes`                          | 4 entries and 8 tools / 8 tools                                                           |
| Routine `params`                                    | 16 properties, 4096 bytes; webhook 100 items, 10 calls a minute                           |
| Routine seen ids                                    | 1000 per instance                                                                         |
| `permissions.tools`                                 | 64                                                                                        |
| `permissions.open.apps` / `external`                | 16 / 8                                                                                    |
| `permissions.attach`                                | 16                                                                                        |
| `permissions.pick_file` extensions / `max_bytes`    | 16 / 50 MiB                                                                               |
| `permissions.storage.quota_bytes`                   | 10 MiB (default 1 MiB)                                                                    |
| `permissions.preview.max_bytes`                     | 8 MiB (default 8 MiB)                                                                     |
| Props                                               | 8 KiB, depth 8, 100 array items                                                           |
| Props schema                                        | 16 properties per object, `maxLength` 512, depth 8                                        |
| Inline width / height                               | 240 to 960 / 96 to 800 points                                                             |
| Inline `min_height` / `max_height`                  | 96 to `height` / `height` to 800; default 120 / 640                                       |
| Inline reveal hold                                  | 1.5 s; 3 s with `wait_ready`                                                              |
| `buwiz.fit`                                         | 8 heights a second per open; changes under 2 points ignored                               |
| `buwiz.actions`                                     | 3; id 64 characters `[A-Za-z0-9_.:-]`; label 24 characters; one primary                   |
| `buwiz.meta` / `buwiz.settle`                       | 32 / 120 characters, one line                                                             |
| `buwiz.call` args / result                          | 256 KiB / 1 MiB                                                                           |
| `buwiz.preview` document / title                    | `max_bytes` (at most 8 MiB) / 120 characters                                              |
| `buwiz.copy` text                                   | 1 MiB                                                                                     |
| `buwiz.open` URL                                    | 2048 characters                                                                           |
| Calls in flight / new calls a second, per open      | 8 / 20                                                                                    |
| Nonce window                                        | 5 minutes, 10,000 per open                                                                |
| Clock skew                                          | 60 s                                                                                      |
| Session certificate                                 | 8 hours                                                                                   |
| Pre-opened session                                  | 60 s unused                                                                               |
| Storage key / value / keys                          | 128 characters / 64 KiB / 1000                                                            |
| Resolve choices                                     | 20; label 80, detail 160, value 512 characters                                            |
| Resolve open / token title, error message           | 60 / 200 characters                                                                       |
| Resolve `prompt`                                    | 4000 characters, commands only                                                            |
| Ticket title                                        | 120 characters                                                                            |
| `buwiz/suggest`                                     | 3; label 40, prompt 200 characters                                                        |
| Answer cards per answer                             | 1 main, 2 small; chips after 5 messages                                                   |
| Error message                                       | 500 characters                                                                            |
| Link / props in a link                              | 2048 characters / 1024 bytes                                                              |
| Accounts                                            | 8 per package; label 60 characters; 16 scopes of 512 characters                           |
| Account refresh                                     | 5 minutes before expiry                                                                   |
| Timeouts                                            | bridge 30 s, broker 120 s, resolve 10 s, reserved 5 s, load 10 s, JS call 2 s             |
| App heap / stack                                    | 256 MB / 4 MB                                                                             |
| Restarts                                            | backoff 1 to 60 s; 6 in 10 minutes, then `failed`                                         |
| Plugin log                                          | 5 MiB, one rotation                                                                       |
| Model text                                          | tool description 1024, instructions 4000, scope hint 1500, routine prompt 4000 characters |

---

## Appendix A. Example manifest

The manifest of a notes plugin. Fingerprints and the signature are placeholders: the signer fills them.

```json
{
  "protocol": "1.0.0",
  "id": "app.buwiz.notes",
  "short": "notes",
  "version": "1.2.0",
  "title": "Notes",
  "description": "Notes and folders, in the chat and full screen.",
  "publisher": { "id": "app.buwiz", "key_id": "gc-2026-01", "name": "Buwiz" },
  "commands": [
    { "name": "note", "args": "[folder]", "description": "Open a folder of notes", "resolve": "notes_resolve" },
    { "name": "draft", "description": "Start a note from a template", "resolve": "notes_resolve" }
  ],
  "scopes": [
    {
      "name": "folder",
      "description": "Folder of notes",
      "resolve": "notes_resolve",
      "attach": true,
      "hint": "When a folder is attached, notes_list and notes_add default to it."
    }
  ],
  "routines": [
    {
      "id": "inbox-notes",
      "name": "Notes from mail",
      "description": "Turns mail labelled 'note' into notes.",
      "every_s": 900,
      "query": { "tool": "notes_mail_query", "field": "query" },
      "params": {
        "type": "object",
        "properties": { "folder": { "type": "string", "maxLength": 40, "description": "Folder ticket" } },
        "required": ["folder"],
        "additionalProperties": false
      },
      "prompt": "Make one note from this message in the given folder. Keep the subject as its title.",
      "reads": [{ "plugin": "app.buwiz.google-workspace", "tools": ["gws_search_mail", "gws_read_mail"] }],
      "writes": ["notes_add"]
    }
  ],
  "apps": [
    {
      "id": "board",
      "title": "Notes board",
      "description": "Every note in a folder.",
      "entry": "buwiz-app://board",
      "mime": "text/x-nsh-tsx",
      "sdk": "1",
      "fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "props": {
        "type": "object",
        "properties": { "ticket": { "type": "string", "maxLength": 30 }, "view": { "enum": ["list", "grid"] } }
      },
      "placement": ["full", "inline"],
      "inline": { "width": 480, "height": 240, "min_height": 120, "max_height": 560, "wait_ready": true },
      "permissions": {
        "tools": ["notes_list", "notes_add", "notes_print"],
        "open": { "apps": ["editor"], "external": ["https://example.com"] },
        "attach": ["folder"],
        "pick_file": { "extensions": [".md", ".txt"], "max_bytes": 1048576, "multiple": true },
        "storage": { "quota_bytes": 262144 },
        "copy": true,
        "preview": {}
      }
    },
    {
      "id": "editor",
      "title": "Note",
      "description": "Edit one note.",
      "entry": "buwiz-app://editor",
      "mime": "text/x-nsh-tsx",
      "sdk": "1",
      "fingerprint": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "props": { "type": "object", "properties": { "ticket": { "type": "string" } }, "required": ["ticket"] },
      "placement": ["full"],
      "permissions": { "tools": ["notes_get", "notes_save"] }
    }
  ],
  "signature": { "alg": "ed25519", "key_id": "gc-2026-01", "value": "<86 characters of base64url>" }
}
```

## Appendix B. Example plugin.json

The same plugin as a package with one Google account and one skill. Hashes and the signature are placeholders.

```json
{
  "name": "notes",
  "version": "1.2.0",
  "description": "Notes and folders for Buwiz Bot",
  "author": { "name": "Buwiz" },
  "license": "Apache-2.0",
  "mcpServers": {
    "notes": {
      "command": "${PLUGIN_ROOT}/bin/notes-mini-app",
      "args": ["mcp"],
      "env": { "BUWIZ_PLUGIN_MANIFEST": "${PLUGIN_ROOT}/app.buwiz.notes.manifest.json" }
    }
  },
  "skills": ["skills/"],
  "buwiz": {
    "protocol": "1.0.0",
    "id": "app.buwiz.notes",
    "short": "notes",
    "version": "1.2.0",
    "server": "notes",
    "accounts": [
      { "id": "google", "provider": "google", "label": "Google account", "scopes": ["https://www.googleapis.com/auth/drive.file"], "required": false }
    ],
    "files": {
      "app.buwiz.notes.manifest.json": { "asset": "app.buwiz.notes.manifest.json", "sha256": "<64 hex>" },
      "skills/weekly-review/SKILL.md": { "asset": "skills.weekly-review.SKILL.md", "sha256": "<64 hex>" }
    },
    "binaries": {
      "macos-aarch64": { "path": "bin/notes-mini-app", "asset": "notes-mini-app-macos-aarch64", "sha256": "<64 hex>" },
      "linux-x86_64": { "path": "bin/notes-mini-app", "asset": "notes-mini-app-linux-x86_64", "sha256": "<64 hex>" }
    },
    "publisher": { "id": "app.buwiz", "key_id": "gc-2026-01" },
    "signature": { "alg": "ed25519", "key_id": "gc-2026-01", "value": "<86 characters of base64url>" }
  }
}
```
