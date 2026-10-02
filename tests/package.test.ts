// Verify the npm boundary and load the manifest entrypoint through Pi's real loader.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { isolateAgentConfig } from "./helpers.js";

const repository = new URL("../../", import.meta.url);
const repositoryPath = fileURLToPath(repository);
const agentDir = isolateAgentConfig();
const packTimeoutMs = 60_000;
const maxPackOutputBytes = 512 * 1024;
const maxErrorOutputChars = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("npm package includes every declared entrypoint and runtime module without tests or build artifacts", async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL("package.json", repository), "utf8"));
  assert.ok(isRecord(manifest));
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package"));
  assert.ok(isRecord(manifest.pi) && Array.isArray(manifest.pi.extensions));
  assert.ok(manifest.pi.extensions.length > 0, "Pi requires a declared entrypoint");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies: unknown = manifest[field];
    if (dependencies === undefined) continue;
    assert.ok(isRecord(dependencies));
    for (const [name, range] of Object.entries(dependencies)) {
      assert.ok(typeof range === "string" && !range.startsWith("workspace:"), `${field}.${name} must resolve outside a workspace`);
    }
  }

  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this check through npm test or npm run pack:check");
  const packed = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repositoryPath, encoding: "utf8", timeout: packTimeoutMs, maxBuffer: maxPackOutputBytes,
  });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr.slice(-maxErrorOutputChars));
  const result: unknown = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(result) && result.length === 1);
  const pack: unknown = result[0];
  assert.ok(isRecord(pack) && Array.isArray(pack.files));
  const paths = new Set<string>();
  for (const file of pack.files) {
    assert.ok(isRecord(file) && typeof file.path === "string");
    paths.add(file.path);
  }
  for (const entrypoint of manifest.pi.extensions) {
    assert.ok(typeof entrypoint === "string" && paths.has(entrypoint), `Package is missing ${entrypoint}`);
  }
  const sources = (await readdir(new URL("src/", repository)))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `src/${name}`);
  assert.deepEqual([...paths].sort(), ["README.md", "CHANGELOG.md", "LICENSE", "package.json", ...sources].sort());
});

test("Pi discovers and loads the source entrypoint declared by the package manifest", async () => {
  const loaded = await discoverAndLoadExtensions([repositoryPath], repositoryPath, agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension.commands.has("codex-compaction"));
  for (const event of ["context", "context_with_system", "before_provider_request", "session_before_compact", "session_shutdown"]) {
    assert.ok(extension.handlers.has(event), `Entrypoint must register ${event}`);
  }
});
