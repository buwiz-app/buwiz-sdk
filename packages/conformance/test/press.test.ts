// The host's rule for a call the person did not make (spec 16.5): which press
// records it passes on, and when a write reaches a tool.
import { expect, test } from "bun:test";
import {
  argsHash,
  audienceProblem,
  callAnswer,
  hostResult,
  mayReach,
  mayUseAccount,
  originOf,
  pressOf,
  pressOptedIn,
  pressProblem,
} from "../src/v1/sessions.mjs";

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
  // the letters count anywhere after the short name
  for (const name of [
    "ledger_payment_create",
    "notes_filed_report",
    "notes_submitted_form",
    "notes_sends_reminder",
    "mail_resend",
    "job_enqueue",
    "notes_sent",
    "notes_profile_update",
    "notes_avoid_x",
    "notes_Reopened",
    "sendmail",
    "sentry_send_note",
    "notes_payment_create",
  ]) {
    expect(pressOptedIn(tool(name)), name).toBe(false);
  }
  // a short name is not read: `sentry`, `payroll` and `files` can opt in
  for (const name of [
    "sentry_post_note",
    "payroll_note_post",
    "files_note_post",
    "books_app_post_entry",
    "books_app_month_close",
    "books_app_batch",
    "books_entry_draft",
    "Notes.Post-1",
  ]) {
    expect(pressOptedIn(tool(name)), name).toBe(true);
  }
  // a lookalike letter or an invisible one hides a word, so any character outside a-z 0-9 _ . - bars the name
  for (const name of ["notes_f\u0456le_post", "notes_fi\u200Ble_post", "notes_post note", "notes_p\u00F6st"]) {
    expect(pressOptedIn(tool(name)), name).toBe(false);
  }
});

test("a declared opt-in that cannot take effect says why", () => {
  const tool = (name: string, meta: unknown) => ({ name, _meta: { "buwiz/press": meta } });
  const good = { approved: true, effect: "post", describe: "notes_describe" };
  expect(pressProblem(tool("notes_post", good))).toBeUndefined();
  expect(pressProblem({ name: "notes_post" })).toBeUndefined();
  expect(pressProblem(tool("notes_file_post", { approved: false }))).toBeUndefined();
  expect(pressProblem(tool("notes_file_post", good))).toContain('"file"');
  expect(pressProblem(tool("notes_f\u0456le", good))).toContain("character");
  expect(pressProblem(tool("notes_post", { ...good, effect: "file" }))).toContain("effect");
  expect(pressProblem(tool("notes_post", { approved: true, effect: "post" }))).toContain("describe");
});

test("an audience that is present and not an array is a problem; absent and arrays are not", () => {
  const tool = (audience?: unknown) => ({ name: "notes_add", _meta: audience === undefined ? {} : { "buwiz/audience": audience } });
  for (const audience of [undefined, [], ["app"], ["agent", "app"]]) expect(audienceProblem(tool(audience))).toBeUndefined();
  for (const audience of ["app", { agent: true }, 1, true, null]) expect(audienceProblem(tool(audience)), String(audience)).toBeDefined();
});

test("an audience that is not an array opens a write to nobody", () => {
  for (const audience of ["agent", "app", { agent: true }, 1, true, null, ["app"], []]) {
    expect(mayReach("agent", { name: "notes_add", _meta: { "buwiz/audience": audience } }, undefined, ARGS)).toBe(false);
  }
});

test("a call that asks for an account switch keeps its result, and the switch only for the person in a first-party plugin", () => {
  const use = { account: "google", label: "work" };
  const r = {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { n: 1 },
    _meta: { "buwiz/account_use": use, "buwiz/save": { a: 1 }, "buwiz/open": {} },
  };
  const own = { content: r.content, structuredContent: r.structuredContent };
  expect(mayUseAccount("person", true)).toBe(true);
  expect(callAnswer(r, "person", () => true)).toEqual({ ...own, _meta: { "buwiz/account_use": use, "buwiz/save": { a: 1 } } });
  for (const actor of ["agent", "routine", "app", "Person", true, null, undefined]) {
    for (const firstParty of [true, false]) {
      if (actor === "person") continue;
      expect(
        callAnswer(r, actor, () => firstParty),
        `${String(actor)} ${firstParty}`,
      ).toEqual({ ...own, _meta: { "buwiz/save": { a: 1 }, "buwiz/account_use_refused": true } });
    }
  }
  expect(callAnswer(r, "person", () => false)).toEqual({ ...own, _meta: { "buwiz/save": { a: 1 }, "buwiz/account_use_refused": true } });
  // nothing asked: no marker, and the plugin is not looked up
  const plain = { content: [], _meta: { "buwiz/open": {} } };
  expect(
    callAnswer(plain, "agent", () => {
      throw new Error("looked up");
    }),
  ).toEqual({ content: [] });
  expect(hostResult({ content: [], _meta: { "buwiz/account_use": use } }, false)).toEqual({ content: [], _meta: { "buwiz/account_use_refused": true } });
});
