// JSON Canonicalization Scheme (RFC 8785) and I-JSON parsing, as the Buwiz
// Bot's broker writes them (server/src/v1/jcs.mjs).
//
// Every signed object (the manifest, session certificates) is signed over
// its JCS bytes. Signed objects carry safe integers only, so the signing
// form refuses any other number. JSON.parse keeps the last of duplicate
// keys; I-JSON (RFC 7493) refuses them, so manifests are parsed with
// parseIJson. Checked against vectors/jcs.json, as the Rust half is.

import { createHash } from "node:crypto";

export class JcsError extends Error {}

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// A string with a lone surrogate is not I-JSON (RFC 7493 2.1).
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function str(s: string): string {
  if (LONE.test(s)) throw new JcsError("a string holds a lone surrogate");
  return JSON.stringify(s);
}

function canon(v: unknown, integersOnly: boolean): string {
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new JcsError("NaN and Infinity have no JSON form");
    if (integersOnly && !Number.isSafeInteger(v)) throw new JcsError(`signed objects carry safe integers only, not ${v}`);
    // ECMAScript Number serialization is RFC 8785's number form (3.2.2.3)
    return JSON.stringify(v);
  }
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, integersOnly)).join(",")}]`;
  if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const o = v as Record<string, unknown>;
    // keys sort by UTF-16 code units, which is what Array.prototype.sort does
    const keys = Object.keys(o).sort();
    return `{${keys.map((key) => `${str(key)}:${canon(o[key], integersOnly)}`).join(",")}}`;
  }
  throw new JcsError(`${typeof v} has no JSON form`);
}

/** RFC 8785 text of any JSON value. */
export const canonicalize = (v: unknown): string => canon(v, false);

/** RFC 8785 text of a value about to be signed or hashed: safe integers
 *  only, anything else throws JcsError. */
export const canonical = (v: unknown): string => canon(v, true);

/** Lowercase hex SHA-256. */
export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Lowercase hex SHA-256 of the JCS bytes of `v`. */
export const sha256Jcs = (v: unknown): string => sha256Hex(canonical(v));

// ── I-JSON parsing (duplicate keys refused) ─────────────────────────────

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// oxlint-disable-next-line no-control-regex -- JSON forbids raw control characters in strings
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/** JSON text → value, refusing duplicate keys, lone surrogates and any
 *  malformed input with JcsError. */
export function parseIJson(text: string): Json {
  let i = 0;
  const fail = (why: string): never => {
    throw new JcsError(`${why} at offset ${i}`);
  };
  const skip = () => {
    while (WS.has(text[i] ?? "")) i++;
  };
  const lex = (re: RegExp): string => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return fail("malformed JSON");
    i += m[0].length;
    return m[0];
  };
  const string = (): string => {
    const s = JSON.parse(lex(STRING)) as string;
    if (LONE.test(s)) fail("a string holds a lone surrogate");
    return s;
  };
  const list = (close: string, item: () => void) => {
    i++;
    skip();
    if (text[i] === close) return void i++;
    for (;;) {
      item();
      skip();
      if (text[i] === close) return void i++;
      if (text[i] !== ",") fail(`expected , or ${close}`);
      i++;
      skip();
    }
  };
  const value = (depth: number): Json => {
    if (depth > 512) fail("nested too deep");
    skip();
    const c = text[i];
    if (c === "{") {
      const o: { [key: string]: Json } = {};
      list("}", () => {
        if (text[i] !== '"') fail("expected a key");
        const key = string();
        if (Object.hasOwn(o, key)) fail(`duplicate key ${JSON.stringify(key).slice(0, 80)}`);
        skip();
        if (text[i] !== ":") fail("expected :");
        i++;
        // defineProperty: a "__proto__" key is data, not the prototype
        Object.defineProperty(o, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
      });
      return o;
    }
    if (c === "[") {
      const a: Json[] = [];
      list("]", () => a.push(value(depth + 1)));
      return a;
    }
    if (c === '"') return string();
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    return Number(lex(NUMBER));
  };
  const v = value(0);
  skip();
  if (i !== text.length) fail("trailing text");
  return v;
}
