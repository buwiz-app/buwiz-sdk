// A plugin on the helper whose tools declare `_meta`, for template.test.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, startPlugin } from "../../lib/buwiz-plugin.mjs";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "../../template");
const object = { type: "object" };
const run = () => ok({});

await startPlugin({
  manifestFile: join(TEMPLATE, "manifest.json"),
  tools: [
    { name: "hello_plain", description: "Plain.", inputSchema: object, annotations: { readOnlyHint: true }, run },
    {
      name: "hello_peek",
      description: "Peek.",
      inputSchema: object,
      annotations: { readOnlyHint: true },
      _meta: { "buwiz/audience": ["agent", "widget"] },
      run,
    },
    {
      name: "hello_post",
      description: "Post.",
      inputSchema: object,
      annotations: { readOnlyHint: false },
      _meta: { "buwiz/press": { approved: true, effect: "post", describe: "hello_peek" } },
      run,
    },
    { name: "hello_raw", description: "Raw.", inputSchema: object, _meta: { "vendor/x": 1 }, run },
  ],
});
