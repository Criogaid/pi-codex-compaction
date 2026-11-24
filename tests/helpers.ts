// Build isolated real Pi registries for request-boundary regression tests.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import assert from "node:assert/strict";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type AuthResult, type ImageContent, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isObject, isObjectArray, type CompactionPayload, type JsonObject } from "../src/protocol.js";

export const fixtureImage: ImageContent = { type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };

export async function testRegistry(provider: Provider, resolve: () => Promise<AuthResult | undefined> = async () => ({ auth: { apiKey: "fixture-key" } })): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider({ ...provider, auth: { apiKey: { name: "Fixture", resolve } } });
  return new ModelRegistry(runtime);
}

// Observe or change the adapter's serialization before the caller prepares the request.
export function withResponsesPayloadHook(
  provider: Provider,
  transform: (payload: CompactionPayload) => CompactionPayload,
): Provider {
  return { ...provider,
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, { ...options,
        onPayload: async (payload, preparedModel) => {
          assert.ok(isObject(payload) && isObjectArray(payload.input));
          const transformed = transform({ ...payload, input: payload.input });
          return await options?.onPayload?.(transformed, preparedModel) ?? transformed;
        },
      });
    },
  };
}

export function midConversationEffortModel(base: Model<Api>): Model<Api> {
  // The official OpenAI endpoint treats the fixture JWT as ChatGPT sign-in, which disables effort updates.
  return { ...base, baseUrl: "https://gateway.example/v1", compat: { ...base.compat, supportsMidConvoEffort: true } };
}

// Overlapping overrides in one process must be disposed in reverse order.
export function mockFetch(fetch: typeof globalThis.fetch): Disposable {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  return { [Symbol.dispose]: () => { globalThis.fetch = original; } };
}

// Node's test runner isolates each test file in its own process.
export function isolateAgentConfig(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-compaction-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

export interface SessionRequest {
  readonly payload: JsonObject;
  readonly bodyBytes: Buffer;
  readonly headers: Headers;
  readonly url: string;
}

/** Exercise real Pi sessions and provider serialization; replace only network I/O with bounded SSE fixtures. */
export async function sessionFixture(options: {
  readonly api?: "openai-responses" | "openai-codex-responses";
  readonly extensions: readonly ExtensionFactory[];
  readonly serializePayload?: Parameters<typeof withResponsesPayloadHook>[1];
  readonly models?: (base: Model<Api>) => readonly Model<Api>[];
  readonly settings?: Parameters<typeof SettingsManager.inMemory>[0];
  readonly respond?: (request: SessionRequest) => Response | undefined | Promise<Response | undefined>;
  readonly ordinaryInputTokens?: () => number | undefined;
}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-compaction-session-"));
  const requests: SessionRequest[] = [];
  const errors: string[] = [];
  const api = options.api ?? "openai-responses";
  const provider: Provider = api === "openai-responses" ? openaiProvider() : openaiCodexProvider();
  const catalogModel = provider.getModels().find((model) => model.id === "gpt-6.1-sol");
  assert.ok(catalogModel);
  const baseModel = { ...catalogModel, contextWindow: 32_000, maxTokens: 4_096,
    compat: { ...catalogModel.compat, supportsStore: false, remoteCompaction: { protocol: "v2" } } };
  const models = options.models?.(baseModel) ?? [baseModel];
  const model = models[0];
  assert.ok(model);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.ok(requests.length < 40, "Fixture request limit exceeded");
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const payload: unknown = JSON.parse(body.toString("utf8"));
    assert.ok(isObject(payload));
    const recorded = { payload, bodyBytes: bytes, headers: request.headers, url: request.url };
    requests.push(recorded);
    const response = await options.respond?.(recorded);
    if (response) return response;
    assert.ok(Array.isArray(payload.input));
    const compacting = payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
    const item = compacting
      ? { type: "compaction", encrypted_content: `fixture-checkpoint-${requests.length}` }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
          content: [{ type: "output_text", text: `Fixture reply ${requests.length}.`, annotations: [] }] };
    const inputTokens = (compacting ? undefined : options.ordinaryInputTokens?.()) ?? 500;
    const outputTokens = 20;
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
    const events = [
      { type: "response.created", response: { id: `resp_${requests.length}` } },
      ...(!compacting ? [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: `Fixture reply ${requests.length}.` },
      ] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
  const adapter = options.serializePayload ? withResponsesPayloadHook(provider, options.serializePayload) : provider;
  runtime.registerNativeProvider({
    ...adapter, getModels: () => [...models], getAllModels: () => [...models],
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: accessToken } }) } },
  });
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 128 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    ...options.settings,
  });
  async function start(manager: SessionManager) {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "You are a fixture assistant. Preserve the task's constraints.",
      extensionFactories: [...options.extensions],
    });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd: directory, agentDir: directory, model, modelRuntime: runtime, sessionManager: manager,
      resourceLoader: loader, settingsManager, thinkingLevel: "low", noTools: "builtin",
    });
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    return session;
  }
  let session: Awaited<ReturnType<typeof start>>;
  const fetchScope = mockFetch(fetch);
  try {
    session = await start(SessionManager.create(directory, join(directory, "sessions")));
  } catch (error) {
    fetchScope[Symbol.dispose]();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    get session() { return session; },
    model, models, runtime, requests, errors,
    async reopen() {
      const path = session.sessionManager.getSessionFile();
      assert.ok(path);
      session.dispose();
      session = await start(SessionManager.open(path));
    },
    async close() {
      try {
        session.dispose();
        await rm(directory, { recursive: true, force: true });
      } finally {
        fetchScope[Symbol.dispose]();
      }
    },
  };
}

/** Saved v1 input fixture; keep it independent of the current summary formatter. */
export function legacyCheckpointSummary(checkpointId: string): string {
  return `Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely. ` +
    "Full replay requires @oipsanthony/pi-codex-compaction and the original provider endpoint and model. " +
    "Without them, only Pi's retained recent messages remain available.";
}

export function assertTrimmedOutput(actual: JsonObject, original: JsonObject): JsonObject {
  assert.equal(typeof actual.output, "string");
  assert.ok(String(actual.output).length > 0);
  assert.notDeepEqual(actual.output, original.output);
  assert.deepEqual({ ...actual, output: original.output }, original);
  return actual;
}
