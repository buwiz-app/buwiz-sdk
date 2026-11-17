// Shared by the conformance tests: run the package's two commands and the probe plugin.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE = join(import.meta.dir, "..");
export const RUNNER = join(PACKAGE, "bin/buwiz-plugin-test.mjs");
export const SIGNER = join(PACKAGE, "src/v1/sign-manifest.mjs");
export const PROBE = join(import.meta.dir, "fixtures/probe-plugin.ts");
export const FIXTURES = join(import.meta.dir, "fixtures");
export const TEMPLATE = join(PACKAGE, "template");

export interface Row {
  id: string;
  what: string;
  status: "pass" | "fail" | "skip";
  note: string;
}

export interface Done {
  code: number;
  out: string;
  err: string;
}

const made: string[] = [];

/** A fresh private directory for one test's keys and files; `removeTempDirs` deletes them all. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "buwiz-conformance-test-"));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Run `node <script> ...args`; `env` is added to a minimal environment (no BUWIZ_* of the caller's). */
export async function node(script: string, args: string[], env: Record<string, string> = {}): Promise<Done> {
  const proc = Bun.spawn(["node", "--disable-warning=ExperimentalWarning", script, ...args], {
    env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** The probe plugin as the runner's `--command` and `--args`. */
export const probe = (...extra: string[]): string[] => ["--command", process.execPath, "--args", PROBE, "--args", "mcp", ...extra];

/** A throwaway 0600 key file made by the runner's own --keygen: its path and public key. */
export async function keygen(dir: string, name = "test.key"): Promise<{ path: string; pub: string }> {
  const path = join(dir, name);
  const done = await node(RUNNER, ["--keygen", path]);
  const pub = /Public key: (\S+)/.exec(done.out)?.[1];
  if (done.code !== 0 || !pub) throw new Error(`keygen: ${done.err}`);
  return { path, pub };
}

/** Run the plugin command line (`bun probe-plugin.ts <args>`); its stdout. */
export async function probeSays(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, PROBE, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`probe ${args.join(" ")} failed`);
  return out;
}

/** The runner's `--command` and `--args` for a fixture plugin (`.mjs`), and `--env` for each of `env`. */
export const fixture = (file: string, env: Record<string, string> = {}): string[] => [
  "--command",
  process.execPath,
  "--args",
  join(FIXTURES, file),
  ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
];

/** Run the runner with `--json`: its exit code and rows (the whole result under `res`). */
export async function runJson(args: string[], env: Record<string, string> = {}) {
  const done = await node(RUNNER, [...args, "--json"], env);
  let res: { ok: boolean; plugin: { id: string }; trust: unknown; rows: Row[] } | null = null;
  try {
    res = JSON.parse(done.out);
  } catch {}
  return { ...done, res, rows: res?.rows ?? [] };
}

/** The ids of the rows with this status, without repeats. */
export const idsOf = (rows: Row[], status: Row["status"]): string[] => [...new Set(rows.filter((r) => r.status === status).map((r) => r.id))];
