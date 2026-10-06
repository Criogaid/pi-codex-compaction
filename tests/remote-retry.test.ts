import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Api, AuthResult, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { requestRemoteCompaction, type RemoteCompactionRequest } from "../src/remote.js";
import { capableModel } from "../src/capability.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { testRegistry } from "./helpers.js";

type ResponsesApi = "openai-responses" | "openai-codex-responses";
const token = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-retry-account" },
})).toString("base64url")}.signature`;
const streamHeaders = { "content-type": "text/event-stream" };
const created = { type: "response.created", response: { id: "resp-retry" } };
const partialItem = { type: "compaction", encrypted_content: "discard-this-partial-attempt" };
const partialDone = { type: "response.output_item.done", output_index: 0, item: partialItem };

function frames(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sse(events: readonly unknown[]): Response {
  return new Response(frames(events), { headers: streamHeaders });
}

function success(): Response {
  const item = { type: "compaction", encrypted_content: "fresh-successful-checkpoint" };
  return sse([created, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-success", status: "completed", output: [item],
      usage: { input_tokens: 23, output_tokens: 7, total_tokens: 30 } } }]);
}

function failed(code: string, message = "Fixture provider error"): Response {
  return sse([created, { type: "response.failed", response: { status: "failed", error: { code, message } } }]);
}

function errorEvent(code: string, named: boolean): Response {
  const payload = named
    ? { type: "error", code, message: "Fixture provider error" }
    : { type: "error", error: { code, message: "Fixture provider error" } };
  return new Response(frames([created]) + `${named ? "event: error\n" : ""}data: ${JSON.stringify(payload)}\n\n`,
    { headers: streamHeaders });
}

function httpError(status: number, retryAfterMs = "1", code = "server_error"): Response {
  return new Response(JSON.stringify({ error: { code, message: "Fixture HTTP failure" } }), {
    status, headers: { "content-type": "application/json", "retry-after-ms": retryAfterMs },
  });
}

async function fixture(api: ResponsesApi, resolve?: () => Promise<AuthResult | undefined>, asRequest = false,
  prepareModel?: (model: Model<Api>, attempt: number) => Model<Api>) {
  const provider: Provider = api === "openai-responses" ? openaiProvider() : openaiCodexProvider();
  const catalog = provider.getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
  assert.ok(catalog);
  const options: Array<SimpleStreamOptions | undefined> = [];
  const observed: Provider = { ...provider, streamSimple(model, context, settings) {
    options.push(settings);
    const fetch = settings?.fetch;
    return provider.streamSimple(prepareModel?.(model, options.length) ?? model, context, asRequest && fetch
      ? { ...settings, fetch: (input, init) => fetch(new Request(input, init)) } : settings);
  } };
  const registry = await testRegistry(observed, resolve ?? (async () => ({ auth: { apiKey: token } })));
  const model = { ...catalog, baseUrl: "https://retry.example/backend-api", contextWindow: 100_000, maxTokens: 10_000 };
  const context: Context = { messages: [{ role: "user", content: "Preserve the original constraint.", timestamp: 1 }] };
  const payloads: JsonObject[] = [];
  const urls: string[] = [];
  let prepared = 0;
  const request: RemoteCompactionRequest = {
    modelRegistry: registry, model, context, reasoning: "low", sessionId: "retry-session",
    signal: new AbortController().signal, maxRetryDelayMs: 1,
    onPrepared: () => { prepared += 1; },
  };
  function fetchReplies(reply: (attempt: number) => Response | Promise<Response>): typeof globalThis.fetch {
    return async (input, init) => {
      assert.ok(payloads.length < 8, "Fixture request limit exceeded");
      const outgoing = new Request(input, init);
      assert.equal(outgoing.redirect, "error", "redirects must not bypass backend identity validation");
      const bytes = Buffer.from(await outgoing.arrayBuffer());
      const body = outgoing.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
      const payload: unknown = JSON.parse(body.toString("utf8"));
      assert.ok(isObject(payload));
      payloads.push(payload);
      urls.push(outgoing.url);
      return reply(payloads.length);
    };
  }
  function assertAttempts(expected: number) {
    assert.equal(payloads.length, expected);
    assert.equal(prepared, expected, "session validation runs before every attempt");
    assert.equal(options.length, expected);
    for (const option of options) {
      assert.equal(option?.maxRetries, 0, "Pi must not multiply the outer retry budget");
      assert.equal(option?.transport, "sse");
    }
    for (const payload of payloads.slice(1)) assert.deepEqual(payload, payloads[0]);
    for (const url of urls.slice(1)) assert.equal(url, urls[0]);
  }
  return { request, context, payloads, urls, options, fetchReplies, assertAttempts };
}

function withMetadata(model: Model<Api>, contextWindow: number, hash?: string): Model<Api> {
  const compat = { ...model.compat, supportsStore: false,
    remoteCompaction: { protocol: "v2", ...(hash ? { compactionModelHash: hash } : {}) },
  };
  return { ...model, contextWindow, compat };
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api}: returns actual producer metadata and trims to its physical window`, async () => {
    const f = await fixture(api, undefined, false, (model) => withMetadata(model, 512, "actual-family"));
    const output = "x".repeat(16_000);
    f.context.messages.push({
      role: "assistant", api, provider: f.request.model.provider, model: f.request.model.id,
      content: [{ type: "toolCall", id: "call_metadata|fc_metadata", name: "read", arguments: { path: "large.txt" } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 2,
    }, {
      role: "toolResult", toolCallId: "call_metadata|fc_metadata", toolName: "read",
      content: [{ type: "text", text: output }], isError: false, timestamp: 3,
    });
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(success) });
    assert.deepEqual(result.modelMetadata, { modelContextWindow: 512, compactionModelHash: "actual-family" });
    const retainedOutput = result.promptInput.find((item) => item.type === "function_call_output");
    assert.ok(retainedOutput);
    assert.equal(typeof retainedOutput.output, "string");
    assert.notEqual(retainedOutput.output, output);
    assert.ok(String(retainedOutput.output).length < output.length);
    assert.doesNotMatch(JSON.stringify(f.payloads[0]), /x{16000}/);
    f.assertAttempts(1);
  });

  test(`${api}: rejects a configured versus actual producer hash mismatch before fetch`, async () => {
    const f = await fixture(api, undefined, false, (model) => withMetadata(model, model.contextWindow, "actual-family"));
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      model: withMetadata(f.request.model, f.request.model.contextWindow, "configured-family"),
      fetch: f.fetchReplies(success),
    }), /hash|compatib|metadata/i);
    assert.equal(f.payloads.length, 0);
    assert.equal(f.options.length, 1);
  });

  test(`${api}: rejects a prior checkpoint versus actual producer hash mismatch before fetch`, async () => {
    const f = await fixture(api, undefined, false, (model) => withMetadata(model, model.contextWindow, "actual-family"));
    const capable = capableModel(f.request.model);
    assert.ok(capable);
    const identity = { ...capable.identity, compactionModelHash: "prior-family" };
    const marker = "checkpoint-metadata-marker";
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      context: { messages: [{ role: "user", content: marker, timestamp: 1 }] },
      priorCheckpoint: { identity, marker, replacementHistory: [{ type: "compaction", encrypted_content: "prior" }] },
      fetch: f.fetchReplies(success),
    }), /hash|compatib|metadata/i);
    assert.equal(f.payloads.length, 0);
    assert.equal(f.options.length, 1);
  });

  test(`${api}: cannot change producer hash presence or physical window between attempts`, async () => {
    for (const [firstHash, secondHash, secondWindow] of [
      ["first-family", "other-family", 100_000],
      [undefined, "new-family", 100_000],
      ["first-family", undefined, 100_000],
      ["first-family", "first-family", 80_000],
    ] as const) {
      const f = await fixture(api, undefined, false, (model, attempt) => withMetadata(model,
        attempt === 1 ? 100_000 : secondWindow, attempt === 1 ? firstHash : secondHash));
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => sse([created])),
      }), /hash|compatib|metadata|window/i);
      assert.equal(f.payloads.length, 1, "changed producer metadata must be rejected before retry transport");
      assert.equal(f.options.length, 2);
      for (const option of f.options) assert.equal(option?.maxRetries, 0);
    }
  });

  for (const stage of ["created", "compaction-output"] as const) {
    test(`${api}: retries EOF after ${stage} with a fresh collector and unchanged request`, async () => {
      const f = await fixture(api);
      const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) =>
        attempt === 1 ? sse(stage === "created" ? [created] : [created, partialDone]) : success()) });
      assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
      assert.equal(result.usage.input, 23);
      assert.equal(result.usage.output, 7);
      f.assertAttempts(2);
    });
  }

  test(`${api}: retries EOF cutting a JSON data frame with a fresh collector`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) =>
      attempt === 1 ? new Response(frames([created, partialDone]) +
        'data: {"type":"response.completed","response":', { headers: streamHeaders }) : success()) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    assert.equal(result.usage.input, 23);
    f.assertAttempts(2);
  });

  test(`${api}: retries a response-body ECONNRESET without retaining the partial item`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) => {
      if (attempt > 1) return success();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(frames([created, partialDone]))); },
        pull(controller) {
          controller.error(new TypeError("Fixture socket termination", {
            cause: Object.assign(new Error("Fixture reset"), { code: "ECONNRESET" }),
          }));
        },
      });
      return new Response(body, { headers: streamHeaders });
    }) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    f.assertAttempts(2);
  });

  test(`${api}: retries a coded connection failure through the real fetch adapter`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) => {
      if (attempt === 1) throw new TypeError("Fixture fetch failure", {
        cause: Object.assign(new Error("Fixture connection reset"), { code: "ECONNRESET" }),
      });
      return success();
    }) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    f.assertAttempts(2);
  });

  test(`${api}: does not infer a transport failure from an arbitrary error message`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => { throw new TypeError("ECONNRESET timeout temporarily unavailable; try again"); }),
    }), Error);
    f.assertAttempts(1);
  });

  test(`${api}: retries the captured payload after caller context changes`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) => {
      if (attempt > 1) return success();
      f.context.messages.push({ role: "user", content: "Do not include this concurrent addition.", timestamp: 2 });
      const first = f.context.messages[0];
      if (first.role === "user") first.content = "The caller mutated the original message.";
      return sse([created]);
    }) });
    assert.doesNotMatch(JSON.stringify(result.promptInput), /concurrent addition|caller mutated/);
    assert.match(JSON.stringify(result.promptInput), /original constraint/);
    f.assertAttempts(2);
  });

  test(`${api}: rejects invalid output, permanent failures, and malformed SSE without retry`, async () => {
    const terminal = { type: "response.completed", response: { status: "completed", output: [] } };
    const cases: Array<[string, () => Response]> = [
      ["duplicate compaction", () => sse([created, partialDone, partialDone, terminal])],
      ["invalid compaction", () => sse([created, { type: "response.output_item.done", item: {
        type: "compaction", encrypted_content: "",
      } }, terminal])],
      ["missing compaction", () => sse([created, terminal])],
      ["quota", () => failed("insufficient_quota")],
      ["HTTP quota", () => httpError(429, "1", "insufficient_quota")],
      ["HTTP unknown error", () => httpError(503, "1", "unknown_fixture_error")],
      ["HTTP invalid request", () => httpError(503, "1", "invalid_request_error")],
      ["oversized HTTP quota", () => new Response(JSON.stringify({
        padding: "x".repeat(1_048_576), error: { code: "insufficient_quota", message: "Fixture quota exceeded" },
      }), { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } })],
      ["conflicting permanent and transient codes", () => sse([created, {
        type: "error", code: "insufficient_quota", error: { code: "server_error" },
      }])],
      ["policy", () => failed("cyber_policy")],
      ["unknown failure", () => failed("unknown_fixture_failure", "Rate limit. Please try again in 0.001s.")],
      ["missing event type", () => sse([created, { arbitrary: "value" }])],
      ["unknown event only", () => sse([{ type: "response.fixture_unknown" }])],
      ["output limit", () => sse([created, { type: "response.incomplete", response: {
        status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      } }])],
      ["content filter", () => sse([created, { type: "response.incomplete", response: {
        status: "incomplete", incomplete_details: { reason: "content_filter" },
      } }])],
      ["malformed JSON", () => new Response(frames([created]) + "data: {not-json}\n\n", { headers: streamHeaders })],
      ["malformed error", () => sse([created, { type: "error", error: { code: 429 } }])],
    ];
    for (const [label, reply] of cases) {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }), Error, label);
      f.assertAttempts(1);
    }
  });

  for (const code of ["server_error", "rate_limit_exceeded"] as const) {
    test(`${api}: retries a structured response.failed ${code}`, async () => {
      const f = await fixture(api);
      const result = await requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies((attempt) => attempt === 1 ? failed(code) : success()) });
      assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
      f.assertAttempts(2);
    });
  }

  test(`${api}: refuses documented rate-limit retry advice above the delay cap`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => failed("rate_limit_exceeded", "Please try again in 500ms.")) }),
    /retry delay|Retry-After|delay.*exceed/i);
    f.assertAttempts(1);
  });

  for (const named of [false, true]) {
    test(`${api}: classifies ${named ? "SSE event:error" : "nested error"} as transient before SDK normalization`, async () => {
      const f = await fixture(api);
      const result = await requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies((attempt) => attempt === 1 ? errorEvent("server_error", named) : success()) });
      assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
      f.assertAttempts(2);
    });

    test(`${api}: does not retry a permanent ${named ? "SSE event:error" : "nested error"}`, async () => {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => errorEvent(named ? "insufficient_quota" : "cyber_policy", named)) }), Error);
      f.assertAttempts(1);
    });
  }

  test(`${api}: never retries HTTP authentication errors`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => httpError(401, "1", "invalid_api_key")) }), Error);
    f.assertAttempts(1);
  });

  test(`${api}: Request transports and endpoint overrides reject redirects before any retry`, async () => {
    for (const endpoint of [undefined, "https://retry.example/custom/responses"]) {
      const f = await fixture(api, undefined, true);
      const model = endpoint ? { ...f.request.model, compat: { ...f.request.model.compat, supportsStore: false,
        ...{ remoteCompaction: { protocol: "v2", endpoint } },
      } } : f.request.model;
      await assert.rejects(requestRemoteCompaction({ ...f.request, model,
        fetch: f.fetchReplies(() => new Response("Fixture redirect", {
          status: 307, headers: { location: "https://different-backend.example/responses" },
        })) }), Error);
      if (endpoint) assert.equal(f.urls[0], endpoint);
      f.assertAttempts(1);
    }
  });

  test(`${api}: shares the configured cap across HTTP 429, stream EOF, and HTTP 503`, async () => {
    for (const [configured, expected] of [[undefined, 3], [0, 1], [1, 2], [2, 3], [9, 3]] as const) {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request, maxRetries: configured,
        fetch: f.fetchReplies((attempt) => attempt === 1 ? httpError(429, "1", "rate_limit_exceeded")
          : attempt === 2 ? sse([created, partialDone]) : httpError(503)) }), Error);
      f.assertAttempts(expected);
    }
  });

  test(`${api}: honors an allowed Retry-After header and retries HTTP 503`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies((attempt) => attempt === 1 ? httpError(503, "1") : success()) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    f.assertAttempts(2);
  });

  test(`${api}: cancellation interrupts a 500 ms server backoff`, { timeout: 1_000 }, async () => {
    const f = await fixture(api);
    const controller = new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = requestRemoteCompaction({ ...f.request, signal: controller.signal, maxRetryDelayMs: 1_000,
        fetch: f.fetchReplies(() => {
          abortTimer = setTimeout(() => controller.abort(new Error("Fixture cancellation")), 10);
          return httpError(503, "500");
        }) });
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error("Backoff ignored cancellation")), 250);
      });
      await assert.rejects(Promise.race([pending, deadline]), /Fixture cancellation|abort/i);
      assert.equal(controller.signal.aborted, true);
      f.assertAttempts(1);
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(deadlineTimer);
      controller.abort();
    }
  });

  test(`${api}: refuses a Retry-After delay above the cap instead of retrying early`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => httpError(503, "500")) }), /retry delay|Retry-After|delay.*exceed/i);
    f.assertAttempts(1);
  });

  test(`${api}: overflowing numeric retry advice does not fall back to an earlier retry`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => httpError(503, "9".repeat(400))) }), /retry delay|delay.*exceed/i);
    f.assertAttempts(1);
  });

  test(`${api}: authentication cannot move a retry to a different backend`, async () => {
    let resolutions = 0;
    const f = await fixture(api, async () => ({ auth: { apiKey: token,
      baseUrl: ++resolutions === 1 ? "https://original.example/backend-api" : "https://changed.example/backend-api",
    } }));
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => sse([created])) }), /backend|endpoint|identity/i);
    assert.equal(f.payloads.length, 1, "a changed backend must never receive the captured request");
    assert.match(f.urls[0], /^https:\/\/original\.example\//);
    assert.equal(f.options.length, 2, "the second auth resolution is checked before transport");
    for (const options of f.options) assert.equal(options?.maxRetries, 0);
  });
}
