// v1/keystore.mjs — where the runner keeps plugin private keys (spec 5.4).
//
// One ed25519 seed per plugin, one 0600 file per plugin id in a directory.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isV1 } from "../grammar.mjs";
import { fromB64u } from "./ed.mjs";

const checkId = (id) => {
  if (!isV1("pluginId", id)) throw new Error(`not a plugin id: ${String(id).slice(0, 80)}`);
};

const checkSeed = (seed) => {
  if (!fromB64u(seed, 32)) throw new Error("a plugin key seed is 32 bytes of base64url");
};

/** A keystore of `<dir>/<plugin id>.key` files. */
export function fileKeystore(dir) {
  const path = (id) => join(dir, `${id}.key`);

  return {
    async put(id, seed) {
      checkId(id);
      checkSeed(seed);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path(id), seed, { mode: 0o600 });
      chmodSync(path(id), 0o600);
    },
    async get(id) {
      checkId(id);

      return existsSync(path(id)) ? readFileSync(path(id), "utf8").trim() : null;
    },
    async remove(id) {
      checkId(id);
      rmSync(path(id), { force: true });
    },
  };
}
