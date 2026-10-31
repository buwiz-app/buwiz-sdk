// The command line every mini app binary shares:
//
//   <name> mcp                         serve MCP on stdio (what the Bot spawns)
//   <name> manifest [--key-id <id>]    print the unsigned manifest as JCS text
//   <name> app-source <id>             print a TSX app's source as served
//   <name> --version | --help

import { canonical } from "./jcs";
import { MANIFEST_ENV, fileName } from "./manifest";
import { type Plugin, Server, serveStdio } from "./server";

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Run the command line; resolves to the exit code. `open` makes the
 *  plugin; only `mcp` calls it, so printing the manifest never opens the
 *  plugin's data. */
export async function main(plugin: Plugin, open: () => Plugin | Promise<Plugin> = () => plugin, argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp" && rest.length === 0) {
    await serveStdio(new Server(await open()));
    return 0;
  }
  if (command === "manifest" && rest.length === 0) return print(canonical(plugin.manifest(plugin.releaseKeyId)));
  if (command === "manifest" && rest.length === 2 && rest[0] === "--key-id" && KEY_ID.test(rest[1] ?? "")) {
    return print(canonical(plugin.manifest(rest[1] as string)));
  }
  if (command === "app-source" && rest.length === 1) {
    const source = plugin.appSource?.(rest[0] as string);
    if (source !== undefined) return print(source);
    process.stderr.write(`${plugin.name}: no TSX app ${rest[0]}\n`);
    return 2;
  }
  if ((command === "--version" || command === "-V") && rest.length === 0) return print(`${plugin.name} ${plugin.version}\n`);
  if ((command === "--help" || command === "-h") && rest.length === 0) return print(usage(plugin));
  process.stderr.write(usage(plugin));
  return 2;
}

function usage({ name, id, releaseKeyId }: Plugin): string {
  return `${name}: the ${id} mini app for the Buwiz Bot.

Usage: ${name} mcp                       speak MCP on stdin/stdout (what the Bot spawns)
       ${name} manifest [--key-id <id>]  print the unsigned manifest as JCS text, under
                                        publisher key id ${releaseKeyId} unless a test id is named
       ${name} app-source <id>           print a TSX app's source exactly as served
       ${name} --version | --help

Environment:
  ${MANIFEST_ENV}  the signed manifest to serve (default: ${fileName(id)} next to this
                         executable; without either the unsigned one is served, and the
                         Bot refuses the plugin)
`;
}

/** Exactly these bytes on stdout (the signer fingerprints them). */
function print(text: string): Promise<number> {
  return new Promise((resolve) => process.stdout.write(text, (e) => resolve(e ? 1 : 0)));
}
