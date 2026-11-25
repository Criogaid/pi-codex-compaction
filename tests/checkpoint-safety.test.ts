// Exercise request-time policies and failed compaction with a real persisted Pi checkpoint.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getLatestCompactionEntry, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolveLatestCheckpoint } from "../src/checkpoint.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import codexCompaction from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { fixtureImage as image, isolateAgentConfig, sessionFixture } from "./helpers.js";

const configPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const originalFact = "The approved project color is cerulean.";
const hasItem = (payload: JsonObject, type: string) =>
  Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === type);

async function seedHistory(fixture: Awaited<ReturnType<typeof sessionFixture>>) {
  await fixture.session.prompt(`${originalFact} ${"Preserve the original requirements. ".repeat(80)}`);
  await fixture.session.prompt("Discuss the implementation. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  await fixture.session.compact();
  const entries = fixture.session.sessionManager.getBranch();
  assert.equal(resolveLatestCheckpoint(entries).state, "parsed");
  const entry = getLatestCompactionEntry(entries);
  assert.ok(entry);
  await fixture.session.prompt("Continue from the saved checkpoint. ".repeat(80));
  assert.ok(hasItem(fixture.requests.at(-1)!.payload, "compaction"));
  return entry;
}

test("discards a V2 checkpoint when an in-flight context edit changes dropped history", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (!hasItem(payload, "compaction_trigger")) return undefined;
      const { sessionManager } = fixture.session;
      const original = sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(original);
      assert.match(JSON.stringify(payload.input), /cerulean/);
      sessionManager.appendContextEdit(original.id, { content: "The approved project color is ochre." });
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await fixture.session.prompt(`${originalFact} ${"Preserve the original requirements. ".repeat(80)}`);
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  const requestCount = fixture.requests.length;

  await assert.rejects(fixture.session.compact(), { message: "Compaction cancelled" });
  const branch = fixture.session.sessionManager.getBranch();
  assert.equal(getLatestCompactionEntry(branch), null);
  assert.equal(branch.at(-1)?.type, "context_edit");
  const messages = JSON.stringify(fixture.session.sessionManager.buildSessionProjection().messages);
  assert.match(messages, /ochre/);
  assert.doesNotMatch(messages, /cerulean/);
  assert.equal(fixture.requests.length - requestCount, 1, "A stale V2 result must not trigger text fallback");
  assert.deepEqual(fixture.errors, []);
});

test("discards a V2 checkpoint after switching to a branch with the same messages", { timeout: 20_000 }, async (t) => {
  let otherLeaf: string;
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (hasItem(payload, "compaction_trigger")) fixture.session.sessionManager.branch(otherLeaf);
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("Remember the agreed requirements. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  const { sessionManager } = fixture.session;
  const conversationLeaf = sessionManager.getLeafId();
  assert.ok(conversationLeaf);
  otherLeaf = sessionManager.appendCustomEntry("fixture-branch", "other");
  sessionManager.branch(conversationLeaf);
  sessionManager.appendCustomEntry("fixture-branch", "original");
  const messages = sessionManager.buildSessionProjection().messages;

  await assert.rejects(fixture.session.compact(), { message: "Compaction cancelled" });
  assert.equal(sessionManager.getLeafId(), otherLeaf);
  assert.equal(getLatestCompactionEntry(sessionManager.getBranch()), null);
  assert.deepEqual(sessionManager.buildSessionProjection().messages, messages);
  assert.deepEqual(fixture.errors, []);
});

test("discards layered recovery after switching to a branch with the same messages", { timeout: 20_000 }, async (t) => {
  await rm(configPath, { force: true });
  let failRemote = false;
  let otherLeaf: string;
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (!failRemote) return undefined;
      if (hasItem(payload, "compaction_trigger")) return new Response("Temporary service outage", { status: 503 });
      fixture.session.sessionManager.branch(otherLeaf);
      return undefined;
    },
  });
  t.after(() => fixture.close());
  const baseCompaction = await seedHistory(fixture);
  await fixture.session.prompt("Discuss layered branch safety. ".repeat(80));
  const { sessionManager } = fixture.session;
  const conversationLeaf = sessionManager.getLeafId();
  assert.ok(conversationLeaf);
  otherLeaf = sessionManager.appendCustomEntry("fixture-branch", "other");
  sessionManager.branch(conversationLeaf);
  sessionManager.appendCustomEntry("fixture-branch", "original");
  const messages = sessionManager.buildSessionProjection().messages;

  failRemote = true;
  await assert.rejects(fixture.session.compact(), { message: "Compaction cancelled" });
  assert.equal(sessionManager.getLeafId(), otherLeaf);
  assert.equal(getLatestCompactionEntry(sessionManager.getBranch())?.id, baseCompaction.id);
  assert.deepEqual(sessionManager.buildSessionProjection().messages, messages);
  assert.deepEqual(fixture.errors, []);
});

test("installs a V2 checkpoint on the starting model after a recorded chat model switch", { timeout: 20_000 }, async (t) => {
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-fixture-second-model" }],
    async respond({ payload }) {
      if (hasItem(payload, "compaction_trigger")) {
        await fixture.session.setModel(fixture.models[1]);
      }
    },
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("Remember the agreed requirements. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  const { details } = await fixture.session.compact();

  const branch = fixture.session.sessionManager.getBranch();
  const checkpoint = resolveLatestCheckpoint(branch);
  assert.equal(checkpoint.state, "parsed");
  assert.deepEqual(getLatestCompactionEntry(branch)?.details, details);
  assert.equal(checkpoint.details.modelId, fixture.model.id);
  assert.equal(fixture.session.model?.id, fixture.models[1].id);
  assert.ok(branch.some((entry) => entry.type === "model_change" && entry.modelId === fixture.models[1].id));
  assert.deepEqual(fixture.errors, []);
});

test("installs and replays a V2 checkpoint when an excluded !! bash command runs during compaction", { timeout: 20_000 }, async (t) => {
  await rm(configPath, { force: true });
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (hasItem(payload, "compaction_trigger")) {
        fixture.session.recordBashResult(
          "echo ok",
          { output: "ok\n", exitCode: 0, cancelled: false, truncated: false },
          { excludeFromContext: true },
        );
      }
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("Remember the agreed requirements. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));
  const { details } = await fixture.session.compact();

  const branch = fixture.session.sessionManager.getBranch();
  const checkpoint = resolveLatestCheckpoint(branch);
  assert.equal(checkpoint.state, "parsed");
  assert.deepEqual(getLatestCompactionEntry(branch)?.details, details);
  assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "bashExecution" && entry.message.excludeFromContext));

  await fixture.session.prompt("Follow up after excluded bash.");
  const replay = fixture.requests.at(-1)!.payload;
  assert.ok(hasItem(replay, "compaction"));
  assert.doesNotMatch(JSON.stringify(replay.input), /echo ok/);
  assert.deepEqual(fixture.errors, []);
});

test("discards a V2 checkpoint when a context-included ! bash command runs during compaction", { timeout: 20_000 }, async (t) => {
  await rm(configPath, { force: true });
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (hasItem(payload, "compaction_trigger")) {
        fixture.session.recordBashResult(
          "echo visible",
          { output: "visible\n", exitCode: 0, cancelled: false, truncated: false },
          { excludeFromContext: false },
        );
      }
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("Remember the agreed requirements. ".repeat(80));
  await fixture.session.prompt("Continue the agreed task. ".repeat(80));

  await assert.rejects(fixture.session.compact(), { message: "Compaction cancelled" });
  const branch = fixture.session.sessionManager.getBranch();
  assert.equal(getLatestCompactionEntry(branch), null);
  assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "bashExecution" && !entry.message.excludeFromContext));
  assert.deepEqual(fixture.errors, []);
});

test("installs and replays layered recovery when an excluded !! bash command runs during compaction", { timeout: 20_000 }, async (t) => {
  await rm(configPath, { force: true });
  let failRemote = false;
  let recordedBash = false;
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond({ payload }) {
      if (!failRemote) return undefined;
      if (hasItem(payload, "compaction_trigger")) return new Response("Temporary service outage", { status: 503 });
      if (!recordedBash) {
        recordedBash = true;
        fixture.session.recordBashResult(
          "echo layered",
          { output: "layered\n", exitCode: 0, cancelled: false, truncated: false },
          { excludeFromContext: true },
        );
      }
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await seedHistory(fixture);
  await fixture.session.prompt("Discuss layered excluded bash handling. ".repeat(80));

  failRemote = true;
  const { details } = await fixture.session.compact();
  const branch = fixture.session.sessionManager.getBranch();
  const checkpoint = resolveLatestCheckpoint(branch);
  assert.equal(checkpoint.state, "parsed");
  assert.equal(checkpoint.details.version, 2);
  assert.deepEqual(getLatestCompactionEntry(branch)?.details, details);

  failRemote = false;
  await fixture.session.prompt("Follow up after layered excluded bash.");
  const replay = fixture.requests.at(-1)!.payload;
  assert.ok(hasItem(replay, "compaction"));
  assert.doesNotMatch(JSON.stringify(replay.input), /echo layered/);
  assert.deepEqual(fixture.errors, []);
});

for (const separateFallback of [false, true]) {
  test(`carries layered textSummary into native text compaction after V2 is disabled (separate fallback=${separateFallback})`, { timeout: 20_000 }, async (t) => {
    await rm(configPath, { force: true });
    let failRemote = false;
    const fixture = await sessionFixture({
      extensions: [codexCompaction],
      respond({ payload }) {
        if (failRemote && hasItem(payload, "compaction_trigger")) {
          return new Response("Temporary service outage", { status: 503 });
        }
        return undefined;
      },
    });
    t.after(() => fixture.close());
    await seedHistory(fixture);
    await fixture.session.prompt("New work before layered fallback. ".repeat(80));
    await fixture.session.prompt("Recent tail during layered fallback. ".repeat(80));

    failRemote = true;
    await fixture.session.compact();
    failRemote = false;

    const layered = resolveLatestCheckpoint(fixture.session.sessionManager.getBranch());
    assert.equal(layered.state, "parsed");
    assert.equal(layered.details.version, 2);
    const previousTextSummary = layered.details.textSummary;
    assert.ok(previousTextSummary.trim().length > 0);

    await fixture.session.prompt("More work after layered checkpoint. ".repeat(80));
    await fixture.session.prompt("Latest tail before disabling V2. ".repeat(80));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: 2,
      remoteCompaction: { enabled: false },
      ...(separateFallback
        ? { summaryModel: { provider: fixture.model.provider, model: fixture.model.id, thinkingLevel: "low" } }
        : {}),
    }));

    const requestCount = fixture.requests.length;
    await fixture.session.compact();
    const summaryRequests = fixture.requests.slice(requestCount);
    assert.ok(summaryRequests.length > 0);
    const summaryInput = JSON.stringify(summaryRequests.map((request) => request.payload.input));
    assert.ok(summaryInput.includes(previousTextSummary), "Text compaction must receive prior layered textSummary");
    assert.doesNotMatch(summaryInput, /Earlier chat history was compressed by Codex Remote Compaction V2/);
    assert.equal(resolveLatestCheckpoint(fixture.session.sessionManager.getBranch()).state, "none");
    assert.deepEqual(fixture.errors, []);
  });
}

test("native text compaction after a layered checkpoint keeps before_provider_headers and the starting model on cycleModel", { timeout: 20_000 }, async (t) => {
  await rm(configPath, { force: true });
  let failRemote = false;
  let requireGatewayHeader = false;
  const gatewayHeaders: ExtensionFactory = (pi) => {
    pi.on("before_provider_headers", (event) => {
      event.headers["x-gateway-token"] = "required-token";
    });
  };
  const fixture = await sessionFixture({
    extensions: [gatewayHeaders, codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-fixture-second-model" }],
    respond({ payload, headers }) {
      if (failRemote && hasItem(payload, "compaction_trigger")) {
        return new Response("Temporary service outage", { status: 503 });
      }
      if (requireGatewayHeader && headers.get("x-gateway-token") !== "required-token") {
        return new Response("Forbidden", { status: 403 });
      }
      return undefined;
    },
  });
  t.after(() => fixture.close());
  await seedHistory(fixture);
  await fixture.session.prompt("New work before layered fallback. ".repeat(80));
  await fixture.session.prompt("Recent tail during layered fallback. ".repeat(80));

  failRemote = true;
  await fixture.session.compact();
  failRemote = false;

  const layered = resolveLatestCheckpoint(fixture.session.sessionManager.getBranch());
  assert.equal(layered.state, "parsed");
  assert.equal(layered.details.version, 2);
  const previousTextSummary = layered.details.textSummary;

  await fixture.session.prompt("More work after layered checkpoint. ".repeat(80));
  await fixture.session.prompt("Latest tail before disabling V2. ".repeat(80));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 2, remoteCompaction: { enabled: false } }));

  const requestCount = fixture.requests.length;
  requireGatewayHeader = true;
  let cycled: ReturnType<typeof fixture.session.cycleModel> | undefined;
  const unsubscribe = fixture.session.subscribe((event) => {
    if (event.type === "compaction_start") {
      // Run cycleModel after compact() freezes its starting model, while session_before_compact awaits settings.
      setImmediate(() => { cycled = fixture.session.cycleModel(); });
    }
  });
  try {
    await fixture.session.compact();
  } finally {
    unsubscribe();
  }
  assert.equal((await cycled)?.model.id, fixture.models[1].id);

  const summaryRequests = fixture.requests.slice(requestCount);
  assert.ok(summaryRequests.length > 0);
  assert.ok(summaryRequests.every((request) => request.headers.get("x-gateway-token") === "required-token"));
  assert.ok(summaryRequests.every((request) => request.payload.model === fixture.models[0].id));
  const summaryInput = JSON.stringify(summaryRequests.map((request) => request.payload.input));
  assert.ok(summaryInput.includes(previousTextSummary));
  assert.doesNotMatch(summaryInput, /Earlier chat history was compressed by Codex Remote Compaction V2/);
  assert.equal(fixture.session.model?.id, fixture.models[1].id);
  assert.equal(resolveLatestCheckpoint(fixture.session.sessionManager.getBranch()).state, "none");
  assert.deepEqual(fixture.errors, []);
});

for (const excludeFromContext of [true, false]) {
  test(`layered recovery ${excludeFromContext ? "stops without summarizing" : "summarizes"} when only a ${excludeFromContext ? "!!" : "!"} bash entry is dropped`, { timeout: 20_000 }, async (t) => {
    await rm(configPath, { force: true });
    let failRemote = false;
    const fixture = await sessionFixture({
      extensions: [codexCompaction],
      respond({ payload }) {
        if (failRemote && hasItem(payload, "compaction_trigger")) {
          return new Response(JSON.stringify({ error: { code: "server_is_overloaded" } }), {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return undefined;
      },
    });
    t.after(() => fixture.close());
    await fixture.session.prompt(`${originalFact} ${"Preserve the original requirements. ".repeat(80)}`);
    await fixture.session.prompt("Continue the agreed task. ".repeat(80));
    await fixture.session.compact();
    const baseEntry = getLatestCompactionEntry(fixture.session.sessionManager.getBranch());
    assert.ok(baseEntry);
    assert.equal(resolveLatestCheckpoint(fixture.session.sessionManager.getBranch()).state, "parsed");
    const command = "echo local-shell-audit-control";
    fixture.session.recordBashResult(
      command,
      { output: "local-shell-audit-control\n", exitCode: 0, cancelled: false, truncated: false },
      { excludeFromContext },
    );
    // Keep the new turn as the retained tail so only the bash execution entry is newly dropped.
    await fixture.session.prompt("Keep this new turn after the bash entry. ".repeat(80));

    const requestCount = fixture.requests.length;
    failRemote = true;
    if (excludeFromContext) {
      await assert.rejects(fixture.session.compact(), { message: "Compaction cancelled" });
      const attempted = fixture.requests.slice(requestCount);
      assert.equal(attempted.filter(({ payload }) => !hasItem(payload, "compaction_trigger")).length, 0);
      assert.equal(getLatestCompactionEntry(fixture.session.sessionManager.getBranch())?.id, baseEntry.id);
    } else {
      await fixture.session.compact();
      const attempted = fixture.requests.slice(requestCount);
      const summaries = attempted.filter(({ payload }) => !hasItem(payload, "compaction_trigger"));
      assert.equal(summaries.length, 1);
      assert.match(JSON.stringify(summaries[0].payload.input), /local-shell-audit-control/);
      const active = resolveLatestCheckpoint(fixture.session.sessionManager.getBranch());
      assert.equal(active.state, "parsed");
      assert.equal(active.details.version, 2);
    }
    assert.deepEqual(fixture.errors, []);
  });
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const reason of ["remote failure", "V2 disabled"] as const) {
    for (const separateFallback of [false, true]) {
      test(`${api} falls back with an active checkpoint on ${reason}, separate fallback=${separateFallback}`, { timeout: 20_000 }, async () => {
        let failRemote = false;
        const fixture = await sessionFixture({
          api, extensions: [codexCompaction],
          respond: ({ payload }) => failRemote && hasItem(payload, "compaction_trigger")
            ? new Response("Temporary service outage", { status: 503 }) : undefined,
        });
        try {
          const entry = await seedHistory(fixture);
          const saved = structuredClone(entry.details);
          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(configPath, JSON.stringify({
            version: 1, remoteCompaction: { enabled: reason !== "V2 disabled" },
            ...(separateFallback ? { fallback: { enabled: true, provider: fixture.model.provider,
              model: fixture.model.id, thinkingLevel: "low" } } : {}),
          }));
          if (reason === "remote failure") {
            await fixture.session.prompt("New work to summarize after A. ".repeat(80));
            await fixture.session.prompt("Keep this new tail after A. ".repeat(80));
          }
          const requestCount = fixture.requests.length;
          failRemote = reason === "remote failure";
          await fixture.session.compact();
          const attempted = fixture.requests.slice(requestCount);
          const summaries = attempted.filter(({ payload }) => !hasItem(payload, "compaction_trigger"));
          assert.ok(summaries.length > 0, "Native summaries remain available after an opaque checkpoint");
          assert.ok(summaries.every(({ payload }) => !hasItem(payload, "compaction")));
          const active = resolveLatestCheckpoint(fixture.session.sessionManager.getBranch());
          assert.equal(active.state, reason === "remote failure" ? "parsed" : "none");
          assert.equal(fixture.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 2);
          assert.deepEqual(entry.details, saved, "The persisted V2 entry remains unchanged");

          failRemote = false;
          await fixture.session.prompt("Continue after the text summary.");
          assert.equal(hasItem(fixture.requests.at(-1)!.payload, "compaction"), reason === "remote failure");
          assert.deepEqual(fixture.errors, []);
        } finally {
          await fixture.close();
          await rm(configPath, { force: true });
        }
      });
    }
  }

  test(`${api} applies image blocking to ordinary and recursive checkpoint replay`, { timeout: 20_000 }, async () => {
    const fixture = await sessionFixture({ api, extensions: [codexCompaction] });
    try {
      await fixture.session.prompt("Preserve the constraints in this image. ".repeat(80), { images: [image] });
      for (let turn = 0; turn < 2; turn++) await fixture.session.prompt("Continue the implementation. ".repeat(80));
      await fixture.session.compact();
      const entries = fixture.session.sessionManager.getBranch();
      assert.equal(resolveLatestCheckpoint(entries).state, "parsed");
      const entry = getLatestCompactionEntry(entries);
      assert.ok(entry);
      const saved = structuredClone(entry.details);
      assert.ok(JSON.stringify(saved).includes(image.data));

      fixture.session.settingsManager.setBlockImages(true);
      await fixture.session.prompt("Continue with image reading disabled. ".repeat(80));
      assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)!.payload), /"type":"input_image"/);
      assert.ok(!JSON.stringify(fixture.requests.at(-1)!.payload).includes(image.data));
      assert.deepEqual(entry.details, saved);

      fixture.session.settingsManager.setBlockImages(false);
      await fixture.session.prompt("Read the saved image again.");
      assert.ok(JSON.stringify(fixture.requests.at(-1)!.payload).includes(image.data));

      fixture.session.settingsManager.setBlockImages(true);
      await fixture.session.compact();
      const recompacted = fixture.requests.at(-1)!.payload;
      assert.ok(hasItem(recompacted, "compaction_trigger"));
      assert.doesNotMatch(JSON.stringify(recompacted), /"type":"input_image"/);
      assert.ok(!JSON.stringify(recompacted).includes(image.data));
      assert.deepEqual(entry.details, saved);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}
