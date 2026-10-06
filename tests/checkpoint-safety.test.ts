// Exercise request-time policies and failed compaction with a real persisted Pi checkpoint.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { latestCheckpoint } from "../src/checkpoint.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

const configPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const originalFact = "The approved project color is cerulean.";
const hasItem = (payload: JsonObject, type: string) =>
  Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === type);

async function seedHistory(fixture: Awaited<ReturnType<typeof sessionFixture>>) {
  await fixture.session.prompt(`${originalFact} ${"Preserve the original requirements. ".repeat(80)}`);
  await fixture.session.prompt("Discuss the implementation. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  await fixture.session.compact();
  const checkpoint = latestCheckpoint(fixture.session.sessionManager.getBranch());
  assert.ok(checkpoint);
  await fixture.session.prompt("Continue from the saved checkpoint. ".repeat(80));
  assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
  return checkpoint;
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const reason of ["remote failure", "V2 disabled"] as const) {
    for (const separateFallback of [false, true]) {
      test(`${api} falls back with an active checkpoint on ${reason}, separate fallback=${separateFallback}`, { timeout: 20_000 }, async () => {
        let failRemote = false;
        const fixture = await sessionFixture({
          api, extensions: [createCodexCompactionExtension()],
          respond: ({ payload }) => failRemote && hasItem(payload, "compaction_trigger")
            ? new Response("Temporary service outage", { status: 503 }) : undefined,
        });
        try {
          const checkpoint = await seedHistory(fixture);
          const saved = structuredClone(checkpoint.entry.details);
          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(configPath, JSON.stringify({
            version: 1, remoteCompaction: { enabled: reason !== "V2 disabled" },
            ...(separateFallback ? { fallback: { enabled: true, provider: fixture.model.provider,
              model: fixture.model.id, thinkingLevel: "low" } } : {}),
          }));
          const requestCount = fixture.requests.length;
          failRemote = reason === "remote failure";
          await fixture.session.compact();
          const attempted = fixture.requests.slice(requestCount);
          const summaries = attempted.filter(({ payload }) => !hasItem(payload, "compaction_trigger"));
          assert.ok(summaries.length > 0, "Native summaries remain available after an opaque checkpoint");
          assert.ok(summaries.every(({ payload }) => !hasItem(payload, "compaction")));
          assert.equal(latestCheckpoint(fixture.session.sessionManager.getBranch()), undefined);
          assert.equal(fixture.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 2);
          assert.deepEqual(checkpoint.entry.details, saved, "The persisted V2 entry remains unchanged");

          failRemote = false;
          await fixture.session.prompt("Continue after the text summary.");
          assert.ok(!hasItem(fixture.requests.at(-1)!.payload, "compaction"));
          assert.deepEqual(fixture.errors, []);
        } finally {
          await fixture.close();
          await rm(configPath, { force: true });
        }
      });
    }
  }

  test(`${api} applies image blocking to ordinary and recursive checkpoint replay`, { timeout: 20_000 }, async () => {
    const image = { type: "image" as const, mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
    const fixture = await sessionFixture({ api, extensions: [createCodexCompactionExtension()] });
    try {
      await fixture.session.prompt("Preserve the constraints in this image. ".repeat(80), { images: [image] });
      for (let turn = 0; turn < 2; turn++) await fixture.session.prompt("Continue the implementation. ".repeat(80));
      await fixture.session.compact();
      const checkpoint = latestCheckpoint(fixture.session.sessionManager.getBranch());
      assert.ok(checkpoint);
      const saved = structuredClone(checkpoint.entry.details);
      assert.ok(JSON.stringify(saved).includes(image.data));

      fixture.session.settingsManager.setBlockImages(true);
      await fixture.session.prompt("Continue with image reading disabled. ".repeat(80));
      assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)!.payload), /"type":"input_image"/);
      assert.ok(!JSON.stringify(fixture.requests.at(-1)!.payload).includes(image.data));
      assert.deepEqual(checkpoint.entry.details, saved);

      fixture.session.settingsManager.setBlockImages(false);
      await fixture.session.prompt("Read the saved image again.");
      assert.ok(JSON.stringify(fixture.requests.at(-1)!.payload).includes(image.data));

      fixture.session.settingsManager.setBlockImages(true);
      await fixture.session.compact();
      const recompacted = fixture.requests.at(-1)!.payload;
      assert.ok(hasItem(recompacted, "compaction_trigger"));
      assert.doesNotMatch(JSON.stringify(recompacted), /"type":"input_image"/);
      assert.ok(!JSON.stringify(recompacted).includes(image.data));
      assert.deepEqual(checkpoint.entry.details, saved);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}
