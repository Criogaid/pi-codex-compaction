// Keep module spies in a child process so npm test needs no experimental flags.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ContextEvent,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isolateAgentConfig } from "./test-registry.test.js";

const mockFlag = "--experimental-test-module-mocks";
const childTimeoutMs = 30_000;
const maxChildOutputBytes = 1024 * 1024;
if (!process.execArgv.includes(mockFlag)) {
  test("context hooks fingerprint and capture only V2-capable requests", () => {
    const child = spawnSync(process.execPath, [mockFlag, "--test", fileURLToPath(import.meta.url)], {
      encoding: "utf8", timeout: childTimeoutMs, maxBuffer: maxChildOutputBytes,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  isolateAgentConfig();
  test("context hook capability gating preserves supported snapshots and clears unsupported requests", async (t) => {
    const checkpoint = await import("./checkpoint.js");
    const snapshots = await import("./request-snapshot.js");
    const fingerprint = t.mock.fn(checkpoint.fingerprintMessage);
    const capture = t.mock.fn(snapshots.captureContextSnapshot);
    t.mock.module(new URL("./checkpoint.js", import.meta.url).href, {
      namedExports: { ...checkpoint, fingerprintMessage: fingerprint },
    });
    t.mock.module(new URL("./request-snapshot.js", import.meta.url).href, {
      namedExports: { ...snapshots, captureContextSnapshot: capture },
    });
    const { createCodexCompactionExtension } = await import("./codex-compaction.js");
    const supported: Model<"openai-responses"> = {
      id: "summary", name: "Summary", provider: "custom-codex", api: "openai-responses",
      baseUrl: "https://codex-gateway.example/v1", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
      compat: { supportsLongCacheRetention: true, ...{ remoteCompaction: { protocol: "v2" } } },
    };
    type Hook = (event: ContextEvent | ContextWithSystemEvent, ctx: ExtensionContext) => unknown;

    function fixture(currentModel: Model<Api> | undefined) {
      fingerprint.mock.resetCalls();
      capture.mock.resetCalls();
      const hooks = new Map<string, Hook>();
      const pi = {
        on(name: string, handler: Hook) { hooks.set(name, handler); },
        registerCommand() {}, registerEntryRenderer() {},
      } as unknown as ExtensionAPI;
      createCodexCompactionExtension()(pi);
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
      const ctx = { model: currentModel, sessionManager: session, hasUI: false } as unknown as ExtensionContext;
      return { ctx, event, projected, async run(input: ContextEvent | ContextWithSystemEvent) {
        const hook = hooks.get(input.type);
        assert.ok(hook, `${input.type} must be registered`);
        return hook(input, ctx);
      } };
    }

    await t.test("supported context hashes every conversation message and captures the real projection", async () => {
      const current = fixture(supported);
      assert.equal(await current.run(current.event), undefined);
      assert.deepEqual(fingerprint.mock.calls.map((call) => call.arguments[0]), current.event.messages);
      assert.equal(capture.mock.callCount(), 0, "capture waits for the system-inclusive projection");
      await current.run(current.projected);
      assert.equal(capture.mock.callCount(), 1);
      const snapshot = capture.mock.calls[0].result;
      assert.ok(snapshot);
      assert.equal(snapshot.sessionId, current.ctx.sessionManager.getSessionId());
      assert.equal(snapshot.identity.modelId, supported.id);
      assert.deepEqual(snapshot.messages, current.projected.messages);
      assert.notEqual(snapshot.messages, current.projected.messages, "capture retains a copy");
      await current.run(current.projected);
      assert.equal(capture.mock.callCount(), 1, "the pending source is consumed once");
    });

    for (const { name, model } of [
      { name: "Responses model without V2 metadata", model: { ...supported, compat: undefined } },
      { name: "non-Responses model even with V2 metadata", model: { ...supported, api: "anthropic-messages" } },
      { name: "missing model", model: undefined },
    ] satisfies readonly { readonly name: string; readonly model: Model<Api> | undefined }[]) {
      await t.test(`${name} skips fingerprints and cannot create a context snapshot`, async () => {
        const current = fixture(model);
        assert.equal(await current.run(current.event), undefined);
        assert.equal(fingerprint.mock.callCount(), 0);
        await current.run(current.projected);
        assert.equal(capture.mock.callCount(), 0);
        current.ctx.model = supported;
        await current.run(current.projected);
        assert.equal(capture.mock.callCount(), 0, "unsupported context cannot leave a source for a later capable model");
        assert.equal(fingerprint.mock.callCount(), 0);
      });
    }

    await t.test("an unsupported context clears a pending source from the previous supported request", async () => {
      const current = fixture(supported);
      await current.run(current.event);
      assert.ok(fingerprint.mock.callCount() > 0);
      fingerprint.mock.resetCalls();
      current.ctx.model = { ...supported, compat: undefined };
      await current.run(structuredClone(current.event));
      assert.equal(fingerprint.mock.callCount(), 0);
      current.ctx.model = supported;
      await current.run(current.projected);
      assert.equal(capture.mock.callCount(), 0);
    });
  });
}
