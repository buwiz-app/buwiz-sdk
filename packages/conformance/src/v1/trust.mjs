// v1/trust.mjs — the trust store (spec 5.1): which publisher keys sign
// manifests and which plugins may be installed.
//
// The Bot owns the trust list (its server/src/v1/trust.json); this package
// ships none. BUWIZ_TRUST_FILE names the file to use (every test run writes
// its own, with a key it generated). The file is read on every use, so an
// edit takes effect at the next verification.
import { readFileSync } from "node:fs";
import { isObject, isString, parseIJson } from "./jcs.mjs";
import { fromB64u } from "./ed.mjs";

/** The trust file BUWIZ_TRUST_FILE names, else "" (there is no shipped one). */
export const TRUST_FILE = () => process.env.BUWIZ_TRUST_FILE || "";

/** {publishers: Map key_id -> {publisher, public_key, first_party}, approved: [{id,
 *  publisher_key_id}]}. A missing or broken file trusts nothing. */
export function loadTrust(file = TRUST_FILE()) {
  let raw = {};

  try {
    raw = parseIJson(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`  v1 trust store ${file}: ${String(e?.message || e).slice(0, 200)}`);
  }

  const publishers = new Map();

  for (const [keyId, p] of Object.entries(isObject(raw.publishers) ? raw.publishers : {}))
    if (isObject(p) && p.alg === "ed25519" && fromB64u(p.public_key, 32)) publishers.set(keyId, { publisher: String(p.publisher || ""), public_key: p.public_key, first_party: p.first_party === true });

  const approved = (Array.isArray(raw.approved_plugins) ? raw.approved_plugins : []).flatMap((a) =>
    isObject(a) && isString(a.id) && isString(a.publisher_key_id) ? [{ id: a.id, publisher_key_id: a.publisher_key_id }] : []);

  return { publishers, approved };
}

/** Whether plugin `id` signed by `keyId` is on the approved list. */
export const isApproved = (trust, id, keyId) => trust.approved.some((a) => a.id === id && a.publisher_key_id === keyId);
