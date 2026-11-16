// The Node template and its helper (lib/buwiz-plugin.mjs): the runner passes the template, the template's
// manifest names an example publisher, and the reserved session.open refuses malformed arguments.

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { b64u, generate, random128 } from "../src/v1/ed.mjs";
import { permsDigest, verifyManifest } from "../src/v1/manifest.mjs";
import { RUNNER, keygen, node, removeTempDirs, tempDir } from "./support";

afterAll(removeTempDirs);

const TEMPLATE = join(import.meta.dir, "../template");
const MINUTE = 60_000;

test("the template's manifest names an example publisher, not a release key", () => {
  const m = JSON.parse(readFileSync(join(TEMPLATE, "manifest.json"), "utf8")) as { id: string; publisher: { id: string; key_id: string; name: string } };
  expect(m.id).toBe("com.example.hello");
  expect(m.publisher).toEqual({ id: "com.example", key_id: "example-key-01", name: "Example Publisher" });
});

test(
  "the runner passes the template as shipped",
  async () => {
    const key = (await keygen(tempDir())).path;
    const done = await node(RUNNER, ["--command", process.execPath, "--args", join(TEMPLATE, "server.mjs"), "--sign-with", key]);
    expect(done.out.trimEnd().split("\n").pop()).toMatch(/^\d+ pass, 0 fail, 0 skipped: conforms$/);
    expect(done.code).toBe(0);
  },
  MINUTE,
);

test(
  "the helper's buwiz.session.open refuses a malformed open_id or ks_pub with invalid_args",
  async () => {
    const client = new Client({ name: "template-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [join(TEMPLATE, "server.mjs")], env: { PATH: process.env.PATH ?? "" } }));
    try {
      const text = ((await client.readResource({ uri: "buwiz://manifest" })).contents[0] as { text: string }).text;
      const manifest = JSON.parse(text);
      const seed = generate();
      await client.callTool({
        name: "buwiz.provision",
        arguments: { protocol: "1.0.0", plugin: manifest.id, key: { alg: "ed25519", seed: seed.seed }, pub: seed.pub },
      });
      const app = manifest.apps[0];
      const good = { app: app.id, open_id: random128(), ks_pub: generate().pub, perms_sha256: permsDigest(app.permissions), not_after: Date.now() + 3600_000 };
      const open = async (over: object) => client.callTool({ name: "buwiz.session.open", arguments: { ...good, ...over } });
      const code = (r: unknown) => {
        const { isError, structuredContent } = r as { isError?: boolean; structuredContent?: { code: string } };
        return isError ? structuredContent?.code : "ok";
      };
      expect(code(await open({}))).toBe("ok");
      for (const bad of [
        { open_id: "short" },
        { open_id: b64u(Buffer.alloc(17)) },
        { open_id: 7 },
        { open_id: `${random128()}=` },
        { ks_pub: "short" },
        { ks_pub: b64u(Buffer.alloc(31)) },
        { ks_pub: undefined },
      ]) {
        expect(code(await open(bad)), JSON.stringify(bad)).toBe("invalid_args");
      }
    } finally {
      await client.close();
    }
  },
  MINUTE,
);

test("a manifest of another protocol gets the one ordinary refusal", () => {
  const manifest = JSON.parse(readFileSync(join(TEMPLATE, "manifest.json"), "utf8"));
  const trust = { publishers: new Map(), approved: [] };
  for (const protocol of ["2.0.0", "2.1.0", "3.0.0", "0.9.0"]) {
    const run = () => verifyManifest(JSON.stringify({ ...manifest, protocol }), trust);
    expect(run).toThrow(`the plugin implements protocol ${protocol}; this Buwiz Bot supports 1.0`);
  }
  expect(() => verifyManifest(JSON.stringify({ ...manifest, protocol: "1.1.0" }), trust)).toThrow("needs a Buwiz Bot that supports 1.1");
});
