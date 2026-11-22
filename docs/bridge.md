# The bridge: `buwiz` in an app

An app imports the bridge with `import { buwiz } from "buwiz"` (it is also the
global `buwiz`). Its methods are implemented by Buwiz Bot; the app reaches nothing
else: no `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage` or
`sessionStorage`, and imports only from `nsh`, `nsh/base` and `buwiz` (spec
11.2). The module's **default export** is the component Buwiz Bot mounts.

A method whose permission the manifest does not grant is **absent**
(`undefined`), not present and failing (spec 12). Test for it if an
app is shared between manifests: `if (buwiz.copy) …`.

## Methods

| Member                                           | Permission      | Returns                                                                                                                                               | Rejects with                                                                                                                                                                  | Spec       |
| ------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `buwiz.props`                                    | always          | The open's props, validated against `apps[].props`; read-only                                                                                         |                                                                                                                                                                               | 11.5       |
| `buwiz.app`                                      | always          | `{plugin, app, version, fingerprint, protocol, sdk}`                                                                                                  |                                                                                                                                                                               | 13.1       |
| `buwiz.viewport`                                 | always          | Signal of `{width, height, placement: "full" \| "inline"}`                                                                                            |                                                                                                                                                                               | 13.1, 13.7 |
| `buwiz.fit(height)`                              | always          | Inline: Buwiz Bot sizes your card to `height` (points) within `inline.min_height`..`max_height`; full screen: ignored. Returns nothing                | throws `invalid_args` for a height that is not a number above 0                                                                                                               | 6.9, 13.4  |
| `buwiz.actions(list)`, `buwiz.onAction(handler)` | always          | Inline: Buwiz Bot draws up to 3 footer buttons under your card; a press calls your handler with the button's `id`. Full screen: checked, then ignored | `invalid_args`                                                                                                                                                                | 13.6       |
| `buwiz.meta({text, pill?})`                      | always          | Inline: a short status in your card's header (`null` removes it). Full screen: ignored                                                                | `invalid_args`                                                                                                                                                                | 13.6       |
| `buwiz.settle(text)`                             | always          | Inline: the card collapses to one outcome line and your app unmounts. Full screen: ignored                                                            | `invalid_args`                                                                                                                                                                | 13.6       |
| `buwiz.ticket.title(ticket)`                     | always          | The ticket's title, or `null`                                                                                                                         | `rate_limited`                                                                                                                                                                | 13.3       |
| `buwiz.call(tool, args?)`                        | `tools`         | `structuredContent`, else the text contents joined with `\n`                                                                                          | `permission_denied`, `disabled`, `not_found`, `invalid_args`, `tool_error`, `result_too_large`, `timeout`, `rate_limited`, `plugin_unavailable`, `plugin_restarted`, `closed` | 13.2       |
| `buwiz.open({app, props?, ticket?})`             | `open.apps`     | Pushes your app on the full-screen stack; no prompt                                                                                                   | `permission_denied`, `not_declared`, `invalid_args`                                                                                                                           | 13.5       |
| `buwiz.open({url})`                              | `open.external` | Opens an `https` URL of a listed origin after the user agrees                                                                                         | `permission_denied`, `consent_declined`, `not_supported`                                                                                                                      | 13.5, 17   |
| `buwiz.attach(scope, value)`                     | `attach`        | `{token, title, attached}` after "Attach … to this chat?"                                                                                             | `permission_denied`, `consent_declined`, `no_chat`                                                                                                                            | 13.5       |
| `buwiz.pickFile({extensions?, multiple?})`       | `pick_file`     | `[{name, size, type, read()}]`, never a path; `[]` on cancel                                                                                          | `permission_denied`, `quota_exceeded`, `closed` (from `read()` after close)                                                                                                   | 13.5       |
| `buwiz.storage.get/set/remove/keys`              | `storage`       | Strings; private to this app                                                                                                                          | `quota_exceeded`, `invalid_args`                                                                                                                                              | 21         |
| `buwiz.copy(text)`                               | `copy`          | Copies to the clipboard                                                                                                                               |                                                                                                                                                                               | 13.5       |
| `buwiz.preview({tool, args?, title?})`           | `preview`       | Shows the document `tool` makes over the app, with Print and Close; resolves once shown                                                               | `not_declared`, `invalid_args`, `tool_error`, `result_too_large`, `not_supported`, and `buwiz.call`'s                                                                         | 13.5       |

Every rejection is a `BuwizError {code, retryable, message, details?}`
(spec 22.1). Retryable: `rate_limited`, `timeout`, `plugin_unavailable`,
`plugin_restarted`, `internal`. A tool result with `isError: true` rejects
with `tool_error` and the first text content (at most 500 chars) as
`message`, so put the user-facing sentence first.

```tsx
import { signal, Text } from "nsh";
import { buwiz } from "buwiz";

export default function Status() {
  const line = signal("…");

  buwiz.call("hello_greet", { ticket: buwiz.props.ticket }).then(
    (r) => line.set(String(r.greeting)),
    (e) => line.set(e.retryable ? "Busy, try again" : `Could not load (${e.code})`),
  );

  return <Text>{line()}</Text>;
}
```

## Print preview: `buwiz.preview`

`buwiz.preview({tool, args?, title?})` asks Buwiz Bot to call `tool` (one of the
app's own `permissions.tools`; another name rejects `not_declared`) with
`args`, as the app, and show the document it returns full screen over the
app: a title bar with `title` (else the result's `structuredContent.title`,
else the app's title), **Print** (the macOS print panel, which also saves a
PDF) and **Close**. The document never passes through the app, so it may
be larger than a `buwiz.call` result: up to `permissions.preview.max_bytes`
(8 MiB at most). The call is signed and checked like `buwiz.call`; its
envelope carries `"purpose": "preview"`, which the broker accepts only from
an app with `preview`.

The tool returns the page as an MCP embedded resource:

```json
{
  "content": [{ "type": "resource", "resource": { "uri": "my://print/1601C.html", "mimeType": "text/html", "text": "<!DOCTYPE html>…" } }],
  "structuredContent": { "title": "Form 1601C — Dela Cruz Jane" }
}
```

Make the page **static**: Buwiz Bot renders it with JavaScript off, no base URL
and a policy that loads nothing (no network, no files; inline `<style>` and
`data:` images, fonts and objects, such as an embedded PDF, only), and it does not follow links or navigate.
A result without a `text/html` resource rejects `tool_error`; `isError`
rejects `tool_error` with its first text; a larger page `result_too_large`.
Buwiz Bot on other platforms rejects `not_supported`.

```tsx
if (buwiz.preview) await buwiz.preview({ tool: "acme_print_page", args: { ticket: buwiz.props.ticket } });
```

## Inline cards that fit their content: `buwiz.fit`

An inline app's card starts at `inline.height` and then takes whatever height
the app reports with `buwiz.fit(height)`, clamped to `inline.min_height` ..
`inline.max_height` ([manifest](manifest.md); default 120 .. 640). Report
what the content needs, not the frame you were given (an app that reports
its frame never grows), and report again when it changes: a status line, an
error message or a button that appears should grow the card, not scroll it.
Keep a `Scroll` only for content that can outgrow `max_height` (a list).

```tsx
import { View, Scroll } from "nsh";
import { buwiz } from "buwiz";

let sent = 0;
const fit = (e: any) => {
  const h = Math.ceil(e.bounds.size.height);
  if (Math.abs(h - sent) >= 1 && buwiz.fit) buwiz.fit((sent = h));
};

export default function Card() {
  // the content's own height: this view is not stretched to the frame
  return (
    <View class="p-3 gap-2" onLayout={fit}>
      {/* … */}
    </View>
  );
}
```

A body that scrolls past `max_height` reports the column's height with the
body's full height in place of the part the scroll shows. Buwiz Bot ignores changes under 2 points and sends at most 8 heights a
second per open, the last always landing; `buwiz.fit` needs no permission
(it sizes only your own frame) and does nothing full screen. Check for it
(`buwiz.fit &&`) if the app may run on an older Buwiz Bot.

## Cards that look like Buwiz Bot's: `buwiz.actions`, `buwiz.meta`, `buwiz.settle`

Spec 13.6. An inline card can hand Buwiz Bot its chrome
instead of drawing it, so it looks like Buwiz Bot's own cards (an approval card's
buttons, its settled line):

- `buwiz.actions([{id, label, primary?, disabled?}])`: footer buttons under
  the app, drawn by Buwiz Bot as 28-point pills, right-aligned, the primary first.
  At most 3; `id` 1 to 64 of `A-Z a-z 0-9 _ . : -`, unique; `label` one line
  of 1 to 24 characters; at most one `primary`. `[]` removes them; each call
  replaces the list. A press of an enabled button calls every
  `buwiz.onAction(handler)` with its `id` (`onAction` returns a function that
  removes the handler). The press does nothing else: do the work with your
  own tools (`buwiz.call`), and update the buttons (`disabled: true` while it
  runs).
- `buwiz.meta({text, pill?})`: a status after the card's title, one line of
  at most 32 characters, as dim text or (`pill: true`) a pill. `null`
  removes it.
- `buwiz.settle(text)`: when the card is done, it collapses to one line of at
  most 120 characters ("Marked paid · ₱12,000") and your app unmounts (its
  session closes). There is no undo.

A call outside these rules rejects `invalid_args` and changes nothing. Full
screen, each call is checked the same way, then ignored: draw your own
buttons there (`buwiz.viewport().placement` says which). They need no
permission.

```tsx
import { buwiz } from "buwiz";

const busy = (b: boolean) =>
  buwiz.actions([
    { id: "pay", label: "Mark paid", primary: true, disabled: b },
    { id: "later", label: "Later", disabled: b },
  ]);

buwiz.onAction(async (id) => {
  if (id === "later") return buwiz.settle("Snoozed until tomorrow");
  await busy(true);
  try {
    await buwiz.call("acme_mark_paid", { ticket: buwiz.props.ticket });
    await buwiz.settle("Marked paid");
  } catch (e) {
    await buwiz.meta({ text: "Could not mark it paid", pill: true });
    await busy(false);
  }
});
busy(false);
buwiz.meta({ text: "Due in 3 days", pill: true });
```

## A badge on a pin: `buwiz/badge`

A tool result may put a dot and up to 8 characters on the pins of one of your apps, so the person sees a
state without opening it (spec 16.4). Any result of one of your own tools may carry it, so a routine's query tool keeps it up to date
while the app is closed. Showing it asks the person for nothing.

Both libraries build the badge and check it as it is made: an app id, a dot of `red`, `amber`, `green` or `none`,
text of 1 to 8 characters with no hidden character (spec 4.2), its plain spaces (U+0020) trimmed from both ends (refused, never cut), a ticket of the
grammar, and something to show: a dot other than `none`, or text. A clear
removes it. The host reads it only from a result that did not fail, for your own apps, and strips it before
the model or an app sees the result.

```rust
use buwiz_plugin::{Badge, Dot, ok, with_badge};
use serde_json::json;

// a routine's query tool: the count of what is due, and the badge for the app's pins
fn notes_due(due: u32) -> serde_json::Value {
    let result = ok(json!({ "query": "due", "items": [] }));
    match due {
        0 => with_badge(result, &Badge::clear("board").unwrap()).unwrap(),
        // the count alone, capped at "99999+" (6 characters), so it always fits the 8 a badge allows
        n => {
            let text = if n > 99_999 { "99999+".to_owned() } else { n.to_string() };
            with_badge(result, &Badge::new("board", Some(Dot::Amber), Some(&text)).unwrap()).unwrap()
        }
    }
}
```

```ts
import { badge, clearBadge, ok, withBadge } from "@buwiz/sdk/plugin";

// a routine's query tool: the count of what is due, and the badge for the app's pins
const notesDue = (due: number) => {
  const result = ok({ query: "due", items: [] });
  // the count alone, capped at "99999+" (6 characters), so it always fits the 8 a badge allows
  const text = due > 99_999 ? "99999+" : String(due);
  return withBadge(result, due === 0 ? clearBadge("board") : badge("board", { dot: "amber", text }));
};
```

`with_badge` returns a `Result` in Rust and `withBadge` throws in TypeScript when the result's `_meta` is not an object.
`for_ticket(ticket)` in Rust and `ticket` in TypeScript narrow a badge, or a clear, to the pins that carry that ticket.
A pin with a ticket shows its own badge, else the one for the app. Keep the text to a state and a count: no
name, tax identification number, amount or ticket value (P12). A plugin on the Node template sets
`_meta["buwiz/badge"]` on its result itself.

## What your tool receives

A bridge call reaches your tool as `tools/call` with the arguments as sent and
`_meta["buwiz/caller"]` = `{origin, plugin, app, open_id, ts}`, and `press` when the AI made the call (spec 16.1, 16.6).
`origin` is `app` for bridge calls, `agent` for the model, `routine` for a
routine's query, `resolve` for resolve tools and `widget` for a generated widget
(`{origin, plugin, widget, ts}`; a tool is offered to widgets by naming `widget` in
`_meta["buwiz/audience"]`, spec 16.5). A bridge call made while the
agent, not the person, is driving your screen comes as `agent` too, unless the
tool has `readOnlyHint: true`: your screen's own reads keep working as `app`, and a
tool you keep for apps refuses its writes. A write reaches your tool only if the
tool's `_meta["buwiz/audience"]` names `agent`, or the tool opted in to the AI's
press as described below: Buwiz Bot holds back every other write, unsent, and
tells the person why. Each of these calls, reads included,
carries `press`, the record of the press: `{by: "ai", who}`. The host sets
`origin` and `press`; no app or plugin can claim either. So `origin: "app"`
with a `press` is your screen reading while the AI drives it, not the person's
own act, and `readOnlyHint` has to be true of the tool: nothing it does may
change anything.

A tool that names no `agent` can still take the AI's press, one press at a time,
if it opts in with `_meta["buwiz/press"] = {approved: true, effect: "post", describe: "<a read>"}`.
`effect` is `post` or `close`. Anything else, a tool with no `effect`, or a tool whose
name has a character outside a-z, 0-9, `_`, `.` and `-`, or contains file, filing, submit, send, sent, queue, pay,
paid, void or reopen after its first `_` (so `ledger_payment_create` has `pay`, and `sentry_post_note` has none), is refused: filing is never the AI's.
Buwiz Bot holds the call unsent and shows the person a card with Not now and Allow.
`describe` is a read of yours (`readOnlyHint: true`, and in the app's
`permissions.tools`): it gets `{tool, args}` and answers `structuredContent`
`{title, lines}`, what the call will do with its real values, covering every
argument the call uses. The title is 1 to 120 characters, there are 1 to 80
lines of 1 to 400 characters, and none holds a ticket or an invisible character.
A tool with no such read is refused, and the read should refuse an argument it
can't show. Only the person's own press of Allow lets the call go, and it
reaches you as `origin: "agent"` with `press` =
`{by: "ai_approved", who, approved_by, once, args_hash, shown_hash, at}`. Check
`args_hash` (`sha256:` over the arguments' JCS bytes) against the arguments you
got. A write open to agents can name `describe` alone, for the same card at Ask, and
a call allowed there carries the same record.

In a routine's turn the
model's calls to the routine's own plugin, and its query, also carry
`routine: "<routine id>"` ([manifest.md](manifest.md#routines-spec-67)). `startPlugin` passes it to
your `run(args, caller)` as `caller`. Use it to authorize (see
[security.md](security.md)).

To offer the user an app from a tool result, add
`_meta["buwiz/open"] = {app, props?, ticket?, title, placement?}` to the result
(spec 16.2). Buwiz Bot shows a card with Open or Show; it never opens by itself.
It is ignored on `isError` results and never reaches the model.

## Resolve tools

A command or scope names a resolve tool (spec 15.2). It receives
`{kind: "command" | "scope", name, value, complete, context: {attached}}` and
answers `structuredContent` with one `result`:

| `result`  | Fields                                                           | Caps                                                                                                    |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `choices` | `choices: [{label, detail?, value}]`; `value` should be a ticket | 20 choices; label 80, detail 160 chars                                                                  |
| `open`    | `app` (yours), `props?`, `ticket?`, `title`, `placement?`        | title 60 chars; props validate; no other plugin's app                                                   |
| `token`   | `ticket`, `title`                                                | title 60 chars; ticket `^tkt_[0-9A-HJKMNP-TV-Z]{26}$`                                                   |
| `prompt`  | `text`                                                           | commands only; at most 4000 chars, not only spaces and line breaks; refused (`plugin_invalid`), not cut |
| `error`   | `message`                                                        | 200 chars                                                                                               |

`prompt` is a starter flow: Buwiz Bot puts `text` in the message field for the
user to edit and send (after their own draft and a blank line, if they typed
one) and never sends it. Answer it for a command, for example a bare
`/draft`, with the text as the user would type it (tokens and line breaks
are kept).

```js
if (args.kind === "command" && !args.value) return ok({ result: "prompt", text: "Draft this month's update:\n- " });
```

An attachable scope must answer `token` for a value it offered as a choice:
`buwiz.attach` and the composer rely on it (spec 13.5, 15.1).

## Declaring who may use a tool

A tool says who may use it in its `tools/list` entry (spec 16.5, 16.6): `_meta["buwiz/audience"]`
is an array of words (`"agent"`, `"widget"`), and `_meta["buwiz/press"]` opts a write in to the
AI's press. Both libraries build the entry from the tool; `_meta` is shown as given, and the key
is left out when the tool has none.

The host offers a widget only the tools whose audience names `"widget"`. Both libraries check
it again: a call with `origin: "widget"` to any other tool is refused before the tool runs.

```rust
use buwiz_plugin::{PressEffect, Tool};

// `peek` is a read tool of the plugin; `notes_post` is a write the AI may press once allowed
let peek = Tool { name: "notes_peek", description: "Peek.", input_schema, read_only: true, meta: None }
    .with_audience(&["agent", "widget"]);
let post = Tool { name: "notes_post", description: "Post.", input_schema, read_only: false, ..Tool::default() }
    .with_press(PressEffect::Post, "notes_peek");
```

```ts
import { withAudience, withPress } from "@buwiz/sdk/plugin";

const peek = withAudience({ name: "notes_peek", description: "Peek.", inputSchema, readOnly: true }, ["agent", "widget"]);
const post = withPress({ name: "notes_post", description: "Post.", inputSchema, readOnly: false }, "post", "notes_peek");
```

`with_press` and `withPress` always write `approved: true`; the audience is always an array. Any
other `_meta` key goes in the tool's `meta` field in Rust and its `_meta` field in TypeScript. A
plugin on the Node template passes `_meta` on the tool object itself.

Naming `"agent"` on a tool that is not read-only does more than list it for the model: by
section 16.6 of the guide the AI's press on an app's screen may then run that write with no Allow
card. When the person should be asked each time, leave `"agent"` out and opt in with the press.

A plugin must not opt in a tool that files, submits, sends, pays, voids or reopens, whatever it is
called (P5, spec 16.6); the host's name rule is only a backstop. Both libraries fail closed on
the opt-in: `tools/list` leaves out a `buwiz/press` whose `describe` is empty or does not name a
read-only tool of the same list, lists the tool without it, and writes one line to stderr naming
the tool and the reason. A hand-written `_meta` gets the same check.

## Reserved tools (Buwiz Bot to your plugin)

`lib/buwiz-plugin.mjs` implements these; you only need them if you write your
own (spec 10). The host makes these calls with no `buwiz/caller`. Both libraries
and the helper refuse a reserved call that names one, so no caller can open a
session for itself.

| Tool                   | Input                                             | Answer                                                                                        |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `buwiz.provision`      | `{protocol, plugin, key: {alg, seed}, pub}`       | `{ok: true, manifest_sha256}`; idempotent for the same key; first, before any other tool      |
| `buwiz.session.open`   | `{app, open_id, ks_pub, perms_sha256, not_after}` | `{cert, cert_sig}`; `invalid_args` for an unknown app, a wrong digest or `not_after` past 8 h |
| `buwiz.session.close`  | `{open_id}`                                       | `{ok: true}`                                                                                  |
| `buwiz.ticket.resolve` | `{ticket}`                                        | `{valid: true, title}` or `{valid: false}`: never the subject                                 |
| `buwiz.uninstall`      | `{}`                                              | `{ok: true}` after deleting tickets and subjects                                              |
| any other `buwiz.*`    |                                                   | MCP error `-32601`                                                                            |

## Theme

Buwiz Bot renders your app in Buwiz Bot's own light or dark setting, not the OS's, and switches it live when the user changes it (spec 11.1). Give every color a `dark:` variant: `bg-white dark:bg-[#161616]`, `text-[#1c1c1c] dark:text-[#f5f5f5]`, `border-black/10 dark:border-white/10`. A color without one stays light in a dark Buwiz Bot. The template shows the pattern.

## Limits

| Item                                                       | Limit                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `buwiz.call` args                                          | 256 KiB serialized                                                              |
| `buwiz.call` result                                        | 1 MiB (structured plus text and embedded resources)                             |
| `buwiz.preview` document                                   | `permissions.preview.max_bytes`, at most 8 MiB                                  |
| Calls in flight per open                                   | 8 (the ninth waits)                                                             |
| New calls per second per open                              | 20 (more: `rate_limited`)                                                       |
| `buwiz.fit` heights per second per open                    | 8 (the last waits for a slot; under 2 points ignored)                           |
| `buwiz.actions`                                            | 3 buttons; id 64 chars `[A-Za-z0-9_.:-]`; label 24 chars, one line; one primary |
| `buwiz.meta` / `buwiz.settle`                              | 32 / 120 chars, one line                                                        |
| `buwiz/badge` text                                         | 8 chars, one line; one change a second per badge                                |
| Resolve `prompt` text                                      | 4000 chars, commands only                                                       |
| Bridge call timeout                                        | 30 s (host), 120 s (broker to plugin)                                           |
| Resolve timeout                                            | 10 s                                                                            |
| `buwiz.provision`, `buwiz.session.open`, `buwiz.uninstall` | 5 s each                                                                        |
| Session certificate                                        | 8 h at most                                                                     |
| Storage key / value / keys                                 | 128 chars `^[A-Za-z0-9._:-]+$` / 64 KiB / 1000                                  |
| Link                                                       | 2048 chars; props in a link 1024 bytes                                          |
| App source                                                 | 512 KiB                                                                         |
| App load / one JS call / heap / stack                      | 10 s / 2 s / 256 MB / 4 MB                                                      |

Section numbers such as spec 4.1 refer to the
[mini app protocol 1.0 specification](https://github.com/buwiz-app/buwiz-sdk/blob/main/docs/protocol-1.0.md).
