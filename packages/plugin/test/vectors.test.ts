// The shared vectors (vectors/) the Rust and TypeScript halves must both
// reproduce byte for byte: RFC 8785 text from the Bot, and the signing
// vectors the Rust half wrote.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JcsError, PluginKey, canonical, fingerprint, fromB64u, parseIJson, permissionsDigest } from "../src";

const VECTORS = join(import.meta.dir, "../../../vectors");
const read = (name: string) => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));

test("every JCS vector gives its text or its refusal", () => {
  const { vectors } = read("jcs.json") as { vectors: { name: string; input: string; jcs?: string; signable?: boolean; error?: boolean }[] };
  expect(vectors.length).toBeGreaterThanOrEqual(15);
  for (const v of vectors) {
    if (v.error) {
      expect(() => parseIJson(v.input), v.name).toThrow(JcsError);
    } else if (v.signable) {
      expect(canonical(parseIJson(v.input)), v.name).toBe(v.jcs as string);
    } else {
      expect(() => canonical(parseIJson(v.input)), v.name).toThrow(JcsError);
    }
  }
});

test("the signing vectors are reproduced", () => {
  const v = read("signing.json");
  const key = PluginKey.fromSeed(fromB64u(v.seed, 32) as Buffer);
  expect(key.public()).toBe(v.pub);
  expect(canonical(v.cert)).toBe(v.cert_jcs);
  expect(key.sign(v.cert)).toBe(v.cert_sig);
  expect(fingerprint(v.app_source)).toBe(v.fingerprint);
  expect(permissionsDigest(v.app)).toBe(v.perms_sha256);
  expect(permissionsDigest({})).toBe(v.perms_sha256_none);
});

test("a key never prints its seed", () => {
  const v = read("signing.json");
  const key = PluginKey.fromSeed(fromB64u(v.seed, 32) as Buffer);
  expect(JSON.stringify({ key })).not.toContain(v.seed);
  expect(Bun.inspect(key)).not.toContain(v.seed);
});
