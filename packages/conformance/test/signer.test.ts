// buwiz-sign-manifest with a throwaway key: the SDK's own code accepts what it signs,
// and rejects it after one changed byte. No Keychain.

import { afterAll, expect, test } from "bun:test";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginKey, b64u, canonical, fingerprint, fromB64u, parseIJson } from "../../plugin/src";
import { loadTrust } from "../src/v1/trust.mjs";
import { verifyManifest } from "../src/v1/manifest.mjs";
import { SIGNER, node, probeSays, removeTempDirs, tempDir } from "./support";

afterAll(removeTempDirs);

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const APP = "export default function Board() {\n  return null;\n}\n";

/** What the SDK itself makes of a signed manifest: its JCS bytes without the signature, checked with node:crypto. */
function sdkVerifies(signedText: string, pub: string): boolean {
  const { signature, ...body } = parseIJson(signedText) as { signature: { alg: string; value: string } } & Record<string, never>;
  const sig = fromB64u(signature.value, 64);
  const key = createPublicKey({ key: Buffer.concat([SPKI, fromB64u(pub, 32) as Buffer]), format: "der", type: "spki" });
  return sig !== undefined && verify(null, Buffer.from(canonical(body), "utf8"), key, sig);
}

/** A throwaway seed in a 0600 key file, and a manifest to sign (the probe plugin's, under a test key id). */
async function setup() {
  const dir = tempDir();
  const seed = randomBytes(32);
  const keyFile = join(dir, "test.key");
  writeFileSync(keyFile, `${b64u(seed)}\n`, { mode: 0o600 });
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, await probeSays(["manifest", "--key-id", "probe-test-01"]));
  writeFileSync(join(dir, "board.tsx"), APP);
  return { dir, keyFile, manifest, key: PluginKey.fromSeed(seed), seed: b64u(seed) };
}

test("a manifest signed with a throwaway key verifies with the SDK's own code", async () => {
  const { dir, keyFile, manifest, key } = await setup();
  const out = join(dir, "signed.json");
  const done = await node(SIGNER, [manifest, "--key-file", keyFile, "--app", `board=${join(dir, "board.tsx")}`, "--out", out]);
  expect(done.code).toBe(0);
  const text = readFileSync(out, "utf8");
  const signed = parseIJson(text) as { signature: { alg: string; key_id: string; value: string }; apps: { fingerprint: string }[] };
  expect(signed.signature.alg).toBe("ed25519");
  expect(signed.signature.key_id).toBe("probe-test-01");
  // the fingerprint is the SDK's, of the source bytes as given
  expect(signed.apps[0]?.fingerprint).toBe(fingerprint(APP));
  expect(sdkVerifies(text, key.public())).toBe(true);
  // and the signature is the SDK's own: ed25519 is deterministic, so the same key signs the same bytes alike
  const { signature, ...body } = signed;
  expect(signature.value).toBe(key.sign(body));
});

test("one changed byte is rejected", async () => {
  const { dir, keyFile, manifest, key } = await setup();
  const out = join(dir, "signed.json");
  await node(SIGNER, [manifest, "--key-file", keyFile, "--out", out]);
  const text = readFileSync(out, "utf8");
  expect(sdkVerifies(text, key.public())).toBe(true);
  expect(sdkVerifies(text.replace('"Probe"', '"Probf"'), key.public())).toBe(false);
  // another key's public half does not verify it either
  expect(sdkVerifies(text, PluginKey.fromSeed(randomBytes(32)).public())).toBe(false);
});

test("the host code in this package accepts the signed manifest under a trust file, and refuses a changed byte", async () => {
  const { dir, keyFile, manifest, key } = await setup();
  const out = join(dir, "signed.json");
  await node(SIGNER, [manifest, "--key-file", keyFile, "--out", out]);
  const trustFile = join(dir, "trust.json");
  const trust = {
    v: 1,
    publishers: { "probe-test-01": { publisher: "com.example", alg: "ed25519", public_key: key.public() } },
    approved_plugins: [{ id: "com.example.probe", publisher_key_id: "probe-test-01" }],
  };
  writeFileSync(trustFile, JSON.stringify(trust));
  const text = readFileSync(out, "utf8");
  expect(verifyManifest(text, loadTrust(trustFile)).manifest.id).toBe("com.example.probe");
  expect(() => verifyManifest(text.replace('"Probe"', '"Probf"'), loadTrust(trustFile))).toThrow();
});

test("a key file others can read is refused, and the seed is never printed", async () => {
  const { dir, keyFile, manifest, seed } = await setup();
  chmodSync(keyFile, 0o644);
  const done = await node(SIGNER, [manifest, "--key-file", keyFile, "--out", join(dir, "signed.json")]);
  expect(done.code).toBe(1);
  expect(done.err).toContain("chmod 600");
  expect(done.out + done.err).not.toContain(seed);
});

test("without --out the signed manifest goes to stdout", async () => {
  const { keyFile, manifest, key } = await setup();
  const done = await node(SIGNER, [manifest, "--key-file", keyFile]);
  expect(done.code).toBe(0);
  expect(sdkVerifies(done.out, key.public())).toBe(true);
});
