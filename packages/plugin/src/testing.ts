// A test harness for a mini app's own tests: a provisioned Server serving
// the unsigned manifest, and calls as the model, a resolve, a routine or an
// app, through the same JSON-RPC path the Bot uses.
//
//   const h = await Harness.start(new Hello());
//   expect(await h.agent("hello_greet", {})).toEqual({ greeting: "Hello, world" });
//   await expect(h.agent("hello_greet", { ticket: "tkt_…" })).rejects.toMatchObject({ code: "not_found" });

import type { Json } from "./jcs";
import { PluginKey, b64u } from "./key";
import { PROTOCOL, Served, permissionsDigest } from "./manifest";
import { type Plugin, Server } from "./server";

/** A test seed: 32 bytes of 7. Never a real key. */
const SEED = new Uint8Array(32).fill(7);

/** An isError result: its structuredContent's code and message. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Harness<P extends Plugin> {
  readonly server: Server<P>;
  #next = 0;
  #opens = 0;

  private constructor(readonly plugin: P) {
    this.server = new Server(plugin, new Served(undefined, plugin.manifest(plugin.releaseKeyId)));
  }

  /** `plugin` behind a server serving its unsigned manifest (release key
   *  id), already provisioned. */
  static async start<P extends Plugin>(plugin: P): Promise<Harness<P>> {
    const h = new Harness(plugin);
    const pub = PluginKey.fromSeed(SEED).public();
    const reply = (await h.call("buwiz.provision", { protocol: PROTOCOL, plugin: plugin.id, key: { alg: "ed25519", seed: b64u(SEED) }, pub }, null)) as {
      ok?: boolean;
    };
    if (reply.ok !== true) throw new Error(`provision: ${JSON.stringify(reply)}`);
    return h;
  }

  /** One JSON-RPC request; the whole reply. */
  async rpc(method: string, params: unknown): Promise<Record<string, any>> {
    const line = await this.server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++this.#next, method, params }));
    return JSON.parse(line as string);
  }

  /** tools/call with `caller` as _meta["buwiz/caller"]: the result's
   *  structuredContent, or a ToolError for an isError result. A JSON-RPC
   *  error rejects with an Error. */
  async call(tool: string, args: Record<string, Json>, caller: Json): Promise<Json> {
    const reply = await this.rpc("tools/call", { name: tool, arguments: args, _meta: { "buwiz/caller": caller } });
    if (!reply.result) throw new Error(`${tool}: JSON-RPC error ${JSON.stringify(reply.error)}`);
    const data = reply.result.structuredContent;
    if (reply.result.isError) throw new ToolError(String(data?.code), String(data?.message));
    return data;
  }

  /** A call as the model. */
  agent(tool: string, args: Record<string, Json> = {}): Promise<Json> {
    return this.call(tool, args, { origin: "agent", plugin: this.plugin.id, ts: 1 });
  }

  /** A call as a command's or scope's resolve. */
  resolve(tool: string, args: Record<string, Json> = {}): Promise<Json> {
    return this.call(tool, args, { origin: "resolve", plugin: this.plugin.id, ts: 1 });
  }

  /** A call from routine `routine`'s turn (as the model in that turn). */
  routine(routine: string, tool: string, args: Record<string, Json> = {}): Promise<Json> {
    return this.call(tool, args, { origin: "agent", plugin: this.plugin.id, routine, ts: 1 });
  }

  /** A call from app `app`, from a fresh open the server certified. */
  async app(app: string, tool: string, args: Record<string, Json> = {}): Promise<Json> {
    const openId = await this.open(app);
    return this.call(tool, args, { origin: "app", plugin: this.plugin.id, app, open_id: openId, ts: 1 });
  }

  /** Open `app` (buwiz.session.open); its open id. */
  async open(app: string): Promise<string> {
    const openId = b64u(new Uint8Array(16).fill(++this.#opens % 256));
    const entry = this.plugin.manifest(this.plugin.releaseKeyId).apps?.find((a) => a.id === app);
    if (!entry) throw new Error(`no app ${app}`);
    await this.call(
      "buwiz.session.open",
      { app, open_id: openId, ks_pub: b64u(new Uint8Array(32).fill(2)), perms_sha256: permissionsDigest(entry), not_after: Date.now() + 3_600_000 },
      null,
    );
    return openId;
  }
}
