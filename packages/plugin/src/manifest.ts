// The manifest: its shape, the constants every mini app's manifest uses,
// the hashes the protocol takes of it, and the file a running plugin
// serves.
//
// A plugin builds its manifest in code (Plugin.manifest), so a TSX app's
// fingerprint is always the hash of the source this build serves. The
// `manifest` subcommand prints it as JCS text; the publisher signs that
// text, and the signed file is what the plugin serves at MANIFEST_URI,
// read again on every request. Without a signed file the unsigned manifest
// is served, and the Bot refuses it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Json, canonical, parseIJson, sha256Hex, sha256Jcs } from "./jcs";
import type { Tool } from "./server";

/** The protocol this SDK implements. A 2.0 host accepts 2.0.x only. */
export const PROTOCOL = "2.0.0";
export const MANIFEST_URI = "buwiz://manifest";
export const MANIFEST_MIME = "application/json";
/** A TSX app's entry is buwiz-app://<id>. */
export const APP_URI_PREFIX = "buwiz-app://";
export const APP_MIME = "text/x-nsh-tsx";
export const APP_SDK = "1";
/** A native screen's abi (first-party publishers only). */
export const NATIVE_ABI = 1;
/** The variable naming the signed manifest to serve. */
export const MANIFEST_ENV = "BUWIZ_PLUGIN_MANIFEST";

// The manifest's shape. The full rules and limits are the Bot's
// server/sdk/mini-app/docs/manifest.md; the conformance runner checks them.

export interface Manifest {
  protocol: typeof PROTOCOL;
  /** Reverse DNS; app.buwiz.<name> for Buwiz's own. */
  id: string;
  /** 2 to 16 of a-z and 0-9; every tool starts with `<short>_`. */
  short: string;
  /** Semver; raise it on every release. */
  version: string;
  title: string;
  description?: string;
  icon?: string;
  publisher: { id: string; key_id: string; name: string };
  commands?: Command[];
  scopes?: Scope[];
  routines?: Routine[];
  apps?: App[];
}

export interface Command {
  name: string;
  description: string;
  args?: string;
  /** One of your read-only tools. */
  resolve: string;
}

export interface Scope {
  name: string;
  description: string;
  resolve: string;
  attach?: boolean;
  hint?: string;
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  every_s: number;
  query: { tool: string; field: string; args?: Record<string, Json> };
  prompt: string;
  reads: { plugin: string; tools: string[] }[];
  writes?: string[];
}

interface AppCommon {
  id: string;
  title: string;
  description: string;
  props?: Record<string, Json>;
  placement: ("full" | "inline")[];
  inline?: { width: number; height: number; min_width?: number; min_height?: number; max_height?: number; resizable?: boolean };
  permissions?: Permissions;
}

/** A TSX screen the Bot compiles and runs. */
export interface TsxApp extends AppCommon {
  entry: string;
  mime: typeof APP_MIME;
  sdk: typeof APP_SDK;
  fingerprint: string;
}

/** A screen built into the Bot (first-party publishers only). */
export interface NativeApp extends AppCommon {
  native: { screen: string; abi: typeof NATIVE_ABI };
}

export type App = TsxApp | NativeApp;

export interface Permissions {
  tools?: string[];
  open?: { apps?: string[]; external?: string[] };
  attach?: string[];
  pick_file?: { extensions: string[]; max_bytes: number; multiple?: boolean };
  storage?: { quota_bytes?: number };
  copy?: true;
  preview?: { max_bytes?: number };
}

/** sha256:<hex> of an app source as served (apps[].fingerprint). */
export const fingerprint = (source: string): string => `sha256:${sha256Hex(source)}`;

/** The TSX fields of an app entry: entry, mime, sdk and fingerprint. */
export const tsx = (id: string, source: string): Pick<TsxApp, "entry" | "mime" | "sdk" | "fingerprint"> => ({
  entry: `${APP_URI_PREFIX}${id}`,
  mime: APP_MIME,
  sdk: APP_SDK,
  fingerprint: fingerprint(source),
});

/** sha256(JCS(permissions)) of an app entry, {} when absent. */
export const permissionsDigest = (app: { permissions?: unknown }): string => sha256Jcs(app.permissions ?? {});

/** The file name a signed manifest ships under, next to the executable. */
export const fileName = (pluginId: string): string => `${pluginId}.manifest.json`;

/** The manifest a running plugin serves. */
export class Served {
  readonly unsigned: string;

  constructor(
    readonly signed: string | undefined,
    unsigned: Manifest,
  ) {
    this.unsigned = canonical(unsigned);
  }

  /** MANIFEST_ENV when set, else <plugin id>.manifest.json next to the
   *  executable when it exists, else the unsigned manifest. */
  static fromEnv(pluginId: string, unsigned: Manifest): Served {
    const beside = join(dirname(process.execPath), fileName(pluginId));
    const signed = process.env[MANIFEST_ENV] || (existsSync(beside) ? beside : undefined);
    return new Served(signed, unsigned);
  }

  /** The manifest text this process serves. */
  text(): string {
    if (this.signed === undefined) return this.unsigned;
    try {
      return readFileSync(this.signed, "utf8");
    } catch (e) {
      // the path is the operator's; the error names the variable, not the file
      throw new Error(`${MANIFEST_ENV}: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
  }

  /** The served manifest, parsed as I-JSON. */
  value(): Manifest {
    const v = parseIJson(this.text());
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("the manifest is not a JSON object");
    return v as unknown as Manifest;
  }

  /** manifest_sha256: SHA-256 of the served manifest's JCS bytes. */
  sha256(): string {
    return sha256Jcs(this.value());
  }
}

/** An entry of the manifest's apps. */
export const app = (manifest: Manifest, id: string): App | undefined => manifest.apps?.find((a) => a.id === id);

/** The tools a routine's writes lets its turn call. */
export const routineWrites = (manifest: Manifest, routine: string): string[] => manifest.routines?.find((r) => r.id === routine)?.writes ?? [];

/** What a manifest gets wrong against the tools a plugin lists: the
 *  protocol, the tool prefix, and every tool a command, scope, routine or
 *  app names. The Bot's conformance runner checks everything; this is the
 *  quick local check for tests. */
export function problems(manifest: Manifest, tools: Tool[]): string[] {
  const out: string[] = [];
  if (manifest.protocol !== PROTOCOL) out.push(`protocol must be ${PROTOCOL}`);
  const prefix = `${manifest.short}_`;
  for (const tool of tools) if (!tool.name.startsWith(prefix)) out.push(`tool ${tool.name} must start with ${prefix}`);
  const named = (name: string, at: string, readOnly: boolean) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) out.push(`${at} names ${name}, which is not a tool`);
    else if (readOnly && !tool.readOnly) out.push(`${at} names ${name}, which is not read-only`);
  };
  for (const kind of ["commands", "scopes"] as const) manifest[kind]?.forEach((entry, i) => named(entry.resolve, `${kind}[${i}].resolve`, true));
  manifest.routines?.forEach((routine, i) => {
    named(routine.query.tool, `routines[${i}].query`, true);
    for (const name of routine.writes ?? []) named(name, `routines[${i}].writes`, false);
  });
  manifest.apps?.forEach((a, i) => {
    for (const name of a.permissions?.tools ?? []) named(name, `apps[${i}].permissions.tools`, false);
  });
  return out;
}
