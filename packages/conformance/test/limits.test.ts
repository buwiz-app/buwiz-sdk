// The limits the documents state are the limits the runner's host enforces, in both directions:
// docs/manifest.md's table (a key of `LIMITS` in each row), and section 24 of the protocol
// specification, read from the real files. A limit the host enforces on a manifest that no table
// lists, or a listed number that is not the enforced one, fails here. A table row about something
// the host does not enforce on a manifest (a badge, a timeout) is not this test's to judge.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "../src/v1/manifest.mjs";
import { PARAMS_MAX_BYTES, PARAMS_MAX_PROPERTIES } from "../src/v1/params.mjs";
import * as plugins from "../src/v1/plugins.mjs";
import * as sessions from "../src/v1/sessions.mjs";

const DOCS = join(import.meta.dir, "../../../docs");
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");

const UNIT: Record<string, number> = { KiB: 1024, MiB: 1024 * 1024 };

/** Every number in a table cell, in order, with a KiB or MiB after it applied: "60 to 86400 s" is [60, 86400]. */
function numbers(cell: string): number[] {
  return [...cell.matchAll(/(\d+(?:,\d{3})*)(?:\s*(KiB|MiB))?/g)].map(([, n, unit]) => Number(n!.replaceAll(",", "")) * (unit ? UNIT[unit]! : 1));
}

/** The rows of the first Markdown table after `heading`: each row's cells, without the padding or the header. */
function table(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, `${heading} is in the document`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const line of markdown
    .slice(start + 1)
    .split("\n")
    .slice(1)) {
    if (line.startsWith("|"))
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    else if (rows.length) break;
  }
  return rows.slice(2);
}

const limit = (key: string) => (LIMITS as Record<string, number | number[]>)[key]!;
const rowsOf = (file: string, heading: string) => new Map(table(read(file), heading).map(([item, value]) => [item!, value!]));

test("every limit in docs/manifest.md's table is the one the host enforces, and every limit the host enforces on a manifest is in it", () => {
  const rows = table(read("manifest.md"), "## Limits").map(([field, value, key]) => ({ field: field!, value: value!, key: /`LIMITS\.(\w+)`/.exec(key!)?.[1] }));
  expect(rows.length).toBeGreaterThan(30);
  // a row names the key it states, and the host has that limit
  expect(rows.filter((r) => !r.key || !(r.key in LIMITS)).map((r) => r.field)).toEqual([]);
  for (const { field, value, key } of rows) {
    const want = limit(key!);
    expect(numbers(value).slice(0, Array.isArray(want) ? 2 : 1), `${field} (${key})`).toEqual(Array.isArray(want) ? want : [want]);
  }
  // each enforced limit has a row
  expect([...new Set(rows.map((r) => r.key))].sort()).toEqual(Object.keys(LIMITS).sort());
});

// Section 24 states most limits in rows that hold several: the row's first cell, then each key in
// the order its number stands in that row (or at a given place, when the row repeats one).
const SPEC: [row: string, ...keys: (string | [string, number])[]][] = [
  ["Manifest", "manifestBytes"],
  ["Plugin id / short / version", "pluginId", ["version", 3]],
  ["Title / description", "title", "description"],
  ["Publisher name", "publisherName"],
  ["Commands / scopes / routines / apps", "commands", "scopes", "routines", "apps"],
  ["Command description / args", "commandDescription", "commandArgs"],
  ["Scope description / hint", "scopeDescription", "scopeHint"],
  ["Routine name / description / prompt / `query.field`", "routineName", "routineDescription", "routinePrompt"],
  ["Routine `every_s`", "everyS"],
  ["Routine `reads` / `writes`", "reads", "readsTools", "writes"],
  ["`permissions.tools`", "permTools"],
  ["`permissions.open.apps` / `external`", "openApps", "openExternal"],
  ["`permissions.attach`", "attach"],
  ["`permissions.pick_file` extensions / `max_bytes`", "pickExtensions", "pickMaxBytes"],
  ["`permissions.storage.quota_bytes`", "storageQuota", "storageDefault"],
  ["`permissions.preview.max_bytes`", "previewMaxBytes"],
  ["Props", "propsBytes", "propsDepth", "propsArray"],
  ["Props schema", "schemaProperties", "schemaMaxLength", ["propsDepth", 2]],
  ["Inline width / height", "inlineWidth", "inlineHeight"],
];

test("every manifest limit the host enforces is in section 24 of the protocol, with the number the host enforces", () => {
  const rows = rowsOf("protocol-1.0.md", "## 24. Limits");
  const seen = new Set<string>();
  for (const [row, ...keys] of SPEC) {
    const value = rows.get(row);
    expect(value, `a row "${row}"`).toBeDefined();
    const nums = numbers(value!);
    let at = 0;
    for (const spec of keys) {
      const [key, index] = Array.isArray(spec) ? spec : [spec, at];
      seen.add(key);
      const want = limit(key);
      // a range ("60 to 86400") takes two numbers
      expect(Array.isArray(want) ? nums.slice(index, index + 2) : nums[index], `${row}: ${key}`).toEqual(want);
      if (!Array.isArray(spec)) at = index + (Array.isArray(want) ? 2 : 1);
    }
  }
  // each enforced limit is covered by a row above: a new limit asks for its row here and in the table
  expect([...seen].sort()).toEqual(Object.keys(LIMITS).sort());
  // the row for min_height and max_height gives the same range as height
  expect(numbers(rows.get("Inline `min_height` / `max_height`")!).slice(0, 2)).toEqual(limit("inlineHeight") as number[]);
});

test("the limits the host enforces on a call, a result, a certificate and a restart are the ones section 24 and docs/bridge.md state", () => {
  const spec = rowsOf("protocol-1.0.md", "## 24. Limits");
  const bridge = rowsOf("bridge.md", "## Limits");
  const inSpec = (row: string) => numbers(spec.get(row) ?? "");
  const inBridge = (row: string) => numbers(bridge.get(row) ?? "");

  expect(inSpec("TSX app source")).toEqual([sessions.SOURCE_MAX]);
  expect(inBridge("App source")).toEqual([sessions.SOURCE_MAX]);
  expect(inSpec("`buwiz.call` args / result")).toEqual([sessions.ARGS_MAX, sessions.RESULT_MAX]);
  expect(inBridge("`buwiz.call` args")).toEqual([sessions.ARGS_MAX]);
  expect(inBridge("`buwiz.call` result").slice(0, 1)).toEqual([sessions.RESULT_MAX]);
  expect(inSpec("Calls in flight / new calls a second, per open")).toEqual([sessions.MAX_INFLIGHT, sessions.MAX_PER_SECOND]);
  expect(inBridge("Calls in flight per open")).toEqual([sessions.MAX_INFLIGHT]);
  expect(inBridge("New calls per second per open")).toEqual([sessions.MAX_PER_SECOND]);
  expect(inSpec("Nonce window")).toEqual([sessions.NONCE_WINDOW_MS / 60_000, sessions.NONCE_MAX]);
  expect(inSpec("Clock skew")).toEqual([sessions.SKEW_MS / 1000]);
  expect(inSpec("Session certificate")).toEqual([sessions.CERT_MAX_MS / 3600_000]);
  expect(inBridge("Session certificate")).toEqual([sessions.CERT_MAX_MS / 3600_000]);
  expect(inSpec("Resolve `prompt`")).toEqual([sessions.PROMPT_MAX]);
  expect(inBridge("Resolve `prompt` text")).toEqual([sessions.PROMPT_MAX]);
  expect(sessions.PREVIEW_MAX).toBe(LIMITS.previewMaxBytes);
  expect(inSpec("Routine `params`").slice(0, 2)).toEqual([PARAMS_MAX_PROPERTIES, PARAMS_MAX_BYTES]);
  // restarts: a backoff from 1 to 60 s, six in ten minutes
  expect(inSpec("Restarts")).toEqual([plugins.BACKOFF_S[0], plugins.BACKOFF_S.at(-1), plugins.MAX_RESTARTS, plugins.RESTART_WINDOW_MS / 60_000]);
});
