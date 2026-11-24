import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import codexCompaction from "../src/index.js";
import { isObject, isObjectArray, type CompactionPayload } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
beforeEach(() => rm(dirname(settingsPath), { recursive: true, force: true }));

async function setEffortSwitch(enabled: boolean) {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ version: 2, reasoningEffortUpdates: { enabled } }));
}

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const trigger = { type: "compaction_trigger" };

function simulatePiEffort(payload: CompactionPayload, effort: string | undefined): CompactionPayload {
  return {
    ...payload,
    input: [...payload.input.flatMap((item) => item.role === "assistant" ? [update("low"), item] : [item]),
      update(effort ?? "low")],
    reasoning: { effort: "medium", summary: "auto" },
  };
}

function responsesPayload(payload: unknown) {
  assert.ok(isObject(payload) && isObjectArray(payload.input) && isObject(payload.reasoning));
  return { ...payload, input: payload.input, reasoning: payload.reasoning };
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const enabled of [true, false]) {
    test(`${api} chat and V2 use the effort switch from settings (${enabled ? "On" : "Off"})`, { timeout: 20_000 }, async (t) => {
      await setEffortSwitch(enabled);
      let observed: unknown;
      const observePiPayload: ExtensionFactory = (pi) => {
        pi.on("before_provider_request", ({ payload }) => { observed = structuredClone(payload); });
      };
      let compactionAttempts = 0;
      const fixture = await sessionFixture({
        api, extensions: [observePiPayload, codexCompaction], serializePayload: simulatePiEffort,
        settings: { retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1 } } },
        respond({ payload }) {
          const { input } = responsesPayload(payload);
          if (input.at(-1)?.type === trigger.type && ++compactionAttempts === 1) {
            return new Response("Fixture busy", { status: 503, headers: { "retry-after-ms": "1" } });
          }
        },
      });
      t.after(() => fixture.close());
      for (let turn = 1; turn <= 3; turn++) {
        await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
      }
      const ordinary = responsesPayload(fixture.requests.at(-1)?.payload);
      const dense = responsesPayload(observed);
      const updates = dense.input.filter((item) => item.type === "configuration_update");
      assert.deepEqual(updates, [update("low"), update("low"), update("low")]);
      const expectedChatInput = enabled
        ? dense.input.filter((item) => item.type !== "configuration_update" || item === updates[0])
        : dense.input;
      assert.deepEqual(ordinary.input, JSON.parse(JSON.stringify(expectedChatInput)));
      assert.deepEqual(ordinary.reasoning, { effort: enabled ? "low" : "medium", summary: "auto" });

      const chatRequestCount = fixture.requests.length;
      await fixture.session.compact();
      const attempts = fixture.requests.slice(chatRequestCount);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[1].bodyBytes, attempts[0].bodyBytes);
      const compacting = responsesPayload(attempts[0].payload);
      assert.deepEqual(compacting.input.at(-1), trigger);
      assert.deepEqual(compacting.reasoning, ordinary.reasoning);
      // The last chat update becomes the update before its assistant reply in V2.
      assert.deepEqual(compacting.input.slice(0, ordinary.input.length), ordinary.input);
      assert.deepEqual(compacting.input.filter((item) => item.type === "configuration_update"),
        enabled ? [update("low")] : [update("low"), update("low"), update("low"), update("low")]);

      const entry = fixture.session.sessionManager.getBranch().findLast((item) => item.type === "compaction");
      assert.ok(entry && parseCheckpointDetails(entry.details));
      fixture.session.setThinkingLevel("high");
      await fixture.session.prompt("Continue with the saved checkpoint.");
      const continuation = responsesPayload(fixture.requests.at(-1)?.payload);
      const continuationInput = continuation.input;
      const compactedAt = continuationInput.findIndex((item) => item.type === "compaction");
      assert.ok(compactedAt >= 0, "The checkpoint must be replayed into the ordinary request");
      assert.deepEqual(continuationInput.slice(compactedAt + 1).filter((item) => item.type === "configuration_update"),
        enabled ? [] : [update("high")]);
      assert.equal(continuation.reasoning.effort, enabled ? "high" : "medium");
      assert.deepEqual(fixture.errors, []);
    });
  }
}

test("chat defaults to Pi effort updates without config and a command toggle applies on the next request", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [codexCompaction], serializePayload: simulatePiEffort });
  t.after(() => fixture.close());
  const notices: string[] = [];
  // Pi uses only the selector and notification methods for this RPC command.
  await fixture.session.bindExtensions({ mode: "rpc", uiContext: {
    async select(_title, options) { return options.find((option) => option.startsWith("Codex reasoning effort updates:")); },
    notify(message) { notices.push(message); },
  } as ExtensionUIContext });
  const sessionId = fixture.session.sessionManager.getSessionId();
  for (const enabled of [false, true, false]) {
    await fixture.session.prompt(`Continue the task with the effort switch ${enabled ? "On" : "Off"}.`);
    const { input, reasoning } = responsesPayload(fixture.requests.at(-1)?.payload);
    assert.equal(reasoning.effort, enabled ? "low" : "medium");
    assert.equal(input.filter((item) => item.type === "configuration_update").length,
      enabled ? 1 : fixture.requests.length);
    if (fixture.requests.length < 3) await fixture.session.prompt("/codex-compaction");
  }
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.session.sessionManager.getSessionId(), sessionId);
  assert.equal(notices.length, 2);
  assert.deepEqual(fixture.errors, []);
});

test("compaction reloads the effort switch for V2 and subsequent chat requests", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [codexCompaction], serializePayload: simulatePiEffort });
  t.after(() => fixture.close());
  for (let turn = 1; turn <= 3; turn++) {
    await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
  }
  await setEffortSwitch(true);
  await fixture.session.compact();
  const compacting = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.deepEqual(compacting.input.at(-1), trigger);
  assert.deepEqual(compacting.input.filter((item) => item.type === "configuration_update"), [update("low")]);
  assert.equal(compacting.reasoning.effort, "low");
  fixture.session.setThinkingLevel("high");
  await fixture.session.prompt("Continue with the saved checkpoint.");
  assert.equal(responsesPayload(fixture.requests.at(-1)?.payload).reasoning.effort, "high");
  assert.deepEqual(fixture.errors, []);
});
