// The smallest plugin the conformance runner passes, built on the SDK's own server:
//
//   bun probe-plugin.ts mcp
//
// PROBE_BREAK=fetch makes its app call fetch(), which an app must not (APP-04),
// and nothing else: the one rule the runner then has to name.

import { type Args, type Manifest, PROTOCOL, type Plugin, type Tool, Tickets, main, ok, tsx } from "../../../plugin/src";

const GOOD = "export default function Board() {\n  return null;\n}\n";
const BAD = `export default function Board() {\n  fetch("https://example.invalid");\n  return null;\n}\n`;
const SOURCE = process.env.PROBE_BREAK === "fetch" ? BAD : GOOD;

class Probe implements Plugin {
  readonly id = "app.buwiz.probe";
  readonly name = "probe-mini-app";
  readonly version = "0.1.0";
  readonly releaseKeyId = "probe-test-01";
  readonly tickets = new Tickets<string>();

  manifest(keyId: string): Manifest {
    return {
      protocol: PROTOCOL,
      id: this.id,
      short: "probe",
      version: this.version,
      title: "Probe",
      description: "A plugin for the conformance runner's own tests.",
      publisher: { id: "app.buwiz", key_id: keyId, name: "Buwiz" },
      scopes: [{ name: "item", description: "An item", resolve: "probe_resolve" }],
      apps: [{ id: "board", title: "Board", description: "The list.", ...tsx("board", SOURCE), placement: ["full"], permissions: { tools: ["probe_list"] } }],
    };
  }

  appSource(id: string) {
    return id === "board" ? SOURCE : undefined;
  }

  tools(): Tool[] {
    const o = { type: "object" };
    return [
      { name: "probe_list", description: "List.", inputSchema: o, readOnly: true },
      { name: "probe_resolve", description: "Resolve.", inputSchema: o, readOnly: true },
    ];
  }

  call(tool: string, args: Args) {
    if (tool === "probe_resolve") {
      const value = String(args.value ?? "");
      return args.complete
        ? ok({ result: "choices", choices: [{ label: "milk", value: this.tickets.issue("milk") }] })
        : ok({ result: "error", message: `No item ${value.slice(0, 40)}.` });
    }
    return ok({ items: ["milk"] });
  }

  ticketTitle(ticket: string) {
    return this.tickets.subject(ticket);
  }

  uninstall() {
    this.tickets.clear();
  }
}

process.exit(await main(new Probe()));
