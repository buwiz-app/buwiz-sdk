// The plugin half of a Buwiz Bot mini app, protocol 1.0, in TypeScript.
//
// A mini app is a stdio MCP server the Bot spawns. Implement Plugin (your
// manifest, your app sources, your tools) and hand it to main(); this
// package does the rest: MCP over stdio, the reserved buwiz.* tools
// (provision, session certificates, ticket titles, uninstall, pushed
// account tokens), the caller
// checks before any tool of yours runs, tickets, and the canonical JSON and
// ed25519 signing the protocol is built on. It mirrors the Rust crate
// buwiz-plugin; both reproduce vectors/.

export { Account, Accounts, DEFAULT_LABEL, accountRequired, nowS } from "./accounts";
export { main } from "./cli";
export { type Json, JcsError, canonical, canonicalize, parseIJson, sha256Hex, sha256Jcs } from "./jcs";
export { PluginKey, b64u, fromB64u } from "./key";
export * from "./manifest";
export { UNSIGNED, binaryAsset, fill as fillPackage, run as runPackage, validPlatform } from "./package";
export {
  type Args,
  type Caller,
  CERT_MAX_MS,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MCP_PROTOCOL,
  METHOD_NOT_FOUND,
  type Origin,
  PARSE_ERROR,
  type Plugin,
  RESERVED,
  type Result,
  Server,
  type Tool,
  callerOf,
  fail,
  ok,
  serveStdio,
} from "./server";
export { Harness, ToolError } from "./testing";
export { Tickets, isTicket, newTicket } from "./tickets";
