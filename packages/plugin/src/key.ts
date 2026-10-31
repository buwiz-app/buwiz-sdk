// The plugin key the Bot provisions, and base64url as the protocol writes
// keys, seeds, open ids and signatures (no padding).
//
// The Bot generates one ed25519 key per install and sends its seed in
// buwiz.provision, the first call of every spawn. The seed lives in a
// PluginKey and nowhere else: never written, logged, echoed or put in an
// error message (P4). node:crypto wants DER, so the raw seed is wrapped in
// the fixed PKCS#8 prefix for Ed25519 (RFC 8410).

import { type KeyObject, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { canonical } from "./jcs";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = 12;
const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Exactly `len` bytes of canonical base64url, else undefined. */
export function fromB64u(text: unknown, len: number): Buffer | undefined {
  if (typeof text !== "string" || !B64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length === len && b64u(bytes) === text ? bytes : undefined;
}

export class PluginKey {
  readonly #key: KeyObject;

  private constructor(seed: Buffer) {
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  }

  /** buwiz.provision's `key` and `pub`. The error never quotes either. */
  static fromProvision(args: Record<string, unknown>): PluginKey {
    const key = args.key as { alg?: unknown; seed?: unknown } | undefined;
    if (typeof key !== "object" || key === null) throw new Error("`key` must be {alg, seed}");
    if (key.alg !== "ed25519") throw new Error("`key.alg` must be ed25519");
    const seed = fromB64u(key.seed, 32);
    if (!seed) throw new Error("`key.seed` must be 32 bytes of base64url");
    const k = new PluginKey(seed);
    if (args.pub !== k.public()) throw new Error("the key and pub do not match");
    return k;
  }

  /** A key from its 32-byte seed (tests and vectors). */
  static fromSeed(seed: Uint8Array): PluginKey {
    return new PluginKey(Buffer.from(seed));
  }

  /** The public key, base64url. */
  public(): string {
    return b64u(createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX));
  }

  sameAs(other: PluginKey): boolean {
    return this.public() === other.public();
  }

  /** base64url signature over the JCS bytes of `value`. */
  sign(value: unknown): string {
    return b64u(sign(null, Buffer.from(canonical(value), "utf8"), this.#key));
  }

  // never printed, whatever prints it
  toJSON(): string {
    return "[PluginKey]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[PluginKey]";
  }
}
