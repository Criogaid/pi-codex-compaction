// Build isolated real Pi registries for request-boundary regression tests.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import assert from "node:assert/strict";
import { InMemoryCredentialStore, InMemoryModelsStore, type AuthResult, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isObject, type JsonObject } from "../src/protocol.js";

export async function testRegistry(provider: Provider, resolve: () => Promise<AuthResult | undefined> = async () => ({ auth: { apiKey: "fixture-key" } })): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider({ ...provider, auth: { apiKey: { name: "Fixture", resolve } } });
  return new ModelRegistry(runtime);
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
  readonly headers: Headers;
  readonly url: string;
}

/** Exercise real Pi sessions and provider serialization; replace only network I/O with bounded SSE fixtures. */
export async function sessionFixture(options: {
  readonly api?: "openai-responses" | "openai-codex-responses";
  readonly extensions: readonly ExtensionFactory[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-compaction-session-"));
  const requests: SessionRequest[] = [];
  const errors: string[] = [];
  const api = options.api ?? "openai-responses";
  const provider: Provider = api === "openai-responses" ? openaiProvider() : openaiCodexProvider();
  const catalogModel = provider.getModels().find((model) => model.id === "gpt-6.1-sol");
  assert.ok(catalogModel);
  const model = { ...catalogModel, contextWindow: 32_000, maxTokens: 4_096,
    compat: { ...catalogModel.compat, supportsStore: false, remoteCompaction: { protocol: "v2" } } };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.ok(requests.length < 40, "Fixture request limit exceeded");
    const request = new Request(input, init);
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
    const payload: unknown = JSON.parse(body.toString("utf8"));
    assert.ok(isObject(payload));
    requests.push({ payload, headers: request.headers, url: request.url });
    assert.ok(Array.isArray(payload.input));
    const compacting = payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
    const item = compacting
      ? { type: "compaction", encrypted_content: `fixture-checkpoint-${requests.length}` }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed",
          content: [{ type: "output_text", text: `Fixture reply ${requests.length}.`, annotations: [] }] };
    const usage = { input_tokens: 500, output_tokens: 20, total_tokens: 520 };
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
  runtime.registerNativeProvider({
    ...provider, getModels: () => [model], getAllModels: () => [model],
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: accessToken } }) } },
    streamSimple(current, context, settings) {
      return provider.streamSimple(current, context, { ...settings, fetch });
    },
  });
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 128 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
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
  try {
    session = await start(SessionManager.create(directory, join(directory, "sessions")));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    get session() { return session; },
    model, runtime, requests, errors,
    async reopen() {
      const path = session.sessionManager.getSessionFile();
      assert.ok(path);
      session.dispose();
      session = await start(SessionManager.open(path));
    },
    async close() {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
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
