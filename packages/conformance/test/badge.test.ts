// A tool result's buwiz/badge as the runner's host reads it (spec 16.4), against the vectors every
// side shares (vectors/badge.json: the Bot's broker, the plugin libraries and this host), and that it
// is stripped with the rest of _meta.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BADGE_TEXT_MAX, badgeProblem, callAnswer, hostResult } from "../src/v1/sessions.mjs";

const V = JSON.parse(readFileSync(join(import.meta.dir, "../../../vectors/badge.json"), "utf8")) as {
  apps: string[];
  cases: { badge: unknown; ok: boolean; why?: string }[];
};
const M = { apps: V.apps.map((id) => ({ id })) };

test("every shared vector is well formed or malformed for its reason", () => {
  expect(V.cases.length).toBeGreaterThan(40);
  for (const c of V.cases) expect(badgeProblem(M, c.badge), JSON.stringify(c.badge)).toBe(c.ok ? null : c.why!);
  expect(BADGE_TEXT_MAX).toBe(8);
});

test("the badge never reaches the app or the model", () => {
  const r = { content: [], structuredContent: { ok: true }, _meta: { "buwiz/badge": { app: "board", dot: "red" }, "buwiz/open": { app: "board" } } };
  expect(hostResult(r)).toEqual({ content: [], structuredContent: { ok: true } });
  expect(callAnswer(r, "person", () => true)).toEqual({ content: [], structuredContent: { ok: true } });
});
