// The server against a toy plugin, through JSON-RPC lines: the provision
// gate, session certificates, the caller checks, the reserved tools and the
// resources. The Rust half runs the same cases (crates/buwiz-plugin/tests/server.rs).

import { expect, test } from "bun:test";
import {
  type Args,
  type Manifest,
  type Plugin,
  PROTOCOL,
  PluginKey,
  RESERVED,
  Served,
  Server,
  Tickets,
  type Tool,
  b64u,
  fail,
  isTicket,
  ok,
  permissionsDigest,
  problems,
  sha256Jcs,
  tsx,
} from "../src";

const APP = "export default function Board() {\n  return null;\n}\n";

class Toy implements Plugin {
  readonly id = "app.buwiz.toy";
  readonly name = "toy-mini-app";
  readonly version = "0.1.0";
  readonly releaseKeyId = "toy-test-01";
  readonly instructions = "Toy keeps a list.";
  readonly tickets = new Tickets<string>();
  readonly calls: string[] = [];

  manifest(keyId: string): Manifest {
    return {
      protocol: PROTOCOL,
      id: this.id,
      short: "toy",
      version: this.version,
      title: "Toy",
      publisher: { id: "app.buwiz", key_id: keyId, name: "Buwiz" },
      scopes: [{ name: "item", description: "Item", resolve: "toy_resolve" }],
      routines: [
        {
          id: "tidy",
          name: "Tidy",
          description: "Tidies.",
          every_s: 3600,
          query: { tool: "toy_list", field: "text" },
          prompt: "Tidy up.",
          reads: [],
          writes: ["toy_add"],
        },
      ],
      apps: [
        { id: "board", title: "Board", description: "The list.", ...tsx("board", APP), placement: ["full"], permissions: { tools: ["toy_list"] } },
        {
          id: "fast",
          title: "Fast",
          description: "Native.",
          native: { screen: "toy.fast", abi: 1 },
          placement: ["full"],
          permissions: { tools: ["toy_list", "toy_add"] },
        },
      ],
    };
  }

  appSource(id: string) {
    return id === "board" ? APP : undefined;
  }

  tools(): Tool[] {
    const o = { type: "object" };
    return [
      { name: "toy_list", description: "List.", inputSchema: o, readOnly: true },
      { name: "toy_add", description: "Add.", inputSchema: o, readOnly: false },
      { name: "toy_resolve", description: "Resolve.", inputSchema: o, readOnly: true },
    ];
  }

  call(tool: string, args: Args) {
    this.calls.push(tool);
    if (tool === "toy_resolve") return ok({ result: "token", ticket: this.tickets.issue(String(args.value)), title: String(args.value) });
    if (tool === "toy_add") return ok({ added: true });
    if (args.ticket !== undefined && this.tickets.subject(args.ticket) === undefined) return fail("not_found", "That item is no longer available.");
    return ok({ text: "milk" });
  }

  ticketTitle(ticket: string) {
    const s = this.tickets.subject(ticket);
    return s === undefined ? undefined : `Item ${s.length}`;
  }

  uninstall() {
    this.tickets.clear();
  }
}

const SEED = new Uint8Array(32).fill(9);

class Run {
  readonly toy = new Toy();
  readonly server = new Server(this.toy, new Served(undefined, this.toy.manifest(this.toy.releaseKeyId)));
  next = 0;

  async rpc(method: string, params: unknown): Promise<any> {
    const reply = await this.server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++this.next, method, params }));
    return JSON.parse(reply as string);
  }

  call(name: string, args: unknown, caller: unknown = null) {
    return this.rpc("tools/call", { name, arguments: args, _meta: { "buwiz/caller": caller } });
  }

  provision() {
    const key = PluginKey.fromSeed(SEED);
    return this.call("buwiz.provision", { protocol: "2.0.1", plugin: this.toy.id, key: { alg: "ed25519", seed: b64u(SEED) }, pub: key.public() });
  }

  open(app: string, byte: number) {
    const entry = this.toy.manifest(this.toy.releaseKeyId).apps?.find((a) => a.id === app) ?? {};
    return this.call("buwiz.session.open", {
      app,
      open_id: b64u(new Uint8Array(16).fill(byte)),
      ks_pub: b64u(new Uint8Array(32).fill(2)),
      perms_sha256: permissionsDigest(entry),
      not_after: Date.now() + 3_600_000,
    });
  }
}

const result = (reply: any) => reply.result.structuredContent;
const appCaller = (app: string, byte: number) => ({ origin: "app", plugin: "app.buwiz.toy", app, open_id: b64u(new Uint8Array(16).fill(byte)), ts: 1 });

test("nothing runs before provision, and provision answers the manifest hash", async () => {
  const run = new Run();
  expect((await run.call("toy_list", {}, { origin: "agent" })).error.code).toBe(-32600);
  expect((await run.call("buwiz.session.open", {})).error.code).toBe(-32600);
  expect(result(await run.provision()).manifest_sha256).toBe(sha256Jcs(run.toy.manifest(run.toy.releaseKeyId)));
  expect(result(await run.provision()).ok).toBe(true);
  const other = PluginKey.fromSeed(new Uint8Array(32).fill(3));
  const again = await run.call("buwiz.provision", {
    protocol: "2.0.0",
    plugin: run.toy.id,
    key: { alg: "ed25519", seed: b64u(new Uint8Array(32).fill(3)) },
    pub: other.public(),
  });
  expect(again.result.isError).toBe(true);
});

test("provision refuses another plugin and leaves the protocol to the manifest", async () => {
  const run = new Run();
  const pub = PluginKey.fromSeed(SEED).public();
  const args = (plugin: string, protocol: string) => ({ protocol, plugin, key: { alg: "ed25519", seed: b64u(SEED) }, pub });
  expect((await run.call("buwiz.provision", args("app.buwiz.other", "2.0.0"))).result.isError).toBe(true);
  // the Bot decides compatibility from the manifest's protocol
  expect(result(await run.call("buwiz.provision", args("app.buwiz.toy", "2.1.0"))).ok).toBe(true);
});

test("a session certificate is the request signed with the provisioned key", async () => {
  const run = new Run();
  await run.provision();
  const reply = await run.open("board", 1);
  const { cert, cert_sig } = result(reply);
  expect(cert).toMatchObject({ typ: "buwiz-session", plugin: "app.buwiz.toy", app: "board" });
  expect(PluginKey.fromSeed(SEED).sign(cert)).toBe(cert_sig);
  expect((await run.open("nope", 2)).result.isError).toBe(true);
  const wrong = await run.call("buwiz.session.open", {
    app: "board",
    open_id: b64u(new Uint8Array(16).fill(3)),
    ks_pub: b64u(new Uint8Array(32).fill(2)),
    perms_sha256: "0".repeat(64),
    not_after: Date.now() + 1000,
  });
  expect(wrong.result.isError).toBe(true);
});

test("an app reaches only the tools its certified open grants", async () => {
  const run = new Run();
  await run.provision();
  expect(result(await run.call("toy_list", {}, appCaller("board", 1))).code).toBe("permission_denied");
  await run.open("board", 1);
  expect(result(await run.call("toy_list", {}, appCaller("board", 1))).text).toBe("milk");
  expect(result(await run.call("toy_add", {}, appCaller("board", 1))).code).toBe("permission_denied");
  expect(result(await run.call("toy_add", {}, appCaller("fast", 1))).code).toBe("permission_denied");
  await run.open("fast", 4);
  expect(result(await run.call("toy_add", {}, appCaller("fast", 4))).added).toBe(true);
  await run.call("buwiz.session.close", { open_id: b64u(new Uint8Array(16).fill(1)) });
  expect(result(await run.call("toy_list", {}, appCaller("board", 1))).code).toBe("permission_denied");
});

test("resolves and routines only read unless the routine declares the write", async () => {
  const run = new Run();
  await run.provision();
  expect(result(await run.call("toy_add", {}, { origin: "resolve" })).code).toBe("permission_denied");
  expect(result(await run.call("toy_add", {}, { origin: "routine", routine: "tidy" })).code).toBe("permission_denied");
  expect(result(await run.call("toy_add", {}, { origin: "agent", routine: "tidy" })).added).toBe(true);
  expect(result(await run.call("toy_add", {}, { origin: "agent", routine: "other" })).code).toBe("permission_denied");
  expect(result(await run.call("toy_add", {}, { origin: "agent" })).added).toBe(true);
  expect(run.toy.calls).toEqual(["toy_add", "toy_add"]);
});

test("tickets resolve to titles and uninstall forgets them", async () => {
  const run = new Run();
  await run.provision();
  const { ticket } = result(await run.call("toy_resolve", { kind: "scope", value: "milk" }, { origin: "resolve" }));
  expect(isTicket(ticket)).toBe(true);
  expect(result(await run.call("buwiz.ticket.resolve", { ticket }))).toEqual({ valid: true, title: "Item 4" });
  await run.call("buwiz.uninstall", {});
  expect(result(await run.call("buwiz.ticket.resolve", { ticket }))).toEqual({ valid: false });
});

test("an unknown reserved name is method-not-found; a throwing tool is an internal error", async () => {
  const run = new Run();
  await run.provision();
  expect((await run.call("buwiz.nope", {})).error.code).toBe(-32601);
  expect((await run.call("toy_nope", {})).error.code).toBe(-32602);
  run.toy.call = () => {
    throw new Error("Ada's book is locked");
  };
  const thrown = await run.call("toy_list", {}, { origin: "agent" });
  expect(result(thrown)).toEqual({ code: "internal", message: "toy_list failed." });
});

test("lists tools and serves the manifest and TSX sources only", async () => {
  const run = new Run();
  const init = await run.rpc("initialize", { protocolVersion: "2025-11-25" });
  expect(init.result.serverInfo.name).toBe("toy-mini-app");
  expect(init.result.instructions).toBe("Toy keeps a list.");
  const names = (await run.rpc("tools/list", {})).result.tools.map((t: Tool) => t.name);
  expect(names).toEqual([...RESERVED, "toy_list", "toy_add", "toy_resolve"]);
  const uris = (await run.rpc("resources/list", {})).result.resources.map((r: { uri: string }) => r.uri);
  expect(uris).toEqual(["buwiz://manifest", "buwiz-app://board"]);
  expect((await run.rpc("resources/read", { uri: "buwiz-app://board" })).result.contents[0].text).toBe(APP);
  expect((await run.rpc("resources/read", { uri: "buwiz-app://fast" })).error.code).toBe(-32602);
  const text = (await run.rpc("resources/read", { uri: "buwiz://manifest" })).result.contents[0].text;
  expect(JSON.parse(text)).toEqual(run.toy.manifest(run.toy.releaseKeyId));
});

test("the local manifest check finds the usual mistakes", () => {
  const toy = new Toy();
  expect(problems(toy.manifest("k"), toy.tools())).toEqual([]);
  const bad = toy.manifest("k");
  (bad as { protocol: string }).protocol = "1.0.0";
  bad.scopes![0]!.resolve = "toy_add";
  bad.apps![0]!.permissions = { tools: ["toy_gone"] };
  expect(problems(bad, toy.tools())).toEqual([
    "protocol must be 2.0.0",
    "scopes[0].resolve names toy_add, which is not read-only",
    "apps[0].permissions.tools names toy_gone, which is not a tool",
  ]);
});

test("the harness provisions, and calls as the model, a resolve, a routine or an app", async () => {
  const { Harness, ToolError } = await import("../src");
  const h = await Harness.start(new Toy());
  expect(await h.agent("toy_list")).toEqual({ text: "milk" });
  await expect(h.resolve("toy_add")).rejects.toBeInstanceOf(ToolError);
  expect(await h.routine("tidy", "toy_add")).toEqual({ added: true });
  expect(await h.app("fast", "toy_add")).toEqual({ added: true });
  await expect(h.app("board", "toy_add")).rejects.toMatchObject({ code: "permission_denied" });
});
