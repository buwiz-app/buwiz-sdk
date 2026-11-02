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
//
// The signed manifest decides the block's protocol, id, short, version and
// publisher, and plugin.json's version: a template need not carry them, and
// its own values are replaced. The mini app's mcpServers entry must run
// ${PLUGIN_ROOT}/bin/<name>.

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
  const server = block.server;
  if (typeof server !== "string" || server === "") throw new Error("the template has no buwiz.server");
  // the signed manifest is the one source of what both signatures name
  const fromServed = fromManifest(readJson(join(out, fileName(id))), id);
  const version = fromServed.version;
  Object.assign(block, fromServed);

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

  plugin.version = version;
  const servers = (plugin.mcpServers ??= {}) as Obj;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error("mcpServers is not an object");
  const command = `\${PLUGIN_ROOT}/bin/${name}`;
  servers[server] ??= { command, args: ["mcp"] };
  checkServer(server, servers[server], command);
  return plugin;
}

/** The block fields the signed manifest decides: protocol, id, short,
 *  version and publisher ({id, key_id}). A template's own values for them
 *  are replaced. */
function fromManifest(served: Obj, id: string): Obj {
  if (served.protocol !== PROTOCOL) throw new Error(`the signed manifest's protocol is ${shown(served.protocol)}; this SDK packages ${PROTOCOL}`);
  if (served.id !== id) throw new Error(`the signed manifest's id is ${shown(served.id)}; this binary serves ${id}`);
  const text = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new Error(`the signed manifest has no ${what}`);
    return v;
  };
  const publisher = (served.publisher ?? {}) as Obj;
  return {
    protocol: PROTOCOL,
    id,
    short: text(served.short, "short"),
    version: text(served.version, "version"),
    publisher: { id: text(publisher.id, "publisher.id"), key_id: text(publisher.key_id, "publisher.key_id") },
  };
}

/** The mini app's mcpServers entry (§7.2): a stdio server whose command is
 *  the package's own binary, the path buwiz.binaries installs. */
function checkServer(server: string, value: unknown, command: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`mcpServers.${server} is not an object`);
  const entry = value as Obj;
  if (entry.command !== command) throw new Error(`mcpServers.${server}.command must be ${command}, the binary the package installs`);
  if ("url" in entry) throw new Error(`mcpServers.${server} is a stdio server: no url`);
  for (const key of ["type", "transport"]) {
    if (key in entry && entry[key] !== "stdio") throw new Error(`mcpServers.${server}.${key} must be stdio`);
  }
  if ("args" in entry && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) {
    throw new Error(`mcpServers.${server}.args must be strings`);
  }
  const env = entry.env;
  if ("env" in entry && !(typeof env === "object" && env !== null && !Array.isArray(env) && Object.values(env).every((v) => typeof v === "string"))) {
    throw new Error(`mcpServers.${server}.env must be an object of strings`);
  }
}

/** `<name> package <template> <out> <platform> [--published <plugin.json>]`:
 *  fill, then write <out>/plugin.unsigned.json. */
export function run(template: string, out: string, id: string, name: string, platform: string, published?: string): void {
  const plugin = fill(readJson(template), out, id, name, platform, published === undefined ? undefined : readJson(published));
  writeFileSync(join(out, UNSIGNED), `${JSON.stringify(plugin, null, 2)}\n`);
}
