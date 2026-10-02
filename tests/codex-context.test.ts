// Keep module spies in a child process so npm test needs no experimental flags.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type BeforeProviderRequestEvent,
  type ContextEvent,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isolateAgentConfig } from "./helpers.js";

const mockFlag = "--experimental-test-module-mocks";
const childTimeoutMs = 30_000;
const maxChildOutputBytes = 1024 * 1024;
if (!process.execArgv.includes(mockFlag)) {
  test("context hooks fingerprint and capture only V2-capable requests", () => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [mockFlag, "--test", fileURLToPath(import.meta.url)], {
      encoding: "utf8", timeout: childTimeoutMs, maxBuffer: maxChildOutputBytes, env: childEnv,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  isolateAgentConfig();
  test("context hook capability gating preserves supported snapshots and clears unsupported requests", async (t) => {
    const checkpoint = await import("../src/checkpoint.js");
    const fingerprint = t.mock.fn(checkpoint.fingerprintMessage);
    t.mock.module(new URL("../src/checkpoint.js", import.meta.url).href, {
      namedExports: { ...checkpoint, fingerprintMessage: fingerprint },
    });
    const snapshots = await import("../src/request-snapshot.js");
    let latestTracker: InstanceType<typeof snapshots.RequestSnapshotTracker> | undefined;
    class ObservedTracker extends snapshots.RequestSnapshotTracker {
      constructor() { super(); latestTracker = this; }
    }
    t.mock.module(new URL("../src/request-snapshot.js", import.meta.url).href, {
      namedExports: { ...snapshots, RequestSnapshotTracker: ObservedTracker },
    });
    const { createCodexCompactionExtension } = await import("../src/index.js");
    const supported: Model<"openai-responses"> = {
      id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "custom-codex", api: "openai-responses",
      baseUrl: "https://codex-gateway.example/v1", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
      compat: { supportsLongCacheRetention: true },
    };
    type HookEvent = ContextEvent | ContextWithSystemEvent | BeforeProviderRequestEvent;
    type Hook = (event: HookEvent, ctx: ExtensionContext) => unknown;

    function fixture(currentModel: Model<Api> | undefined) {
      fingerprint.mock.resetCalls();
      const hooks = new Map<string, Hook>();
      const pi = {
        on(name: string, handler: Hook) { hooks.set(name, handler); },
        registerCommand() {}, registerEntryRenderer() {},
        getThinkingLevel: () => "low", getSettings: () => ({}), getActiveTools: () => [], getAllTools: () => [],
      } as unknown as ExtensionAPI;
      createCodexCompactionExtension()(pi);
      const tracker = latestTracker;
      assert.ok(tracker);
      const session = SessionManager.inMemory();
      session.appendMessage({ role: "system", content: "Canonical prompt", timestamp: 0 });
      session.appendMessage({ role: "user", content: "Canonical request", timestamp: 1 });
      session.appendMessage({ role: "user", content: "Follow-up request", timestamp: 2 });
      const canonical = session.buildSessionContext().messages;
      const event: ContextEvent = {
        type: "context", messages: structuredClone(canonical.filter((message) => message.role !== "system")),
      };
      const projected: ContextWithSystemEvent = {
        type: "context_with_system", messages: canonical.map((message) => message.role === "user"
          ? { ...message, content: "Projected request" } : message),
      };
      const ctx = { model: currentModel, sessionManager: session, hasUI: false, getSystemPrompt: () => "Canonical prompt" } as unknown as ExtensionContext;
      const providerEvent: BeforeProviderRequestEvent = { type: "before_provider_request", payload: {} };
      return { ctx, event, projected, providerEvent, tracker, async run(input: HookEvent) {
        const hook = hooks.get(input.type);
        assert.ok(hook, `${input.type} must be registered`);
        return hook(input, ctx);
      } };
    }

    await t.test("supported context hashes every conversation message and captures the real projection", async () => {
      const current = fixture(supported);
      assert.equal(await current.run(current.event), undefined);
      assert.deepEqual(fingerprint.mock.calls.map((call) => call.arguments[0]), current.event.messages);
      assert.equal(current.tracker.current().context, undefined, "capture waits for the system-inclusive projection");
      await current.run(current.projected);
      assert.equal(current.tracker.current().context, undefined, "publish waits for the provider request");
      await current.run(current.providerEvent);
      const snapshot = current.tracker.current().context;
      assert.ok(snapshot);
      assert.equal(snapshot.sessionId, current.ctx.sessionManager.getSessionId());
      assert.equal(snapshot.identity.modelId, supported.id);
      assert.deepEqual(snapshot.messages, current.projected.messages);
      assert.notEqual(snapshot.messages, current.projected.messages, "capture retains a copy");
      await current.run(current.providerEvent);
      assert.equal(current.tracker.current().context, snapshot, "a provider retry publishes the same snapshot");
    });

    for (const { name, model } of [
      { name: "non-GPT model without V2 metadata", model: { ...supported, id: "other-model", compat: undefined } },
      { name: "GPT model with invalid V2 metadata", model: { ...supported, compat: { ...supported.compat, ...{ remoteCompaction: false } } } },
      { name: "missing model", model: undefined },
    ] satisfies readonly { readonly name: string; readonly model: Model<Api> | undefined }[]) {
      await t.test(`${name} skips fingerprints and cannot create a context snapshot`, async () => {
        const current = fixture(model);
        assert.equal(await current.run(current.event), undefined);
        assert.equal(fingerprint.mock.callCount(), 0);
        await current.run(current.projected);
        await current.run(current.providerEvent);
        assert.equal(current.tracker.current().context, undefined);
        current.ctx.model = supported;
        await current.run(current.projected);
        await current.run(current.providerEvent);
        assert.equal(current.tracker.current().context, undefined, "unsupported context cannot leave a source for a later capable model");
        assert.equal(fingerprint.mock.callCount(), 0);
      });
    }

    await t.test("an unsupported context clears a pending source from the previous supported request", async () => {
      const current = fixture(supported);
      await current.run(current.event);
      assert.ok(fingerprint.mock.callCount() > 0);
      fingerprint.mock.resetCalls();
      current.ctx.model = { ...supported, id: "other-model", compat: undefined };
      await current.run(structuredClone(current.event));
      assert.equal(fingerprint.mock.callCount(), 0);
      current.ctx.model = supported;
      await current.run(current.projected);
      await current.run(current.providerEvent);
      assert.equal(current.tracker.current().context, undefined);
    });

    await t.test("recordContext without a target skips fingerprints and clears both pending stages", () => {
      const tracker = new snapshots.RequestSnapshotTracker();
      const canonical = [{ role: "user" as const, content: "source", timestamp: 1 }];
      fingerprint.mock.resetCalls();
      tracker.recordContext("session", undefined, canonical);
      assert.equal(fingerprint.mock.callCount(), 0);
      const target = { model: supported, identity: { provider: supported.provider, api: supported.api,
        modelId: supported.id, baseUrl: supported.baseUrl, endpoint: `${supported.baseUrl}/responses` } };
      tracker.recordContext("session", target, canonical);
      tracker.recordProjectedRequest("session", target, () => canonical, () => undefined, canonical);
      fingerprint.mock.resetCalls();
      tracker.recordContext("session", undefined, structuredClone(canonical));
      assert.equal(fingerprint.mock.callCount(), 0);
      tracker.recordProviderRequest("session", undefined, () => assert.fail("canonical must stay lazy"),
        () => assert.fail("prompt must stay lazy"), () => assert.fail("payload must stay lazy"));
      assert.equal(tracker.current().context, undefined, "unsupported context clears a pending projected snapshot");
      assert.equal(tracker.current().promptOverride, undefined);
      tracker.recordProjectedRequest("session", target, () => assert.fail("unsupported context clears its pending source"),
        () => assert.fail("checkpoint must stay lazy"), canonical);
      assert.equal(fingerprint.mock.callCount(), 0);
    });
  });
}
