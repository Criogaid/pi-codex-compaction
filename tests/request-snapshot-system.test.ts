import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSystemMessageUpdate } from "@earendil-works/pi-ai";
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
