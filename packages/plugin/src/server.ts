// MCP over stdio: JSON-RPC 2.0, one message per line.
//
// Methods: initialize, ping, tools/list, tools/call, resources/list,
// resources/templates/list, resources/read. Notifications get no answer.
// Resources (the manifest and the TSX app sources) are readable before
// buwiz.provision; tools are not (P7).
//
// The reserved tools are answered here: buwiz.provision,
// buwiz.session.open, buwiz.session.close, buwiz.ticket.resolve and
// buwiz.uninstall; any other buwiz.* name is -32601. Before a plugin's own
// tool runs, Server checks its caller against the served manifest (see
// Server.authorize).
//
// Nothing is logged: no argument, no subject and never the key (P4).

import { createInterface } from "node:readline";
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

export const RESERVED = ["buwiz.provision", "buwiz.session.open", "buwiz.session.close", "buwiz.ticket.resolve", "buwiz.uninstall"] as const;

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
}

/** Who asked: _meta["buwiz/caller"]. "unknown": the broker sent none. */
export type Origin = "app" | "agent" | "routine" | "resolve" | "unknown";

export interface Caller {
  origin: Origin;
  /** The app, for "app". */
  app?: string;
  /** The open the app call came from, for "app". */
  openId?: string;
  /** The routine whose turn or query this is. */
  routine?: string;
}

export function callerOf(params: Record<string, unknown>): Caller {
  const c = (params._meta as Record<string, unknown> | undefined)?.["buwiz/caller"] as Record<string, unknown> | undefined;
  const text = (key: string) => (typeof c?.[key] === "string" ? (c[key] as string) : undefined);
  const o = text("origin");
  const origin: Origin = o === "app" || o === "agent" || o === "routine" || o === "resolve" ? o : "unknown";
  return { origin, app: text("app"), openId: text("open_id"), routine: text("routine") };
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
      case "tools/list":
        return {
          tools: [
            ...RESERVED.map((name) => ({ name, description: "Reserved for the Buwiz Bot.", inputSchema: { type: "object" } })),
            ...this.plugin
              .tools()
              .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } })),
          ],
        };
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
    if (name.startsWith("buwiz.")) return this.#reserved(name, args);
    // P7: nothing before a successful provision
    if (!this.#key) throw new RpcError(INVALID_REQUEST, "buwiz.provision must come first");
    const tool = this.plugin.tools().find((t) => t.name === name);
    if (!tool) throw new RpcError(INVALID_PARAMS, "no such tool");
    const caller = callerOf(params);
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
   *  - an app's call comes from an open this process certified for that
   *    app, and names a tool in the app's permissions.tools;
   *  - a resolve and a routine's query only read;
   *  - a routine's turn only reads, or calls a write its routine declares. */
  authorize(tool: Tool, caller: Caller): string | undefined {
    const served = this.served.value();
    if (caller.origin === "app") {
      if (!caller.app) return "an app call names no app";
      if (this.#sessions.get(caller.openId ?? "") !== caller.app) return "this app open was not certified by this plugin";
      const entry = manifest.app(served, caller.app);
      if (!entry) return "no such app";
      if (!(entry.permissions?.tools ?? []).includes(tool.name)) return `${tool.name} is not in this app's permissions`;
    }
    if (tool.readOnly) return undefined;
    if (caller.origin === "resolve" || caller.origin === "routine") return `${tool.name} changes data, so it does not run here`;
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
      default:
        this.plugin.uninstall();
        this.#sessions.clear();
        return ok({ ok: true });
    }
  }

  #provision(args: Args): Result {
    if (args.plugin !== this.plugin.id) return fail("invalid_args", `this is ${this.plugin.id}`);
    const majorMinor = (v: unknown) => (typeof v === "string" ? v.split(".").slice(0, 2).join(".") : undefined);
    if (majorMinor(args.protocol) !== majorMinor(manifest.PROTOCOL)) return fail("invalid_args", `this plugin implements protocol ${manifest.PROTOCOL}`);
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
