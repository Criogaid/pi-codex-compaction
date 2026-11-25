import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import codexCompaction from "../src/index.js";
import { isObject } from "../src/protocol.js";
import { isCompactionRequest, isolateAgentConfig, sessionFixture, sseResponse, textEvents } from "./helpers.js";

isolateAgentConfig();

const TURN_STATE_HEADER = "x-codex-turn-state";

function toolCallEvents(requestNumber: number, callId: string): Record<string, unknown>[] {
  const item = {
    type: "function_call",
    id: `fc_${requestNumber}`,
    call_id: callId,
    name: "ping",
    arguments: "{}",
  };
  return [
    { type: "response.created", response: { id: `resp_${requestNumber}` } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${requestNumber}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 },
      },
    },
  ];
}

function pingToolExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "ping",
      label: "ping",
      description: "Fixture tool that triggers multi-step turns",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
    });
    pi.on("session_start", () => {
      pi.setActiveTools(["ping"]);
    });
  };
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  const transport = api === "openai-responses" ? "auto" : "sse";
  test(`real ${api} (${transport}) session latches x-codex-turn-state within a turn and clears it across user turns`, { timeout: 20_000 }, async () => {
    let call = 0;
    const fixture = await sessionFixture({
      api,
      settings: { transport },
      extensions: [pingToolExtension(), codexCompaction],
      respond: () => {
        call++;
        if (call === 1) return sseResponse(toolCallEvents(call, "call_1"), { "X-Codex-Turn-State": "turn-1-state" });
        if (call === 2) return sseResponse(toolCallEvents(call, "call_2"), { "x-codex-turn-state": "turn-1-ignored-overwrite" });
        if (call === 3) return sseResponse(textEvents(call, "Turn 1 complete."));
        if (call === 4) return sseResponse(toolCallEvents(call, "call_3"), { "x-codex-turn-state": "turn-2-state" });
        return sseResponse(textEvents(call, "Turn 2 complete."));
      },
    });
    try {
      await fixture.session.prompt("Run two tool steps.");
      await fixture.session.prompt("Start a fresh user turn.");

      assert.equal(fixture.requests.length, 5);
      // Turn 1: request 1 has no token; requests 2 and 3 replay the first latched token unchanged.
      assert.equal(fixture.requests[0].headers.get(TURN_STATE_HEADER), null);
      assert.equal(fixture.requests[1].headers.get(TURN_STATE_HEADER), "turn-1-state");
      assert.equal(fixture.requests[2].headers.get(TURN_STATE_HEADER), "turn-1-state");
      // Turn 2: fresh turn must not replay turn 1's token; step 2 replays turn 2's own token.
      assert.equal(fixture.requests[3].headers.get(TURN_STATE_HEADER), null);
      assert.equal(fixture.requests[4].headers.get(TURN_STATE_HEADER), "turn-2-state");
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}

test("in-turn auto-compaction replays the active turn's x-codex-turn-state", { timeout: 20_000 }, async () => {
  let ordinaryCalls = 0;
  const fixture = await sessionFixture({
    api: "openai-responses",
    extensions: [codexCompaction],
    settings: {
      compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 128 },
    },
    respond: (request) => {
      if (isCompactionRequest(request)) return undefined;
      ordinaryCalls++;
      // Return high input tokens only on turn 2 to trigger threshold auto-compaction before agent_settled.
      const tokens = ordinaryCalls === 2 ? 31_500 : 500;
      const header = `turn-${ordinaryCalls}-state`;
      return sseResponse(textEvents(ordinaryCalls, `Reply ${ordinaryCalls}. ${"word ".repeat(80)}`, tokens), {
        "x-codex-turn-state": header,
      });
    },
  });
  try {
    await fixture.session.prompt(`Turn 1: ${"Preserve constraints. ".repeat(60)}`);
    await fixture.session.prompt(`Turn 2: ${"Trigger threshold compaction. ".repeat(60)}`);

    const compactIndex = fixture.requests.findIndex(isCompactionRequest);
    assert.equal(compactIndex, 2, "Expected threshold auto-compaction immediately after turn 2");
    assert.equal(fixture.requests[0].headers.get(TURN_STATE_HEADER), null);
    assert.equal(fixture.requests[1].headers.get(TURN_STATE_HEADER), null);
    assert.equal(fixture.requests[compactIndex].headers.get(TURN_STATE_HEADER), "turn-2-state");
    assert.match(fixture.requests[compactIndex].headers.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);

    // Next user turn after auto-compaction settled must start fresh.
    await fixture.session.prompt("Turn 3 after auto-compaction.");
    assert.equal(fixture.requests.length, 4);
    assert.equal(fixture.requests[3].headers.get(TURN_STATE_HEADER), null);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

for (const { status, source } of [
  { status: 503, source: "response headers" },
  { status: 200, source: "response headers" },
  { status: 200, source: "SSE metadata" },
] as const) {
  test(`manual V2 retry after HTTP ${status} with turn state in ${source}`, { timeout: 20_000 }, async () => {
    const token = "manual-compact-retry-state";
    let compactAttempt = 0;
    const fixture = await sessionFixture({
      extensions: [codexCompaction],
      settings: { retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 1_000 } } },
      respond: (request) => {
        if (!isCompactionRequest(request)) {
          return sseResponse(textEvents(fixture.requests.length, `Reply. ${"word ".repeat(60)}`), {
            [TURN_STATE_HEADER]: "settled-turn-state",
          });
        }
        if (++compactAttempt !== 1) return undefined;
        const headers = { [TURN_STATE_HEADER]: token };
        if (status === 200) {
          const metadata = source === "SSE metadata" ? [{ type: "response.metadata", headers }] : [];
          return sseResponse([
            { type: "response.created", response: { id: "resp_failed" } },
            ...metadata,
            { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "try again" } } },
          ], source === "response headers" ? headers : undefined);
        }
        return Response.json({ error: { code: "server_is_overloaded", message: "try again" } }, {
          status,
          headers: { ...headers, "retry-after": "0" },
        });
      },
    });
    try {
      await fixture.session.prompt(`Turn 1: ${"Preserve constraints. ".repeat(60)}`);
      await fixture.session.prompt(`Turn 2: ${"More details. ".repeat(60)}`);
      await fixture.session.compact();
      await fixture.session.prompt("Turn 3 after manual compaction.");

      assert.deepEqual(fixture.errors, []);
      assert.deepEqual(fixture.requests.map(isCompactionRequest), [false, false, true, true, false]);
      assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [
        null, null, null, status === 200 && source === "response headers" ? token : null, null,
      ]);
    } finally {
      await fixture.close();
    }
  });
}

test("honors explicit header overrides and deletion without changing the latched response header", { timeout: 20_000 }, async () => {
  let step = 0;
  const overrideExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_headers", (event) => {
      if (step === 1) event.headers["X-Codex-Turn-State"] = "explicit-caller-state";
      if (step === 2) event.headers["X-Codex-Turn-State"] = null;
    });
  };
  const fixture = await sessionFixture({
    extensions: [pingToolExtension(), overrideExtension, codexCompaction],
    respond: () => {
      step++;
      if (step === 1) return sseResponse(toolCallEvents(step, "call_override_1"), { [TURN_STATE_HEADER]: "response-state" });
      if (step <= 3) return sseResponse(toolCallEvents(step, `call_override_${step}`));
      return sseResponse(textEvents(step, "Done."));
    },
  });
  try {
    await fixture.session.prompt("Run the header override steps.");
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [
      null, "explicit-caller-state", null, "response-state",
    ]);
  } finally {
    await fixture.close();
  }
});

test("SSE metadata with a non-ByteString token does not block a tool continuation", { timeout: 20_000 }, async () => {
  let step = 0;
  const fixture = await sessionFixture({
    api: "openai-codex-responses",
    extensions: [pingToolExtension(), codexCompaction],
    respond: () => {
      if (++step === 1) {
        return sseResponse([
          { type: "response.metadata", headers: { [TURN_STATE_HEADER]: "路由" } },
          ...toolCallEvents(step, "call_unicode"),
        ]);
      }
      return sseResponse(textEvents(step, "Done."));
    },
  });
  try {
    await fixture.session.prompt("Run a tool after receiving SSE metadata.");
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [null, null]);
  } finally {
    await fixture.close();
  }
});

test("a cache warming response during a tool call cannot seed turn state", { timeout: 20_000 }, async () => {
  const warmed = Promise.withResolvers<void>();
  let foregroundCalls = 0;
  // Pi's OpenAI Responses adapter clamps the warmer's one-token limit to 16.
  const warmOutputLimit = 16;
  const waitForWarm: ExtensionFactory = (pi) => {
    pi.on("tool_result", async () => {
      // Keep the first tool step open until Pi consumes and records the warm response.
      const deadline = setTimeout(() => warmed.reject(new Error("Pi did not record cache_warm usage")), 8_000);
      try {
        await warmed.promise;
      } finally {
        clearTimeout(deadline);
      }
    });
  };
  const fixture = await sessionFixture({
    extensions: [pingToolExtension(), waitForWarm, codexCompaction],
    models: (base) => [{
      ...base,
      // Use an API endpoint where Pi serializes the warmer's output cap with fixture credentials.
      baseUrl: "https://fixture.example/v1",
      promptCache: { short: 11, long: 11 },
      // The fixture's 500 input tokens must clear Pi's five-cent savings threshold.
      cost: { input: 200, output: 10, cacheRead: 1, cacheWrite: 0 },
    }],
    settings: { cacheWarming: "streaming" },
    respond: ({ payload }) => {
      const requestNumber = fixture.requests.length;
      if (payload.max_output_tokens === warmOutputLimit) {
        return sseResponse(textEvents(requestNumber, "Warm."), { [TURN_STATE_HEADER]: "warm-state" });
      }
      switch (++foregroundCalls) {
        case 1: return sseResponse(toolCallEvents(requestNumber, "call_before_warm"));
        case 2: return sseResponse(toolCallEvents(requestNumber, "call_after_warm"), { [TURN_STATE_HEADER]: "chat-state" });
        default: return sseResponse(textEvents(requestNumber, "Done."));
      }
    },
  });
  const unsubscribe = fixture.session.subscribe((event) => {
    if (event.type === "entry_appended" && event.entry.type === "usage" && event.entry.kind === "cache_warm") warmed.resolve();
  });
  try {
    await fixture.session.prompt("Run two tool steps while Pi warms the cache.");
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ payload }) => payload.max_output_tokens === warmOutputLimit), [
      false, true, false, false,
    ]);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [
      null, null, null, "chat-state",
    ]);
  } finally {
    unsubscribe();
    await fixture.close();
  }
});

test("an awaited model switch clears the latched token and lets the new model latch its own", { timeout: 20_000 }, async () => {
  let step = 0;
  const switchAfterTool: ExtensionFactory = (pi) => {
    pi.on("tool_result", async () => {
      if (step === 3) await fixture.session.setModel(fixture.models[1]);
    });
  };
  const fixture = await sessionFixture({
    extensions: [pingToolExtension(), switchAfterTool, codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-6.2-sol" }],
    respond: () => {
      step++;
      if (step === 1) return sseResponse(toolCallEvents(step, "call_1"), { [TURN_STATE_HEADER]: "   " });
      if (step === 2) return sseResponse(toolCallEvents(step, "call_2"), { [TURN_STATE_HEADER]: "model-a-state" });
      if (step === 3) return sseResponse(toolCallEvents(step, "call_3"));
      if (step === 4) return sseResponse(toolCallEvents(step, "call_4"), { [TURN_STATE_HEADER]: "model-b-state" });
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  try {
    await fixture.session.prompt("Run tools across model switch.");
    const [a, b] = fixture.models;
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ payload }) => payload.model), [a.id, a.id, a.id, b.id, b.id]);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [
      null, null, "model-a-state", null, "model-b-state",
    ]);
  } finally {
    await fixture.close();
  }
});

test("an in-flight response from the previous model cannot seed the new model's turn state", { timeout: 20_000 }, async () => {
  let step = 0;
  const fixture = await sessionFixture({
    api: "openai-responses",
    extensions: [pingToolExtension(), codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-6.2-sol" }],
    respond: async () => {
      step++;
      if (step === 1) {
        await fixture.session.setModel(fixture.models[1]);
        return sseResponse(toolCallEvents(step, "call_a"), { [TURN_STATE_HEADER]: "model-a-state" });
      }
      if (step === 2) {
        return sseResponse(toolCallEvents(step, "call_b"), { [TURN_STATE_HEADER]: "model-b-state" });
      }
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  try {
    await fixture.session.prompt("Run tools while the selected model changes.");
    const [, nextRequest, finalRequest] = fixture.requests;
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ payload }) => payload.model), [
      fixture.model.id, fixture.models[1].id, fixture.models[1].id,
    ]);
    assert.equal(nextRequest.headers.get(TURN_STATE_HEADER), null);
    assert.equal(finalRequest.headers.get(TURN_STATE_HEADER), "model-b-state");
  } finally {
    await fixture.close();
  }
});

test("threshold compaction before the next prompt has no settled turn token", { timeout: 20_000 }, async () => {
  let ordinaryCalls = 0;
  const fixture = await sessionFixture({
    extensions: [codexCompaction],
    respond(request) {
      if (isCompactionRequest(request)) return undefined;
      ordinaryCalls++;
      return sseResponse(textEvents(ordinaryCalls, `Reply. ${"word ".repeat(80)}`, ordinaryCalls === 2 ? 31_500 : 500), {
        [TURN_STATE_HEADER]: "settled-turn-state",
      });
    },
  });
  try {
    await fixture.session.prompt(`Turn 1: ${"Preserve constraints. ".repeat(60)}`);
    await fixture.session.prompt(`Turn 2: ${"Build up context. ".repeat(60)}`);
    assert.deepEqual(fixture.requests.map(isCompactionRequest), [false, false]);
    // Enabling compaction after settlement leaves the last assistant's usage for Pi's preflight check.
    fixture.session.settingsManager.setCompactionEnabled(true);
    await fixture.session.prompt("Run the next turn.");
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(isCompactionRequest), [false, false, true, false]);
    assert.equal(fixture.requests[2].headers.get(TURN_STATE_HEADER), null);
  } finally {
    await fixture.close();
  }
});

for (const activeToken of [undefined, "overflow-turn-state"]) {
  test(activeToken
    ? "overflow compaction and its continuation replay the active turn token"
    : "a failed chat response does not seed turn state for overflow recovery", { timeout: 20_000 }, async () => {
    let ordinaryCalls = 0;
    const reasons: string[] = [];
    const fixture = await sessionFixture({
      api: "openai-codex-responses",
      extensions: [pingToolExtension(), codexCompaction],
      settings: { compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 128 } },
      respond(request) {
        if (isCompactionRequest(request)) return undefined;
        ordinaryCalls++;
        if (activeToken && ordinaryCalls === 3) {
          return sseResponse(toolCallEvents(ordinaryCalls, "call_overflow"), { [TURN_STATE_HEADER]: activeToken });
        }
        if (ordinaryCalls === (activeToken ? 4 : 3)) {
          return Response.json({ error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model" } }, {
            status: 400, headers: { [TURN_STATE_HEADER]: "failed-chat-state" },
          });
        }
        return sseResponse(textEvents(ordinaryCalls, `Reply. ${"word ".repeat(80)}`));
      },
    });
    try {
      fixture.session.subscribe((event) => {
        if (event.type === "compaction_start") reasons.push(event.reason);
      });
      await fixture.session.prompt(`Turn 1: ${"Preserve constraints. ".repeat(60)}`);
      await fixture.session.prompt(`Turn 2: ${"Build up context. ".repeat(60)}`);
      await fixture.session.prompt(`Turn 3: ${"Trigger overflow. ".repeat(60)}`);
      assert.deepEqual(fixture.errors, []);
      assert.deepEqual(reasons, ["overflow"]);
      assert.deepEqual(fixture.requests.map(isCompactionRequest), [
        false, false, false, ...(activeToken ? [false] : []), true, false,
      ]);
      assert.deepEqual(fixture.requests.slice(-3).map(({ headers }) => headers.get(TURN_STATE_HEADER)),
        Array(3).fill(activeToken ?? null));
    } finally {
      await fixture.close();
    }
  });
}

test("SSE metadata cannot seed turn state on either side of a model switch", { timeout: 20_000 }, async () => {
  let step = 0;
  const switchBeforeMetadata: ExtensionFactory = (pi) => {
    pi.on("provider_stream_event", async (event) => {
      if (step === 1 && isObject(event.data) && event.data.type === "response.metadata") {
        await fixture.session.setModel(fixture.models[1]);
      }
    });
  };
  const fixture = await sessionFixture({
    extensions: [pingToolExtension(), switchBeforeMetadata, codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-6.2-sol" }],
    respond() {
      step++;
      if (step <= 2) {
        const token = step === 1 ? "model-a-stream-state" : "model-b-stream-state";
        return sseResponse([
          { type: "response.metadata", headers: { [TURN_STATE_HEADER]: token } },
          ...toolCallEvents(step, `call_stream_${step}`),
        ]);
      }
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  try {
    await fixture.session.prompt("Run tools across a model switch while the response is streaming.");
    const [a, b] = fixture.models;
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ payload }) => payload.model), [a.id, b.id, b.id]);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [null, null, null]);
  } finally {
    await fixture.close();
  }
});

test("switching Pi sessions starts with an empty turn-state slot", { timeout: 20_000 }, async () => {
  let step = 0;
  const fixture = await sessionFixture({
    api: "openai-codex-responses",
    extensions: [pingToolExtension(), codexCompaction],
    respond() {
      step++;
      if (step === 1 || step === 3) {
        return sseResponse(toolCallEvents(step, `call_session_${step}`), { [TURN_STATE_HEADER]: `session-state-${step}` });
      }
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  try {
    const oldId = fixture.session.sessionManager.getSessionId();
    await fixture.session.prompt("Use a tool in the original session.");
    assert.deepEqual(await fixture.sessionRuntime.newSession(), { cancelled: false });
    const newId = fixture.session.sessionManager.getSessionId();
    assert.notEqual(newId, oldId);
    await fixture.session.prompt("Use a tool in the new session.");

    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get("session-id")), [oldId, oldId, newId, newId]);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [
      null, "session-state-1", null, "session-state-3",
    ]);
  } finally {
    await fixture.close();
  }
});

test("Codex auto transport omits the turn-state header even when WebSocket falls back to SSE", { timeout: 20_000 }, async () => {
  let socketAttempts = 0;
  let step = 0;
  const fixture = await sessionFixture({
    api: "openai-codex-responses",
    settings: { transport: undefined },
    extensions: [pingToolExtension(), codexCompaction],
    respond() {
      step++;
      if (step === 1) return sseResponse(toolCallEvents(step, "call_auto"), { [TURN_STATE_HEADER]: "auto-turn-state" });
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  const originalSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    constructor() {
      socketAttempts++;
      throw new Error("Fixture WebSocket transport unavailable");
    }
  } });
  try {
    assert.equal(fixture.session.settingsManager.getTransport(), "auto");
    await fixture.session.prompt("Use a tool with the default transport.");
    assert.deepEqual(fixture.errors, []);
    assert.equal(socketAttempts, 1);
    assert.deepEqual(fixture.requests.map(({ headers }) => headers.get(TURN_STATE_HEADER)), [null, null]);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalSocket });
    await fixture.close();
  }
});
