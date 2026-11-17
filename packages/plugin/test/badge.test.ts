// badge and withBadge: what a plugin may put on a result as
// _meta["buwiz/badge"] (spec 16.4). crates/plugin/tests/badge.rs runs the same cases.

import { describe, expect, test } from "bun:test";
import { BADGE_KEY, BADGE_TEXT_MAX, BadgeError, badge, clearBadge, fail, ok, withBadge } from "../src";

const TICKET = "tkt_0123456789ABCDEFGHJKMNPQRS";

const reason = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(BadgeError);
    return (e as BadgeError).reason;
  }
  throw new Error("did not throw");
};

describe("badge", () => {
  test("a badge sets a dot, text or both", () => {
    expect(badge("board", { dot: "red", text: "2 due" })).toEqual({ app: "board", dot: "red", text: "2 due" });
    expect(badge("board", { dot: "green" })).toEqual({ app: "board", dot: "green" });
    expect(badge("board", { text: "18h" })).toEqual({ app: "board", text: "18h" });
    expect(badge("board", { dot: "amber", text: "" })).toEqual({ app: "board", dot: "amber", text: "" });
    for (const dot of ["red", "amber", "green", "none"] as const) expect(badge("board", { dot }).dot).toBe(dot);
  });

  test("the text is trimmed and never cut", () => {
    expect(badge("board", { text: "  ok \n" }).text).toBe("ok");
    expect(BADGE_TEXT_MAX).toBe(8);
    expect(badge("board", { text: "12345678" }).text).toBe("12345678");
    expect(badge("board", { text: "ÅÅÅÅÅÅÅÅ" }).text).toBe("ÅÅÅÅÅÅÅÅ");
    expect(reason(() => badge("board", { text: "123456789" }))).toBe("text_too_long");
    expect(reason(() => badge("board", { text: "ÅÅÅÅÅÅÅÅÅ" }))).toBe("text_too_long");
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0007b", "a\u2028b", "a\u2029b"])
      expect(reason(() => badge("board", { text: bad }))).toBe("text_not_one_line");
  });

  test("a set needs a dot or text and an app id", () => {
    expect(reason(() => badge("board", {}))).toBe("empty");
    for (const app of ["", "Board", "1board", "bo ard", "a_b", "a".repeat(49)]) {
      expect(reason(() => badge(app, { dot: "red" }))).toBe("app");
      expect(reason(() => clearBadge(app))).toBe("app");
    }
    expect(badge("a".repeat(48), { dot: "red" }).app).toHaveLength(48);
    expect(reason(() => badge("board", { dot: "blue" as never }))).toBe("dot");
  });

  test("a ticket narrows a badge or a clear", () => {
    expect(badge("board", { dot: "red", text: "late", ticket: TICKET })).toEqual({ app: "board", dot: "red", text: "late", ticket: TICKET });
    expect(clearBadge("board", TICKET)).toEqual({ app: "board", clear: true, ticket: TICKET });
    for (const bad of ["", "tkt_x", "tkt_0123456789abcdefghjkmnpqrs", "0123456789ABCDEFGHJKMNPQRS"]) {
      expect(reason(() => badge("board", { dot: "red", ticket: bad }))).toBe("ticket");
      expect(reason(() => clearBadge("board", bad))).toBe("ticket");
    }
  });

  test("a clear is the app and clear only", () => {
    expect(clearBadge("board")).toEqual({ app: "board", clear: true });
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
    expect(withBadge(fail("not_found", "No such item."), b).isError).toBe(true);
    expect(BADGE_KEY).toBe("buwiz/badge");
  });
});
