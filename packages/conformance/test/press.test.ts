// The host's rule for a call the person did not make (spec 16.5): which press
// records it passes on, and when a write reaches a tool.
import { expect, test } from "bun:test";
import { argsHash, hostResult, mayReach, mayUseAccount, originOf, pressOf, pressOptedIn, withoutAccountUse } from "../src/v1/sessions.mjs";

const ARGS = { folder: "work", n: 1 };
const approved = (args: unknown = ARGS) => ({
  by: "ai_approved",
  who: "agent.example",
  approved_by: "person.example",
  once: "press-0123456789abcdef",
  args_hash: argsHash(args),
  shown_hash: `sha256:${"0".repeat(64)}`,
  at: 1793000000000,
});
const read = { name: "notes_list", annotations: { readOnlyHint: true } };
const write = { name: "notes_add" };
const open = { name: "notes_add", _meta: { "buwiz/audience": ["agent"] } };
const opted = { name: "notes_post", _meta: { "buwiz/press": { approved: true, effect: "post", describe: "notes_describe" } } };

test("a press record passes only in one of the two shapes, and never on the person's call", () => {
  const ai = { by: "ai", who: "agent.example" };
  expect(pressOf("agent", ai)).toEqual(ai);
  expect(pressOf("agent", approved())).toEqual(approved());
  expect(pressOf("person", ai)).toBeUndefined();
  const { at: _at, ...short } = approved();
  for (const bad of [null, "ai", [], { by: "ai" }, { ...ai, more: 1 }, { by: "person", who: "person.example" }, short]) {
    expect(pressOf("agent", bad)).toBeUndefined();
  }
  for (const field of [{ at: 1.5 }, { at: -1 }, { at: 2 ** 53 }, { args_hash: "sha256:00" }, { shown_hash: "0".repeat(64) }, { once: "x" }]) {
    expect(pressOf("agent", { ...approved(), ...field })).toBeUndefined();
  }
});

test("a write that is not the person's reaches a tool open to agents, or an opted-in one with a yes to these arguments", () => {
  expect(originOf("person", write)).toBe("app");
  expect(originOf("agent", read)).toBe("app");
  expect(originOf("agent", write)).toBe("agent");
  expect(originOf(undefined, write)).toBe("agent");
  // the person's calls and reads always pass
  expect(mayReach("person", write, undefined, ARGS)).toBe(true);
  expect(mayReach("agent", read, undefined, ARGS)).toBe(true);
  // a write: not without an audience of agent or an opt-in
  expect(mayReach("agent", write, approved(), ARGS)).toBe(false);
  expect(mayReach("agent", open, undefined, ARGS)).toBe(true);
  // opted in: only with the person's yes, and only to the arguments it was given for
  expect(mayReach("agent", opted, approved(), ARGS)).toBe(true);
  expect(mayReach("agent", opted, { by: "ai", who: "agent.example" }, ARGS)).toBe(false);
  expect(mayReach("agent", opted, undefined, ARGS)).toBe(false);
  expect(mayReach("agent", opted, approved(), { ...ARGS, n: 2 })).toBe(false);
  // key order does not change what was approved
  expect(mayReach("agent", opted, approved({ n: 1, folder: "work" }), ARGS)).toBe(true);
});

test("a tool opts in only with approved true, an effect of post or close, and a name with none of the words", () => {
  const press = { approved: true, effect: "post" };
  const tool = (name: string, meta: unknown = press) => ({ name, _meta: { "buwiz/press": meta } });
  expect(pressOptedIn(tool("notes_post"))).toBe(true);
  expect(pressOptedIn(tool("notes_close", { approved: true, effect: "close" }))).toBe(true);
  for (const meta of [null, { effect: "post" }, { approved: "true", effect: "post" }, { approved: true }, { approved: true, effect: "file" }]) {
    expect(pressOptedIn(tool("notes_post", meta))).toBe(false);
  }
  for (const name of ["ledger_pay_run", "tax_file", "tax_filing_start", "mail_send", "Queue.add", "bill_paid", "entry_void", "period_reopen", "form-submit"]) {
    expect(pressOptedIn(tool(name))).toBe(false);
  }
  // the letters count anywhere in the name
  for (const name of [
    "ledger_payment_create",
    "filed_report",
    "submitted_form",
    "sends_reminder",
    "sendmail_draft",
    "mail_resend",
    "job_enqueue",
    "note_sent",
    "profile_update",
    "avoid_x",
    "Reopened",
  ]) {
    expect(pressOptedIn(tool(name))).toBe(false);
  }
  for (const name of ["books_app_post_entry", "books_app_month_close", "books_app_batch", "books_entry_draft"]) {
    expect(pressOptedIn(tool(name))).toBe(true);
  }
});

test("an audience that is not an array opens a write to nobody", () => {
  for (const audience of ["agent", "app", { agent: true }, 1, true, null, ["app"], []]) {
    expect(mayReach("agent", { name: "notes_add", _meta: { "buwiz/audience": audience } }, undefined, ARGS)).toBe(false);
  }
});

test("a result that asks for an account switch keeps everything else and drops the switch when the caller may not", () => {
  const use = { account: "google", label: "work" };
  const r = { content: [], _meta: { "buwiz/account_use": use, "buwiz/save": { a: 1 }, "buwiz/open": {} } };
  expect(mayUseAccount("person", true)).toBe(true);
  for (const [actor, firstParty] of [
    ["agent", true],
    ["routine", true],
    ["person", false],
    [undefined, true],
  ] as const) {
    expect(mayUseAccount(actor, firstParty)).toBe(false);
  }
  expect(withoutAccountUse(hostResult(r))).toEqual({ content: [], _meta: { "buwiz/save": { a: 1 } } });
  expect(withoutAccountUse(hostResult({ content: [], _meta: { "buwiz/account_use": use } }))).toEqual({ content: [] });
  expect(withoutAccountUse(hostResult({ content: [] }))).toEqual({ content: [] });
  expect(hostResult(r)._meta["buwiz/account_use"]).toEqual(use);
});
