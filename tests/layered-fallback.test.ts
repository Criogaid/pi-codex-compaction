import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture, type SessionRequest } from "./helpers.js";

const configPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const summaryModelId = "fixture-text-summary";
const hasTrigger = ({ payload }: SessionRequest) => Array.isArray(payload.input) &&
  payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
const checkpointItems = (payload: JsonObject) => {
  assert.ok(Array.isArray(payload.input));
  return payload.input.filter((item) => isObject(item) && item.type === "compaction");
};
const occurrences = (value: unknown, text: string) => JSON.stringify(value).split(text).length - 1;
const work = (marker: string) => `${marker} ${"Preserve this implementation decision. ".repeat(100)}`;

async function configure(provider: string, enabled = true) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 2, remoteCompaction: { enabled },
    summaryModel: { provider, model: summaryModelId, thinkingLevel: "low" } }));
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`real ${api} layers failed V2 text fallback over A without losing or duplicating history`, { timeout: 30_000 }, async () => {
    let failRemote = false;
    const fixture = await sessionFixture({
      api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
      respond: (request) => failRemote && hasTrigger(request)
        ? new Response("Temporary fixture outage", { status: 503 }) : undefined,
    });
    try {
      await configure(fixture.model.provider);
      await fixture.session.prompt(work("before-A-one"));
      await fixture.session.prompt(work("before-A-two"));
      await fixture.session.prompt(work("before-A-tail"));
      await fixture.session.compact();
      await fixture.session.prompt(work("discarded-after-A-one"));
      const initial = fixture.requests.at(-1)!.payload;
      const a = checkpointItems(initial);
      assert.equal(a.length, 1, "The first successful V2 creates A");
      await fixture.session.prompt(work("discarded-after-A-two"));
      await fixture.session.prompt(work("retained-after-A-tail"));
      const beforeFallback = fixture.requests.length;
      failRemote = true;
      await fixture.session.compact();
      const attempted = fixture.requests.slice(beforeFallback);
      assert.equal(attempted.filter(hasTrigger).length, 1);
      const summaries = attempted.filter(({ payload }) => payload.model === summaryModelId);
      assert.ok(summaries.length > 0, "The configured text model handles the failed V2 request");
      const summaryInput = summaries.map(({ payload }) => payload.input);
      assert.equal(occurrences(summaryInput, "before-A-"), 0, "The text model must not summarize plaintext already represented by A");
      assert.equal(occurrences(summaryInput, "encrypted_content"), 0, "Opaque A never enters text summarization");
      for (const marker of ["discarded-after-A-one", "discarded-after-A-two"]) {
        assert.equal(occurrences(summaryInput, marker), 1, "Each discarded post-A message is summarized once");
      }
      assert.equal(occurrences(summaryInput, "retained-after-A-tail"), 0, "The retained tail stays outside the summary");
      const summaryTexts = summaries.map((request) => `Fixture reply ${fixture.requests.indexOf(request) + 1}.`);
      const retiredSummaryTexts: string[] = [];
      let retainedMarker = "retained-after-A-tail";
      const discardedMarkers = ["discarded-after-A-one", "discarded-after-A-two"];
      const assertReplay = (payload: JsonObject) => {
        assert.deepEqual(checkpointItems(payload), a, "Replay A exactly once");
        for (const summary of summaryTexts) assert.equal(occurrences(payload.input, summary), 1, "Replay the cumulative text summary once");
        for (const summary of retiredSummaryTexts) assert.equal(occurrences(payload.input, summary), 0, "The cumulative summary replaces its predecessor");
        assert.equal(occurrences(payload.input, retainedMarker), 1, "Replay the retained tail once");
        for (const marker of discardedMarkers) {
          assert.equal(occurrences(payload.input, marker), 0, "Summarized messages must not also survive verbatim");
        }
      };
      await fixture.session.prompt("Continue immediately after layered fallback.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.reopen();
      await fixture.session.prompt("Continue after reopening layered fallback.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.session.prompt(work("second-layer-discarded"));
      await fixture.session.prompt(work("second-layer-tail"));
      const secondStart = fixture.requests.length;
      await fixture.session.compact();
      const secondSummaries = fixture.requests.slice(secondStart).filter(({ payload }) => payload.model === summaryModelId);
      assert.ok(secondSummaries.length > 0);
      const secondInput = secondSummaries.map(({ payload }) => payload.input);
      for (const marker of [retainedMarker, "second-layer-discarded"]) assert.equal(occurrences(secondInput, marker), 1);
      for (const summary of summaryTexts) assert.equal(occurrences(secondInput, summary), 1, "The summary model receives the previous plaintext summary once");
      for (const marker of [...discardedMarkers, "before-A-", "second-layer-tail", "encrypted_content"]) {
        assert.equal(occurrences(secondInput, marker), 0, "A new layer summarizes only newly discarded history");
      }
      discardedMarkers.push(retainedMarker, "second-layer-discarded");
      retainedMarker = "second-layer-tail";
      retiredSummaryTexts.push(...summaryTexts);
      summaryTexts.splice(0, summaryTexts.length, ...secondSummaries.map((request) => `Fixture reply ${fixture.requests.indexOf(request) + 1}.`));
      await fixture.session.prompt("Continue after repeated text layering.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.reopen();
      await fixture.session.prompt("Resume the repeated layers.");
      assertReplay(fixture.requests.at(-1)!.payload);
      failRemote = false;
      await fixture.session.prompt(work("work-before-V2-recovery"));
      await fixture.session.prompt(work("tail-before-V2-recovery"));
      await fixture.session.compact();
      const resumed = fixture.requests.at(-1)!;
      assert.ok(hasTrigger(resumed), "A later V2 can compact the layered history");
      assertReplay(resumed.payload);
      await fixture.session.prompt("Continue after successful V2 recovery.");
      const recovered = checkpointItems(fixture.requests.at(-1)!.payload);
      assert.equal(recovered.length, 1);
      assert.notDeepEqual(recovered, a, "Successful V2 replaces A rather than stacking both opaque items");
      for (const summary of [...summaryTexts, ...retiredSummaryTexts]) {
        assert.equal(occurrences(fixture.requests.at(-1)!.payload.input, summary), 0, "Successful V2 absorbs old text layers");
      }
      assert.equal(fixture.session.model?.id, fixture.model.id);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
      await rm(configPath, { force: true });
    }
  });

  for (const enabled of [true, false]) {
    test(`real ${api} keeps native text fallback without A, V2 enabled=${enabled}`, { timeout: 20_000 }, async () => {
      const fixture = await sessionFixture({
        api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
        models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
        respond: (request) => hasTrigger(request) ? new Response("Fixture rejection", { status: 400 }) : undefined,
      });
      try {
        await configure(fixture.model.provider, enabled);
        await fixture.session.prompt(work("native-discarded-one"));
        await fixture.session.prompt(work("native-discarded-two"));
        await fixture.session.prompt(work("native-retained-tail"));
        const start = fixture.requests.length;
        await fixture.session.compact();
        const attempts = fixture.requests.slice(start);
        assert.equal(attempts.filter(hasTrigger).length, enabled ? 1 : 0);
        const summaries = attempts.filter(({ payload }) => payload.model === summaryModelId);
        assert.ok(summaries.length > 0);
        for (const marker of ["native-discarded-one", "native-discarded-two"]) {
          assert.equal(occurrences(summaries.map(({ payload }) => payload.input), marker), 1);
        }
        await fixture.session.prompt("Continue native text history.");
        assert.equal(checkpointItems(fixture.requests.at(-1)!.payload).length, 0);
        assert.equal(occurrences(fixture.requests.at(-1)!.payload.input, "native-retained-tail"), 1);
        assert.equal(fixture.session.model?.id, fixture.model.id);
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
        await rm(configPath, { force: true });
      }
    });
  }
}
