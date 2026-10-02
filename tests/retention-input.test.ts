import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { ImageEstimates } from "../src/image-budget.js";
import { contextUserItems, prepareRetention, userItemOrigins } from "../src/retention-input.js";
import { historyGroups } from "../src/history-groups.js";

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const notice = { role: "developer", content: [{ type: "input_text", text: " <IMAGE_RESIZE_NOTICE>resized</IMAGE_RESIZE_NOTICE> " }] };
const skill = '<skill name="fixture" location="E:/skills/fixture/SKILL.md">\nSkill instructions.\n</skill>';
const images: ImageEstimates = { bytes: () => assert.fail("retention preparation must reuse the supplied estimates") };

function bash(excludeFromContext = false): AgentMessage {
  return { role: "bashExecution", command: "echo fixture", output: "fixture", exitCode: 0,
    cancelled: false, truncated: false, timestamp: 1, excludeFromContext };
}

test("groups each source with only its immediately following resize notice", () => {
  const tool = { type: "function_call_output", output: "tool" };
  const message = user("request");
  const input = [tool, notice, notice, message];
  const groups = historyGroups(input);
  assert.deepEqual(groups.map(({ source, notice }) => [source, notice]), [[tool, notice], [notice, undefined], [message, undefined]]);
  assert.equal(groups[0].source, tool);
  assert.equal(groups[0].notice, notice);
  assert.deepEqual(historyGroups([]), []);
  assert.deepEqual(historyGroups([notice]).map(({ source }) => source), [notice]);
});

test("does not attach notice lookalikes with the wrong role, item type, or content shape", () => {
  const source = user("request");
  for (const lookalike of [
    { ...notice, role: "user" }, { ...notice, type: "function_call_output" },
    { ...notice, content: [...notice.content, { type: "input_text", text: "extra" }] },
    { ...notice, content: [{ type: "output_text", text: notice.content[0].text }] },
    { ...notice, content: [{ type: "input_text", text: "prefix <image_resize_notice>x</image_resize_notice>" }] },
  ]) {
    assert.equal(historyGroups([source, lookalike]).length, 2);
  }
});

test("aligns contextual flags to input indices including notices and reuses image estimates", async () => {
  const hidden = user("hidden extension data");
  const visible = user("visible request");
  const input = [hidden, notice, visible, notice];
  const saved = structuredClone(input);
  const prepared = await prepareRetention(input, new AbortController().signal, { images, contextual: [true, false, false, true] });
  assert.deepEqual(prepared.groups, [{ source: visible, notice }]);
  assert.equal(prepared.images, images);
  assert.deepEqual(input, saved);
  assert.equal((await prepareRetention(input, new AbortController().signal, { images, contextual: [] })).groups.length, 2);
});

test("extracts the user request from Pi skill blocks while preserving other parts and metadata", async () => {
  const expanded = `${skill}\n\n  Explain this code.  `;
  assert.equal(parseSkillBlock(expanded)?.userMessage, "Explain this code.");
  const image = { type: "input_image", detail: "original", image_url: "already estimated" };
  const input = { role: "user", id: "source", content: [
    { type: "input_text", text: expanded, annotation: "preserve" }, image,
    { type: "input_text", text: "Additional request." },
  ] };
  const saved = structuredClone(input);
  const prepared = await prepareRetention([input, notice], new AbortController().signal, { images });
  assert.deepEqual(prepared.groups, [{ source: { ...input, content: [
    { ...input.content[0], text: "Explain this code." }, image, input.content[2],
  ] }, notice }]);
  assert.deepEqual(input, saved);
});

test("drops skill-only parts and their notice only when no content remains", async () => {
  for (const text of [skill, `${skill}\n\n  \n`]) {
    assert.equal(parseSkillBlock(text)?.userMessage, undefined);
    const prepared = await prepareRetention([user(text), notice], new AbortController().signal, { images });
    assert.deepEqual(prepared.groups, []);
  }
  const image = { type: "input_image", file_id: "keep" };
  const mixed = { role: "user", content: [{ type: "input_text", text: skill }, image] };
  const prepared = await prepareRetention([mixed, notice], new AbortController().signal, { images });
  assert.deepEqual(prepared.groups, [{ source: { ...mixed, content: [image] }, notice }]);
});

test("retains skill lookalikes that Pi does not parse", async () => {
  for (const text of [skill.replace(' location="E:/skills/fixture/SKILL.md"', ""), `prefix ${skill}`, `${skill}\nrequest`, skill.replaceAll("\n", "")]) {
    assert.equal(parseSkillBlock(text), null);
    const input = user(text);
    const prepared = await prepareRetention([input], new AbortController().signal, { images });
    assert.deepEqual(prepared.groups.map(({ source }) => source), [input]);
  }
});

test("classifies bash and hidden custom messages in the provider's user sequence", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "instructions", timestamp: 0 },
    { role: "user", content: [], timestamp: 1 },
    { role: "user", content: "", timestamp: 2 },
    bash(), bash(true),
    { role: "custom", customType: "fixture", content: "hidden", display: false, timestamp: 3 },
    { role: "custom", customType: "fixture", content: [], display: false, timestamp: 4 },
    { role: "custom", customType: "fixture", content: "visible", display: true, timestamp: 5 },
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 6 },
    { role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/png" }], timestamp: 7 },
    { role: "user", content: `${skill}\n\nrequest`, timestamp: 8 },
  ];
  assert.deepEqual(userItemOrigins(messages), ["user", "context", "context", "user", "user", "user"]);
  assert.deepEqual(userItemOrigins([]), []);
});

test("aligns origins only with user message items and returns their original references", () => {
  const hidden = user("hidden");
  const visible = { ...user("visible"), type: "message" };
  const input = [null, [], { role: "developer", content: [] }, hidden,
    { type: "function_call", role: "user" }, visible];
  const contextual = contextUserItems(input, ["context", "user"]);
  assert.deepEqual([...contextual], [hidden]);
  assert.ok(contextual.has(hidden));
  assert.ok(!contextual.has(structuredClone(hidden)));
});

test("falls back to no contextual items when the provider changes user item counts", () => {
  const input = [user("first"), user("second")];
  for (const origins of [undefined, [], ["context"], ["context", "context", "context"]] as const) {
    assert.equal(contextUserItems(input, origins).size, 0);
  }
  for (const input of [undefined, null, "not an array", {}]) {
    assert.equal(contextUserItems(input, ["context"]).size, 0);
  }
});

test("observes cancellation before retaining a source with supplied estimates", async () => {
  await assert.rejects(prepareRetention([user("request")], AbortSignal.abort(), { images }), { name: "AbortError" });
});
