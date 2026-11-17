import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings } from "../src/fallback-settings.js";
import { isolateAgentConfig } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const summaryModel = { provider: "cheap", model: "summary", thinkingLevel: "low" };
beforeEach(() => rm(dirname(settingsPath), { recursive: true, force: true }));

async function writeSettings(settings: unknown) {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings));
}

for (const { name, value } of [
  { name: "valid", value: summaryModel },
  { name: "incomplete", value: { provider: "x" } },
  { name: "unknown fields", value: { ...summaryModel, extra: { untouched: [1, "two"] } } },
  { name: "null", value: null },
]) {
  test(`save without a summaryModel field preserves the ${name} value verbatim`, async () => {
    await writeSettings({ version: 2, summaryModel: value });
    const settings = await loadCompactionSettings(settingsPath);
    await settings.save({ remoteCompactionEnabled: false });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 2, remoteCompaction: { enabled: false }, summaryModel: value,
    });
  });

  test(`save with explicit undefined removes the ${name} summaryModel`, async () => {
    await writeSettings({ version: 2, summaryModel: value });
    const settings = await loadCompactionSettings(settingsPath);
    await settings.save({ remoteCompactionEnabled: false, summaryModel: undefined });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 2, remoteCompaction: { enabled: false },
    });
    assert.equal((await loadCompactionSettings(settingsPath)).configuration.summaryModel, undefined);
  });
}

test("lazy summary-model validation does not prevent preserving the invalid field", async () => {
  const invalid = { provider: "x" };
  await writeSettings({ version: 2, summaryModel: invalid });
  const settings = await loadCompactionSettings(settingsPath);
  assert.equal(settings.configuration.remoteCompactionEnabled, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => settings.configuration.summaryModel, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(settingsPath));
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
  await settings.save({ remoteCompactionEnabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 2, remoteCompaction: { enabled: false }, summaryModel: invalid,
  });
});

for (const remoteCompactionEnabled of [true, false]) {
  test(`v2 summary model round-trips independently of V2 enabled=${remoteCompactionEnabled}`, async () => {
    const settings = await loadCompactionSettings(settingsPath);
    assert.deepEqual(settings.configuration, { remoteCompactionEnabled: true, summaryModel: undefined });
    await settings.save({ remoteCompactionEnabled, summaryModel });
    assert.deepEqual((await loadCompactionSettings(settingsPath)).configuration, { remoteCompactionEnabled, summaryModel });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 2, remoteCompaction: { enabled: remoteCompactionEnabled }, summaryModel,
    });
    assert.deepEqual(await readdir(dirname(settingsPath)), ["config.json"]);
  });
}

for (const { name, fallback, expected } of [
  { name: "implicit enabled", fallback: summaryModel, expected: summaryModel },
  { name: "enabled", fallback: { enabled: true, ...summaryModel }, expected: summaryModel },
  { name: "disabled", fallback: { enabled: false, ...summaryModel }, expected: undefined },
  { name: "disabled invalid model", fallback: { enabled: false, extra: true }, expected: undefined },
  { name: "model-less enabled", fallback: { enabled: true }, expected: undefined },
  { name: "model-less disabled", fallback: { enabled: false }, expected: undefined },
  { name: "empty", fallback: {}, expected: undefined },
  { name: "absent", fallback: undefined, expected: undefined },
]) {
  test(`v1 ${name} migrates on the next save without retaining fallback`, async () => {
    await writeSettings({ version: 1, remoteCompaction: { enabled: false }, fallback });
    const settings = await loadCompactionSettings(settingsPath);
    assert.deepEqual(settings.configuration, { remoteCompactionEnabled: false, summaryModel: expected });
    await settings.save({ remoteCompactionEnabled: true });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 2, remoteCompaction: { enabled: true }, ...(expected === undefined ? {} : { summaryModel: expected }),
    });
    assert.deepEqual((await loadCompactionSettings(settingsPath)).configuration, { remoteCompactionEnabled: true, summaryModel: expected });
  });
}

for (const fallback of [null, "invalid", { enabled: "yes", ...summaryModel }, { enabled: true, provider: "x" }]) {
  test(`invalid v1 fallback ${JSON.stringify(fallback)} stays lazy and migrates without data loss`, async () => {
    await writeSettings({ version: 1, fallback });
    const settings = await loadCompactionSettings(settingsPath);
    assert.equal(settings.configuration.remoteCompactionEnabled, true);
    assert.throws(() => settings.configuration.summaryModel);
    await settings.save({ remoteCompactionEnabled: false });
    const raw = typeof fallback === "object" && fallback !== null && fallback.enabled === true
      ? { provider: fallback.provider } : fallback;
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 2, remoteCompaction: { enabled: false }, summaryModel: raw,
    });
    const migrated = await loadCompactionSettings(settingsPath);
    assert.throws(() => migrated.configuration.summaryModel);
  });
}

for (const invalid of [
  { version: 2, fallback: summaryModel },
  { version: 1, summaryModel },
  { version: 2, extra: true },
  { version: 3, summaryModel },
  { summaryModel },
  { version: 2, remoteCompaction: { enabled: "yes" } },
]) {
  test(`invalid top-level settings ${JSON.stringify(invalid)} fail before saving`, async () => {
    await writeSettings(invalid);
    const original = await readFile(settingsPath, "utf8");
    await assert.rejects(loadCompactionSettings(settingsPath));
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });
}
