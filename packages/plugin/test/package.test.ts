// The package command's fill, as crates/plugin/src/package.rs tests it.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL, binaryAsset, fileName, fillPackage, sha256Hex } from "../src";

const ID = "app.buwiz.toy";
const NAME = "toy-mini-app";

const template = (): Record<string, any> => ({
  name: "toy",
  version: "1.2.0",
  description: "Toy.",
  buwiz: {
    protocol: PROTOCOL,
    id: ID,
    short: "toy",
    version: "1.2.0",
    server: "toy",
    files: { "skills/tidy/SKILL.md": { asset: "tidy-SKILL.md" } },
    binaries: {},
    publisher: { id: "app.buwiz", key_id: "toy-test-01" },
    signature: { stale: true },
  },
});

function out(): string {
  const dir = mkdtempSync(join(tmpdir(), "buwiz-package-"));
  mkdirSync(dir, { recursive: true });
  const served = { protocol: PROTOCOL, id: ID, short: "toy", version: "1.2.0", publisher: { id: "app.buwiz", key_id: "toy-test-01" } };
  writeFileSync(join(dir, fileName(ID)), JSON.stringify(served));
  writeFileSync(join(dir, binaryAsset(NAME, "macos-aarch64")), "mac binary");
  writeFileSync(join(dir, binaryAsset(NAME, "linux-x86_64")), "linux binary");
  writeFileSync(join(dir, "tidy-SKILL.md"), "---\nname: tidy\n---\n");
  return dir;
}

test("fills files, binaries and the server entry", () => {
  const dir = out();
  const p = fillPackage(template(), dir, ID, NAME, "macos-aarch64") as Record<string, any>;
  const b = p.buwiz;
  expect(b.signature).toBeUndefined();
  expect(b.files[`bin/${ID}.manifest.json`].sha256).toBe(sha256Hex(readFileSync(join(dir, fileName(ID)))));
  expect(b.files["skills/tidy/SKILL.md"].asset).toBe("tidy-SKILL.md");
  expect(b.binaries["macos-aarch64"]).toEqual({ path: `bin/${NAME}`, asset: `${NAME}-macos-aarch64`, sha256: sha256Hex("mac binary") });
  expect(p.mcpServers.toy.command).toBe(`\${PLUGIN_ROOT}/bin/${NAME}`);
  const both = fillPackage(template(), dir, ID, NAME, "linux-x86_64", p) as Record<string, any>;
  expect(Object.keys(both.buwiz.binaries)).toEqual(["linux-x86_64", "macos-aarch64"]);
  rmSync(dir, { recursive: true });
});

const message = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

test("the signed manifest decides the block", () => {
  const dir = out();
  const bare = template();
  for (const key of ["protocol", "id", "short", "version", "publisher"]) delete bare.buwiz[key];
  delete bare.version;
  const stale = template();
  stale.version = "1.1.0";
  stale.buwiz.version = "1.1.0";
  stale.buwiz.publisher.key_id = "old-01";
  for (const t of [bare, stale]) {
    const p = fillPackage(t, dir, ID, NAME, "macos-aarch64") as Record<string, any>;
    expect(p.version).toBe("1.2.0");
    const b = p.buwiz;
    expect([b.protocol, b.id, b.short, b.version]).toEqual([PROTOCOL, ID, "toy", "1.2.0"]);
    expect(b.publisher).toEqual({ id: "app.buwiz", key_id: "toy-test-01" });
  }
  const good = { protocol: PROTOCOL, id: ID, short: "toy", version: "1.2.0", publisher: { id: "app.buwiz", key_id: "toy-test-01" } };
  const refuse = (key: string, value: unknown) => {
    writeFileSync(join(dir, fileName(ID)), JSON.stringify({ ...good, [key]: value }));
    return message(() => fillPackage(template(), dir, ID, NAME, "macos-aarch64"));
  };
  expect(refuse("protocol", "2.1.0")).toContain("protocol");
  expect(refuse("id", "app.buwiz.other")).toContain("app.buwiz.other");
  expect(refuse("version", null)).toContain("version");
  expect(refuse("publisher", { id: "app.buwiz" })).toContain("key_id");
  rmSync(dir, { recursive: true });
});

test("the mini app server runs the packaged binary", () => {
  const dir = out();
  const command = `\${PLUGIN_ROOT}/bin/${NAME}`;
  const refuse = (entry: unknown) => {
    const t = template();
    t.mcpServers = { toy: entry };
    return message(() => fillPackage(t, dir, ID, NAME, "macos-aarch64"));
  };
  expect(refuse({ command: "/usr/local/bin/toy" })).toContain("command");
  expect(refuse({ command: "${PLUGIN_ROOT}/bin/other" })).toContain("command");
  expect(refuse({ command, url: "https://example.com" })).toContain("url");
  expect(refuse({ command, type: "http" })).toContain("type");
  expect(refuse({ command, args: ["mcp", 1] })).toContain("args");
  expect(refuse({ command, env: { A: 1 } })).toContain("env");
  // a template's own stdio entry is kept as written
  const t = template();
  t.mcpServers = { toy: { command, args: ["serve"], env: { A: "b" } }, other: { url: "https://example.com/mcp" } };
  const p = fillPackage(t, dir, ID, NAME, "macos-aarch64") as Record<string, any>;
  expect(p.mcpServers).toEqual(t.mcpServers);
  rmSync(dir, { recursive: true });
});

test("refuses what would not install", () => {
  const dir = out();
  const refuse = (edit: (t: Record<string, any>) => void, platform = "macos-aarch64") => {
    const t = template();
    edit(t);
    return message(() => fillPackage(t, dir, ID, NAME, platform));
  };
  expect(refuse(() => {}, "macOS")).toContain("platform");
  expect(refuse(() => {}, "windows-x86_64")).toContain("windows-x86_64");
  expect(refuse((t) => (t.buwiz = {}))).toContain("buwiz.server");
  expect(refuse((t) => (t.buwiz.files = { "plugin.json": { asset: "x" } }))).toContain("plugin.json");
  const p = fillPackage(template(), dir, ID, NAME, "macos-aarch64") as Record<string, any>;
  const older = structuredClone(p);
  older.buwiz.version = "1.1.0";
  expect(() => fillPackage(template(), dir, ID, NAME, "linux-x86_64", older)).toThrow("1.1.0");
  rmSync(dir, { recursive: true });
});
