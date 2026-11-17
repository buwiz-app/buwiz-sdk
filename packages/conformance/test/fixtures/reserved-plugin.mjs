// A plugin that answers the reserved tools itself, without the helper, so it can break them one
// at a time, for runner-cases.test.ts. RESERVED_MODE says how:
//
//   (none)          answers them as the protocol says
//   strict-host     buwiz.provision refuses a protocol other than 1.0.0
//   skip-provision  answers its tools before buwiz.provision
//   bad-cert        signs a session certificate with a key other than the provisioned one
//   log-seed        writes the provisioned seed to stderr
//
// The manifest is read from BUWIZ_PLUGIN_MANIFEST, else reserved-manifest.json beside this file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generate, pubOf, sign } from "../../src/v1/ed.mjs";
import { parseIJson, signedBytes } from "../../src/v1/jcs.mjs";
import { manifestHash, permsDigest } from "../../src/v1/manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.env.RESERVED_MODE ?? "";
const manifestFile = process.env.BUWIZ_PLUGIN_MANIFEST || join(HERE, "reserved-manifest.json");
const manifestText = () => readFileSync(manifestFile, "utf8");
const board = readFileSync(join(HERE, "board.tsx"), "utf8");
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const fail = (code, message) => ({ isError: true, content: [{ type: "text", text: message }], structuredContent: { code, message } });
let key = null;

function provision(args) {
  if (mode === "strict-host" && args.protocol !== "1.0.0") return fail("invalid_args", `protocol ${String(args.protocol).slice(0, 20)} is not supported`);
  if (!key) key = { seed: args.key.seed, pub: pubOf(args.key.seed) };
  if (mode === "log-seed") console.error(`provisioned with ${key.seed}`);
  return ok({ ok: true, manifest_sha256: manifestHash(parseIJson(manifestText())) });
}

function sessionOpen(args) {
  const m = parseIJson(manifestText());
  const app = m.apps.find((a) => a.id === args.app);
  if (!app) return fail("invalid_args", "no such app");
  if (args.perms_sha256 !== permsDigest(app.permissions)) return fail("invalid_args", "perms_sha256 does not match the manifest");
  if (args.not_after > Date.now() + 8 * 3600_000) return fail("invalid_args", "not_after must be within 8 h");
  const cert = {
    v: 1,
    typ: "buwiz-session",
    plugin: m.id,
    app: app.id,
    open_id: args.open_id,
    ks_pub: args.ks_pub,
    perms_sha256: args.perms_sha256,
    not_after: args.not_after,
  };
  return ok({ cert, cert_sig: sign(mode === "bad-cert" ? generate().seed : key.seed, signedBytes(cert)) });
}

const reserved = {
  "buwiz.session.open": sessionOpen,
  "buwiz.session.close": () => ok({ ok: true }),
  "buwiz.ticket.resolve": () => ok({ valid: false }),
  "buwiz.uninstall": () => ok({ ok: true }),
};

const server = new Server({ name: "reserved", version: "1.0.0" }, { capabilities: { tools: {}, resources: { listChanged: true } } });
const object = { type: "object" };

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    ...["buwiz.provision", ...Object.keys(reserved)].map((name) => ({ name, description: "Reserved for Buwiz Bot.", inputSchema: object })),
    { name: "reserved_list", description: "List.", inputSchema: object, annotations: { readOnlyHint: true } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "buwiz.provision") return provision(args);
  if (name.startsWith("buwiz.") && !Object.hasOwn(reserved, name)) throw new McpError(ErrorCode.MethodNotFound, `${name} is not a tool of this plugin`);
  if (!key && mode !== "skip-provision") throw new Error("buwiz.provision must come first");
  if (name === "reserved_list") return ok({ items: [] });
  if (Object.hasOwn(reserved, name)) return reserved[name](args);
  throw new Error(`no tool ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [
    { uri: "buwiz://manifest", name: "manifest", mimeType: "application/json" },
    { uri: "buwiz-app://board", name: "board", mimeType: "text/x-nsh-tsx" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, (req) => {
  const { uri } = req.params;
  if (uri === "buwiz://manifest") return { contents: [{ uri, mimeType: "application/json", text: manifestText() }] };
  return { contents: [{ uri, mimeType: "text/x-nsh-tsx", text: board }] };
});

await server.connect(new StdioServerTransport());
