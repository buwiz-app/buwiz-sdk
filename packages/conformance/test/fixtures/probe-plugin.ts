// The smallest plugin the conformance runner passes, built on the SDK's own server:
//
//   bun probe-plugin.ts mcp
//
// PROBE_BREAK=fetch makes its app call fetch(), which an app must not (APP-04);
// PROBE_BREAK=prompt makes its command answer a blank prompt (INV-10). Each
// breaks that one rule and nothing else, which the runner then has to name.
// Its tools return a well formed buwiz/badge made with the SDK's `badge` and `withBadge`;
// PROBE_BREAK=badge makes it a malformed one (BRG-20). PROBE_BADGE=none returns none at all.
// PROBE_TOOLS=<n> gives its app n more tools to call, to exercise the runner's pace.

import { type Args, type Manifest, PROTOCOL, type Plugin, type Tool, Tickets, badge, main, ok, tsx, withBadge } from "../../../plugin/src";

const GOOD = "export default function Board() {\n  return null;\n}\n";
const BAD = `export default function Board() {\n  fetch("https://example.invalid");\n  return null;\n}\n`;
const SOURCE = process.env.PROBE_BREAK === "fetch" ? BAD : GOOD;
const MORE = Array.from({ length: Number(process.env.PROBE_TOOLS ?? 0) }, (_, i) => `probe_t${i + 1}`);

class Probe implements Plugin {
  readonly id = "com.example.probe";
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
      publisher: { id: "com.example", key_id: keyId, name: "Example" },
      commands: [{ name: "note", description: "Start a note", resolve: "probe_resolve" }],
      scopes: [{ name: "item", description: "An item", resolve: "probe_resolve" }],
      apps: [
        {
          id: "board",
          title: "Board",
          description: "The list.",
          ...tsx("board", SOURCE),
          placement: ["full"],
          permissions: { tools: ["probe_list", ...MORE] },
        },
      ],
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
      ...MORE.map((name) => ({ name, description: "List.", inputSchema: o, readOnly: true })),
    ];
  }

  call(tool: string, args: Args) {
    if (tool === "probe_resolve") {
      const value = String(args.value ?? "");
      if (args.kind === "command") return ok({ result: "prompt", text: process.env.PROBE_BREAK === "prompt" ? "  \n" : "Note:\n- " });
      return args.complete
        ? ok({ result: "choices", choices: [{ label: "milk", value: this.tickets.issue("milk") }] })
        : ok({ result: "error", message: `No item ${value.slice(0, 40)}.` });
    }
    const result = ok({ items: ["milk"] });
    if (process.env.PROBE_BREAK === "badge") return { ...result, _meta: { "buwiz/badge": { app: "board", dot: "blue" } } };
    return process.env.PROBE_BADGE === "none" ? result : withBadge(result, badge("board", { dot: "amber", text: "1 item" }));
  }

  ticketTitle(ticket: string) {
    return this.tickets.subject(ticket);
  }

  uninstall() {
    this.tickets.clear();
  }
}

process.exit(await main(new Probe()));
