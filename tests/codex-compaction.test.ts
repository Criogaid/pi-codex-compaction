import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getSystemMessageText,
  type Context,
  type Tool,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  SessionManager,
  convertToLlm,
  type ContextEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { checkpointMarker, createCheckpointDetails, fallbackSummary, parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isolateAgentConfig, testRegistry } from "./helpers.js";
import { isObject, type JsonObject } from "../src/protocol.js";

const fallbackSettingsPath = join(isolateAgentConfig(), "extensions", "pi-codex-compaction", "config.json");
await mkdir(dirname(fallbackSettingsPath), { recursive: true });
afterEach(() => rm(fallbackSettingsPath, { force: true }));

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

type TestSettings = ReturnType<ExtensionAPI["getSettings"]>;
interface TestTools { active: string[]; all: Tool[] }

function mockPi(thinkingLevel: ThinkingLevel = "high", settings: TestSettings = { transport: "sse" }, tools: TestTools = { active: [], all: [] }) {
  const events = new Map<string, Handler[]>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const entryRenderers = new Map<string, Handler>();
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerEntryRenderer(customType: string, renderer: Handler) {
      entryRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getThinkingLevel: () => thinkingLevel,
    getSettings: () => settings,
    getActiveTools: () => tools.active,
    getAllTools: () => tools.all,
  };
  return { pi: pi as unknown as ExtensionAPI, events, appendedEntries, entryRenderers };
}

function fakeProvider(observe?: (options: SimpleStreamOptions | undefined) => void, payloadPreparations = 1): Provider {
  return {
    id: capability.provider,
    name: "Custom Codex",
    baseUrl: capability.baseUrl,
    auth: {} as Provider["auth"],
    getModels: () => [model],
    streamSimple(currentModel, context, options) {
      observe?.(options);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const input = context.messages.map((message) => {
            const content = typeof message.content === "string" ? message.content : message.content[0];
            const text = typeof content === "string" ? content : "text" in content ? content.text : "image";
            return { role: "user", content: [{ type: "input_text", text }] };
          });
          for (let attempt = 0; attempt < payloadPreparations; attempt++) {
            await options?.onPayload?.({ model: currentModel.id, input }, currentModel);
          }
          const response = await options?.fetch?.(capability.endpoint, {
            method: "POST",
            headers: options.headers as HeadersInit,
          });
          for (const line of (await response?.text() ?? "").split("\n")) {
            if (line.startsWith("data: ")) await options?.onProviderStreamEvent?.(JSON.parse(line.slice(6)), currentModel);
          }
          const message = {
            role: "assistant" as const,
            content: [],
            api: currentModel.api,
            provider: currentModel.provider,
            model: currentModel.id,
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
            api: currentModel.api,
            provider: currentModel.provider,
            model: currentModel.id,
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
  let requestController = new AbortController();
  let abortCount = 0;
  const ctx = {
    model,
    hasUI: true,
    get signal() { return requestController.signal; },
    abort() { abortCount++; requestController.abort(); },
    isIdle: () => true,
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
  return {
    ctx: ctx as unknown as ExtensionContext, notifications, statuses,
    get abortCount() { return abortCount; },
    beginRequest() { requestController = new AbortController(); },
  };
}

function sseResponse() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "response-fixture", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const fetchSse = (async () => sseResponse()) as unknown as typeof globalThis.fetch;

async function compactSession(
  mock: ReturnType<typeof mockPi>,
  sessionManager: SessionManager,
  firstKeptEntryId: string,
  current: Awaited<ReturnType<typeof context>>,
  customInstructions?: string,
) {
  const event = compactEvent();
  event.customInstructions = customInstructions;
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

test("compacts GPT models without metadata through the registered provider", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];
  const current = await context({ model: { ...model, compat: undefined } });
  const result = await compact?.(compactEvent(), current.ctx) as {
    compaction: { details: unknown; usage: unknown };
  };
  const details = parseCheckpointDetails(result.compaction.details);
  assert.ok(details);
  assert.equal(details.modelId, model.id);
  assert.deepEqual(result.compaction.usage, usage);
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
  assert.deepEqual(current.notifications.map((notice) => notice.level), ["info"]);

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

test("provider switches stop requests before replay and preserve the opaque checkpoint", async () => {
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
  const savedEntry = structuredClone(entry);
  const select = mock.events.get("model_select")?.[0];
  await select?.({ type: "model_select", model: switchedModel }, switched.ctx);
  assert.equal(switched.abortCount, 0, "an idle selection warns without aborting a request");
  assert.equal(switched.notifications[0]?.level, "warning");
  assert.match(switched.notifications[0].message, /incompatible/);
  const project = mock.events.get("context")?.[0];
  assert.ok(project);
  await assert.rejects(async () => project({ type: "context", messages: [] }, switched.ctx), /incompatible/);
  assert.equal(switched.abortCount, 1);
  assert.equal(switched.ctx.signal?.aborted, true, "abort is required because Pi catches hook exceptions");
  switched.beginRequest();
  const rewrite = mock.events.get("before_provider_request")?.[0];
  assert.ok(rewrite);
  await assert.rejects(async () => rewrite({ type: "before_provider_request", payload: {
    model: switchedModel.id,
    input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker(details.checkpointId) }] }],
  } }, switched.ctx), /incompatible/);
  assert.equal(switched.abortCount, 2);
  assert.equal(switched.ctx.signal?.aborted, true);
  assert.deepEqual(switched.notifications.map((notice) => notice.level), ["warning", "error", "error"]);
  assert.deepEqual(entry, savedEntry);
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
  assert.equal(failed.notifications.at(-1)?.level, "warning");

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

for (const interruption of ["abort", "session-switch"] as const) {
  test(`a late remote checkpoint after ${interruption} is discarded without starting fallback`, async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const mock = mockPi("high", { transport: "sse", retry: { provider: { maxRetries: 0 } } });
    let requests = 0;
    createCodexCompactionExtension({ fetch: async () => {
      requests++;
      entered.resolve();
      // Simulate a server completing after the caller stopped owning the request.
      return reply.promise;
    } })(mock.pi);
    const native = openaiProvider();
    const registry = await testRegistry({ ...native, id: model.provider });
    let sessionId = "original-session";
    const entries = branch();
    const current = await context({
      modelRegistry: registry,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    });
    const compact = mock.events.get("session_before_compact")?.[0];
    assert.ok(compact);
    const pending = Promise.resolve(compact(compactEvent(controller.signal), current.ctx));
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Compaction ended before its provider request"); })]);
      if (interruption === "abort") controller.abort();
      else sessionId = "replacement-session";
      reply.resolve(sseResponse());
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(requests, 1);
      assert.deepEqual(mock.appendedEntries, []);
      assert.deepEqual(current.notifications.filter((notice) => notice.level !== "info"), []);
    } finally {
      controller.abort();
      reply.resolve(sseResponse());
    }
  });
}

test("non-GPT models, GPT models outside Responses APIs, and invalid metadata use Pi compaction silently", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const compact = mock.events.get("session_before_compact")?.[0];

  const unsupported = await context({ model: { ...model, compat: { ...{ remoteCompaction: false } } } });
  assert.equal(await compact?.(compactEvent(), unsupported.ctx), undefined);
  assert.deepEqual(unsupported.notifications, []);

  const unconfigured = await context({ model: { ...model, id: "other-model", compat: undefined } });
  assert.equal(await compact?.(compactEvent(), unconfigured.ctx), undefined);
  assert.deepEqual(unconfigured.notifications, []);

  const chatCompletions = await context({ model: { ...model, api: "openai-completions", compat: undefined } });
  assert.equal(await compact?.(compactEvent(), chatCompletions.ctx), undefined);
  assert.deepEqual(chatCompletions.notifications, []);
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

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

async function providerCompaction(messages: SessionMessage[], options: {
  settings?: TestSettings; tools?: TestTools; customInstructions?: string;
  adaptPayload?: (payload: JsonObject) => JsonObject;
  ordinaryPrompt?: string;
  ordinaryProjection?: (messages: AgentMessage[]) => AgentMessage[];
  prepareOrdinarySource?: (messages: AgentMessage[]) => AgentMessage[];
  retryOrdinaryPayload?: boolean;
  compactionResponses?: readonly Response[];
  afterOrdinary?: (session: SessionManager, mock: ReturnType<typeof mockPi>, current: Awaited<ReturnType<typeof context>>, requestModel: Model<"openai-responses">) => void | Promise<void>;
} = {}) {
  const mock = mockPi("high", options.settings, options.tools);
  let payload: unknown;
  const requests: JsonObject[] = [];
  createCodexCompactionExtension({ fetch: async (input, init) => {
    payload = await new Request(input, init).json();
    assert.ok(isObject(payload));
    requests.push(structuredClone(payload));
    return options.compactionResponses?.[requests.length - 1] ?? sseResponse();
  } })(mock.pi);
  const sessionManager = SessionManager.inMemory();
  const entries = messages.map((message) => sessionManager.appendMessage(message));
  const firstUser = messages.findIndex((message) => message.role === "user");
  assert.ok(firstUser >= 0);
  const native = openaiProvider();
  const provider: Provider<"openai-responses"> = { ...native, id: model.provider,
    streamSimple(currentModel, transcript, streamOptions) {
      return native.streamSimple(currentModel, transcript, { ...streamOptions, onPayload: (input, preparedModel) => {
        assert.ok(isObject(input));
        return streamOptions?.onPayload?.(options.adaptPayload?.(input) ?? input, preparedModel);
      } });
    },
  };
  const registry = await testRegistry(provider);
  const contexts: Context[] = [];
  const modelRegistry: Pick<ModelRegistry, "streamSimple" | "getApiKeyAndHeaders"> = {
    streamSimple(currentModel, currentContext, streamOptions) {
      contexts.push(currentContext);
      return registry.streamSimple(currentModel, currentContext, streamOptions);
    },
    getApiKeyAndHeaders: registry.getApiKeyAndHeaders.bind(registry),
  };
  const requestModel: Model<"openai-responses"> = { ...model, input: ["text", "image"] };
  let runtimePrompt = options.ordinaryPrompt ?? "system";
  const current = await context({ sessionManager, modelRegistry, model: requestModel, getSystemPrompt: () => runtimePrompt });
  let ordinaryPayload: JsonObject | undefined;
  if (options.ordinaryPrompt !== undefined || options.ordinaryProjection) {
    const canonical = sessionManager.buildSessionContext().messages;
    const source = options.prepareOrdinarySource?.(canonical) ?? canonical;
    const head = getCurrentSystemMessage(convertToLlm(source));
    assert.ok(head);
    const projected = await mock.events.get("context")?.[0]?.({ type: "context", messages: source.filter((message) => message.role !== "system") }, current.ctx) as ContextEventResult | undefined;
    let transformed = projected?.messages ? [head, ...projected.messages] : source;
    if (options.ordinaryProjection) transformed = options.ordinaryProjection(transformed);
    await mock.events.get("context_with_system")?.[0]?.({ type: "context_with_system", messages: transformed }, current.ctx);
    runtimePrompt = options.ordinaryPrompt ?? getSystemMessageText(head);
    const transcript = convertToLlm(transformed);
    const ordinaryContext: Context = { messages: options.ordinaryPrompt === undefined ? transcript : [
      { role: "system", content: options.ordinaryPrompt, toolsAdded: head.toolsAdded, timestamp: head.timestamp },
      ...transcript.filter((message) => message.role !== "system"),
    ] };
    for await (const event of registry.streamSimple(requestModel, ordinaryContext, {
      fetch: async () => sseResponse(), sessionId: sessionManager.getSessionId(),
      onPayload: async (input) => {
        assert.ok(isObject(input));
        ordinaryPayload = structuredClone(input);
        const event = { type: "before_provider_request", payload: input };
        const rewritten = await mock.events.get("before_provider_request")?.[0]?.(event, current.ctx);
        return options.retryOrdinaryPayload
          ? await mock.events.get("before_provider_request")?.[0]?.(event, current.ctx) ?? input
          : rewritten ?? input;
      },
    })) {
      // Drain the ordinary response before Pi clears its per-run prompt override.
      if (event.type === "error") throw new Error(event.error.errorMessage ?? "Ordinary fixture request failed");
    }
    runtimePrompt = getSystemMessageText(head);
    await options.afterOrdinary?.(sessionManager, mock, current, requestModel);
  }
  const details = await compactSession(mock, sessionManager, entries[firstUser], current, options.customInstructions);
  assert.ok(isObject(payload));
  return { payload, ordinaryPayload, contexts, details, requests, notifications: current.notifications };
}

function toolHistory(): SessionMessage[] {
  return [
    { role: "system", content: "canonical prompt", timestamp: 0 },
    { role: "user", content: "request", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "settings.md" } }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "read-call", toolName: "read", content: [{ type: "text", text: "Original tool output" }], isError: false, timestamp: 3 },
  ];
}

function packToolHistory(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => message.role === "toolResult"
    ? { ...message, content: message.content.map((block) => block.type === "text"
        ? { ...block, text: "[large tool result replaced after 2 successful responses on this branch] obs_fixture" } : block) }
    : message);
}

test("compaction preserves Pi's ordinary context projection and appends only new history", async () => {
  const messages = toolHistory();
  const saved = structuredClone(messages);
  const result = await providerCompaction(messages, { ordinaryProjection: packToolHistory, retryOrdinaryPayload: true,
    afterOrdinary(session) {
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "New final answer" }],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 4 });
    },
  });
  assert.ok(result.ordinaryPayload && Array.isArray(result.ordinaryPayload.input) && Array.isArray(result.payload.input));
  assert.equal(JSON.stringify(result.payload.input.slice(0, result.ordinaryPayload.input.length)), JSON.stringify(result.ordinaryPayload.input));
  assert.match(JSON.stringify(result.payload.input.at(-2)), /New final answer/);
  assert.equal(result.payload.input.length, result.ordinaryPayload.input.length + 2);
  assert.deepEqual(messages, saved);
});

test("an image-bearing projected prefix survives a failed HTTP compaction attempt and its retry", async () => {
  const image = { type: "image" as const, mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
  const messages: SessionMessage[] = toolHistory().map((message) => {
    if (message.role === "system") return { ...message, toolsAdded: [{
      name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } },
    }] };
    if (message.role === "user") return { ...message, content: [{ type: "text", text: "Inspect this image" }, image] };
    if (message.role === "toolResult") return { ...message, content: [...message.content, image] };
    return message;
  });
  const saved = structuredClone(messages);
  const result = await providerCompaction(messages, {
    ordinaryProjection: packToolHistory,
    settings: { transport: "sse", images: { blockImages: false }, retry: { provider: { maxRetries: 1, maxRetryDelayMs: 1 } } },
    compactionResponses: [new Response("Service unavailable", { status: 503 }), sseResponse()],
    afterOrdinary(session) {
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Image inspected" }],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 4 });
    },
  });
  const ordinary = result.ordinaryPayload;
  assert.ok(ordinary && Array.isArray(ordinary.input));
  assert.ok(Array.isArray(ordinary.tools) && ordinary.tools.length > 0);
  const images = ordinary.input.filter(isObject).flatMap((item) => [
    ...(Array.isArray(item.content) ? item.content : []),
    ...(Array.isArray(item.output) ? item.output : []),
  ]).filter(isObject).filter((block) => block.type === "input_image");
  assert.equal(images.length, 2);
  assert.match(JSON.stringify(ordinary.input), /obs_fixture/);
  assert.equal(result.requests.length, 2);
  for (const request of result.requests) {
    assert.ok(Array.isArray(request.input));
    assert.equal(JSON.stringify(request.input.slice(0, ordinary.input.length)), JSON.stringify(ordinary.input));
    assert.deepEqual(request.instructions, ordinary.instructions);
    assert.equal(request.tools, undefined, "compaction omits schemas while preserving the observed conversation prefix");
    assert.match(JSON.stringify(request.input.at(-2)), /Image inspected/);
    assert.deepEqual(request.input.at(-1), { type: "compaction_trigger" });
    assert.equal(request.input.length, ordinary.input.length + 2);
  }
  assert.deepEqual(result.requests[1], result.requests[0]);
  assert.deepEqual(messages, saved);
});

test("compaction does not reuse an ordinary context whose source includes unpersisted messages", async () => {
  const result = await providerCompaction(toolHistory(), { ordinaryProjection: packToolHistory,
    prepareOrdinarySource(messages) {
      return [...messages, { role: "user", content: "request-local message", timestamp: 4 }];
    },
  });
  assert.match(JSON.stringify(result.payload.input), /Original tool output/);
  assert.doesNotMatch(JSON.stringify(result.payload.input), /obs_fixture|request-local message/);
});

for (const change of ["edit", "system", "session-start", "session-shutdown", "session-id", "model", "backend"] as const) {
  test(`compaction discards its ordinary context projection after ${change} changes`, async () => {
    const result = await providerCompaction(toolHistory(), { ordinaryProjection: packToolHistory,
      async afterOrdinary(session, mock, current, requestModel) {
        if (change === "edit") {
          const entry = session.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
          assert.ok(entry);
          session.appendContextEdit(entry.id, { content: "edited request" });
        }
        if (change === "system") session.appendMessage({ role: "system", content: "new instructions", timestamp: 4 });
        if (change === "session-start") await mock.events.get("session_start")?.[0]?.({ type: "session_start" }, current.ctx);
        if (change === "session-shutdown") await mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, current.ctx);
        if (change === "session-id") session.getSessionId = () => "replacement-session";
        if (change === "model") requestModel.id = "other-model";
        if (change === "backend") {
          requestModel.baseUrl = "https://other.example/v1";
          const compat = { ...requestModel.compat, remoteCompaction: { protocol: "v2", endpoint: "https://other.example/v1/responses" } };
          requestModel.compat = compat;
        }
      },
    });
    assert.match(JSON.stringify(result.payload.input), /Original tool output/);
    assert.doesNotMatch(JSON.stringify(result.payload.input), /obs_fixture/);
    if (change === "edit") assert.match(JSON.stringify(result.payload.input), /edited request/);
  });
}

test("compaction reuses the effective ordinary prompt after Pi clears its run override", async () => {
  const tool: Tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
  const messages: SessionMessage[] = [
    { role: "system", content: "", sections: { preamble: "Preamble", tools: "<tools>\nread\n</tools>", docs: "<docs>\nDocs\n</docs>" }, toolsAdded: [tool], timestamp: 0 },
    { role: "user", content: "request", timestamp: 1 },
  ];
  const saved = structuredClone(messages);
  const result = await providerCompaction(messages, { ordinaryPrompt: "Preamble\n\n<docs>\nDocs\n</docs>\n\n<tools>\nread\n</tools>" });
  assert.ok(result.ordinaryPayload && Array.isArray(result.ordinaryPayload.input) && Array.isArray(result.payload.input));
  assert.deepEqual(result.payload.input[0], result.ordinaryPayload.input[0]);
  assert.deepEqual(messages, saved);
});

for (const change of ["system", "session-start", "session-shutdown", "session-id", "model"] as const) {
  test(`compaction discards an ordinary prompt override after ${change} changes`, async () => {
    const messages: SessionMessage[] = [
      { role: "system", content: "canonical prompt", timestamp: 0 },
      { role: "user", content: "request", timestamp: 1 },
    ];
    const result = await providerCompaction(messages, { ordinaryPrompt: "per-run override",
      async afterOrdinary(session, mock, current, requestModel) {
        if (change === "system") session.appendMessage({ role: "system", content: "new instructions", timestamp: 2 });
        if (change === "session-start") await mock.events.get("session_start")?.[0]?.({ type: "session_start" }, current.ctx);
        if (change === "session-shutdown") await mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, current.ctx);
        if (change === "session-id") session.getSessionId = () => "replacement-session";
        if (change === "model") requestModel.id = "other-model";
      },
    });
    assert.ok(Array.isArray(result.payload.input));
    const expected = change === "system" ? "canonical prompt\n\nnew instructions" : "canonical prompt";
    assert.deepEqual(result.payload.input[0], { role: "developer", content: expected });
  });
}

for (const withSystem of [true, false]) {
  test(`sends one system prompt without tool schemas with transcript system messages ${withSystem}`, async () => {
    const tool: Tool = { name: "transcript_tool", description: "Transcript tool", parameters: { type: "object", properties: {} } };
    const inactive = { ...tool, name: "inactive_tool" };
    const messages: SessionMessage[] = [
      ...(withSystem ? [{ role: "system" as const, content: "system", toolsAdded: [tool], timestamp: 0 }] : []),
      { role: "user", content: "request", timestamp: 1 },
    ];
    const result = await providerCompaction(messages, { tools: { active: [tool.name], all: [tool, inactive] } });
    assert.equal(result.contexts.length, 1);
    if (withSystem) {
      assert.deepEqual(Object.keys(result.contexts[0]), ["messages"]);
    } else {
      assert.equal(result.contexts[0].systemPrompt, "system");
      assert.deepEqual(result.contexts[0].tools, [tool], "Pi may use internal declarations to serialize historical tool calls");
    }
    assert.ok(Array.isArray(result.payload.input));
    const instructions = result.payload.input.filter(isObject).filter((item) => item.role === "system" || item.role === "developer");
    assert.deepEqual(instructions, [{ role: "developer", content: "system" }]);
    assert.equal(result.payload.tools, undefined);
    assert.doesNotMatch(JSON.stringify(result.payload), /transcript_tool|inactive_tool/);
    assert.equal(result.payload.instructions, undefined);
    assert.deepEqual(result.notifications.filter((notice) => notice.level === "warning"), []);
  });
}

test("uses transcript system updates without tool schemas", async () => {
  const tool: Tool = { name: "transcript_tool", description: "Transcript tool", parameters: { type: "object", properties: {} } };
  const result = await providerCompaction([
    { role: "system", content: "initial instructions", toolsAdded: [tool], timestamp: 0 },
    { role: "user", content: "request", timestamp: 1 },
    { role: "system", content: "updated instructions", timestamp: 2 },
  ], { tools: { active: ["fallback_tool"], all: [{ ...tool, name: "fallback_tool" }] } });
  const wire = JSON.stringify(result.payload);
  assert.equal(wire.split("initial instructions").length - 1, 1);
  assert.equal(wire.split("updated instructions").length - 1, 1);
  assert.doesNotMatch(wire, /fallback_tool/);
  assert.deepEqual(Object.keys(result.contexts[0]), ["messages"]);
});

for (const blockImages of [true, false]) {
  test(`applies blockImages=${blockImages} to user and tool-result payloads without changing history`, async () => {
    const image = { type: "image" as const, data: "fixture-image", mimeType: "image/png" };
    const separator = { type: "text" as const, text: "separator" };
    const content = [image, image, separator, image, image];
    const messages: SessionMessage[] = [
      { role: "user", content, timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call", toolName: "read", content, isError: false, timestamp: 3 },
    ];
    const saved = structuredClone(messages);
    const result = await providerCompaction(messages, { settings: { transport: "sse", images: { blockImages } } });
    const converted = result.contexts[0].messages.filter((message) => message.role === "user" || message.role === "toolResult");
    assert.equal(converted.length, 2);
    const first = converted[0].content;
    assert.ok(Array.isArray(first));
    const placeholder = first[0];
    if (blockImages) assert.ok(placeholder.type === "text" && placeholder.text.length > 0);
    for (const message of converted) {
      assert.deepEqual(message.content, blockImages ? [placeholder, separator, placeholder] : content);
    }
    const wire = JSON.stringify(result.payload);
    if (blockImages) {
      assert.doesNotMatch(wire, /input_image|fixture-image/);
      assert.ok(placeholder.type === "text");
      assert.equal(wire.split(placeholder.text).length - 1, 4);
    } else {
      assert.match(wire, /input_image/);
      assert.match(wire, /fixture-image/);
    }
    assert.deepEqual(messages, saved);
  });
}

test("preserves Pi reasoning and retry delay while V2 owns retries and uses SSE", async () => {
  const settings: TestSettings = { transport: "websocket", thinkingBudgets: { minimal: 16, low: 32, medium: 64, high: 128 },
    retry: { maxRetries: 17, provider: { maxRetries: 9, maxRetryDelayMs: 321 } }, websocketConnectTimeoutMs: 0 };
  const observed: SimpleStreamOptions[] = [];
  const provider = fakeProvider((options) => { assert.ok(options); observed.push(options); });
  const mock = mockPi("high", settings);
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const current = await context({ modelRegistry: await testRegistry(provider) });
  const compact = mock.events.get("session_before_compact")?.[0];
  assert.ok(compact);
  assert.ok(await compact(compactEvent(), current.ctx));
  assert.equal(observed[0].transport, "sse");
  assert.deepEqual(observed[0].thinkingBudgets, settings.thinkingBudgets);
  assert.equal(observed[0].maxRetries, 0, "the V2 retry loop owns the request budget; provider retries must not multiply it");
  assert.equal(observed[0].maxRetryDelayMs, 321);
  assert.equal(observed[0].websocketConnectTimeoutMs, undefined);
  settings.transport = "sse";
  settings.retry = { provider: { maxRetries: 0, maxRetryDelayMs: 123 } };
  settings.websocketConnectTimeoutMs = 45;
  assert.ok(await compact(compactEvent(), current.ctx));
  assert.equal(observed[1].transport, "sse");
  assert.equal(observed[1].maxRetries, 0);
  assert.equal(observed[1].maxRetryDelayMs, 123);
  assert.equal(observed[1].websocketConnectTimeoutMs, undefined);
});

test("warns for nonempty custom instructions and leaves provider instructions unchanged", async () => {
  for (const customInstructions of [undefined, "", " \n\t", "Summarize only security issues."]) {
    const result = await providerCompaction([{ role: "user", content: "request", timestamp: 1 }], { customInstructions });
    const warnings = result.notifications.filter((notice) => notice.level === "warning");
    assert.equal(warnings.length, customInstructions?.trim() ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(result.payload), /Summarize only security issues/);
  }
});

test("announces once when a provider prepares multiple retry payloads and again for the next compaction", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const current = await context({ modelRegistry: await testRegistry(fakeProvider(undefined, 3)) });
  const compact = mock.events.get("session_before_compact")?.[0];
  assert.ok(compact);
  assert.ok(await compact(compactEvent(), current.ctx));
  assert.equal(current.notifications.filter((notice) => notice.level === "info").length, 1);
  assert.ok(await compact(compactEvent(), current.ctx));
  assert.equal(current.notifications.filter((notice) => notice.level === "info").length, 2);
  assert.deepEqual(current.notifications.filter((notice) => notice.level === "warning"), []);
});

test("keeps visible custom and skill user text while excluding bash, hidden custom and skill-only content", async () => {
  const skill = '<skill name="fixture" location="E:/skills/fixture/SKILL.md">\nSkill instructions.\n</skill>';
  const result = await providerCompaction([
    { role: "user", content: [], timestamp: 0 },
    { role: "bashExecution", command: "echo fixture", output: "shell context", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
    { role: "custom", customType: "fixture", content: "hidden context", display: false, timestamp: 2 },
    { role: "custom", customType: "fixture", content: "visible notice", display: true, timestamp: 3 },
    { role: "user", content: `${skill}\n\nUser request.`, timestamp: 4 },
    { role: "user", content: skill, timestamp: 5 },
  ]);
  assert.match(JSON.stringify(result.payload), /shell context/);
  assert.match(JSON.stringify(result.payload), /hidden context/);
  assert.deepEqual(result.details.replacementHistory, [
    { role: "user", content: [{ type: "input_text", text: "visible notice" }] },
    { role: "user", content: [{ type: "input_text", text: "User request." }] },
    { type: "compaction", encrypted_content: "opaque" },
  ]);
});

test("falls back to text classification when a provider inserts an extra user item", async () => {
  const result = await providerCompaction([
    { role: "user", content: "request", timestamp: 1 },
    { role: "custom", customType: "fixture", content: "hidden without marker", display: false, timestamp: 2 },
  ], { adaptPayload(payload) {
    assert.ok(Array.isArray(payload.input));
    return { ...payload, input: [...payload.input, { role: "user", content: [{ type: "input_text", text: "<environment_context>injected</environment_context>" }] }] };
  } });
  assert.deepEqual(result.details.replacementHistory, [
    { role: "user", content: [{ type: "input_text", text: "request" }] },
    { role: "user", content: [{ type: "input_text", text: "hidden without marker" }] },
    { type: "compaction", encrypted_content: "opaque" },
  ]);
});

test("stops every failed projection request across sessions and checkpoints", async () => {
  const mock = mockPi();
  createCodexCompactionExtension()(mock.pi);
  const session = SessionManager.inMemory();
  const message: AgentMessage = { role: "user", content: "kept", timestamp: 1 };
  const firstKept = session.appendMessage(message);
  const append = () => {
    const details = createCheckpointDetails({ identity: { ...capability, modelId: model.id },
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }], keptMessages: [message] });
    session.appendCompaction(fallbackSummary(details.checkpointId), firstKept, 100, details);
  };
  append();
  let sessionId = "first-session";
  const current = await context({ sessionManager: { getSessionId: () => sessionId, getBranch: () => session.getBranch() } });
  const project = mock.events.get("context")?.[0];
  assert.ok(project);
  let failures = 0;
  const failProjection = async () => {
    current.beginRequest();
    const savedBranch = structuredClone(session.getBranch());
    const messages = session.buildSessionProjection().messages.filter((message) => message.role !== "system")
      .map((message) => message.role === "user" ? { ...message, content: "changed by another context hook" } : message);
    await assert.rejects(async () => project({ type: "context", messages }, current.ctx), /no longer matches the retained messages/);
    failures++;
    assert.equal(current.abortCount, failures);
    assert.equal(current.ctx.signal?.aborted, true);
    assert.equal(current.notifications.length, failures);
    assert.ok(current.notifications.every((notice) => notice.level === "error"));
    assert.deepEqual(session.getBranch(), savedBranch);
  };
  await failProjection();
  await failProjection();
  sessionId = "second-session";
  await failProjection();
  append();
  await failProjection();
  await failProjection();
  await mock.events.get("session_start")?.[0]?.({ type: "session_start" }, current.ctx);
  await failProjection();
  assert.equal(current.abortCount, 6);
});

test("stops invalid checkpoint requests without a UI and on incompatible model identities", async () => {
  const session = SessionManager.inMemory();
  const message: AgentMessage = { role: "user", content: "kept", timestamp: 1 };
  const firstKept = session.appendMessage(message);
  const details = createCheckpointDetails({ identity: { ...capability, modelId: model.id },
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }], keptMessages: [message] });
  session.appendCompaction(fallbackSummary(details.checkpointId), firstKept, 100, details);
  const savedBranch = structuredClone(session.getBranch());
  for (const overrides of [{ hasUI: false }, { model: { ...model, provider: "other" } }, { model: { ...model, api: "openai-completions" } }]) {
    const mock = mockPi();
    createCodexCompactionExtension()(mock.pi);
    const current = await context({ sessionManager: session, ...overrides });
    const project = mock.events.get("context")?.[0];
    assert.ok(project);
    await assert.rejects(async () => project({ type: "context", messages: [] }, current.ctx),
      overrides.hasUI === false ? /no longer matches the retained messages/ : /incompatible/);
    assert.equal(current.abortCount, 1);
    assert.equal(current.ctx.signal?.aborted, true);
    if (overrides.hasUI === false) assert.deepEqual(current.notifications, []);
    else assert.deepEqual(current.notifications.map((notice) => notice.level), ["error"]);
    assert.deepEqual(session.getBranch(), savedBranch);
  }
});

const fallbackModel: Model<"openai-responses"> = {
  ...model, provider: "cheap-provider", id: "gpt-6.1-sol", name: "Cheap summary", compat: undefined,
};
const astraModel: Model<"openai-responses"> = { ...model, id: "astra", compat: undefined };

async function configureFallback(thinkingLevel = "high") {
  await writeFile(fallbackSettingsPath, JSON.stringify({
    version: 1, fallback: { provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel },
  }));
}

async function fallbackFixture(options: {
  currentModel?: Model<"openai-responses">;
  stopReason?: "stop" | "length" | "error" | "aborted";
  text?: string;
  onRequest?: () => void;
  auth?: boolean;
  thinkingLevelMap?: Model<"openai-responses">["thinkingLevelMap"];
} = {}) {
  const calls: Array<{ model: Model<"openai-responses">; context: Context; options?: SimpleStreamOptions }> = [];
  let remoteRequests = 0;
  const registry = await testRegistry(fakeProvider(() => { remoteRequests++; }));
  const configured = { ...fallbackModel, thinkingLevelMap: options.thinkingLevelMap };
  registry.registerProvider({
    id: fallbackModel.provider, name: "Cheap provider", baseUrl: fallbackModel.baseUrl,
    auth: { apiKey: { name: "Fixture", resolve: async () => options.auth === false ? undefined : { auth: { apiKey: "cheap-fixture-key" } } } },
    getModels: () => [configured],
    streamSimple(requestModel, requestContext, streamOptions) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let stopReason = options.stopReason ?? "stop";
        let errorMessage;
        try {
          await streamOptions?.onPayload?.({ model: requestModel.id, input: [] }, requestModel);
          calls.push({ model: configured, context: requestContext, options: streamOptions });
          options.onRequest?.();
        } catch (error) {
          stopReason = "error";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        const response = {
          role: "assistant" as const, content: [{ type: "text" as const, text: options.text ?? "Keep working on the cache fix." }],
          api: fallbackModel.api, provider: fallbackModel.provider, model: fallbackModel.id, usage, stopReason,
          errorMessage: errorMessage ?? (stopReason === "error" ? "fixture request failed" : undefined), timestamp: 1,
        };
        if (stopReason === "error" || stopReason === "aborted") {
          stream.push({ type: "error", reason: stopReason, error: response });
        } else {
          stream.push({ type: "done", reason: stopReason, message: response });
        }
        stream.end(response);
      })();
      return stream;
    },
    stream() { throw new Error("not used"); },
  });
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: "older task", timestamp: 1 });
  const firstKeptEntryId = sessionManager.appendMessage({ role: "user", content: "recent task", timestamp: 2 });
  const current = await context({ model: options.currentModel ?? astraModel, modelRegistry: registry, sessionManager });
  const event = compactEvent();
  event.branchEntries = sessionManager.getBranch();
  event.preparation.firstKeptEntryId = firstKeptEntryId;
  event.preparation.messagesToSummarize = [{ role: "user", content: "older task", timestamp: 1 }];
  const mock = mockPi("low", { transport: "sse", retry: { enabled: false } });
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const run = () => mock.events.get("session_before_compact")?.[0]?.(event, current.ctx) as Promise<SessionBeforeCompactResult | undefined>;
  return { ...current, mock, event, sessionManager, calls, run, remoteRequests: () => remoteRequests };
}

for (const reason of ["manual", "threshold", "overflow"] as const) {
  test(`uses the configured native summary model for ${reason} compaction without changing the chat model`, async () => {
    await configureFallback();
    const fixture = await fallbackFixture();
    fixture.event.reason = reason;
    fixture.event.willRetry = reason === "overflow";
    fixture.event.customInstructions = "Preserve the failing cache test.";
    fixture.event.preparation.previousSummary = "Previously investigated request prefixes.";
    fixture.event.preparation.fileOps.read.add("src/fallback.ts");
    const result = await fixture.run();
    assert.ok(result?.compaction);
    const compacted = result.compaction;
    assert.match(compacted.summary, /Keep working on the cache fix/);
    assert.match(compacted.summary, /<read-files>\nsrc\/fallback.ts\n<\/read-files>/);
    assert.equal(compacted.firstKeptEntryId, fixture.event.preparation.firstKeptEntryId);
    assert.equal(compacted.tokensBefore, 123);
    assert.deepEqual(compacted.usage, usage);
    assert.equal(parseCheckpointDetails(compacted.details), undefined);
    assert.equal(fixture.remoteRequests(), 0);
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0];
    assert.equal(call.model.id, fallbackModel.id);
    assert.equal(call.options?.reasoning, "high");
    assert.equal(call.options?.sessionId, fixture.sessionManager.getSessionId());
    assert.equal(call.options?.cacheRetention, "none");
    assert.equal(call.options?.signal, fixture.event.signal);
    assert.equal(call.options?.apiKey, "cheap-fixture-key");
    const prompt = JSON.stringify(call.context);
    assert.match(prompt, /older task/);
    assert.match(prompt, /Previously investigated request prefixes/);
    assert.match(prompt, /Preserve the failing cache test/);
    assert.doesNotMatch(prompt, /recent task/);
    fixture.sessionManager.appendCompaction(compacted.summary, compacted.firstKeptEntryId, compacted.tokensBefore, compacted.details, true, compacted.usage);
    await fixture.mock.events.get("session_compact")?.[0]?.({ type: "session_compact", fromExtension: true, compactionEntry: { details: compacted.details } }, fixture.ctx);
    assert.deepEqual(fixture.mock.appendedEntries, []);
    const projection = fixture.sessionManager.buildSessionProjection();
    assert.match(JSON.stringify(projection.messages), /Keep working on the cache fix/);
    assert.match(JSON.stringify(projection.messages), /recent task/);
    assert.equal(fixture.ctx.model, astraModel);
    assert.equal(fixture.mock.pi.getThinkingLevel(), "low");
    assert.equal(fixture.statuses.get("codex-compaction"), undefined);
  });
}

test("uses the configured fallback after a remote failure and preserves legacy behavior without configuration", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ currentModel: model });
  // Returning no compaction item makes the remote protocol fail after payload preparation.
  const failedRemote = createCodexCompactionExtension({ fetch: async () => new Response("", { headers: { "content-type": "text/event-stream" } }) });
  fixture.mock.events.clear();
  failedRemote(fixture.mock.pi);
  const result = await fixture.run();
  assert.ok(result?.compaction);
  assert.equal(fixture.remoteRequests(), 1);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.ctx.model, model);
  const warnings = () => fixture.notifications.filter((item) => item.level === "warning").length;
  assert.equal(warnings(), 1);
  await rm(fallbackSettingsPath);
  const legacy = await fixture.run();
  assert.equal(legacy, undefined);
  assert.equal(fixture.calls.length, 1);
  assert.equal(warnings(), 2);
});

test("successful remote compaction does not validate an unused malformed fallback section", async () => {
  await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, fallback: null }));
  const fixture = await fallbackFixture({ currentModel: model });
  const result = await fixture.run();
  assert.ok(result?.compaction);
  assert.ok(parseCheckpointDetails(result.compaction.details));
  assert.equal(fixture.calls.length, 0);
});

test("disabled fallback delegates unsupported models to Pi", async () => {
  const fixture = await fallbackFixture();
  assert.equal(await fixture.run(), undefined);
  await writeFile(fallbackSettingsPath, "{}");
  assert.equal(await fixture.run(), undefined);
  assert.equal(fixture.calls.length, 0);
});

test("an explicit off switch skips model resolution even when the saved model is unavailable", async () => {
  await writeFile(fallbackSettingsPath, JSON.stringify({
    version: 1, fallback: { enabled: false, provider: "removed", model: "old", thinkingLevel: "unsupported" },
  }));
  const fixture = await fallbackFixture();
  fixture.ctx.modelRegistry.find = () => { throw new Error("Disabled fallback must not resolve a model"); };
  assert.equal(await fixture.run(), undefined);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.remoteRequests(), 0);
});

for (const enabled of [false, true]) {
  test(`a switch without a configured model remains inactive (enabled=${enabled})`, async () => {
    await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, fallback: { enabled } }));
    const fixture = await fallbackFixture();
    fixture.ctx.modelRegistry.find = () => { throw new Error("An unconfigured fallback must not resolve a model"); };
    assert.equal(await fixture.run(), undefined);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.remoteRequests(), 0);
  });
}

test("an explicit on switch uses the selected fallback model", async () => {
  await writeFile(fallbackSettingsPath, JSON.stringify({
    version: 1, fallback: { enabled: true, provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" },
  }));
  const fixture = await fallbackFixture();
  assert.ok((await fixture.run())?.compaction);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].options?.reasoning, "high");
  assert.equal(fixture.ctx.model, astraModel);
});

for (const content of [
  "invalid JSON",
  "[]",
  JSON.stringify({ version: 2, fallback: { provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" } }),
  JSON.stringify({ fallback: { provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" } }),
  JSON.stringify({ version: 1, fallback: null }),
  JSON.stringify({ version: 1, fallback: { provider: fallbackModel.provider, model: fallbackModel.id } }),
  JSON.stringify({ version: 1, fallback: { provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "typo" } }),
  JSON.stringify({ version: 1, fallback: { provider: "missing", model: fallbackModel.id, thinkingLevel: "high" } }),
  JSON.stringify({ version: 1, fallback: { provider: fallbackModel.provider, model: "missing", thinkingLevel: "high" } }),
  JSON.stringify({ version: 1, fallback: { provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high", unexpected: true } }),
  ...["false", 0, null].map((enabled) => JSON.stringify({ version: 1, fallback: { enabled, provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" } })),
  JSON.stringify({ unexpected: true }),
  " ".repeat(16 * 1024 + 1),
]) {
  test(`invalid fallback settings stop compaction before a provider request (${content.slice(0, 45).trim() || "oversized"})`, async () => {
    await writeFile(fallbackSettingsPath, content);
    const fixture = await fallbackFixture();
    assert.deepEqual(await fixture.run(), { cancel: true });
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.remoteRequests(), 0);
    assert.ok(fixture.notifications.some((item) => item.level === "error"));
    assert.equal(fixture.sessionManager.getBranch().filter((item) => item.type === "compaction").length, 0);
  });
}

for (const stopReason of ["length", "error"] as const) {
  test(`a fallback ${stopReason} response stops compaction without delegating to the chat model`, async () => {
    await configureFallback();
    const fixture = await fallbackFixture({ stopReason });
    assert.deepEqual(await fixture.run(), { cancel: true });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.remoteRequests(), 0);
    assert.equal(fixture.ctx.model, astraModel);
    assert.equal(fixture.statuses.get("codex-compaction"), undefined);
  });
}

test("missing fallback authentication stops compaction", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ auth: false });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 0);
});

test("empty fallback summaries stop compaction", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ text: " " });
  fixture.event.preparation.fileOps.read.add("tracked.ts");
  assert.deepEqual(await fixture.run(), { cancel: true });
});

test("cancellation before fallback preparation sends no request", async () => {
  await configureFallback();
  const fixture = await fallbackFixture();
  fixture.event.signal = AbortSignal.abort();
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.notifications, []);
});

test("cancellation during fallback discards its result", async () => {
  await configureFallback();
  const controller = new AbortController();
  const fixture = await fallbackFixture({ onRequest: () => controller.abort() });
  fixture.event.signal = controller.signal;
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 1);
  assert.ok(!fixture.notifications.some((item) => item.level === "error"));
});

test("a session switch during fallback discards its result", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ onRequest: () => { fixture.ctx.sessionManager.getSessionId = () => "other-session"; } });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 1);
  assert.ok(!fixture.notifications.some((item) => item.level === "error"));
});

test("unsupported model thinking levels stop compaction instead of silently reducing effort", async () => {
  await configureFallback("high");
  const fixture = await fallbackFixture({ thinkingLevelMap: { high: null } });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 0);
});

test("fallback off disables reasoning and forwards Pi provider runtime settings", async () => {
  await configureFallback("off");
  const fixture = await fallbackFixture();
  const mock = mockPi("high", {
    transport: "sse", thinkingBudgets: { high: 1234 }, websocketConnectTimeoutMs: 4567,
    retry: { enabled: false, provider: { timeoutMs: 7890, maxRetries: 1, maxRetryDelayMs: 2345 } },
  });
  createCodexCompactionExtension()(mock.pi);
  const result = await mock.events.get("session_before_compact")?.[0]?.(fixture.event, fixture.ctx) as SessionBeforeCompactResult;
  assert.ok(result.compaction);
  const options = fixture.calls[0].options;
  assert.equal(options?.reasoning, undefined);
  assert.equal(options?.transport, "sse");
  assert.deepEqual(options?.thinkingBudgets, { high: 1234 });
  assert.equal(options?.websocketConnectTimeoutMs, 4567);
  assert.equal(options?.timeoutMs, 7890);
  assert.equal(options?.maxRetries, 1);
  assert.equal(options?.maxRetryDelayMs, 2345);
});

test("split-turn fallback uses Pi's two summary requests and combines usage", async () => {
  await configureFallback();
  const fixture = await fallbackFixture();
  fixture.event.preparation.isSplitTurn = true;
  fixture.event.preparation.turnPrefixMessages = [{ role: "user", content: "unfinished turn", timestamp: 3 }];
  const result = await fixture.run();
  assert.ok(result?.compaction);
  assert.equal(result.compaction.summary.split("Keep working on the cache fix.").length - 1, 2);
  assert.equal(fixture.calls.length, 2);
  assert.equal(result.compaction.usage?.input, usage.input * 2);
  assert.equal(result.compaction.usage?.output, usage.output * 2);
  assert.ok(fixture.calls.every((call) => call.options?.reasoning === "high"));
});

test("a provider abort without a cancelled signal does not become a fallback summary", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ stopReason: "aborted" });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.calls.length, 1);
});

test("native Responses fallback authenticates and retries with the configured effort, then preserves provider usage", async () => {
  await configureFallback();
  const fixture = await fallbackFixture();
  const native = openaiProvider();
  const payloads: JsonObject[] = [];
  const provider: Provider<"openai-responses"> = {
    ...native, id: fallbackModel.provider, getModels: () => [fallbackModel],
    streamSimple(requestModel, requestContext, options) {
      return native.streamSimple(requestModel, requestContext, { ...options, fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.headers.get("authorization"), "Bearer native-fixture-key");
        const payload: unknown = await request.json();
        assert.ok(isObject(payload));
        payloads.push(payload);
        if (payloads.length === 1) return new Response("Service unavailable", { status: 503 });
        const item = { type: "message", id: "msg-summary", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native HTTP summary.", annotations: [] }] };
        const events = [
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "summary-response", status: "completed", output: [item], usage: { input_tokens: 321, output_tokens: 7 } } },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
    },
  };
  const registry = await testRegistry(provider, async () => ({ auth: { apiKey: "native-fixture-key" } }));
  fixture.ctx.modelRegistry = registry;
  const mock = mockPi("low", { transport: "sse", retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, provider: { maxRetries: 0 } } });
  createCodexCompactionExtension()(mock.pi);
  const result = await mock.events.get("session_before_compact")?.[0]?.(fixture.event, fixture.ctx) as SessionBeforeCompactResult;
  assert.ok(result.compaction);
  assert.equal(result.compaction.summary, "Native HTTP summary.");
  assert.equal(result.compaction.usage?.input, 321);
  assert.equal(result.compaction.usage?.output, 7);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].model, fallbackModel.id);
  assert.ok(isObject(payloads[1].reasoning));
  assert.equal(payloads[1].reasoning.effort, "high");
  assert.doesNotMatch(JSON.stringify(payloads[1]), /compaction_trigger/);
  assert.match(JSON.stringify(payloads[1]), /older task/);
  assert.equal(fixture.ctx.model, astraModel);
});

for (const reason of ["manual", "threshold", "overflow"] as const) {
  test(`V2 off uses the configured text fallback for ${reason} compaction without a remote request`, async () => {
    await writeFile(fallbackSettingsPath, JSON.stringify({
      version: 1, remoteCompaction: { enabled: false },
      fallback: { enabled: true, provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" },
    }));
    const fixture = await fallbackFixture({ currentModel: model });
    fixture.event.reason = reason;
    fixture.event.willRetry = reason === "overflow";
    fixture.event.customInstructions = "Preserve the V2 switch test.";
    const result = await fixture.run();
    assert.ok(result?.compaction);
    assert.equal(parseCheckpointDetails(result.compaction.details), undefined);
    assert.equal(fixture.remoteRequests(), 0);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].options?.reasoning, "high");
    assert.match(JSON.stringify(fixture.calls[0].context), /Preserve the V2 switch test/);
    assert.equal(fixture.ctx.model, model);
    assert.equal(fixture.mock.pi.getThinkingLevel(), "low");
  });
}

for (const fallback of [undefined, { enabled: true }, { enabled: false, provider: "missing", model: "missing", thinkingLevel: "high" }]) {
  test(`V2 off delegates to Pi when fallback is inactive (${JSON.stringify(fallback)})`, async () => {
    await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: false }, fallback }));
    const fixture = await fallbackFixture({ currentModel: model });
    assert.equal(await fixture.run(), undefined);
    assert.equal(fixture.remoteRequests(), 0);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.ctx.model, model);
  });
}

test("turning V2 back on restores remote compaction on the next attempt", async () => {
  const fixture = await fallbackFixture({ currentModel: model });
  await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: false } }));
  assert.equal(await fixture.run(), undefined);
  assert.equal(fixture.remoteRequests(), 0);
  await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: true } }));
  const result = await fixture.run();
  assert.ok(result?.compaction && parseCheckpointDetails(result.compaction.details));
  assert.equal(fixture.remoteRequests(), 1);
  assert.equal(fixture.calls.length, 0);
});

test("V2 off still stops compaction when the enabled fallback fails", async () => {
  await writeFile(fallbackSettingsPath, JSON.stringify({
    version: 1, remoteCompaction: { enabled: false },
    fallback: { enabled: true, provider: fallbackModel.provider, model: fallbackModel.id, thinkingLevel: "high" },
  }));
  const fixture = await fallbackFixture({ currentModel: model, stopReason: "error" });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.remoteRequests(), 0);
  assert.equal(fixture.calls.length, 1);
});

test("a settings edit during a remote request applies to the next compaction only", async () => {
  await configureFallback();
  const fixture = await fallbackFixture({ currentModel: model });
  fixture.mock.events.clear();
  createCodexCompactionExtension({ fetch: async () => {
    await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: false }, fallback: { enabled: false } }));
    return new Response("", { headers: { "content-type": "text/event-stream" } });
  } })(fixture.mock.pi);
  assert.ok((await fixture.run())?.compaction);
  assert.equal(fixture.remoteRequests(), 1);
  assert.equal(fixture.calls.length, 1);
  assert.equal(await fixture.run(), undefined);
  assert.equal(fixture.remoteRequests(), 1);
  assert.equal(fixture.calls.length, 1);
});

test("V2 off preserves replay of an existing opaque checkpoint", async () => {
  const mock = mockPi();
  createCodexCompactionExtension({ fetch: fetchSse })(mock.pi);
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "older", timestamp: 0 });
  const firstKept = session.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const current = await context({ sessionManager: session });
  const details = await compactSession(mock, session, firstKept, current);
  await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction: { enabled: false } }));
  await assertSessionReplay(mock, session, current, details);
});

for (const remoteCompaction of [null, true, {}, { enabled: "false" }, { enabled: 0 }, { enabled: false, unexpected: true }]) {
  test(`invalid V2 settings stop before remote or fallback requests (${JSON.stringify(remoteCompaction)})`, async () => {
    await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, remoteCompaction }));
    const fixture = await fallbackFixture({ currentModel: model });
    assert.deepEqual(await fixture.run(), { cancel: true });
    assert.equal(fixture.remoteRequests(), 0);
    assert.equal(fixture.calls.length, 0);
    assert.ok(fixture.notifications.some((notice) => notice.level === "error"));
  });
}

test("malformed JSON stops before any remote request because the V2 switch cannot be read", async () => {
  await writeFile(fallbackSettingsPath, "invalid JSON");
  const fixture = await fallbackFixture({ currentModel: model });
  assert.deepEqual(await fixture.run(), { cancel: true });
  assert.equal(fixture.remoteRequests(), 0);
  assert.equal(fixture.calls.length, 0);
});

for (const { virtualMaxTokens, reserveTokens, expected } of [
  { virtualMaxTokens: 1_024, reserveTokens: 16_384, expected: [10_000, 8_192] },
  { virtualMaxTokens: 0, reserveTokens: 16_384, expected: [10_000, 8_192] },
  { virtualMaxTokens: 20_000, reserveTokens: 16_384, expected: [10_000, 8_192] },
  { virtualMaxTokens: 1_024, reserveTokens: 1_000, expected: [800, 500] },
]) {
  test(`virtual fallback ignores display limit ${virtualMaxTokens} and preserves reserve ${reserveTokens}`, async () => {
    const fixture = await fallbackFixture();
    const registry: ModelRegistry = fixture.ctx.modelRegistry;
    let routes = 0;
    registry.registerVirtualModel({
      provider: "summary-router", id: "virtual-summary", name: "Virtual summary",
      thinkingLevels: ["off", "high"], maxTokens: virtualMaxTokens,
      route(request) {
        routes++;
        assert.equal(request.reason, "direct");
        assert.equal(request.model.maxTokens, virtualMaxTokens, "route the original catalog model");
        assert.equal(request.thinkingLevel, "high");
        return { model: fallbackModel, thinkingLevel: "medium" };
      },
    });
    await registry.refresh({ allowNetwork: false });
    await writeFile(fallbackSettingsPath, JSON.stringify({ version: 1, fallback: {
      enabled: true, provider: "summary-router", model: "virtual-summary", thinkingLevel: "high",
    } }));
    fixture.event.preparation.settings.reserveTokens = reserveTokens;
    fixture.event.preparation.isSplitTurn = true;
    fixture.event.preparation.turnPrefixMessages = [{ role: "user", content: "Continue the current task.", timestamp: 2 }];
    const result = await fixture.run();
    assert.ok(result?.compaction);
    assert.deepEqual(fixture.calls.map((call) => call.options?.maxTokens), expected);
    assert.equal(routes, 2, "route each native summary once");
    for (const call of fixture.calls) {
      assert.equal(call.model.id, fallbackModel.id);
      assert.equal(call.options?.reasoning, "medium");
    }
    assert.equal(fixture.ctx.model?.id, astraModel.id);
    assert.equal(registry.find("summary-router", "virtual-summary")?.maxTokens, virtualMaxTokens);
  });
}
