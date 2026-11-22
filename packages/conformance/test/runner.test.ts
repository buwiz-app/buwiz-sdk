// buwiz-plugin-test against a minimal plugin built on the SDK's own server: it
// passes, a copy that breaks one rule fails and the output names that check.
// No network, throwaway keys only.

import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pacer } from "../bin/buwiz-plugin-test.mjs";
import { type Row, RUNNER, SIGNER, keygen, node, probe, probeSays, removeTempDirs, tempDir } from "./support";

afterAll(removeTempDirs);

const MINUTE = 60_000;

test(
  "the runner passes a minimal known-good plugin",
  async () => {
    const key = (await keygen(tempDir())).path;
    const done = await node(RUNNER, [...probe("--sign-with", key), "--json"]);
    const res = JSON.parse(done.out) as { ok: boolean; plugin: { id: string }; rows: Row[] };
    expect(res.plugin.id).toBe("com.example.probe");
    expect(res.rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(res.ok).toBe(true);
    expect(done.code).toBe(0);
    // the checks that matter most ran, rather than being skipped
    const passed = new Set(res.rows.filter((r) => r.status === "pass").map((r) => r.id));
    for (const id of [
      "MAN-01",
      "MAN-02",
      "MAN-10",
      "MAN-15",
      "MAN-16",
      "APP-01",
      "APP-02",
      "APP-03",
      "APP-04",
      "RSV-01",
      "RSV-03",
      "RSV-05",
      "LCY-01",
      "BRG-03",
      "BRG-04",
      "BRG-06",
      "INV-04",
      "INV-10",
      "RSV-04",
      "INV-10",
    ]) {
      expect(passed.has(id), id).toBe(true);
    }
  },
  MINUTE,
);

test(
  "the checklist ends with a summary line and exits 0",
  async () => {
    const key = (await keygen(tempDir())).path;
    const done = await node(RUNNER, probe("--sign-with", key));
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/^Buwiz Mini App Protocol 1\.0, plugin checks: com\.example\.probe 0\.1\.0$/m);
    expect(done.out.trimEnd().split("\n").pop()).toMatch(/^\d+ pass, 0 fail, 0 skipped: conforms$/);
  },
  MINUTE,
);

test(
  "the runner fails a plugin that breaks a rule, and names the check",
  async () => {
    const key = (await keygen(tempDir())).path;
    const done = await node(RUNNER, [...probe("--sign-with", key, "--env", "PROBE_BREAK=fetch")]);
    expect(done.code).toBe(1);
    expect(done.out).toContain("[ ] APP-04 FAIL");
    expect(done.out).toContain("uses fetch");
    expect(done.out.trimEnd().split("\n").pop()).toMatch(/^\d+ pass, 1 fail, 0 skipped: does NOT conform$/);

    const json = await node(RUNNER, [...probe("--sign-with", key, "--env", "PROBE_BREAK=fetch"), "--json"]);
    const failed = (JSON.parse(json.out) as { rows: Row[] }).rows.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.id)).toEqual(["APP-04"]);
  },
  MINUTE,
);

test(
  "permissions.models is a strict empty object",
  async () => {
    const dir = tempDir();
    const key = await keygen(dir);
    const keyId = "probe-test-01";
    const manifest = JSON.parse(await probeSays(["manifest", "--key-id", keyId]));
    const source = join(dir, "board.tsx");
    writeFileSync(source, await probeSays(["app-source", "board"]));

    const run = async (models?: object) => {
      const candidate = structuredClone(manifest);
      if (models === undefined) delete candidate.apps[0].permissions.models;
      else candidate.apps[0].permissions.models = models;
      const input = join(dir, "manifest.json");
      const signed = join(dir, "signed.json");
      writeFileSync(input, JSON.stringify(candidate));
      const sign = await node(SIGNER, [input, "--key-file", key.path, "--app", `board=${source}`, "--out", signed]);
      expect(sign.code).toBe(0);
      return node(RUNNER, [...probe("--manifest", signed, "--key-file", key.path), "--json"]);
    };

    const absent = await run();
    expect(absent.code).toBe(0);
    expect((JSON.parse(absent.out) as { rows: Row[] }).rows.some((row) => row.id === "BRG-17" && row.status === "pass")).toBe(true);

    const valid = await run({});
    expect(valid.code).toBe(0);
    expect((JSON.parse(valid.out) as { rows: Row[] }).rows.some((row) => row.id === "BRG-17" && row.status === "pass")).toBe(true);

    const invalid = await run({ x: 1 });
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain("models");
    const invalidRows = (JSON.parse(invalid.out) as { rows: Row[] }).rows;
    expect(
      invalidRows.some((row) => row.id === "BRG-17" && row.status === "fail" && row.what === "permissions.models is a strict empty object when granted"),
    ).toBe(true);
    expect(invalidRows.some((row) => row.id === "MAN-06" && row.status === "fail")).toBe(false);
  },
  MINUTE,
);

test(
  "BRG-20 passes a well formed badge, fails a malformed one and is skipped, with its reason, when no result carries one",
  async () => {
    const key = (await keygen(tempDir())).path;
    const rows = async (...env: string[]) => (JSON.parse((await node(RUNNER, [...probe("--sign-with", key, ...env), "--json"])).out) as { rows: Row[] }).rows;
    const good = await rows();
    expect(good.filter((r) => r.status === "fail")).toEqual([]);
    expect(good.filter((r) => r.id === "BRG-20").map((r) => r.status)).toEqual(["pass"]);

    const bad = await node(RUNNER, [...probe("--sign-with", key, "--env", "PROBE_BREAK=badge"), "--json"]);
    const failed = (JSON.parse(bad.out) as { rows: Row[] }).rows.filter((r) => r.status === "fail");
    expect(bad.code).toBe(1);
    expect(failed.map((r) => r.id)).toEqual(["BRG-20"]);
    expect(failed[0]?.note).toContain("dot is not red, amber, green or none");

    const viaResolve = (await rows("--env", "PROBE_BREAK=badge-resolve")).filter((r) => r.status === "fail");
    expect(viaResolve.map((r) => r.id)).toEqual(["BRG-20"]);
    expect(viaResolve[0]?.note).toContain("probe_resolve: text is over 8 characters");

    const none = (await rows("--env", "PROBE_BADGE=none")).filter((r) => r.id === "BRG-20");
    expect(none.map((r) => r.status)).toEqual(["skip"]);
    expect(none[0]?.note).toContain("no tool result");
  },
  MINUTE,
);

test(
  "a manifest signed by the signer is trusted from --key-file, or from BUWIZ_TRUST_FILE",
  async () => {
    const dir = tempDir();
    const key = await keygen(dir);
    const keyId = "probe-test-01";
    // the same steps a template's conformance.sh takes: manifest under the test key id, app source, sign
    writeFileSync(join(dir, "manifest.json"), await probeSays(["manifest", "--key-id", keyId]));
    writeFileSync(join(dir, "board.tsx"), await probeSays(["app-source", "board"]));
    const signed = join(dir, "signed.json");
    const sign = await node(SIGNER, [join(dir, "manifest.json"), "--key-file", key.path, "--app", `board=${join(dir, "board.tsx")}`, "--out", signed]);
    expect(sign.code).toBe(0);

    const withKey = await node(RUNNER, probe("--manifest", signed, "--key-file", key.path));
    expect(withKey.out.trimEnd().split("\n").pop()).toMatch(/ 0 fail, 0 skipped: conforms$/);
    expect(withKey.out).toContain("from --key-file");

    // a trust file, named by BUWIZ_TRUST_FILE, used as it is
    const trust = (approved: object[]) =>
      JSON.stringify({ v: 1, publishers: { [keyId]: { publisher: "com.example", alg: "ed25519", public_key: key.pub } }, approved_plugins: approved });
    writeFileSync(join(dir, "trust.json"), trust([{ id: "com.example.probe", publisher_key_id: keyId }]));
    const trusted = await node(RUNNER, probe("--manifest", signed), { BUWIZ_TRUST_FILE: join(dir, "trust.json") });
    expect(trusted.out.trimEnd().split("\n").pop()).toMatch(/ 0 fail, 0 skipped: conforms$/);
    expect(trusted.out).toContain("trust: BUWIZ_TRUST_FILE");
    expect(trusted.out).toContain("com.example.probe approved");

    // the key is trusted but the plugin is not approved: MAN-01 fails with the host's message
    writeFileSync(join(dir, "unapproved.json"), trust([]));
    const refused = await node(RUNNER, probe("--manifest", signed), { BUWIZ_TRUST_FILE: join(dir, "unapproved.json") });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("[ ] MAN-01 FAIL");
  },
  MINUTE,
);

test(
  "--manifest with neither --key-file nor BUWIZ_TRUST_FILE stops: the SDK ships no trust list",
  async () => {
    const dir = tempDir();
    const key = await keygen(dir);
    writeFileSync(join(dir, "manifest.json"), await probeSays(["manifest", "--key-id", "probe-test-01"]));
    const signed = join(dir, "signed.json");
    await node(SIGNER, [join(dir, "manifest.json"), "--key-file", key.path, "--out", signed]);
    const done = await node(RUNNER, probe("--manifest", signed));
    expect(done.code).toBe(1);
    expect(done.out).toContain("BUWIZ_TRUST_FILE");
    expect(done.out).toContain("does NOT conform");
  },
  MINUTE,
);

test(
  "usage errors exit 2 without running anything",
  async () => {
    const done = await node(RUNNER, ["--no-such-option"]);
    expect(done.code).toBe(2);
    expect(done.err).toContain("unknown option --no-such-option");
  },
  MINUTE,
);

test("the pacer counts a call from the moment it starts: parallel callers never exceed the limit in a window", async () => {
  const window = 200;
  const pace = pacer(5, window);
  const starts: number[] = [];
  // 15 callers at once, each call slow: a count taken only when a call settles would let all 15 start together
  await Promise.all(
    Array.from({ length: 15 }, () =>
      pace(async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 300));
      }),
    ),
  );
  expect(starts.length).toBe(15);
  for (const t of starts) expect(starts.filter((u) => u >= t && u < t + window).length).toBeLessThanOrEqual(5);
});

test("the pacer keeps sequential calls inside a host that counts each call when it arrives", async () => {
  // the host's own limit: `max` arrivals in any `window`, counted when a call reaches it
  const window = 200;
  const max = 5;
  const arrived: number[] = [];
  let refused = 0;
  const host = async (latency: number) => {
    await new Promise((r) => setTimeout(r, latency));
    const now = Date.now();
    while (arrived.length && now - arrived[0]! >= window) arrived.shift();
    if (arrived.length >= max) refused += 1;
    else arrived.push(now);
  };
  const pace = pacer(max, window);
  // the first call is slow to arrive and the rest are quick: a count taken when a call
  // starts would free the first place before the host's own window for it has ended
  for (let i = 0; i < 12; i += 1) await pace(() => host(i === 0 ? 80 : 0));
  expect(refused).toBe(0);
});

test("a caller waiting on running calls wakes when one settles, and a place frees one window later", async () => {
  const window = 100;
  const pace = pacer(2, window);
  const release: (() => void)[] = [];
  const hold = () => new Promise<void>((r) => release.push(r));
  const first = pace(hold);
  const second = pace(hold);
  let started = 0;
  const third = pace(async () => {
    started = Date.now();
  });
  // both places are running: the third caller has no time to wait for, only a settle
  await new Promise((r) => setTimeout(r, 150));
  expect(started).toBe(0);
  const settled = Date.now();
  release[0]!();
  await first;
  await third;
  expect(started - settled).toBeGreaterThanOrEqual(window);
  expect(started - settled).toBeLessThan(window + 150);
  release[1]!();
  await second;
});

test(
  "the real host refuses no call of a plugin with more tools than fit in one second",
  async () => {
    const key = (await keygen(tempDir())).path;
    const json = await node(RUNNER, [...probe("--sign-with", key, "--env", "PROBE_TOOLS=50"), "--json"]);
    const rows = (JSON.parse(json.out) as { rows: Row[] }).rows;
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    // one signed call per permitted tool: probe_list and the fifty more
    expect(rows.filter((r) => r.id === "BRG-03" && r.status === "pass").length).toBeGreaterThanOrEqual(51);
  },
  MINUTE,
);

test(
  "the runner fails a blank prompt with the check INV-10",
  async () => {
    const key = (await keygen(tempDir())).path;
    const json = await node(RUNNER, [...probe("--sign-with", key, "--env", "PROBE_BREAK=prompt"), "--json"]);
    const failed = (JSON.parse(json.out) as { rows: Row[] }).rows.filter((r) => r.status === "fail");
    expect([...new Set(failed.map((r) => r.id))]).toEqual(["INV-10"]);
    expect(failed[0]?.note).toContain("a prompt result needs text");
  },
  MINUTE,
);
