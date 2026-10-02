import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  buildSessionProjection,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ProviderIdentity } from "../src/capability.js";
import {
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  keptMessages,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
  withoutSystemMessages,
} from "../src/checkpoint.js";
import { legacyCheckpointSummary } from "./helpers.js";

const identity: ProviderIdentity = {
  provider: "custom-codex",
  api: "openai-codex-responses",
  modelId: "gpt-6.1-sol",
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

test("caches a fingerprint per immutable message object without conflating equal copies", () => {
  let reads = 0;
  const message: UserMessage = { role: "user", timestamp: 1, get content() { reads++; return "unchanged"; } };
  const fingerprint = fingerprintMessage(message);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  assert.equal(fingerprintMessage(message), fingerprint);
  assert.equal(reads, firstReads, "the same message is not serialized twice");
  assert.equal(fingerprintMessage({ timestamp: 1, content: "unchanged", role: "user" }), fingerprint);
  assert.notEqual(fingerprintMessage({ role: "user", content: "changed", timestamp: 1 }), fingerprint);
  assert.notEqual(fingerprintMessage({ role: "user", content: "unchanged", timestamp: 2 }), fingerprint);
});

test("caches normalized legacy details by entry object across branch array snapshots", () => {
  const { session, entryId } = legacySession("replacement");
  const original = session.getEntry(entryId);
  assert.ok(original?.type === "compaction");
  let reads = 0;
  const entry: CompactionEntry = { ...original, get details() { reads++; return original.details; } };
  const entries = session.getBranch().map((item) => item.id === entryId ? entry : item);
  const first = latestCheckpoint(entries);
  assert.ok(first);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  const second = latestCheckpoint([...entries]);
  assert.equal(second?.details, first.details);
  assert.equal(reads, firstReads, "parsing and legacy normalization run only once per entry");
  const copy = latestCheckpoint(entries.map((item) => item === entry ? { ...entry } : item));
  assert.deepEqual(copy?.details, first.details);
  assert.notEqual(copy?.details, first.details, "the cache is not keyed by persisted entry ID");
});

test("caches invalid compaction entries without reviving an older checkpoint", () => {
  let reads = 0;
  const details = checkpoint([]);
  const valid: CompactionEntry = { type: "compaction", id: "valid", parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z", summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId: "kept", tokensBefore: 10, details };
  const invalid: CompactionEntry = { ...valid, id: "invalid", parentId: valid.id,
    get details() { reads++; return { kind: "invalid" }; } };
  assert.equal(latestCheckpoint([valid, invalid]), undefined);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  assert.equal(latestCheckpoint([valid, invalid]), undefined);
  assert.equal(reads, firstReads);
  assert.equal(latestCheckpoint([valid])?.details.checkpointId, details.checkpointId);
  const reloaded: CompactionEntry = { ...invalid, details };
  assert.equal(latestCheckpoint([valid, reloaded])?.details.checkpointId, details.checkpointId);
});

function localizedToolMessage(): ToolResultMessage {
  return { role: "toolResult", toolCallId: "call", toolName: "fixture",
    content: [{ type: "text", text: "original output" }],
    details: { z: 1, ä: 2, Case: 3, case: 4 }, isError: false, timestamp: 2 };
}

test("new checkpoints replay unchanged across default collation changes", (t) => {
  let compare = new Intl.Collator("en-US").compare;
  t.mock.method(String.prototype, "localeCompare", function(this: string, other: string) { return compare(String(this), other); });
  const session = SessionManager.inMemory();
  const firstKept = session.appendMessage(localizedToolMessage());
  const details = checkpoint(keptMessages(session.getBranch(), firstKept));
  session.appendCompaction(fallbackSummary(details.checkpointId), firstKept, 100, details);
  const saved = JSON.stringify(session.getBranch());
  compare = new Intl.Collator("sv-SE").compare;
  const entries: SessionEntry[] = JSON.parse(saved);
  const restored = latestCheckpoint(entries);
  assert.ok(restored);
  assert.ok(projectCheckpointContext(buildSessionProjection(entries).messages, restored.details));
  assert.equal(fingerprintMessage(localizedToolMessage()), details.keptMessageFingerprints[0]);
  assert.equal(JSON.stringify(entries), saved);
});

// Golden hashes produced by the locale-sorted v1 writer, including its raw-entry predecessor.
const localeFingerprints = [
  { locale: "en-US", original: "f4805842843b412c0530ed203b067c63e8a91e805e48001db7f465638def5d1f",
    edited: "13ad52f731c97891aeac5e7113dcfdd24b2da7806872f8caa8e12ad9a5c6fee5" },
  { locale: "sv-SE", original: "f431c01890641c90d21522b23c5a1993911c94c4257a5d181debe0481060e47c",
    edited: "6bb925063d760fd715f71378f4fb9b4a267d0dbb2a7ff2ad7614ee6ede138723" },
];

for (const fixture of localeFingerprints) {
  for (const shape of ["canonical", "raw"] as const) {
    for (const editedAfterCheckpoint of [false, true]) {
      test(`loads ${fixture.locale} ${shape} legacy hashes and ${editedAfterCheckpoint ? "rejects later edits" : "preserves replay"}`, (t) => {
        const compare = new Intl.Collator(fixture.locale).compare;
        t.mock.method(String.prototype, "localeCompare", function(this: string, other: string) { return compare(String(this), other); });
        const session = SessionManager.inMemory();
        const targetId = session.appendMessage(localizedToolMessage());
        session.appendContextEdit(targetId, { content: [{ type: "text", text: "edited output" }] });
        const details = checkpoint(keptMessages(session.getBranch(), targetId));
        details.keptMessageFingerprints = [shape === "raw" ? fixture.original : fixture.edited];
        session.appendCompaction(fallbackSummary(details.checkpointId), targetId, 100, details);
        if (editedAfterCheckpoint) {
          session.appendContextEdit(targetId, { content: [{ type: "text", text: "original output" }] });
        }
        const saved = structuredClone(session.getEntries());
        const active = latestCheckpoint(session.getBranch());
        assert.ok(active);
        assert.notEqual(active.details.keptMessageFingerprints[0], fixture.edited, "normalize to locale-independent hashes");
        const projected = projectCheckpointContext(session.buildSessionProjection().messages, active.details);
        assert.equal(projected !== undefined, !editedAfterCheckpoint);
        assert.deepEqual(session.getEntries(), saved);
        assert.equal(active.details.version, 1);
      });
    }
  }
}

test("does not guess an unverifiable legacy locale or rewrite its checkpoint", (t) => {
  const compare = new Intl.Collator("en-US").compare;
  t.mock.method(String.prototype, "localeCompare", function(this: string, other: string) { return compare(String(this), other); });
  const session = SessionManager.inMemory();
  const firstKept = session.appendMessage(localizedToolMessage());
  const details = checkpoint([localizedToolMessage()]);
  details.keptMessageFingerprints = [localeFingerprints[1].original];
  session.appendCompaction(fallbackSummary(details.checkpointId), firstKept, 100, details);
  const saved = structuredClone(session.getEntries());
  const active = latestCheckpoint(session.getBranch());
  assert.ok(active);
  assert.deepEqual(active.details.keptMessageFingerprints, details.keptMessageFingerprints);
  assert.equal(projectCheckpointContext(session.buildSessionProjection().messages, active.details), undefined);
  assert.deepEqual(session.getEntries(), saved);
});

test("withoutSystemMessages removes interleaved system messages while preserving order and references", () => {
  const first = user("first", 1);
  const tool: AgentMessage = { role: "toolResult", toolCallId: "call", toolName: "read",
    content: [{ type: "text", text: "system" }], isError: false, timestamp: 3 };
  const custom: AgentMessage = { role: "custom", customType: "system", content: "metadata", display: false, timestamp: 5 };
  const last = user("last", 7);
  const input: readonly AgentMessage[] = Object.freeze([
    { role: "system", content: "first prompt", timestamp: 0 }, first,
    { role: "system", content: "middle prompt", timestamp: 2 }, tool,
    { role: "system", content: "another prompt", timestamp: 4 }, custom, last,
    { role: "system", content: "last prompt", timestamp: 8 },
  ]);
  const saved = structuredClone(input);
  const result = withoutSystemMessages(input);
  const expected = [first, tool, custom, last];
  assert.deepEqual(result, expected);
  for (const [index, message] of expected.entries()) assert.equal(result[index], message);
  assert.deepEqual(input, saved);
});

test("withoutSystemMessages handles empty and all-system transcripts and only filters the exact role", () => {
  assert.deepEqual(withoutSystemMessages([]), []);
  assert.deepEqual(withoutSystemMessages([{ role: "system" }, { role: "system" }]), []);
  const input = [{ role: "SYSTEM", text: "preserve case" }, { role: "user", text: "preserve" }];
  const result = withoutSystemMessages(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
});

test("persisted legacy summaries restore only their own unchanged checkpoint history", () => {
  const kept = user("kept", 2);
  const details = checkpoint([kept]);
  const summary: AgentMessage = { role: "compactionSummary", summary: legacyCheckpointSummary(details.checkpointId), tokensBefore: 100, timestamp: 1 };
  assert.ok(projectCheckpointContext([summary, kept], details));
  assert.equal(projectCheckpointContext([summary, user("edited", 2)], details), undefined);
  assert.equal(projectCheckpointContext([{ ...summary, summary: legacyCheckpointSummary("different-checkpoint") }, kept], details), undefined);
});
