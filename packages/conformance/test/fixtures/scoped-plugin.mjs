// A plugin on the helper whose resolve tool answers as SCOPED_MODE says, for runner.test.ts. Each
// mode breaks one thing and leaves the rest as a plugin would have it:
//
//   (none)         a bare /draft answers a prompt, the scope offers a ticket and resolves it
//   quiet          the scope offers no ticket and refuses any it did not offer; /draft opens with a ticket
//   long-prompt    a bare /draft answers a prompt of 4001 characters
//   scope-prompt   the scope answers a prompt
//   device-import  the app imports a module outside nsh, nsh/base and buwiz
//
// The manifest is read from BUWIZ_PLUGIN_MANIFEST, else scoped-manifest.json beside this file.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, startPlugin, ticketStore } from "../../lib/buwiz-plugin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.env.SCOPED_MODE ?? "";
const tickets = ticketStore();

function resolve(args) {
  const value = String(args.value ?? "");
  if (args.kind === "command") {
    if (mode === "quiet") return ok({ result: "open", app: "board", props: { ticket: tickets.issue("home") }, title: "Scoped", placement: "full" });
    if (value === "") return ok({ result: "prompt", text: mode === "long-prompt" ? "x".repeat(4001) : "Draft a note about:\n- " });
    return ok({ result: "open", app: "board", title: "Scoped", placement: "full" });
  }
  if (mode === "scope-prompt") return ok({ result: "prompt", text: "Note this" });
  if (mode === "quiet") {
    if (args.complete) return ok({ result: "choices", choices: [] });
    return ok({ result: "error", message: "That is not a note." });
  }
  if (args.complete) return ok({ result: "choices", choices: [{ label: "milk", value: tickets.issue("milk") }] });
  if (tickets.subject(value) === undefined) return ok({ result: "error", message: "That is not a note." });
  return ok({ result: "token", ticket: value, title: "Milk" });
}

await startPlugin({
  name: "scoped",
  manifestFile: process.env.BUWIZ_PLUGIN_MANIFEST || join(HERE, "scoped-manifest.json"),
  apps: { board: join(HERE, mode === "device-import" ? "board-device-import.txt" : "board.tsx") },
  tickets,
  ticketTitle: (subject) => subject,
  tools: [
    {
      name: "scoped_resolve",
      description: "Resolve /draft and @scoped:note.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      run: resolve,
    },
  ],
});
