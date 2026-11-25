import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import codexCompaction from "../src/index.js";
import { isObject } from "../src/protocol.js";
import { TURN_STATE_HEADER } from "../src/turn-state.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

function sseResponse(events: readonly Record<string, unknown>[], headers?: Record<string, string>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

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

function textEvents(requestNumber: number, text: string, inputTokens = 500, extra: readonly Record<string, unknown>[] = []): Record<string, unknown>[] {
  const item = {
    type: "message",
    id: `msg_${requestNumber}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: `resp_${requestNumber}` } },
    ...extra,
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${requestNumber}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 },
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
  test(`real ${api} session latches x-codex-turn-state within a turn and clears it across user turns`, { timeout: 20_000 }, async () => {
    let call = 0;
    const fixture = await sessionFixture({
      api,
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
    respond: ({ payload }) => {
      const compacting = Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
      if (compacting) return undefined;
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

    const compactIndex = fixture.requests.findIndex(({ payload }) =>
      Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
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

test("standalone manual compaction does not reuse the previous turn's token, replays across its own retries, and does not leak to the next turn", { timeout: 20_000 }, async () => {
  let compactAttempt = 0;
  const fixture = await sessionFixture({
    api: "openai-responses",
    extensions: [codexCompaction],
    settings: {
      retry: { enabled: false, provider: { maxRetries: 2, maxRetryDelayMs: 1_000 } },
    },
    respond: ({ payload }) => {
      const compacting = Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
      if (!compacting) {
        return sseResponse(textEvents(fixture.requests.length, `Reply. ${"word ".repeat(60)}`), {
          "x-codex-turn-state": "settled-turn-state",
        });
      }
      compactAttempt++;
      if (compactAttempt === 1) {
        return new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: "try again" } }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
            "x-codex-turn-state": "manual-compact-retry-state",
          },
        });
      }
      return undefined;
    },
  });
  try {
    await fixture.session.prompt(`Turn 1: ${"Preserve constraints. ".repeat(60)}`);
    await fixture.session.prompt(`Turn 2: ${"More details. ".repeat(60)}`);
    await fixture.session.compact();
    await fixture.session.prompt("Turn 3 after manual compaction.");

    const compactRequests = fixture.requests.filter(({ payload }) =>
      Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
    assert.equal(compactRequests.length, 2);
    assert.equal(compactRequests[0].headers.get(TURN_STATE_HEADER), null);
    assert.equal(compactRequests[1].headers.get(TURN_STATE_HEADER), "manual-compact-retry-state");
    assert.equal(fixture.requests.at(-1)?.headers.get(TURN_STATE_HEADER), null);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("captures x-codex-turn-state from response.metadata stream events and respects explicit header overrides", { timeout: 20_000 }, async () => {
  let step = 0;
  const overrideExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_headers", (event) => {
      if (step === 2) event.headers["X-Codex-Turn-State"] = "explicit-caller-state";
    });
  };
  const fixture = await sessionFixture({
    api: "openai-responses",
    extensions: [pingToolExtension(), overrideExtension, codexCompaction],
    respond: () => {
      step++;
      if (step === 1) {
        // No HTTP x-codex-turn-state header; deliver via response.metadata event instead.
        return sseResponse([
          { type: "response.metadata", headers: { "X-Codex-Turn-State": "stream-meta-state" } },
          ...toolCallEvents(step, "call_meta_1"),
        ]);
      }
      if (step === 2) {
        return sseResponse(toolCallEvents(step, "call_meta_2"));
      }
      return sseResponse(textEvents(step, "Done."));
    },
  });
  try {
    await fixture.session.prompt("Use tool twice.");
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.requests[0].headers.get(TURN_STATE_HEADER), null);
    assert.equal(fixture.requests[1].headers.get(TURN_STATE_HEADER), "stream-meta-state");
    // Earlier before_provider_headers handler explicitly set X-Codex-Turn-State on step 3 (after step=2).
    assert.equal(fixture.requests[2].headers.get(TURN_STATE_HEADER), "explicit-caller-state");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("model switch clears latched x-codex-turn-state and ignores invalid header values", { timeout: 20_000 }, async () => {
  let step = 0;
  const fixture = await sessionFixture({
    api: "openai-responses",
    extensions: [pingToolExtension(), codexCompaction],
    models: (base) => [base, { ...base, id: "gpt-6.2-sol" }],
    respond: () => {
      step++;
      if (step === 1) {
        // Whitespace-only header must be ignored so the next valid header can latch.
        return sseResponse(toolCallEvents(step, "call_1"), { "x-codex-turn-state": "   " });
      }
      if (step === 2) {
        return sseResponse(toolCallEvents(step, "call_2"), { "x-codex-turn-state": "model-a-state" });
      }
      return sseResponse(textEvents(step, "Finished."));
    },
  });
  try {
    let switched = false;
    const alt = fixture.models[1];
    assert.ok(alt);
    fixture.session.subscribe((event) => {
      if (!switched && event.type === "tool_execution_end" && step === 2) {
        switched = true;
        void fixture.session.setModel(alt);
      }
    });
    await fixture.session.prompt("Run tools across model switch.");
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.requests[0].headers.get(TURN_STATE_HEADER), null);
    assert.equal(fixture.requests[1].headers.get(TURN_STATE_HEADER), null);
    // Switched to model B before step 3, so model A's token must not be replayed.
    assert.equal(fixture.requests[2].headers.get(TURN_STATE_HEADER), null);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});
