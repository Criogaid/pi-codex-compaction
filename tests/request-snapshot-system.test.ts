import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemMessage, getSystemMessageText, renderSystemMessageUpdate } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import codexCompaction from "../src/index.js";
import { isObject, isObjectArray, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

type Fixture = Awaited<ReturnType<typeof sessionFixture>>;

function inputItems(payload: JsonObject): JsonObject[] {
  assert.ok(isObjectArray(payload.input));
  return payload.input;
}

function lastPayload(fixture: Fixture): JsonObject {
  const request = fixture.requests.at(-1);
  assert.ok(request);
  return request.payload;
}

async function installCheckpoint(fixture: Fixture): Promise<JsonObject> {
  for (let turn = 1; turn <= 3; turn++) {
    await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
  }
  const checkpoint = parseCheckpointDetails((await fixture.session.compact()).details);
  assert.ok(checkpoint);
  const opaque = checkpoint.replacementHistory.find((item) => item.type === "compaction");
  assert.ok(opaque);
  return opaque;
}

function isInstruction(item: JsonObject): boolean {
  return item.role === "developer" || item.role === "system";
}

function userItem(text: string): JsonObject {
  return { role: "user", content: [{ type: "input_text", text }] };
}

test("V2 keeps cancelling system section deltas around their user turn", async () => {
  const fixture = await sessionFixture({ extensions: [codexCompaction] });
  try {
    await installCheckpoint(fixture);
    await fixture.session.prompt("Continue from the checkpoint. ".repeat(60));
    const [head] = inputItems(lastPayload(fixture));
    assert.ok(isInstruction(head));

    const { sessionManager } = fixture.session;
    const add = { role: "system" as const, content: "", sections: { fixture: "Temporary instructions" }, timestamp: 1 };
    const remove = { role: "system" as const, content: "", sections: { fixture: null }, timestamp: 3 };
    const user = "Work under the temporary instructions. ".repeat(60);
    sessionManager.appendMessage(add);
    sessionManager.appendMessage({ role: "user", content: user, timestamp: 2 });
    const preCompactionLeaf = sessionManager.appendMessage(remove);
    fixture.session.refreshContext();

    assert.ok(parseCheckpointDetails((await fixture.session.compact()).details));
    const compacted = inputItems(lastPayload(fixture));
    assert.deepEqual(compacted.at(-1), { type: "compaction_trigger" });

    // Ask Pi to serialize the same branch after measuring V2, so chat cannot refresh the snapshot first.
    sessionManager.branch(preCompactionLeaf);
    fixture.session.refreshContext();
    await fixture.session.prompt("Confirm the temporary section has been removed.");
    const ordinary = inputItems(lastPayload(fixture));
    const turnItems = (items: JsonObject[]) => items.filter((item) => isInstruction(item) ||
      (item.role === "user" && isObjectArray(item.content) && item.content.some((part) => part.text === user)));
    assert.deepEqual(turnItems(ordinary), [
      head,
      { role: head.role, content: renderSystemMessageUpdate(add) },
      userItem(user),
      { role: head.role, content: renderSystemMessageUpdate(remove) },
    ]);
    assert.deepEqual(turnItems(compacted), turnItems(ordinary));
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("V2 without new system deltas reuses the observed checkpoint wire prefix", async () => {
  const wireOnlyInstruction = { role: "developer", content: "Provider-only instruction for the observed request." };
  let stampOrdinary = false;
  const fixture = await sessionFixture({ extensions: [
    (pi) => pi.on("before_provider_request", ({ payload }) => {
      if (!stampOrdinary) return;
      assert.ok(isObject(payload) && isObjectArray(payload.input));
      return { ...payload, input: [...payload.input, wireOnlyInstruction] };
    }),
    codexCompaction,
  ] });
  try {
    const opaque = await installCheckpoint(fixture);
    stampOrdinary = true;
    await fixture.session.prompt("Continue from the checkpoint. ".repeat(60));
    stampOrdinary = false;
    const ordinary = inputItems(lastPayload(fixture));
    assert.ok(ordinary.some((item) => item.encrypted_content === opaque.encrypted_content));
    assert.deepEqual(ordinary.at(-1), wireOnlyInstruction);

    assert.ok(parseCheckpointDetails((await fixture.session.compact()).details));
    const compacted = inputItems(lastPayload(fixture));
    assert.equal(JSON.stringify(compacted.slice(0, ordinary.length)), JSON.stringify(ordinary));
    assert.deepEqual(compacted.at(-1), { type: "compaction_trigger" });
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api} keeps checkpoint system order in chat and V2 after reload`, async (t) => {
    const fixture = await sessionFixture({ api, extensions: [codexCompaction] });
    try {
      const opaque = await installCheckpoint(fixture);
      const leadingPrompt = (payload: JsonObject) => api === "openai-codex-responses"
        ? payload.instructions : inputItems(payload)[0].content;
      const originalPrompt = leadingPrompt(lastPayload(fixture));
      assert.equal(typeof originalPrompt, "string");
      const update = "Use the updated instructions for the next task.";
      const user = "Continue under the updated instructions. ".repeat(60);
      fixture.session.sessionManager.appendMessage({ role: "system", content: update, timestamp: 1 });
      fixture.session.refreshContext();
      await fixture.session.prompt(user);
      const ordinary = lastPayload(fixture);

      await fixture.session.reload();
      const beforeV2 = fixture.requests.length;
      assert.ok(parseCheckpointDetails((await fixture.session.compact()).details));
      assert.equal(fixture.requests.length, beforeV2 + 1);
      const compacted = lastPayload(fixture);
      assert.deepEqual(inputItems(compacted).at(-1), { type: "compaction_trigger" });

      for (const [phase, payload] of [["chat", ordinary], ["V2 after reload", compacted]] as const) {
        await t.test(phase, () => {
          const items = inputItems(payload);
          const replay = items.findIndex((item) => item.encrypted_content === opaque.encrypted_content);
          assert.ok(replay >= 0, "The previous checkpoint must be replayed");
          assert.deepEqual({ prompt: leadingPrompt(payload), afterReplay: items.slice(replay + 1, replay + 3) }, {
            prompt: originalPrompt,
            afterReplay: [{ role: "developer", content: update }, userItem(user)],
          });
        });
      }
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}

const warmup = "Record the background decisions for this task. ".repeat(60);
const suffixTurn = "Apply the new instructions.";

function hasUserText(item: JsonObject, text: string): boolean {
  return item.role === "user" && isObjectArray(item.content) && item.content.some((part) => part.text === text);
}

function appendSystemSuffix(fixture: Fixture): { delta: JsonObject; user: JsonObject } {
  const update = { role: "system" as const, content: "Use the new instructions for the final task.", timestamp: Date.now() };
  fixture.session.sessionManager.appendMessage(update);
  fixture.session.sessionManager.appendMessage({ role: "user", content: suffixTurn, timestamp: Date.now() });
  fixture.session.refreshContext();
  return { delta: { role: "developer", content: renderSystemMessageUpdate(update) }, user: userItem(suffixTurn) };
}

async function compactInput(fixture: Fixture): Promise<JsonObject[]> {
  const before = fixture.requests.length;
  assert.ok(parseCheckpointDetails((await fixture.session.compact()).details));
  assert.equal(fixture.requests.length, before + 1);
  const items = inputItems(lastPayload(fixture));
  assert.deepEqual(items.at(-1), { type: "compaction_trigger" });
  return items;
}

test("V2 treats an empty forced prompt as an override of Pi's persisted sections", async (t) => {
  const forcedTurn = "Continue with no system text.";
  const fixture = await sessionFixture({ extensions: [codexCompaction, (pi) => {
    pi.on("before_agent_start", ({ prompt }) => {
      if (prompt === forcedTurn) return { systemPrompt: "" };
    });
  }] });
  t.after(() => fixture.close());
  await fixture.session.prompt(warmup);
  await fixture.session.prompt(warmup);
  await fixture.session.prompt(forcedTurn);
  const { sessionManager } = fixture.session;
  const persisted = getCurrentSystemMessage(sessionManager.buildSessionContext().messages);
  assert.ok(persisted?.sections?.preamble);
  assert.notEqual(getSystemMessageText(persisted), "");
  assert.deepEqual(inputItems(lastPayload(fixture)).filter(isInstruction), []);
  fixture.session.setThinkingLevel("high");
  assert.deepEqual((await compactInput(fixture)).filter(isInstruction), []);
  assert.deepEqual(fixture.errors, []);
});

test("V2 scopes a same-text forced prompt sample to one Pi run", async (t) => {
  const forcedTurn = "Continue with the base prompt forced at the head.";
  const continuation = "Complete the queued follow-up.";
  const fixtureSection = "Temporary instructions used during warmup.";
  let forcedPrompt: string | undefined;
  const starts: string[] = [];
  const attempts: JsonObject[][] = [];
  let queueFollowUp: (() => Promise<void>) | undefined;
  const fixture = await sessionFixture({
    settings: { retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1 } } },
    extensions: [codexCompaction, (pi) => {
      pi.on("before_agent_start", (event) => {
        starts.push(event.prompt);
        if (event.prompt === warmup) event.systemPromptOptions.sections.fixture = fixtureSection;
        if (event.prompt === forcedTurn) {
          forcedPrompt = event.systemPrompt;
          return { systemPrompt: forcedPrompt };
        }
      });
    }],
    async respond({ payload }) {
      if (!queueFollowUp) return;
      attempts.push(inputItems(payload));
      if (attempts.length === 1) await queueFollowUp();
      if (attempts.length === 2) {
        return Response.json({ error: { message: "Service unavailable" } }, {
          status: 503, headers: { "retry-after-ms": "1" },
        });
      }
    },
  });
  t.after(() => fixture.close());

  await fixture.session.prompt(warmup);
  await fixture.session.prompt(warmup);
  const warmupInstructions = inputItems(lastPayload(fixture)).filter(isInstruction);
  assert.equal(warmupInstructions.length, 1);
  const warmupHead = warmupInstructions[0].content;
  assert.ok(typeof warmupHead === "string" && warmupHead.includes(fixtureSection));
  queueFollowUp = async () => {
    assert.equal(await fixture.session.followUp(continuation), "queued");
  };
  await fixture.session.prompt(forcedTurn);
  queueFollowUp = undefined;

  assert.deepEqual(starts, [warmup, warmup, forcedTurn]);
  assert.equal(attempts.length, 3);
  assert.ok(forcedPrompt);
  const head = { role: "developer", content: forcedPrompt };
  for (const attempt of attempts) assert.deepEqual(attempt.filter(isInstruction), [head]);
  assert.ok(!attempts[0].some((item) => hasUserText(item, continuation)));
  assert.ok(attempts[1].some((item) => hasUserText(item, continuation)));
  assert.deepEqual(attempts[2], attempts[1]);

  const { sessionManager } = fixture.session;
  const persisted = getCurrentSystemMessage(sessionManager.buildSessionContext().messages);
  assert.ok(persisted);
  assert.equal(getSystemMessageText(persisted), forcedPrompt);
  const leaf = sessionManager.getLeafId();
  assert.ok(leaf);

  await t.test("continuation and retry preserve the folded prefix and leave the new delta in place", async () => {
    const { delta, user } = appendSystemSuffix(fixture);
    const items = await compactInput(fixture);
    const relevant = items.filter((item) => isInstruction(item) || hasUserText(item, continuation) || hasUserText(item, suffixTurn));
    assert.deepEqual(relevant, [head, userItem(continuation), delta, user]);
  });

  await t.test("an idle custom-message run does not inherit the force", async () => {
    sessionManager.branch(leaf);
    fixture.session.refreshContext();
    const beforeIdle = fixture.requests.length;
    await fixture.session.sendCustomMessage({
      customType: "idle-follow-up", content: "Review the transcript as recorded.", display: true,
    }, { triggerTurn: true });
    assert.equal(fixture.requests.length, beforeIdle + 1);
    assert.deepEqual(starts, [warmup, warmup, forcedTurn]);
    const inPlaceItems = (item: JsonObject) => isInstruction(item) || hasUserText(item, warmup) || hasUserText(item, forcedTurn);
    const ordinary = inputItems(lastPayload(fixture)).filter(inPlaceItems);
    assert.deepEqual(ordinary.map((item) => item.role), ["developer", "user", "user", "developer", "user"]);
    assert.deepEqual(ordinary[0], warmupInstructions[0]);
    // A new effort requires V2 to serialize its context without the observed wire prefix.
    fixture.session.setThinkingLevel("high");
    assert.deepEqual((await compactInput(fixture)).filter(inPlaceItems), ordinary);
  });
  assert.deepEqual(fixture.errors, []);
});

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const order of ["before", "after"] as const) {
    test(`V2 rebuilds the ${api} folded prompt when the same-text hook runs ${order} capture`, async (t) => {
      const forcedTurn = "Continue with the unchanged prompt explicitly returned.";
      const persistSection: ExtensionFactory = (pi) => void pi.on("before_agent_start", (event) => {
        if (event.prompt === warmup) event.systemPromptOptions.sections.fixture = "Temporary instructions for warmup.";
      });
      const forceSameText: ExtensionFactory = (pi) => void pi.on("before_agent_start", (event) => {
        if (event.prompt === forcedTurn) return { systemPrompt: event.systemPrompt };
      });
      const fixture = await sessionFixture({ api, extensions: [persistSection,
        ...(order === "before" ? [forceSameText, codexCompaction] : [codexCompaction, forceSameText]),
      ] });
      t.after(() => fixture.close());
      await fixture.session.prompt(warmup);
      await fixture.session.prompt(warmup);
      await fixture.session.prompt(forcedTurn);

      const { messages } = fixture.session.sessionManager.buildSessionContext();
      assert.ok(messages.some((message) => message.role === "system" && message.sections?.fixture === null),
        "The run persisted a mid-history system delta removing the warmup section");
      const head = getCurrentSystemMessage(messages);
      assert.ok(head);
      const forcedText = getSystemMessageText(head);
      const ordinary = lastPayload(fixture);
      const ordinarySystemItems = inputItems(ordinary).filter(isInstruction);
      if (api === "openai-codex-responses") {
        assert.equal(ordinary.instructions, forcedText);
        assert.deepEqual(ordinarySystemItems, []);
      } else {
        assert.deepEqual(ordinarySystemItems, [{ role: "developer", content: forcedText }]);
      }

      fixture.session.setThinkingLevel("high");
      const compacted = await compactInput(fixture);
      assert.deepEqual({ instructions: lastPayload(fixture).instructions, input: compacted.filter(isInstruction) },
        { instructions: ordinary.instructions, input: ordinarySystemItems });
      assert.deepEqual(fixture.errors, []);
    });
  }
}

for (const thinkingChanged of [false, true]) {
  test(`V2 rebuilds input after a system suffix and ${thinkingChanged ? "drops fields after effort changes" : "keeps independent fields"}`, async (t) => {
    const fields = { prompt_cache_key: "fixture-suffix-cache", service_tier: "priority" };
    const wireOnlyInstruction = { role: "developer", content: "Only in the ordinary request's provider input." };
    const fixture = await sessionFixture({ extensions: [
      (pi) => pi.on("before_provider_request", ({ payload }) => {
        assert.ok(isObject(payload));
        return { ...payload, ...fields, input: [...inputItems(payload), wireOnlyInstruction] };
      }),
      codexCompaction,
    ] });
    t.after(() => fixture.close());
    await fixture.session.prompt(warmup);
    await fixture.session.prompt(warmup);
    const ordinary = lastPayload(fixture);
    const [head] = inputItems(ordinary);
    assert.ok(isInstruction(head));
    assert.deepEqual(inputItems(ordinary).at(-1), wireOnlyInstruction);
    assert.equal(ordinary.prompt_cache_key, fields.prompt_cache_key);
    assert.equal(ordinary.service_tier, fields.service_tier);

    const { delta, user } = appendSystemSuffix(fixture);
    if (thinkingChanged) fixture.session.setThinkingLevel("high");
    const compacted = await compactInput(fixture);
    const relevant = compacted.filter((item) => isInstruction(item) || hasUserText(item, warmup) || hasUserText(item, suffixTurn));
    assert.deepEqual(relevant, [head, userItem(warmup), userItem(warmup), delta, user]);
    const v2 = lastPayload(fixture);
    if (thinkingChanged) {
      assert.notEqual(v2.prompt_cache_key, fields.prompt_cache_key);
      assert.equal(v2.service_tier, undefined);
    } else {
      assert.deepEqual({ prompt_cache_key: v2.prompt_cache_key, service_tier: v2.service_tier }, fields);
    }
    assert.deepEqual(fixture.errors, []);
  });
}
