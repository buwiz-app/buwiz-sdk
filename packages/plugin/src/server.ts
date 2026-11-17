// MCP over stdio: JSON-RPC 2.0, one message per line.
//
// Methods: initialize, ping, tools/list, tools/call, resources/list,
// resources/templates/list, resources/read. Notifications get no answer.
// Resources (the manifest and the TSX app sources) are readable before
// buwiz.provision; tools are not (P7).
//
// The reserved tools are answered here: buwiz.provision,
// buwiz.session.open, buwiz.session.close, buwiz.ticket.resolve,
// buwiz.uninstall, buwiz.account.set and buwiz.account.clear; any other
// buwiz.* name is -32601. Pushed account tokens stay in memory and reach a
// tool through Caller.account. Before a plugin's own
// tool runs, Server checks its caller against the served manifest (see
// Server.authorize).
//
// Nothing is logged: no argument, no subject and never the key (P4).

import { createInterface } from "node:readline";
import { type Account, Accounts } from "./accounts";
import { type Json } from "./jcs";
import { fromB64u, PluginKey } from "./key";
import * as manifest from "./manifest";
import type { Manifest } from "./manifest";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/** The MCP revision this server speaks (the broker's). */
export const MCP_PROTOCOL = "2025-11-25";

export const RESERVED = [
  "buwiz.provision",
  "buwiz.session.open",
  "buwiz.session.close",
  "buwiz.ticket.resolve",
  "buwiz.uninstall",
  "buwiz.account.set",
  "buwiz.account.clear",
] as const;

/** The longest session a certificate may cover: 8 hours. */
export const CERT_MAX_MS = 8 * 3600 * 1000;

/** A tool's arguments. */
export type Args = Record<string, Json>;

/** A tool result (MCP CallToolResult). */
export interface Result {
  content: { type: "text"; text: string }[];
  structuredContent?: Json;
  isError: boolean;
  _meta?: Record<string, Json>;
}

/** A tool result whose structuredContent is `data`. */
export const ok = (data: Json): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });

/** A refusal with a protocol error code (not_found, invalid_args,
 *  permission_denied…). The message is user-facing, comes first, and
 *  carries no subject data. */
export const fail = (code: string, message: string): Result => ({
  content: [{ type: "text", text: message }],
  structuredContent: { code, message },
  isError: true,
});

/** One of the plugin's own tools, as tools/list shows it. */
export interface Tool {
  /** <short>_<name>. */
  name: string;
  /** What the model reads to choose it. */
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, Json>;
  /** Changes nothing. Resolve tools, a routine's query and a routine's turn
   *  may call only read-only tools (and a routine's declared writes). */
  readOnly: boolean;
  /** The tool's `_meta`, shown in tools/list as given (a `buwiz/press` opt-in
   *  whose `describe` names no read-only tool of the list is left out); absent
   *  leaves the key out. `withAudience` and `withPress` write into it. */
  _meta?: Record<string, Json>;
}

/** What an approved AI press does (spec 16.5). */
export type PressEffect = "post" | "close";

const withMeta = (tool: Tool, key: string, value: Json): Tool => ({ ...tool, _meta: { ...tool._meta, [key]: value } });

/** `tool` with `_meta["buwiz/audience"]` set to `words` ("agent", "widget";
 *  spec 16.4), always as an array.
 *
 *  Naming "agent" on a tool that is not read-only does more than list it for
 *  the model: by spec 16.5 the AI's press on an app's screen may then run that
 *  write with no Allow card. When the person should be asked each time, leave
 *  "agent" out and opt in with `withPress`. */
export const withAudience = (tool: Tool, words: string[]): Tool => withMeta(tool, "buwiz/audience", [...words]);

/** `tool` opted in to the AI's press: `_meta["buwiz/press"]` is
 *  `{approved: true, effect, describe}` (spec 16.5), and the person gets an
 *  Allow card each time. `describe` names a read-only tool of the plugin;
 *  tools/list leaves the opt-in out (and writes a line to stderr) when it is
 *  empty or names no read-only tool of the list.
 *
 *  A plugin MUST NOT opt in a tool that files, submits, sends, pays, voids or
 *  reopens, whatever it is called (P5, spec 16.5); the host's name rule is only
 *  a backstop. */
export const withPress = (tool: Tool, effect: PressEffect, describe: string): Tool => withMeta(tool, "buwiz/press", { approved: true, effect, describe });

/** The `_meta` tools/list shows for `tool`: its press opt-in is dropped, with a
 *  line on stderr, unless `describe` names a read-only tool of `tools`. */
function listedMeta(tool: Tool, tools: Tool[]): Record<string, Json> | undefined {
  if (!tool._meta) return undefined;
  const meta = { ...tool._meta };
  if ("buwiz/press" in meta) {
    const press = meta["buwiz/press"];
    const describe = press && typeof press === "object" && !Array.isArray(press) ? press.describe : undefined;
    const target = typeof describe === "string" && describe !== "" ? tools.find((t) => t.name === describe) : undefined;
    const why =
      typeof describe !== "string" || describe === ""
        ? "describe is empty"
        : !target
          ? "describe names no tool of the plugin"
          : !target.readOnly
            ? "describe names a tool that is not read-only"
            : "";
    if (why) {
      console.error(`${tool.name}: buwiz/press left out, ${why}`);
      delete meta["buwiz/press"];
    }
  }
  return Object.keys(meta).length ? meta : undefined;
}

/** Who asked: _meta["buwiz/caller"]. "unknown": the broker sent none, or an
 *  origin this library does not know; it only reads. */
export type Origin = "app" | "agent" | "routine" | "resolve" | "widget" | "unknown";

/** The record of an AI's press: _meta["buwiz/caller"].press (spec 16.5). Only
 *  the host sets it, on a call the person did not make. */
export type Press =
  | { by: "ai"; who: string }
  | {
      by: "ai_approved";
      who: string;
      approvedBy: string;
      /** The one-time id of the press. */
      once: string;
      /** "sha256:" and 64 hex digits over the JCS bytes of the call's args. */
      argsHash: string;
      /** The same over the card the person saw. */
      shownHash: string;
      /** When the person said yes, in unix ms. */
      at: number;
    };

export interface Caller {
  origin: Origin;
  /** The app, for "app". */
  app?: string;
  /** The open the app call came from, for "app". */
  openId?: string;
  /** The routine whose turn or query this is. */
  routine?: string;
  /** The widget's name (R37), for "widget" (spec 16.4). */
  widget?: string;
  /** The record of the AI's press, when the AI made the call (spec 16.5). An
   *  "app" call that has one is a read the AI made, not the person's act. */
  press?: Press;
  /** `account`'s live token: its "default" sign-in, else any live one.
   *  undefined: answer accountRequired(account) so the host asks the person
   *  to sign in. */
  account(account: string): Account | undefined;
}

function pressOf(record: unknown): Press | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const r = record as Record<string, unknown>;
  const text = (key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
  const who = text("who");
  if (who === undefined) return undefined;
  if (r.by === "ai") return { by: "ai", who };
  const [approvedBy, once, argsHash, shownHash] = [text("approved_by"), text("once"), text("args_hash"), text("shown_hash")];
  const at = r.at;
  if (r.by !== "ai_approved" || approvedBy === undefined || once === undefined || argsHash === undefined || shownHash === undefined) return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return undefined;
  return { by: "ai_approved", who, approvedBy, once, argsHash, shownHash, at };
}

/** Whether a tools/call names a caller at all: _meta["buwiz/caller"] is there
 *  and not null, whatever it says. The host's own reserved calls name none. */
function callerNamed(params: Record<string, unknown>): boolean {
  const named = (params._meta as Record<string, unknown> | undefined)?.["buwiz/caller"];
  return named !== undefined && named !== null;
}

export function callerOf(params: Record<string, unknown>, accounts: Accounts = new Accounts()): Caller {
  const c = (params._meta as Record<string, unknown> | undefined)?.["buwiz/caller"] as Record<string, unknown> | undefined;
  const text = (key: string) => (typeof c?.[key] === "string" ? (c[key] as string) : undefined);
  const o = text("origin");
  const origin: Origin = o === "app" || o === "agent" || o === "routine" || o === "resolve" || o === "widget" ? o : "unknown";
  return {
    origin,
    app: text("app"),
    openId: text("open_id"),
    routine: text("routine"),
    widget: text("widget"),
    press: pressOf(c?.press),
    account: (id: string) => accounts.get(id),
  };
}

/** A mini app's own half: its manifest, app sources and tools. Server does
 *  the rest. */
export interface Plugin {
  /** The plugin id: reverse DNS, app.buwiz.<name> for Buwiz's own. */
  readonly id: string;
  /** The MCP server name (serverInfo.name), e.g. the binary's name. */
  readonly name: string;
  /** The MCP server version (serverInfo.version). */
  readonly version: string;
  /** The publisher key id a release manifest is signed under. */
  readonly releaseKeyId: string;
  /** MCP instructions: approved text the model reads. */
  readonly instructions?: string;
  /** The unsigned manifest under publisher key id `keyId`. */
  manifest(keyId: string): Manifest;
  /** A TSX app's source exactly as served; undefined for a native screen or
   *  an unknown id. */
  appSource?(id: string): string | undefined;
  /** The plugin's own tools, in tools/list order. */
  tools(): Tool[];
  /** Run one of tools(). The caller has been checked against the served
   *  manifest; checks of your own subjects are yours (P1). */
  call(tool: string, args: Args, caller: Caller): Result | Promise<Result>;
  /** buwiz.ticket.resolve: the title of a ticket this plugin issued, never
   *  its subject. */
  ticketTitle(ticket: string): string | undefined;
  /** buwiz.uninstall: forget every ticket and subject. */
  uninstall(): void;
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class Server<P extends Plugin = Plugin> {
  #key: PluginKey | undefined;
  /** open_id -> app id, for opens this process certified. */
  readonly #sessions = new Map<string, string>();
  /** Tokens the host pushed (buwiz.account.set). */
  readonly #accounts = new Accounts();

  constructor(
    readonly plugin: P,
    readonly served: manifest.Served = manifest.Served.fromEnv(plugin.id, plugin.manifest(plugin.releaseKeyId)),
  ) {}

  /** One line in; the line to answer, if any. */
  async handleLine(line: string): Promise<string | undefined> {
    if (!line.trim()) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return JSON.stringify(errorResponse(null, PARSE_ERROR, "parse error"));
    }
    const reply = await this.handle(message);
    return reply === undefined ? undefined : JSON.stringify(reply);
  }

  /** One JSON-RPC message; undefined for a notification. */
  async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return errorResponse(null, INVALID_REQUEST, "expected a single JSON-RPC object");
    }
    const m = message as Record<string, unknown>;
    const id = m.id as Json | undefined;
    if (typeof m.method !== "string") return id === undefined ? undefined : errorResponse(id, INVALID_REQUEST, "missing method");
    if (id === undefined) return undefined;
    const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
    let reply: Reply;
    try {
      reply = { result: await this.#method(m.method, params) };
    } catch (e) {
      reply = e instanceof RpcError ? { error: { code: e.code, message: e.message } } : { error: { code: INVALID_PARAMS, message: (e as Error).message } };
    }
    return { jsonrpc: "2.0", id, ...reply };
  }

  async #method(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: MCP_PROTOCOL,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: this.plugin.name, version: this.plugin.version },
          ...(this.plugin.instructions ? { instructions: this.plugin.instructions } : {}),
        };
      case "ping":
        return {};
      case "tools/list": {
        const tools = this.plugin.tools();
        return {
          tools: [
            ...RESERVED.map((name) => ({ name, description: "Reserved for the Buwiz Bot.", inputSchema: { type: "object" } })),
            ...tools.map((t) => {
              const meta = listedMeta(t, tools);
              return {
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                annotations: { readOnlyHint: t.readOnly },
                ...(meta ? { _meta: meta } : {}),
              };
            }),
          ],
        };
      }
      case "tools/call":
        return this.#toolsCall(params);
      case "resources/list":
        return { resources: this.#resources() };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read":
        return this.#read(params);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method.slice(0, 60)}`);
    }
  }

  async #toolsCall(params: Record<string, unknown>): Promise<Result> {
    const name = params.name;
    if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call requires params.name");
    const raw = params.arguments ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("invalid_args", "arguments must be a JSON object");
    const args = raw as Args;
    if (name.startsWith("buwiz.")) {
      // the host's own calls, which carry no caller: one that names a caller,
      // whoever it says it is, is not the host's
      if (callerNamed(params)) return fail("permission_denied", "a reserved tool is the host's own to call");
      return this.#reserved(name, args);
    }
    // P7: nothing before a successful provision
    if (!this.#key) throw new RpcError(INVALID_REQUEST, "buwiz.provision must come first");
    const tool = this.plugin.tools().find((t) => t.name === name);
    if (!tool) throw new RpcError(INVALID_PARAMS, "no such tool");
    const caller = callerOf(params, this.#accounts.snapshot());
    const refusal = this.authorize(tool, caller);
    if (refusal) return fail("permission_denied", refusal);
    try {
      return await this.plugin.call(name, args, caller);
    } catch (e) {
      // the error may quote a subject: stderr only when asked (P4)
      if (process.env.BUWIZ_PLUGIN_DEBUG === "1") console.error(e);
      return fail("internal", `${name} failed.`);
    }
  }

  /** The checks every plugin makes before its own tool runs; the refusal,
   *  or undefined to go ahead:
   *
   *  - a call through an app, the person's or the AI's (any call that names
   *    an app or an open, whatever its origin), comes from an open this
   *    process certified for that app, and names a tool in the app's
   *    permissions.tools;
   *  - a resolve, a routine's query and a caller this library does not know
   *    only read;
   *  - a routine's turn only reads, or calls a write its routine declares;
   *  - a generated widget reaches only a tool whose audience names "widget"
   *    (spec 16.4), read or write, and its call names no app, open or press. */
  authorize(tool: Tool, caller: Caller): string | undefined {
    const served = this.served.value();
    if (caller.origin === "widget") {
      if (caller.app !== undefined || caller.openId !== undefined || caller.press !== undefined) return "a widget's call names no app, open or press";
      const audience = tool._meta?.["buwiz/audience"];
      if (!Array.isArray(audience) || !audience.includes("widget")) return `${tool.name} is not offered to widgets`;
    }
    if (caller.origin === "app" || caller.app !== undefined || caller.openId !== undefined) {
      if (!caller.app) return "an app call names no app";
      if (this.#sessions.get(caller.openId ?? "") !== caller.app) return "this app open was not certified by this plugin";
      const entry = manifest.app(served, caller.app);
      if (!entry) return "no such app";
      if (!(entry.permissions?.tools ?? []).includes(tool.name)) return `${tool.name} is not in this app's permissions`;
    }
    if (tool.readOnly) return undefined;
    if (caller.origin === "resolve" || caller.origin === "routine" || caller.origin === "unknown") return `${tool.name} changes data, so it does not run here`;
    if (caller.routine !== undefined && !manifest.routineWrites(served, caller.routine).includes(tool.name)) {
      return `${tool.name} is not a write this routine declares`;
    }
    return undefined;
  }

  #reserved(name: string, args: Args): Result {
    if (!(RESERVED as readonly string[]).includes(name)) throw new RpcError(METHOD_NOT_FOUND, "not a reserved tool of this plugin");
    if (name === "buwiz.provision") return this.#provision(args);
    if (!this.#key) throw new RpcError(INVALID_REQUEST, "buwiz.provision must come first");
    switch (name) {
      case "buwiz.session.open":
        return this.#sessionOpen(args, Date.now());
      case "buwiz.session.close":
        if (typeof args.open_id === "string") this.#sessions.delete(args.open_id);
        return ok({ ok: true });
      case "buwiz.ticket.resolve": {
        const title = this.plugin.ticketTitle(typeof args.ticket === "string" ? args.ticket : "");
        return ok(title === undefined ? { valid: false } : { valid: true, title: [...title].slice(0, 120).join("") });
      }
      case "buwiz.account.set":
        return this.#accounts.set(args);
      case "buwiz.account.clear":
        return this.#accounts.clear(args);
      default:
        this.plugin.uninstall();
        this.#sessions.clear();
        this.#accounts.forget();
        return ok({ ok: true });
    }
  }

  #provision(args: Args): Result {
    if (args.plugin !== this.plugin.id) return fail("invalid_args", `this is ${this.plugin.id}`);
    // `protocol` is not checked: the Bot decides compatibility from the
    // manifest's `protocol`
    let key: PluginKey;
    try {
      key = PluginKey.fromProvision(args);
    } catch (e) {
      return fail("invalid_args", (e as Error).message);
    }
    if (this.#key && !this.#key.sameAs(key)) return fail("invalid_args", "already provisioned with another key");
    let sha256: string;
    try {
      sha256 = this.served.sha256();
    } catch (e) {
      return fail("manifest_invalid", (e as Error).message);
    }
    this.#key = key;
    return ok({ ok: true, manifest_sha256: sha256 });
  }

  #sessionOpen(args: Args, now: number): Result {
    const { app, open_id: openId, ks_pub: ksPub, perms_sha256: perms, not_after: notAfter } = args;
    if (typeof app !== "string") return fail("invalid_args", "`app` must be a string");
    if (!fromB64u(openId, 16)) return fail("invalid_args", "`open_id` must be 128 bits of base64url");
    if (!fromB64u(ksPub, 32)) return fail("invalid_args", "`ks_pub` must be a 32-byte ed25519 key in base64url");
    if (typeof perms !== "string") return fail("invalid_args", "`perms_sha256` must be a string");
    if (!Number.isSafeInteger(notAfter)) return fail("invalid_args", "`not_after` must be an integer (unix ms)");
    if ((notAfter as number) <= now || (notAfter as number) > now + CERT_MAX_MS) return fail("invalid_args", "not_after must be within 8 h");
    let served: Manifest;
    try {
      served = this.served.value();
    } catch (e) {
      return fail("manifest_invalid", (e as Error).message);
    }
    const entry = manifest.app(served, app);
    if (!entry) return fail("invalid_args", `no app ${app.slice(0, 60)}`);
    if (manifest.permissionsDigest(entry) !== perms) return fail("invalid_args", "perms_sha256 does not match the manifest");
    const cert = {
      v: 1,
      typ: "buwiz-session",
      plugin: this.plugin.id,
      app,
      open_id: openId as string,
      ks_pub: ksPub as string,
      perms_sha256: perms,
      not_after: notAfter as number,
    };
    const certSig = (this.#key as PluginKey).sign(cert);
    this.#sessions.set(openId as string, app);
    return ok({ cert, cert_sig: certSig });
  }

  #resources() {
    const tsx = (this.plugin.manifest(this.plugin.releaseKeyId).apps ?? []).filter((a) => "entry" in a);
    return [
      { uri: manifest.MANIFEST_URI, name: "manifest", mimeType: manifest.MANIFEST_MIME },
      ...tsx.map((a) => ({ uri: `${manifest.APP_URI_PREFIX}${a.id}`, name: a.id, mimeType: manifest.APP_MIME })),
    ];
  }

  #read(params: Record<string, unknown>) {
    const uri = params.uri;
    if (typeof uri !== "string") throw new RpcError(INVALID_PARAMS, "resources/read requires params.uri");
    if (uri === manifest.MANIFEST_URI) return { contents: [{ uri, mimeType: manifest.MANIFEST_MIME, text: this.served.text() }] };
    const source = uri.startsWith(manifest.APP_URI_PREFIX) ? this.plugin.appSource?.(uri.slice(manifest.APP_URI_PREFIX.length)) : undefined;
    if (source === undefined) throw new RpcError(INVALID_PARAMS, "no such resource");
    return { contents: [{ uri, mimeType: manifest.APP_MIME, text: source }] };
  }
}

function errorResponse(id: Json, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Serve stdin to stdout until stdin closes. Requests run as they arrive;
 *  each answer is written when it is ready. */
export async function serveStdio(server: Server): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const p = server.handleLine(line).then((reply) => {
      if (reply !== undefined) process.stdout.write(`${reply}\n`);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
