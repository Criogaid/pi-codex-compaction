import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings } from "../src/fallback-settings.js";
import { isolateAgentConfig } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
beforeEach(() => rm(dirname(settingsPath), { recursive: true, force: true }));

async function writeSettings(fallback: unknown) {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: true }, fallback }));
}

for (const { name, fallback } of [
  { name: "legacy valid", fallback: { provider: "cheap", model: "summary", thinkingLevel: "low" } },
  { name: "incomplete", fallback: { enabled: true, provider: "x" } },
  { name: "unknown fields", fallback: { enabled: false, extra: { untouched: [1, "two"] } } },
  { name: "null", fallback: null },
]) {
  test(`save without a fallback field preserves the ${name} fallback verbatim`, async () => {
    await writeSettings(fallback);
    const settings = await loadCompactionSettings(settingsPath);
    await settings.save({ remoteCompactionEnabled: false });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 1, remoteCompaction: { enabled: false }, fallback,
    });
  });

  test(`save with explicit undefined removes the ${name} fallback`, async () => {
    await writeSettings(fallback);
    const settings = await loadCompactionSettings(settingsPath);
    await settings.save({ remoteCompactionEnabled: false, fallback: undefined });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 1, remoteCompaction: { enabled: false },
    });
    assert.equal((await loadCompactionSettings(settingsPath)).configuration.fallback, undefined);
  });
}

test("lazy fallback validation does not prevent preserving the invalid field", async () => {
  const fallback = { enabled: true, provider: "x" };
  await writeSettings(fallback);
  const settings = await loadCompactionSettings(settingsPath);
  assert.equal(settings.configuration.remoteCompactionEnabled, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => settings.configuration.fallback, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
  await settings.save({ remoteCompactionEnabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: false }, fallback,
  });
});
