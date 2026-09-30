import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  type ContextEventResult,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { checkpointMarker, createCheckpointDetails, fallbackSummary, parseCheckpointDetails } from "./checkpoint.js";
import { createCodexCompactionExtension } from "./codex-compaction.js";
import { testRegistry } from "./test-registry.test.js";

const capability = {
  provider: "custom-codex",
  api: "openai-responses" as const,
  baseUrl: "https://codex-gateway.example/v1",
  endpoint: "https://codex-gateway.example/v1/responses",
};
const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: capability.api,
  provider: capability.provider,
  baseUrl: capability.baseUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
  compat: {
    remoteCompaction: {
      protocol: "v2",
      endpoint: capability.endpoint,
    },
  },
} as Model<"openai-responses">;
const usage = {
  input: 20,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 21,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Handler = (...args: any[]) => unknown;

function mockPi(thinkingLevel: ThinkingLevel = "high") {
  const events = new Map<string, Handler[]>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const entryRenderers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerEntryRenderer(customType: string, renderer: Handler) {
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getThinkingLevel: () => thinkingLevel,
    getSettings: () => ({ transport: "sse" as const }),
    getActiveTools: () => [],
    getAllTools: () => [],
  };
  return { pi: pi as never, events, appendedEntries, entryRenderers };
}

function fakeProvider(observe?: (options: SimpleStreamOptions | undefined) => void): Provider {
  return {
    id: capability.provider,
    name: "Custom Codex",
    baseUrl: capability.baseUrl,
    auth: {} as Provider["auth"],
    getModels: () => [model],
    streamSimple(_model, context, options) {
      observe?.(options);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const input = context.messages.map((message) => {
            const content = typeof message.content === "string" ? message.content : message.content[0];
            const text = typeof content === "string" ? content : "text" in content ? content.text : "image";
            return { role: "user", content: [{ type: "input_text", text }] };
          });
          await options?.onPayload?.({ model: model.id, input }, model);
          const response = await options?.fetch?.(capability.endpoint, {
            method: "POST",
            headers: options.headers as HeadersInit,
          });
          for (const line of (await response?.text() ?? "").split("\n")) {
            if (line.startsWith("data: ")) await options?.onProviderStreamEvent?.(JSON.parse(line.slice(6)), _model);
          }
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "error" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    stream() {
      throw new Error("not used");
    },
  };
}

function branch(): SessionEntry[] {
  return [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
}

function compactEvent(signal = new AbortController().signal): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "assistant",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: branch(),
    reason: "manual",
    willRetry: false,
    signal,
  };
}

async function context(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const entries = (overrides.entries as SessionEntry[] | undefined) ?? branch();
  const ctx = {
    model,
    hasUI: true,
    getSystemPrompt: () => "system",
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    },
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => entries,
    },
    modelRegistry: await testRegistry(fakeProvider()),
    ...overrides,
  };
  return { ctx: ctx as never, notifications, statuses };
}

function sseResponse() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`,
  );
}

const fetchSse = (async () => sseResponse()) as unknown as typeof globalThis.fetch;

async function compactSession(
  mock: ReturnType<typeof mockPi>,
  sessionManager: SessionManager,
  firstKeptEntryId: string,
  current: Awaited<ReturnType<typeof context>>,
) {
  const event = compactEvent();
  event.branchEntries = sessionManager.getBranch();
  event.preparation.firstKeptEntryId = firstKeptEntryId;
  // The mock event bus erases Pi's event/result pairing.
  const result = await mock.events.get("session_before_compact")?.[0]?.(event, current.ctx) as SessionBeforeCompactResult | undefined;
  assert.ok(result?.compaction, "remote compaction must succeed");
  const { summary, tokensBefore, details, usage: compactionUsage } = result.compaction;
  sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true, compactionUsage);
  const checkpoint = parseCheckpointDetails(details);
  assert.ok(checkpoint);
  return checkpoint;
}

async function assertSessionReplay(
  mock: ReturnType<typeof mockPi>,
  sessionManager: SessionManager,
  current: Awaited<ReturnType<typeof context>>,
  details: NonNullable<ReturnType<typeof parseCheckpointDetails>>,
) {
  const messages = sessionManager.buildSessionProjection().messages.filter((message) => message.role !== "system");
  const projected = await mock.events.get("context")?.[0]?.({ type: "context", messages }, current.ctx) as ContextEventResult | undefined;
  assert.ok(projected?.messages, "checkpoint must replay through Pi's canonical context");
  assert.equal(projected.messages.length, 1, "retained messages must be replaced exactly once");
  const marker = checkpointMarker(details.checkpointId);
  const markerMessage = projected.messages[0];
  assert.ok(markerMessage.role === "user");
  assert.deepEqual(markerMessage.content, [{ type: "text", text: marker }]);
  const rewritten = await mock.events.get("before_provider_request")?.[0]?.({
    type: "before_provider_request",
    payload: { model: model.id, input: [{ role: "user", content: [{ type: "input_text", text: marker }] }] },
  }, current.ctx);
  assert.deepEqual(rewritten, { model: model.id, input: details.replacementHistory });
}

for (const scenario of ["replacement", "omission", "older checkpoints", "system update"] as const) {
  test(`replays newly created checkpoints with ${scenario} in Pi's retained context`, async () => {
    const mock = mockPi();
    createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "older", timestamp: 0 });
    const firstKeptEntryId = sessionManager.appendMessage({ role: "user", content: "kept start", timestamp: 1 });
    const targetId = sessionManager.appendMessage({ role: "user", content: "kept end", timestamp: 2 });
    if (scenario === "replacement") sessionManager.appendContextEdit(targetId, { content: "edited end" });
    if (scenario === "omission") sessionManager.appendContextEdit(targetId, null);
    if (scenario === "older checkpoints") {
      sessionManager.appendCompaction("first summary", firstKeptEntryId, 100);
      sessionManager.appendMessage({ role: "user", content: "between compactions", timestamp: 3 });
      sessionManager.appendCompaction("second summary", firstKeptEntryId, 100);
    }
    if (scenario === "system update") {
      sessionManager.appendMessage({ role: "system", content: "updated instructions", timestamp: 3 });
    }
    const current = await context({ sessionManager });
    const details = await compactSession(mock, sessionManager, firstKeptEntryId, current);
    await assertSessionReplay(mock, sessionManager, current, details);
    assert.deepEqual(current.notifications.filter((notice) => notice.level === "warning"), []);
  });
}

test("replays and recompacts legacy checkpoints through Pi lifecycle hooks", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: "older", timestamp: 0 });
  const original = { role: "user" as const, content: "original retained message", timestamp: 1 };
  const firstKeptEntryId = sessionManager.appendMessage(original);
  sessionManager.appendContextEdit(firstKeptEntryId, { content: "edited retained message" });
  const legacy = createCheckpointDetails({
    identity: { ...capability, modelId: model.id },
    replacementHistory: [
      { role: "user", content: [{ type: "input_text", text: "edited retained message" }] },
      { type: "compaction", encrypted_content: "legacy opaque" },
    ],
    keptMessages: [original],
  });
  const legacyEntryId = sessionManager.appendCompaction(fallbackSummary(legacy.checkpointId), firstKeptEntryId, 100, legacy);
  const savedLegacyEntry = structuredClone(sessionManager.getEntry(legacyEntryId));
  const current = await context({ sessionManager });
  await assertSessionReplay(mock, sessionManager, current, legacy);
  const next = await compactSession(mock, sessionManager, firstKeptEntryId, current);
  assert.notEqual(next.checkpointId, legacy.checkpointId);
  await assertSessionReplay(mock, sessionManager, current, next);
  assert.deepEqual(sessionManager.getEntry(legacyEntryId), savedLegacyEntry);
  assert.deepEqual(current.notifications.filter((notice) => notice.level === "warning"), []);
});

test("does not notify when a session starts", async () => {
  const mock = mockPi();
  createCodexCompactionExtension()(mock.pi);
  const current = await context();
  const start = mock.events.get("session_start")?.[0];
  await start?.({ type: "session_start", reason: "startup" }, current.ctx);
  assert.deepEqual(current.notifications, []);
});

test("creates and resumes a checkpoint for a configured custom provider", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];
  const initial = branch();
  const current = await context({ entries: initial });
  const result = await compact?.(compactEvent(), current.ctx) as {
    compaction: { details: unknown; summary: string; usage: unknown };
  };
  const details = parseCheckpointDetails(result.compaction.details);
  assert.ok(details);
  assert.equal(details.provider, capability.provider);
  assert.equal(details.baseUrl, capability.baseUrl);
  assert.equal(details.endpoint, capability.endpoint);
  assert.deepEqual(result.compaction.usage, usage);
  assert.doesNotMatch(JSON.stringify(details), /secret/);
  assert.equal(current.statuses.get("codex-compaction"), undefined);
  assert.deepEqual(current.notifications, [
    {
      message: "Starting Codex Remote Compaction V2 for custom-codex/gpt-5.6.",
      level: "info",
    },
  ]);

  const compactionEntry = {
    type: "compaction" as const,
    id: "compact",
    parentId: "assistant",
    timestamp: "2026-01-01T00:00:02.000Z",
    summary: result.compaction.summary,
    firstKeptEntryId: "assistant",
    tokensBefore: 123,
    details,
  };
  const afterCompact = mock.events.get("session_compact")?.[0];
  await afterCompact?.(
    {
      type: "session_compact",
      compactionEntry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    },
    current.ctx,
  );
  assert.deepEqual(mock.appendedEntries, [
    {
      customType: "pi-codex-compaction-completed",
      data: {
        message: "Codex Remote Compaction V2 completed for custom-codex/gpt-5.6.",
        protocol: "remote-compaction-v2",
        checkpointId: details.checkpointId,
      },
    },
  ]);
  assert.ok(mock.entryRenderers.has("pi-codex-compaction-completed"));

  const replay = await context({ entries: [...initial, compactionEntry] });
  const summary = {
    role: "compactionSummary" as const,
    summary: result.compaction.summary,
    tokensBefore: 123,
    timestamp: 3,
  };
  const kept = initial[1].type === "message" ? initial[1].message : assert.fail("message");
  const later = { role: "user" as const, content: [{ type: "text" as const, text: "later" }], timestamp: 4 };
  const project = mock.events.get("context")?.[0];
  const projected = await project?.({ type: "context", messages: [summary, kept, later] }, replay.ctx) as {
    messages: Array<{ content: Array<{ text: string }> }>;
  };
  const marker = projected.messages[0].content[0].text;
  const rewrite = mock.events.get("before_provider_request")?.[0];
  const rewritten = await rewrite?.({
    type: "before_provider_request",
    payload: {
      model: model.id,
      input: [
        { role: "user", content: [{ type: "input_text", text: marker }] },
        { role: "user", content: [{ type: "input_text", text: "later" }] },
      ],
    },
  }, replay.ctx) as { input: Array<Record<string, unknown>> };
  assert.equal(rewritten.input.at(-2)?.type, "compaction");
  assert.match(JSON.stringify(rewritten.input.at(-1)), /later/);
});

test("provider switches do not replay opaque history", async () => {
  const mock = mockPi();
  createCodexCompactionExtension()(mock.pi);
  const details = parseCheckpointDetails({
    kind: "pi-codex-compaction",
    version: 1,
    checkpointId: "checkpoint-123",
    provider: capability.provider,
    api: capability.api,
    modelId: model.id,
    baseUrl: capability.baseUrl,
    endpoint: capability.endpoint,
    protocol: "remote-compaction-v2",
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
    keptMessageFingerprints: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(details);
  const entry = {
    type: "compaction" as const,
    id: "compact",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "fallback",
    firstKeptEntryId: "kept",
    tokensBefore: 10,
    details,
  };
  const switchedModel = { ...model, provider: "other" };
  const switched = await context({ model: switchedModel, entries: [entry] });
  const project = mock.events.get("context")?.[0];
  assert.equal(await project?.({ type: "context", messages: [] }, switched.ctx), undefined);
  const select = mock.events.get("model_select")?.[0];
  await select?.({ type: "model_select", model: switchedModel }, switched.ctx);
  assert.match(switched.notifications[0]?.message ?? "", /cannot replay/);
});

test("configured auth failures fall back to native Pi compaction", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];
  const failed = await context({
    modelRegistry: await testRegistry(fakeProvider(), async () => { throw new Error("missing auth"); }),
  });
  assert.equal(await compact?.(compactEvent(), failed.ctx), undefined);
  assert.equal(failed.notifications.length, 1);
  assert.match(failed.notifications.at(-1)?.message ?? "", /using Pi compaction/);

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await compact?.(compactEvent(controller.signal), (await context()).ctx), { cancel: true });
});

test("cancels a pending compaction when session ownership changes", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];
  let sessionId = "session";
  let releaseAuth: (() => void) | undefined;
  const authReady = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const current = await context({
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch(),
    },
    modelRegistry: await testRegistry(fakeProvider(), async () => {
      await authReady;
      return { auth: { apiKey: "secret" } };
    }),
  });

  const pending = compact?.(compactEvent(), current.ctx);
  sessionId = "replacement-session";
  releaseAuth?.();

  assert.deepEqual(await pending, { cancel: true });
  assert.deepEqual(current.notifications, []);
});

test("unsupported and unconfigured models use Pi compaction silently", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];

  const unsupported = await context({ model: { ...model, api: "openai-completions" } });
  assert.equal(await compact?.(compactEvent(), unsupported.ctx), undefined);
  assert.deepEqual(unsupported.notifications, []);

  const unconfigured = await context({ model: { ...model, compat: undefined } });
  assert.equal(await compact?.(compactEvent(), unconfigured.ctx), undefined);
  assert.deepEqual(unconfigured.notifications, []);
});

test("inherits the runtime thinking level and active session for every compaction", async () => {
  for (const thinkingLevel of ["off", "high", "max"] as const) {
    const { pi, events } = mockPi(thinkingLevel);
    let observed = false;
    const provider = fakeProvider((options) => {
      observed = true;
      assert.equal(options?.reasoning, thinkingLevel === "off" ? undefined : thinkingLevel);
      assert.equal(options?.sessionId, "session");
      assert.equal(options?.cacheRetention, undefined);
    });
    createCodexCompactionExtension({ fetch: fetchSse })(pi);
    const fixture = await context({
      modelRegistry: await testRegistry(provider),
    });
    const result = await events.get("session_before_compact")?.[0]?.(compactEvent(), fixture.ctx);
    assert.ok(result && observed);
    assert.deepEqual(fixture.notifications.filter((notice) => notice.level === "warning"), []);
  }
});
