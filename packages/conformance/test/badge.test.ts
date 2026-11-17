// A tool result's buwiz/badge as the runner's host reads it (spec 16.4): what makes one malformed, and
// that it is stripped with the rest of _meta like every key it does not act on. The Bot's broker
// reads it with the same rules.

import { expect, test } from "bun:test";
import { BADGE_TEXT_MAX, badgeProblem, callAnswer, hostResult } from "../src/v1/sessions.mjs";

const M = { apps: [{ id: "board" }, { id: "card" }] };
const TICKET = "tkt_0123456789ABCDEFGHJKMNPQRS";

test("a well formed badge has no problem", () => {
  for (const b of [
    { app: "board", dot: "red", text: "2 due" },
    { app: "board", dot: "green" },
    { app: "card", text: "18h" },
    { app: "board", text: "  ok \n" },
    { app: "board", text: "12345678" },
    { app: "board", text: "ÅÅÅÅÅÅÅÅ" },
    { app: "board", dot: "none", text: "" },
    { app: "board", clear: true },
    { app: "board", clear: true, ticket: TICKET },
    { app: "board", dot: "red", ticket: TICKET },
  ])
    expect(badgeProblem(M, b), JSON.stringify(b)).toBeNull();
  expect(BADGE_TEXT_MAX).toBe(8);
});

test("each malformed badge says why", () => {
  const bad: [unknown, string][] = [
    ["red", "it is not an object"],
    [{ dot: "red" }, "app is not a string"],
    [{ app: "other", dot: "red" }, "app is not an app of this plugin"],
    [{ app: "board", dot: "blue" }, "dot is not red, amber, green or none"],
    [{ app: "board", dot: 3 }, "dot is not red, amber, green or none"],
    [{ app: "board", text: "123456789" }, "text is over 8 characters"],
    [{ app: "board", text: "ÅÅÅÅÅÅÅÅÅ" }, "text is over 8 characters"],
    [{ app: "board", text: "a\nb" }, "text is not one line of plain characters"],
    [{ app: "board", text: "a\u0007b" }, "text is not one line of plain characters"],
    [{ app: "board", text: "a\u2028b" }, "text is not one line of plain characters"],
    [{ app: "board", text: 7 }, "text is not a string"],
    [{ app: "board", dot: "red", ticket: "tkt_x" }, "ticket breaks the ticket grammar"],
    [{ app: "board", dot: "red", ticket: 4 }, "ticket breaks the ticket grammar"],
    [{ app: "board" }, "it sets neither dot nor text"],
    [{ app: "board", clear: true, dot: "red" }, "a clear carries only app and ticket"],
    [{ app: "board", clear: true, text: "" }, "a clear carries only app and ticket"],
    [{ app: "board", clear: false }, "clear is not true"],
    [{ app: "board", clear: "yes" }, "clear is not true"],
  ];
  for (const [b, why] of bad) expect(badgeProblem(M, b), JSON.stringify(b)).toBe(why);
});

test("the badge never reaches the app or the model", () => {
  const r = { content: [], structuredContent: { ok: true }, _meta: { "buwiz/badge": { app: "board", dot: "red" }, "buwiz/open": { app: "board" } } };
  expect(hostResult(r)).toEqual({ content: [], structuredContent: { ok: true } });
  expect(callAnswer(r, "person", () => true)).toEqual({ content: [], structuredContent: { ok: true } });
});
