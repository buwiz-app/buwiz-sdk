// badge and withBadge: what a plugin may put on a result as
// _meta["buwiz/badge"] (spec 16.4). crates/plugin/tests/badge.rs runs the same cases, and both read
// vectors/badge.json, which the Bot's broker and the runner's host read too.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BADGE_KEY, BADGE_TEXT_MAX, BadgeError, badge, clearBadge, fail, ok, withBadge } from "../src";

const TICKET = "tkt_0123456789ABCDEFGHJKMNPQRS";
const VECTORS = JSON.parse(readFileSync(join(import.meta.dir, "../../../vectors/badge.json"), "utf8")) as {
  cases: { badge: unknown; ok: boolean; why?: string; helper_ok?: boolean }[];
};

const reason = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(BadgeError);
    return (e as BadgeError).reason;
  }
  throw new Error("did not throw");
};
const wire = (b: unknown) => JSON.parse(JSON.stringify(b)) as Record<string, unknown>;

describe("badge", () => {
  test("the helper accepts and refuses what the shared vectors say", () => {
    expect(VECTORS.cases.length).toBeGreaterThan(40);
    let tried = 0;
    for (const c of VECTORS.cases) {
      const b = c.badge as Record<string, unknown>;
      if (typeof b !== "object" || b === null || "clear" in b) continue;
      const want = c.helper_ok ?? c.ok;
      let made: unknown = null;
      let error: unknown = null;
      try {
        // a value the signature rules out is a refusal too, whichever way it fails
        made = badge(b.app as string, { dot: b.dot as never, text: b.text as never, ticket: (b.ticket ?? undefined) as never });
      } catch (e) {
        error = e;
      }
      tried++;
      expect(error === null, `${JSON.stringify(b)}: ${String(error)}`).toBe(want);
      if (made) {
        const w = wire(made);
        if (typeof w.text === "string") expect(w.text.length > 0 && !w.text.startsWith(" ") && !w.text.endsWith(" ")).toBe(true);
      }
    }
    expect(tried).toBeGreaterThan(30);
  });

  test("a badge shows a dot, text or both", () => {
    expect(wire(badge("board", { dot: "red", text: "2 due" }))).toEqual({ app: "board", dot: "red", text: "2 due" });
    expect(wire(badge("board", { dot: "green" }))).toEqual({ app: "board", dot: "green" });
    expect(wire(badge("board", { text: "18h" }))).toEqual({ app: "board", text: "18h" });
    expect(wire(badge("board", { dot: "none", text: "18h" }))).toEqual({ app: "board", dot: "none", text: "18h" });
    expect(reason(() => badge("board", {}))).toBe("empty");
    expect(reason(() => badge("board", { dot: "none" }))).toBe("empty");
    expect(reason(() => badge("board", { dot: "blue" as never }))).toBe("dot");
  });

  test("the text is trimmed of plain spaces only and never cut", () => {
    expect(BADGE_TEXT_MAX).toBe(8);
    expect(wire(badge("board", { text: "  ok  " })).text).toBe("ok");
    expect(wire(badge("board", { text: "12345678" })).text).toBe("12345678");
    expect(wire(badge("board", { text: "ÅÅÅÅÅÅÅÅ" })).text).toBe("ÅÅÅÅÅÅÅÅ");
    expect(wire(badge("board", { text: " x" })).text).toBe(" x");
    expect(wire(badge("board", { text: "﻿x" })).text).toBe("﻿x");
    for (const empty of ["", "   "]) expect(reason(() => badge("board", { text: empty }))).toBe("text_empty");
    expect(reason(() => badge("board", { dot: "red", text: " " }))).toBe("text_empty");
    expect(reason(() => badge("board", { text: "123456789" }))).toBe("text_too_long");
    expect(reason(() => badge("board", { text: "ÅÅÅÅÅÅÅÅÅ" }))).toBe("text_too_long");
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0007b", "a\u2028b", "a\u2029b", "\u0085x", "ok\n", "\nok", " ok\n"])
      expect(reason(() => badge("board", { text: bad }))).toBe("text_not_one_line");
  });

  test("an app id and a ticket are checked", () => {
    for (const app of ["", "Board", "1board", "bo ard", "a_b", "a".repeat(49)]) {
      expect(reason(() => badge(app, { dot: "red" }))).toBe("app");
      expect(reason(() => clearBadge(app))).toBe("app");
    }
    expect(wire(badge("a".repeat(48), { dot: "red" })).app).toHaveLength(48);
    expect(wire(badge("board", { dot: "red", text: "late", ticket: TICKET }))).toEqual({ app: "board", dot: "red", text: "late", ticket: TICKET });
    expect(wire(clearBadge("board", TICKET))).toEqual({ app: "board", clear: true, ticket: TICKET });
    for (const bad of ["", "tkt_x", "tkt_0123456789abcdefghjkmnpqrs", "0123456789ABCDEFGHJKMNPQRS"]) {
      expect(reason(() => badge("board", { dot: "red", ticket: bad }))).toBe("ticket");
      expect(reason(() => clearBadge("board", bad))).toBe("ticket");
    }
    expect(wire(clearBadge("board"))).toEqual({ app: "board", clear: true });
  });

  test("a Badge cannot be built by hand", () => {
    // a plain object is no Badge (the type checker refuses it), and the class has no public way in
    // @ts-expect-error a plain object is not a Badge
    const plain: Parameters<typeof withBadge>[1] = { app: "board" };
    expect(() => withBadge(ok({}), plain)).toThrow();
  });

  test("withBadge puts it in the result's _meta and keeps the rest", () => {
    const b = badge("board", { dot: "amber", text: "18h" });
    const r = withBadge(ok({ due: 18 }), b);
    expect(r._meta?.[BADGE_KEY]).toEqual({ app: "board", dot: "amber", text: "18h" });
    expect(r.structuredContent).toEqual({ due: 18 });
    expect(r.isError).toBe(false);
    const other = withBadge({ ...ok({}), _meta: { "buwiz/suggest": [] } }, b);
    expect(other._meta?.["buwiz/suggest"]).toEqual([]);
    expect(other._meta?.[BADGE_KEY]).toEqual({ app: "board", dot: "amber", text: "18h" });
    // a null _meta is the same as none
    expect(withBadge({ ...ok({}), _meta: null as never }, b)._meta?.[BADGE_KEY]).toEqual({ app: "board", dot: "amber", text: "18h" });
    expect(withBadge(fail("not_found", "No such item."), b).isError).toBe(true);
    expect(BADGE_KEY).toBe("buwiz/badge");
  });

  test("a _meta that is not an object is the author's error", () => {
    const b = badge("board", { dot: "amber" });
    for (const meta of ["x", [], 3, true]) expect(reason(() => withBadge({ ...ok({}), _meta: meta as never }, b))).toBe("meta");
  });
});
