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

test("refuses what would not install", () => {
  const dir = out();
  const refuse = (edit: (t: Record<string, any>) => void, platform = "macos-aarch64") => {
    const t = template();
    edit(t);
    expect(() => fillPackage(t, dir, ID, NAME, platform)).toThrow();
    try {
      fillPackage(t, dir, ID, NAME, platform);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  expect(refuse((t) => (t.buwiz.protocol = "2.1.0"))).toContain("protocol");
  expect(refuse((t) => (t.buwiz.version = "1.3.0"))).toContain("buwiz.version");
  expect(refuse((t) => (t.version = "1.3.0"))).toContain("plugin.json's version");
  expect(refuse((t) => (t.buwiz.publisher.key_id = "other-01"))).toContain("key_id");
  expect(refuse(() => {}, "macOS")).toContain("platform");
  expect(refuse(() => {}, "windows-x86_64")).toContain("windows-x86_64");
  expect(refuse((t) => (t.buwiz.files = { "plugin.json": { asset: "x" } }))).toContain("plugin.json");
  const p = fillPackage(template(), dir, ID, NAME, "macos-aarch64") as Record<string, any>;
  const older = structuredClone(p);
  older.buwiz.version = "1.1.0";
  expect(() => fillPackage(template(), dir, ID, NAME, "linux-x86_64", older)).toThrow("1.1.0");
  rmSync(dir, { recursive: true });
});
