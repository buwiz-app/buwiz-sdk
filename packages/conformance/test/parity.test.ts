// The Node modules this package carries (canonical JSON, ed25519, fingerprints, the permissions
// digest) give the SDK's own answers on vectors/. This is what lets the runner's host copy be
// replaced one day by the SDK's modules, or by the Rust broker's, without a change in bytes.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginKey, canonical, fingerprint, fromB64u, parseIJson, permissionsDigest } from "../../plugin/src";
import { generate, pubOf, sign, verify } from "../src/v1/ed.mjs";
import { isObject, parseIJson as hostParse, signedBytes } from "../src/v1/jcs.mjs";
import { permsDigest } from "../src/v1/manifest.mjs";
import { fingerprintOf } from "../src/v1/signing.mjs";

const VECTORS = join(import.meta.dir, "../../../vectors");
const read = (name: string) => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));

test("the host's canonical JSON gives every JCS vector's text or refusal, as the SDK does", () => {
  const { vectors } = read("jcs.json") as { vectors: { name: string; input: string; jcs?: string; signable?: boolean; error?: boolean }[] };
  expect(vectors.length).toBeGreaterThanOrEqual(15);
  for (const v of vectors) {
    if (v.error) {
      expect(() => hostParse(v.input), v.name).toThrow();
      expect(() => parseIJson(v.input), v.name).toThrow();
    } else if (v.signable) {
      const host = Buffer.from(signedBytes(hostParse(v.input)) as Uint8Array).toString("utf8");
      expect(host, v.name).toBe(v.jcs as string);
      expect(canonical(parseIJson(v.input)), v.name).toBe(host);
    } else {
      expect(() => signedBytes(hostParse(v.input)), v.name).toThrow();
      expect(() => canonical(parseIJson(v.input)), v.name).toThrow();
    }
  }
});

test("the host's ed25519, fingerprint and digest reproduce the signing vectors", () => {
  const v = read("signing.json");
  expect(pubOf(v.seed)).toBe(v.pub);
  expect(Buffer.from(signedBytes(v.cert) as Uint8Array).toString("utf8")).toBe(v.cert_jcs);
  expect(sign(v.seed, signedBytes(v.cert))).toBe(v.cert_sig);
  expect(verify(v.pub, signedBytes(v.cert), v.cert_sig)).toBe(true);
  expect(fingerprintOf(Buffer.from(v.app_source, "utf8"))).toBe(v.fingerprint);
  expect(permsDigest(v.app.permissions)).toBe(v.perms_sha256);
  expect(permsDigest(undefined)).toBe(v.perms_sha256_none);
});

test("host and SDK agree on keys and signatures made fresh", () => {
  for (let i = 0; i < 5; i++) {
    const k = generate();
    const key = PluginKey.fromSeed(fromB64u(k.seed, 32) as Buffer);
    expect(key.public()).toBe(k.pub);
    const value = { a: i, b: ["x", { c: null }], d: "é" };
    expect(key.sign(value)).toBe(sign(k.seed, signedBytes(value)));
  }
  const app = { permissions: { tools: ["x_y"] } };
  expect(permissionsDigest(app)).toBe(permsDigest(app.permissions));
  expect(fingerprint("source")).toBe(fingerprintOf(Buffer.from("source")));
  expect(isObject({})).toBe(true);
});
