// Own the standalone npm package boundary and verify its Pi entrypoints without publishing.
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PACK_TIMEOUT_MS = 60_000;
const MAX_PACK_OUTPUT_BYTES = 512 * 1024;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check with npm run pack:check.");
const repository = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", repository), "utf8"));
if (!manifest.keywords?.includes("pi-package")) throw new Error("package.json keywords must include pi-package.");
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) {
      throw new Error(`package.json ${field}.${name} must resolve outside a workspace.`);
    }
  }
}
const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
  cwd: fileURLToPath(repository), encoding: "utf8", timeout: PACK_TIMEOUT_MS, maxBuffer: MAX_PACK_OUTPUT_BYTES,
});
if (result.error) throw new Error("npm pack --dry-run failed before completing.", { cause: result.error });
if (result.status !== 0) throw new Error(`npm pack --dry-run exited ${result.status}: ${result.stderr.slice(-2000)}`);
const packs = JSON.parse(result.stdout);
if (!Array.isArray(packs) || packs.length !== 1 || !Array.isArray(packs[0].files)) {
  throw new Error("npm pack --dry-run did not return one package file list.");
}
const paths = new Set(packs[0].files.map((file) => file.path));
const declaredEntrypoints = manifest.pi?.extensions;
if (!Array.isArray(declaredEntrypoints) || declaredEntrypoints.length === 0) {
  throw new Error("package.json pi.extensions must declare at least one entrypoint.");
}
const extensionFiles = (await readdir(new URL("extensions/", repository)))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => `extensions/${name}`);
for (const path of ["README.md", "LICENSE", "package.json", ...declaredEntrypoints, ...extensionFiles]) {
  if (!paths.has(path)) throw new Error(`Package is missing ${path}.`);
}
for (const path of paths) {
  if (path.endsWith(".test.ts") || path.startsWith("dist/") || path.startsWith("migration/") || path.startsWith(".changeset/")) {
    throw new Error(`Package unexpectedly includes ${path}.`);
  }
}
console.log(`PASS: ${manifest.name} packs ${paths.size} files with every Pi entrypoint and runtime module; tests and maintenance records are excluded.`);
