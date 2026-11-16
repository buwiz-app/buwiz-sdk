#!/usr/bin/env node
// v1/sign-manifest.mjs — sign a plugin manifest with a publisher key (5.2).
//
//   buwiz-sign-manifest manifest.json --key-file publisher.key \
//        --app forms=dist/forms.tsx --app calendar=dist/calendar.tsx [--out signed.json]
//
// Fills each named app's `fingerprint` from its source bytes (11.2), then
// `signature` = ed25519 over the JCS bytes of the manifest without it. The
// key comes from a 0600 file holding the base64url seed. The seed is never
// printed; the signed manifest goes to --out or stdout.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isMain } from "./cli.mjs";
import { isObject, parseIJson } from "./jcs.mjs";
import { signManifest } from "./signing.mjs";

export { fingerprintOf, signManifest } from "./signing.mjs";

// A key file must be the owner's alone, as ssh insists for private keys.
function readKeyFile(path) {
  if (statSync(path).mode & 0o077) throw new Error(`${path} is readable by others; chmod 600 it`);

  return readFileSync(path, "utf8").trim();
}

function cli(argv) {
  const opts = { apps: {}, file: "", out: "", keyFile: "" };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--key-file") opts.keyFile = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--app") {
      const [id, path] = String(argv[++i]).split(/=(.*)/s);

      opts.apps[id] = readFileSync(path);
    } else opts.file = a;
  }

  if (!opts.file || !opts.keyFile) throw new Error("usage: buwiz-sign-manifest <manifest.json> --key-file <path> [--app <id>=<file>]... [--out <file>]");

  const m = parseIJson(readFileSync(opts.file, "utf8"));

  if (!isObject(m)) throw new Error("the manifest must be a JSON object");

  const seed = readKeyFile(opts.keyFile);
  const text = `${JSON.stringify(signManifest(m, seed, opts.apps), null, 2)}\n`;

  if (opts.out) writeFileSync(opts.out, text);
  else process.stdout.write(text);
}

if (isMain(import.meta.url))
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    console.error(`buwiz-sign-manifest: ${String(e?.message || e).slice(0, 300)}`);
    process.exit(1);
  }
