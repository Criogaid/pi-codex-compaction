import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import codexCompaction from "../src/index.js";
import { isObject, isObjectArray } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
beforeEach(() => rm(dirname(settingsPath), { recursive: true, force: true }));

async function setEffortSwitch(enabled: boolean) {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ version: 2, reasoningEffortUpdates: { enabled } }));
}

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const trigger = { type: "compaction_trigger" };
const retrySettings = { retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1 } } };

function responsesPayload(payload: unknown) {
  assert.ok(isObject(payload) && isObjectArray(payload.input) && isObject(payload.reasoning));
  return { ...payload, input: payload.input, reasoning: payload.reasoning };
}

function effortUpdates(input: ReturnType<typeof responsesPayload>["input"]) {
  return input.filter((item) => item.type === "configuration_update");
}

async function fillHistory(session: Awaited<ReturnType<typeof sessionFixture>>["session"], phase: string) {
  for (let turn = 1; turn <= 3; turn++) {
    await session.prompt(`${phase} ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
  }
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const enabled of [true, false]) {
    test(`${api} chat and V2 use the effort switch from settings (${enabled ? "On" : "Off"})`, { timeout: 20_000 }, async (t) => {
      await setEffortSwitch(enabled);
      let observed: unknown;
      let compactionAttempts = 0;
      const observePiPayload: ExtensionFactory = (pi) => {
        pi.on("before_provider_request", ({ payload }) => { observed = structuredClone(payload); });
      };
      const emitsUpdates = api === "openai-responses";
      const fixture = await sessionFixture({
        api, extensions: [observePiPayload, codexCompaction], simulatePi152Effort: true, settings: retrySettings,
        respond({ payload }) {
          if (responsesPayload(payload).input.at(-1)?.type === trigger.type && ++compactionAttempts === 1) {
            return new Response("Fixture busy", { status: 503, headers: { "retry-after-ms": "1" } });
          }
        },
      });
      t.after(() => fixture.close());
      await fillHistory(fixture.session, "Task");
      const ordinary = responsesPayload(fixture.requests.at(-1)?.payload);
      const original = responsesPayload(observed);
      const updates = effortUpdates(original.input);
      assert.deepEqual(updates, emitsUpdates ? [update("low"), update("low"), update("low")] : []);
      const expectedChatInput = emitsUpdates && enabled
        ? original.input.filter((item) => item.type !== "configuration_update" || item === updates[0])
        : original.input;
      assert.deepEqual(ordinary.input, JSON.parse(JSON.stringify(expectedChatInput)));
      assert.deepEqual(ordinary.reasoning, { effort: emitsUpdates && !enabled ? "medium" : "low", summary: "auto" });

      const chatRequestCount = fixture.requests.length;
      await fixture.session.compact();
      const attempts = fixture.requests.slice(chatRequestCount);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[1].bodyBytes, attempts[0].bodyBytes);
      const compacting = responsesPayload(attempts[0].payload);
      assert.deepEqual(compacting.input.at(-1), trigger);
      assert.deepEqual(compacting.reasoning, ordinary.reasoning);
      // The chat's sampling update becomes the historical update before its reply in V2.
      assert.deepEqual(compacting.input.slice(0, ordinary.input.length), ordinary.input);
      assert.deepEqual(effortUpdates(compacting.input), emitsUpdates
        ? enabled ? [update("low")] : [update("low"), update("low"), update("low"), update("low")]
        : []);

      const entry = fixture.session.sessionManager.getBranch().findLast((item) => item.type === "compaction");
      assert.ok(entry && parseCheckpointDetails(entry.details));
      fixture.session.setThinkingLevel("high");
      await fixture.session.prompt("Continue with the saved checkpoint.");
      const continuation = responsesPayload(fixture.requests.at(-1)?.payload);
      const compactedAt = continuation.input.findIndex((item) => item.type === "compaction");
      assert.ok(compactedAt >= 0, "The checkpoint must be replayed into the ordinary request");
      assert.deepEqual(effortUpdates(continuation.input.slice(compactedAt + 1)),
        emitsUpdates && !enabled ? [update("high")] : []);
      assert.equal(continuation.reasoning.effort, emitsUpdates && !enabled ? "medium" : "high");
      assert.deepEqual(fixture.errors, []);
    });
  }
}

test("synthetic Pi 1.5.2 effort shape groups outputs by same-model assistant message", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [], simulatePi152Effort: true });
  t.after(() => fixture.close());
  await fixture.session.prompt("Record a real assistant reply at low effort.");
  const assistant = fixture.session.messages.findLast((message) => message.role === "assistant");
  assert.ok(assistant);
  const manager = fixture.session.sessionManager;
  manager.appendMessage({ ...assistant, model: "gpt-fixture-other-model", providerThinkingLevel: "medium",
    content: [{ type: "text", text: "Different model output." }] });
  manager.appendMessage({ ...assistant, providerThinkingLevel: undefined,
    content: [{ type: "text", text: "Assistant output without a native effort." }] });
  manager.appendMessage({ ...assistant, providerThinkingLevel: "high", content: [] });
  manager.appendMessage({ ...assistant, providerThinkingLevel: "medium", stopReason: "toolUse", content: [
    { type: "toolCall", id: "call_fixture|fc_fixture", name: "fixture_tool", arguments: {} },
    { type: "text", text: "Same assistant message, second output." },
  ] });
  manager.appendMessage({ role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "fixture_tool",
    content: [{ type: "text", text: "Fixture tool result." }], isError: false, timestamp: assistant.timestamp });
  await fixture.reopen();
  fixture.session.setThinkingLevel("high");
  await fixture.session.prompt("Read the replayed history.");
  const { input, reasoning } = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.equal(reasoning.effort, "medium");
  assert.deepEqual(effortUpdates(input), [update("low"), update("medium"), update("high")]);
  const toolAt = input.findIndex((item) => item.type === "function_call" && item.call_id === "call_fixture");
  assert.ok(toolAt > 0);
  assert.deepEqual(input[toolAt - 1], update("medium"));
  assert.equal(input[toolAt - 2]?.role, "assistant");
  assert.equal(input[toolAt + 1]?.role, "assistant");
  assert.equal(input[toolAt + 2]?.type, "function_call_output");
  assert.deepEqual(input.at(-1), update("high"));
  assert.deepEqual(fixture.errors, []);
});

test("openai-responses leaves effort on the request when mid-conversation effort is unsupported", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [], simulatePi152Effort: true,
    models: (base) => [{ ...base, compat: { ...base.compat, supportsMidConvoEffort: false } }],
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("Record a reply at low effort.");
  fixture.session.setThinkingLevel("high");
  await fixture.session.prompt("Continue at high effort.");
  const { input, reasoning } = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.deepEqual(effortUpdates(input), []);
  assert.equal(reasoning.effort, "high");
  assert.deepEqual(fixture.errors, []);
});

test("V2 retry over a checkpoint preserves the request baseline and later effort change", { timeout: 20_000 }, async (t) => {
  await setEffortSwitch(true);
  let retrySecondCompaction = false;
  let rejected = false;
  const fixture = await sessionFixture({
    extensions: [codexCompaction], simulatePi152Effort: true, settings: retrySettings,
    respond({ payload }) {
      if (retrySecondCompaction && !rejected && responsesPayload(payload).input.at(-1)?.type === trigger.type) {
        rejected = true;
        return new Response("Fixture busy", { status: 503, headers: { "retry-after-ms": "1" } });
      }
    },
  });
  t.after(() => fixture.close());
  fixture.session.setThinkingLevel("medium");
  await fillHistory(fixture.session, "Before first checkpoint");
  await fixture.session.compact();
  const checkpoint = fixture.session.sessionManager.getBranch().findLast((item) => item.type === "compaction");
  assert.ok(checkpoint && parseCheckpointDetails(checkpoint.details));
  await fixture.session.prompt("Continue with the saved checkpoint at medium effort.");
  fixture.session.setThinkingLevel("high");
  await fillHistory(fixture.session, "After increasing effort");

  const requestCount = fixture.requests.length;
  retrySecondCompaction = true;
  await fixture.session.compact();
  const attempts = fixture.requests.slice(requestCount);
  assert.ok(rejected, "The first attempt at the second compaction must receive a 503");
  assert.equal(attempts.length, 2);
  for (const [attempt, { payload }] of attempts.entries()) {
    const { input, reasoning } = responsesPayload(payload);
    assert.deepEqual(input.at(-1), trigger);
    const compactionAt = input.findIndex((item) => item.type === "compaction");
    assert.ok(compactionAt >= 0, "The second compaction must replay the first checkpoint");
    assert.deepEqual({ baseline: reasoning.effort, updates: effortUpdates(input.slice(compactionAt + 1)) },
      { baseline: "medium", updates: [update("high")] }, `Second compaction attempt ${attempt + 1}`);
  }
  assert.deepEqual(attempts[1].bodyBytes, attempts[0].bodyBytes);
  const nextCheckpoint = fixture.session.sessionManager.getBranch().findLast((item) => item.type === "compaction");
  assert.ok(nextCheckpoint && parseCheckpointDetails(nextCheckpoint.details));
  assert.notEqual(nextCheckpoint.id, checkpoint.id);
  assert.deepEqual(fixture.errors, []);
});

test("chat defaults to Pi effort updates without config and a command toggle applies on the next request", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [codexCompaction], simulatePi152Effort: true });
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
    assert.deepEqual(effortUpdates(input), Array.from({ length: enabled ? 1 : fixture.requests.length }, () => update("low")));
    if (fixture.requests.length < 3) await fixture.session.prompt("/codex-compaction");
  }
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.session.sessionManager.getSessionId(), sessionId);
  assert.equal(notices.length, 2);
  assert.deepEqual(fixture.errors, []);
});

test("compaction keeps the session effort switch for V2 and subsequent chat requests", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({ extensions: [codexCompaction], simulatePi152Effort: true });
  t.after(() => fixture.close());
  await fillHistory(fixture.session, "Task");
  await setEffortSwitch(true);
  await fixture.session.compact();
  const compacting = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.deepEqual(compacting.input.at(-1), trigger);
  assert.deepEqual(effortUpdates(compacting.input), [update("low"), update("low"), update("low"), update("low")]);
  assert.equal(compacting.reasoning.effort, "medium");
  fixture.session.setThinkingLevel("high");
  await fixture.session.prompt("Continue with the saved checkpoint.");
  const continuation = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.equal(continuation.reasoning.effort, "medium");
  assert.deepEqual(effortUpdates(continuation.input), [update("high")]);
  assert.deepEqual(fixture.errors, []);
});
