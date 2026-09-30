import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ProviderIdentity } from "./capability.js";
import {
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";

const identity: ProviderIdentity = {
  provider: "custom-codex",
  api: "openai-codex-responses",
  modelId: "gpt-5.6",
  baseUrl: "https://codex-gateway.example/v1",
  endpoint: "https://codex-gateway.example/v1/responses",
};
const opaque = { type: "compaction", encrypted_content: "opaque" };
function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}
function rawUser(text: string) {
  return { role: "user", content: [{ type: "input_text", text }] };
}
function checkpoint(kept: AgentMessage[] = [user("kept", 2)], id = "checkpoint-123") {
  return createCheckpointDetails({
    identity,
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: kept,
    checkpointId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("persists and validates the complete provider endpoint identity", () => {
  const details = checkpoint();
  assert.deepEqual(parseCheckpointDetails(details), details);
  for (const patch of [
    { provider: "other" },
    { modelId: "other" },
    {
      baseUrl: "https://other.example/v1",
      endpoint: "https://other.example/v1/responses",
    },
  ]) {
    assert.ok(parseCheckpointDetails({ ...details, ...patch }));
  }
  assert.equal(
    parseCheckpointDetails({ ...details, baseUrl: "https://other.example/v1" }),
    undefined,
  );
  assert.equal(
    parseCheckpointDetails({ ...details, endpoint: "https://other.example/v1/responses" }),
    undefined,
  );
  assert.equal(parseCheckpointDetails({ ...details, api: "anthropic-messages" }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, version: 2 }), undefined);
  assert.doesNotMatch(JSON.stringify(details), /authorization|apiKey|token/i);
});


test("projects exact retained messages for resume and rejects corrupt state", () => {
  const kept = user("kept", 2);
  const details = checkpoint([kept]);
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 1,
  };
  const after = user("after", 3);
  const projected = projectCheckpointContext([summary, kept, after], details);
  assert.equal(projected?.length, 2);
  assert.match(JSON.stringify(projected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT/);
  assert.equal(projectCheckpointContext([summary, user("changed", 2), after], details), undefined);
  assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [] }), undefined);
});

test("selects checkpoints from the active fork only", () => {
  const first = checkpoint([], "checkpoint-first");
  const second = checkpoint([], "checkpoint-second");
  const entry = (id: string, details: ReturnType<typeof checkpoint>, parentId: string | null): CompactionEntry => ({
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId: "kept",
    tokensBefore: 10,
    details,
  });
  const branch = [entry("first", first, null), entry("second", second, "first")] as SessionEntry[];
  assert.equal(latestCheckpoint(branch)?.details.checkpointId, "checkpoint-second");
  assert.equal(latestCheckpoint(branch.slice(0, 1))?.details.checkpointId, "checkpoint-first");
  const native = { ...entry("native", second, "second"), details: undefined, summary: "native" };
  assert.equal(latestCheckpoint([...branch, native]), undefined);
});

test("normalizes the legacy compaction alias when loading a saved checkpoint", () => {
  const details = checkpoint();
  const legacy = { ...details, replacementHistory: [rawUser("old"), { ...opaque, type: "compaction_summary" }] };
  assert.deepEqual(parseCheckpointDetails(legacy), details);
  const last = legacy.replacementHistory.at(-1);
  assert.ok(last && "type" in last);
  assert.equal(last.type, "compaction_summary");
});

test("persists retained images above the former checkpoint byte ceiling", () => {
  const image = { type: "input_image", image_url: `data:image/png;base64,${"x".repeat(9 * 1024 * 1024)}` };
  const details = createCheckpointDetails({ identity, replacementHistory: [{ role: "user", content: [image] }, opaque], keptMessages: [] });
  assert.deepEqual(parseCheckpointDetails(details), details);
});

function legacySession(scenario: "replacement" | "omission" | "older checkpoints" | "system update") {
  const session = SessionManager.inMemory();
  session.appendMessage(user("older", 0));
  const firstKeptEntryId = session.appendMessage(user("kept start", 1));
  const original = user("kept end", 2);
  const targetId = session.appendMessage(original);
  if (scenario === "replacement") session.appendContextEdit(targetId, { content: "edited end" });
  if (scenario === "omission") session.appendContextEdit(targetId, null);
  if (scenario === "older checkpoints") {
    session.appendCompaction("first summary", firstKeptEntryId, 100);
    session.appendMessage(user("between compactions", 3));
    session.appendCompaction("second summary", firstKeptEntryId, 100);
  }
  if (scenario === "system update") {
    session.appendMessage({ role: "system", content: "updated instructions", timestamp: 3 });
  }
  // Reproduce the v1 writer's raw-entry fingerprints before saving the checkpoint.
  const entries = session.buildContextEntries();
  const keptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  const details = checkpoint(entries.slice(keptIndex).flatMap(sessionEntryToContextMessages));
  const entryId = session.appendCompaction(fallbackSummary(details.checkpointId), firstKeptEntryId, 100, details);
  return { session, details, entryId, firstKeptEntryId, targetId, original };
}

for (const scenario of ["replacement", "omission", "older checkpoints", "system update"] as const) {
  test(`loads legacy checkpoints with ${scenario} without changing persisted entries`, () => {
    const { session, details } = legacySession(scenario);
    const savedEntries = structuredClone(session.getEntries());
    const active = latestCheckpoint(session.getBranch());
    assert.ok(active);
    const projected = projectCheckpointContext(session.buildSessionProjection().messages, active.details);
    assert.ok(projected, "legacy checkpoint must replay against Pi's canonical messages");
    assert.notDeepEqual(active.details.keptMessageFingerprints, details.keptMessageFingerprints);
    assert.deepEqual(active.details.replacementHistory, details.replacementHistory);
    assert.equal(active.details.version, 1);
    assert.deepEqual(session.getEntries(), savedEntries);
  });
}

test("does not reinterpret later edits as a legacy fingerprint repair", () => {
  const { session, details, targetId, original } = legacySession("replacement");
  session.appendContextEdit(targetId, { content: original.content });
  const projected = session.buildSessionProjection();
  const restored = projected.entries.find((entry) => entry.sourceEntry.id === targetId)?.messages[0];
  assert.ok(restored);
  assert.equal(fingerprintMessage(restored), details.keptMessageFingerprints.at(-1));
  const active = latestCheckpoint(session.getBranch());
  assert.ok(active);
  assert.equal(projectCheckpointContext(projected.messages, active.details), undefined);
});

test("does not normalize corrupt legacy fingerprints", () => {
  const { session, details } = legacySession("replacement");
  details.keptMessageFingerprints[0] = fingerprintMessage(user("unrelated", 99));
  const active = latestCheckpoint(session.getBranch());
  assert.ok(active);
  assert.deepEqual(active.details.keptMessageFingerprints, details.keptMessageFingerprints);
  assert.equal(projectCheckpointContext(session.buildSessionProjection().messages, active.details), undefined);
});

test("requires the creation-time retained entries to repair legacy fingerprints", () => {
  const { session, details, firstKeptEntryId } = legacySession("replacement");
  const incomplete = session.getBranch().filter((entry) => entry.id !== firstKeptEntryId);
  const active = latestCheckpoint(incomplete);
  assert.ok(active);
  assert.deepEqual(active.details.keptMessageFingerprints, details.keptMessageFingerprints);
  assert.equal(projectCheckpointContext(session.buildSessionProjection().messages, active.details), undefined);
});

test("repairs only the selected checkpoint branch after navigating back", () => {
  const { session, entryId, targetId, original } = legacySession("replacement");
  session.appendContextEdit(targetId, { content: original.content });
  session.branch(entryId);
  const active = latestCheckpoint(session.getBranch());
  assert.ok(active);
  assert.ok(projectCheckpointContext(session.buildSessionProjection().messages, active.details));
});
