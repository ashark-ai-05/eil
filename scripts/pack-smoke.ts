import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "eil-pack-smoke-"));
function run(cmd: string, args: string[], cwd = root): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  run("corepack", ["pnpm", "pack", "--pack-destination", dir]);
  const packed = readdirSync(dir).find((name) => name.endsWith(".tgz"));
  if (!packed) throw new Error("pnpm pack produced no tarball");
  const tarball = join(dir, packed);
  run("corepack", ["pnpm", "add", "--prefer-offline", "--ignore-scripts", tarball], dir);
  const manifest = run(join(dir, "node_modules", ".bin", "eil"), ["tools"], dir);
  const parsed = JSON.parse(manifest);
  if (!Array.isArray(parsed.tools) || parsed.tools.length !== 6)
    throw new Error(`expected 6 tools, received ${parsed.tools?.length}`);
  console.log("package smoke: packed install and CLI manifest passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
