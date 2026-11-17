// buwiz-plugin-test against plugins that each break one rule of the reserved tools, of a resolve
// answer or of an app, or that need a flag: the runner fails the one row that is broken, with its
// status and note, and passes the rows around it. The plugins are in fixtures/. No network, throwaway keys only.

import { afterAll, expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Row, RUNNER, SIGNER, TEMPLATE, FIXTURES, fixture, idsOf, keygen, node, runJson, removeTempDirs, tempDir } from "./support";

afterAll(removeTempDirs);

const MINUTE = 60_000;
const signed = async (args: string[]) => runJson([...args, "--sign-with", (await keygen(tempDir())).path]);
const reserved = (mode?: string) => fixture("reserved-plugin.mjs", mode ? { RESERVED_MODE: mode } : {});
const scoped = (mode?: string) => fixture("scoped-plugin.mjs", mode ? { SCOPED_MODE: mode } : {});

test(
  "the reserved-tools plugin, answering as the protocol says, passes every row",
  async () => {
    const { code, rows } = await signed(reserved());
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    for (const id of ["RSV-01", "RSV-02", "RSV-03", "RSV-05", "BRG-03", "LCY-01"]) expect(idsOf(rows, "pass"), id).toContain(id);
  },
  MINUTE,
);

test(
  "the runner provisions with protocol 1.0.0: a plugin that refuses any other protocol passes RSV-01 to RSV-05",
  async () => {
    // the plugin does refuse another protocol, so passing means the runner sent 1.0.0
    const client = new Client({ name: "runner-cases-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(FIXTURES, "reserved-plugin.mjs")], env: { RESERVED_MODE: "strict-host" } }),
    );
    try {
      const key = { alg: "ed25519", seed: "A".repeat(43) };
      const refused = await client.callTool({ name: "buwiz.provision", arguments: { protocol: "2.0.0", plugin: "com.example.reserved", key, pub: "" } });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
    const { code, rows } = await signed(reserved("strict-host"));
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    for (const id of ["RSV-01", "RSV-02", "RSV-03", "RSV-04", "RSV-05", "LCY-01"]) expect(idsOf(rows, "pass"), id).toContain(id);
  },
  MINUTE,
);

test(
  "the runner fails a plugin that answers a tool before buwiz.provision, with RSV-01 only",
  async () => {
    const { code, rows } = await signed(reserved("skip-provision"));
    const failed = rows.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.id)).toEqual(["RSV-01"]);
    expect(failed[0]?.what).toContain("a tool before buwiz.provision fails");
    expect(failed[0]?.note).toContain("answered before buwiz.provision");
    expect(code).toBe(1);
    // provisioning itself is fine, and so are the rows after it
    for (const id of ["RSV-02", "RSV-03", "RSV-05", "BRG-03", "LCY-01"]) expect(idsOf(rows, "pass"), id).toContain(id);
    expect(rows.some((r) => r.id === "RSV-01" && r.status === "pass" && r.what.startsWith("buwiz.provision answers"))).toBe(true);
  },
  MINUTE,
);

test(
  "the runner fails a plugin whose session certificate is signed by another key, with RSV-03 and the host's BRG-03",
  async () => {
    const { code, rows } = await signed(reserved("bad-cert"));
    const failed = rows.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.id).sort()).toEqual(["BRG-03", "RSV-03"]);
    expect(failed.find((r) => r.id === "RSV-03")?.note).toContain("cert_sig does not verify with the plugin public key");
    expect(code).toBe(1);
    for (const id of ["RSV-01", "RSV-02", "RSV-05", "LCY-01"]) expect(idsOf(rows, "pass"), id).toContain(id);
  },
  MINUTE,
);

test(
  "the runner fails a plugin that writes its key to stderr, with RSV-03 and the host's install gate",
  async () => {
    const { code, rows } = await signed(reserved("log-seed"));
    const failed = rows.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.id).sort()).toEqual(["LCY-01", "RSV-03"]);
    const leak = failed.find((r) => r.id === "RSV-03");
    expect(leak?.what).toContain("never writes its key to stderr");
    expect(leak?.note).toBe("a seed appeared in stderr");
    expect(code).toBe(1);
    // the certificates are right: only the log is wrong
    for (const id of ["RSV-01", "RSV-02", "RSV-05"]) expect(idsOf(rows, "pass"), id).toContain(id);
    expect(rows.some((r) => r.id === "RSV-03" && r.status === "pass" && r.what.startsWith("the session certificate"))).toBe(true);
  },
  MINUTE,
);

test(
  "the runner fails an app that imports outside nsh, nsh/base and buwiz, with APP-03 only",
  async () => {
    const { code, rows } = await signed(scoped("device-import"));
    const failed = rows.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.id)).toEqual(["APP-03"]);
    expect(failed[0]?.what).toContain("board: imports only nsh, nsh/base, buwiz");
    expect(failed[0]?.note).toContain("unsupported_import: nsh/device");
    expect(code).toBe(1);
    for (const id of ["APP-01", "APP-02", "APP-04", "RSV-01", "RSV-03", "BRG-03"]) expect(idsOf(rows, "pass"), id).toContain(id);
  },
  MINUTE,
);

const chosen = (rows: Row[]) => rows.filter((r) => r.id === "INV-04" && /a chosen completion/.test(r.what));

test(
  "INV-04 resolves a chosen completion of an attachable scope, a ticket its own completion offered",
  async () => {
    const { code, rows } = await signed(scoped());
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    expect(chosen(rows).map((r) => r.status)).toEqual(["pass"]);
  },
  MINUTE,
);

test(
  "INV-04 skips an attachable scope that offered no ticket, rather than resolving a ticket it did not offer",
  async () => {
    // /draft opens with a ticket, but the scope's completion offers none and refuses a ticket it did not offer
    const { code, rows } = await signed(scoped("quiet"));
    expect(chosen(rows).map((r) => r.status)).toEqual(["skip"]);
    expect(chosen(rows)[0]?.what).toContain("scope note");
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    // the scope's other INV-04 rows ran
    expect(rows.filter((r) => r.id === "INV-04" && r.status === "pass").length).toBeGreaterThanOrEqual(2);
  },
  MINUTE,
);

test(
  "INV-10 passes a bare command's prompt and fails one over 4000 characters, with the other rows passing",
  async () => {
    const good = await signed(scoped());
    expect(good.rows.filter((r) => r.id === "INV-10").map((r) => [r.status, r.note])).toEqual([["pass", "22 characters"]]);

    const { code, rows } = await signed(scoped("long-prompt"));
    const prompts = rows.filter((r) => r.id === "INV-10");
    expect(prompts.map((r) => [r.status, r.note])).toEqual([["fail", "a prompt's text is at most 4000 characters"]]);
    expect(prompts[0]?.what).toContain("command draft");
    expect(rows.filter((r) => r.status === "fail" && r.id !== "INV-10")).toEqual([]);
    expect(code).toBe(1);
  },
  MINUTE,
);

test(
  "INV-10 fails a scope that answers a prompt, whether or not it was asked to complete",
  async () => {
    const { code, rows } = await signed(scoped("scope-prompt"));
    const prompts = rows.filter((r) => r.id === "INV-10");
    const ofScope = prompts.filter((r) => r.what.startsWith("scope note"));
    expect(ofScope.map((r) => [r.status, r.note])).toEqual([
      ["fail", "a prompt result answers a command, not a scope"],
      ["fail", "a prompt result answers a command, not a scope"],
    ]);
    // the command's own prompt, and every other row, still pass
    expect(prompts.filter((r) => r.what.startsWith("command draft")).map((r) => r.status)).toEqual(["pass"]);
    expect(rows.filter((r) => r.status === "fail" && r.id !== "INV-10")).toEqual([]);
    expect(code).toBe(1);
  },
  MINUTE,
);

test(
  "a manifest of another protocol is refused with the one ordinary refusal, at MAN-04",
  async () => {
    const dir = tempDir();
    const key = await keygen(dir);
    const manifest = JSON.parse(readFileSync(join(FIXTURES, "scoped-manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, protocol: "2.1.0" }));
    const file = join(dir, "signed.json");
    const sign = await node(SIGNER, [join(dir, "manifest.json"), "--key-file", key.path, "--app", `board=${join(FIXTURES, "board.tsx")}`, "--out", file]);
    expect(sign.code).toBe(0);
    const { code, rows, out } = await runJson([...scoped(), "--manifest", file, "--key-file", key.path]);
    const failed = rows.filter((r) => r.status === "fail");
    // the manifest check and the install gate that needs it
    expect(failed.map((r) => r.id)).toEqual(["MAN-04", "LCY-01"]);
    for (const r of failed) expect(r.note).toContain("the plugin implements protocol 2.1.0; this Buwiz Bot supports 1.0");
    expect(out).not.toMatch(/pre-release/i);
    expect(code).toBe(1);
  },
  MINUTE,
);

test(
  "a native-only plugin conforms under --first-party, with the native APP checks and no source read; without the flag it is refused",
  async () => {
    const dir = tempDir();
    const manifest = JSON.parse(readFileSync(join(TEMPLATE, "manifest.json"), "utf8"));
    const [app] = manifest.apps;
    for (const k of ["entry", "mime", "sdk", "fingerprint"]) delete app[k];
    app.native = { screen: "hello.home", abi: 1 };
    const file = join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    const args = ["--command", process.execPath, "--args", join(TEMPLATE, "server.mjs"), "--env", `BUWIZ_PLUGIN_MANIFEST=${file}`];
    const key = (await keygen(dir)).path;

    const first = await runJson([...args, "--sign-with", key, "--first-party"]);
    expect(first.rows.filter((r) => r.status === "fail")).toEqual([]);
    expect(first.code).toBe(0);
    for (const id of ["APP-01", "APP-02", "APP-03"])
      expect(
        first.rows.some((r) => r.id === id && r.status === "pass" && r.what.startsWith("hello: ")),
        id,
      ).toBe(true);
    expect(idsOf(first.rows, "skip")).toEqual(["APP-04"]);
    expect(first.rows.some((r) => /source check|text\/x-nsh-tsx/.test(r.what))).toBe(false);

    const not = await runJson([...args, "--sign-with", key]);
    expect(not.code).toBe(1);
    // the host refuses the manifest, so the install gate fails with it
    const refused = not.rows.filter((r) => r.status === "fail");
    expect(refused.map((r) => r.id).sort()).toEqual(["LCY-01", "MAN-07"]);
    for (const r of refused) expect(r.note).toContain("native screens are for first-party plugins only");
    expect(idsOf(not.rows, "pass")).toEqual(expect.arrayContaining(["MAN-15", "RSV-01", "RSV-02"]));
  },
  MINUTE,
);

test(
  "--first-party with BUWIZ_TRUST_FILE is a usage error: the store says which keys are first-party",
  async () => {
    const dir = tempDir();
    const store = join(dir, "trust.json");
    writeFileSync(store, JSON.stringify({ v: 1, publishers: {}, approved_plugins: [] }));
    const key = (await keygen(dir)).path;
    const done = await node(RUNNER, [...fixture("scoped-plugin.mjs"), "--sign-with", key, "--first-party"], { BUWIZ_TRUST_FILE: store });
    expect(done.code).toBe(2);
    expect(done.err).toContain("--first-party marks this run's own trust");
    expect(done.out).toBe("");
  },
  MINUTE,
);

test("the command-line tools start when run through a symlinked folder, as anything under $TMPDIR is on macOS", async () => {
  const link = join(tempDir(), "conformance");
  symlinkSync(join(RUNNER, "../.."), link);

  // with no arguments each prints its usage and exits non-zero: a tool that did not start would exit 0 silent
  const runner = await node(join(link, "bin/buwiz-plugin-test.mjs"), []);
  expect(runner.code).toBe(2);
  expect(runner.err).toContain("usage: buwiz-plugin-test");
  const signer = await node(join(link, "src/v1/sign-manifest.mjs"), []);
  expect(signer.code).toBe(1);
  expect(signer.err).toContain("usage: buwiz-sign-manifest");

  // and does its work: a key written through the link
  const dir = tempDir();
  const keygenDone = await node(join(link, "bin/buwiz-plugin-test.mjs"), ["--keygen", join(dir, "k.key")]);
  expect(keygenDone.code).toBe(0);
  expect(keygenDone.out).toMatch(/Public key: \S+/);
});
