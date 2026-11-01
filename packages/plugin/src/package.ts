// A release's plugin.json (protocol 1.0 §7): `<name> package` fills a
// template's buwiz.files and buwiz.binaries with each file's SHA-256 and
// writes plugin.unsigned.json for `buwiz-broker sign-manifest --block buwiz`
// to sign.
//
// The out folder holds this platform's binary as <name>-<platform> and the
// signed manifest as <plugin id>.manifest.json. The package installs them at
// bin/<name> and bin/<plugin id>.manifest.json, where Served.fromEnv finds
// the manifest without a setting. Other files the template lists
// (buwiz.files: install path → {asset}) get their SHA-256 too.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./jcs";
import { PROTOCOL, fileName } from "./manifest";

/** The file `<name> package` writes into the out folder. */
export const UNSIGNED = "plugin.unsigned.json";

/** A release asset name for this platform's binary. */
export const binaryAsset = (name: string, platform: string): string => `${name}-${platform}`;

/** <os>-<arch> as Rust names them, e.g. macos-aarch64. */
export const validPlatform = (platform: string): boolean => /^[a-z0-9_]+-[a-z0-9_]+$/.test(platform);

type Obj = Record<string, unknown>;

const sha256File = (path: string): string => {
  try {
    return sha256Hex(readFileSync(path));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
};

const readJson = (path: string): Obj => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Obj;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const shown = (v: unknown): string => JSON.stringify(v ?? null);

/** `template` filled for the plugin `id` (binary `name`) on `platform`, from
 *  the files in `out`. With `published` (another platform's plugin.json of
 *  the same version) its binaries are kept and this platform's is added.
 *  Throws an Error naming what would not install. */
export function fill(template: Obj, out: string, id: string, name: string, platform: string, published?: Obj): Obj {
  if (!validPlatform(platform)) throw new Error(`platform ${JSON.stringify(platform)} is not <os>-<arch>`);
  const plugin = structuredClone(template);
  const block = plugin.buwiz as Obj | undefined;
  if (typeof block !== "object" || block === null || Array.isArray(block)) throw new Error("the template has no buwiz block");
  if (block.protocol !== PROTOCOL) throw new Error(`buwiz.protocol must be ${PROTOCOL}`);
  if (block.id !== id) throw new Error(`buwiz.id must be ${id}`);
  const served = readJson(join(out, fileName(id)));
  for (const key of ["id", "short", "version"]) {
    if (!same(block[key], served[key])) throw new Error(`buwiz.${key} is ${shown(block[key])}; the signed manifest's is ${shown(served[key])}`);
  }
  if (!same((block.publisher as Obj | undefined)?.key_id, (served.publisher as Obj | undefined)?.key_id)) {
    throw new Error("buwiz.publisher.key_id differs from the signed manifest's");
  }
  const version = block.version;
  const server = block.server;
  if (typeof server !== "string" || server === "") throw new Error("the template has no buwiz.server");

  const manifestName = fileName(id);
  const files: Obj = { [`bin/${manifestName}`]: { asset: manifestName, sha256: sha256File(join(out, manifestName)) } };
  for (const [path, entry] of Object.entries((block.files as Obj | undefined) ?? {})) {
    if (path === "plugin.json" || path.startsWith("bin/")) throw new Error(`buwiz.files cannot list ${path}`);
    const asset = (entry as Obj | undefined)?.asset;
    if (typeof asset !== "string") throw new Error(`buwiz.files[${path}] names no asset`);
    if (asset.includes("/")) throw new Error(`buwiz.files[${path}].asset ${JSON.stringify(asset)} is not a flat asset name`);
    files[path] = { asset, sha256: sha256File(join(out, asset)) };
  }

  const binaries: Obj = {};
  if (published) {
    const old = (published.buwiz ?? {}) as Obj;
    if (!same(old.version, version)) throw new Error(`the published plugin.json is ${shown(old.version)}, this build is ${shown(version)}`);
    if (!same(old.files, files)) throw new Error("the published files differ from this build's: release a new version");
    Object.assign(binaries, old.binaries ?? {});
  }
  const asset = binaryAsset(name, platform);
  binaries[platform] = { path: `bin/${name}`, asset, sha256: sha256File(join(out, asset)) };
  block.files = files;
  block.binaries = Object.fromEntries(Object.entries(binaries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  delete block.signature;

  if (!same(plugin.version, version)) throw new Error("plugin.json's version must equal buwiz.version");
  const servers = (plugin.mcpServers ??= {}) as Obj;
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("mcpServers is not an object");
  servers[server] ??= { command: `\${PLUGIN_ROOT}/bin/${name}`, args: ["mcp"] };
  return plugin;
}

/** `<name> package <template> <out> <platform> [--published <plugin.json>]`:
 *  fill, then write <out>/plugin.unsigned.json. */
export function run(template: string, out: string, id: string, name: string, platform: string, published?: string): void {
  const plugin = fill(readJson(template), out, id, name, platform, published === undefined ? undefined : readJson(published));
  writeFileSync(join(out, UNSIGNED), `${JSON.stringify(plugin, null, 2)}\n`);
}
