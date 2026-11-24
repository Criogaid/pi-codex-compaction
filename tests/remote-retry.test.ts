import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import type { Api, AuthResult, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { RemoteCompactionTransientError, requestRemoteCompaction, type RemoteCompactionRequest } from "../src/remote.js";
import { CodexCompactionProtocolError, isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture, testRegistry } from "./helpers.js";

type ResponsesApi = "openai-responses" | "openai-codex-responses";
const token = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-retry-account" },
})).toString("base64url")}.signature`;
const streamHeaders = { "content-type": "text/event-stream" };
const created = { type: "response.created", response: { id: "resp-retry" } };
const partialItem = { type: "compaction", encrypted_content: "discard-this-partial-attempt" };
const partialDone = { type: "response.output_item.done", output_index: 0, item: partialItem };

function frames(events: readonly unknown[], newline = "\n"): string {
  return events.map((event) => `data: ${JSON.stringify(event)}${newline}${newline}`).join("");
}

function sse(events: readonly unknown[]): Response {
  return new Response(frames(events), { headers: streamHeaders });
}

function chunkedSse(chunks: readonly string[], headers: HeadersInit = streamHeaders): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers });
}

function success(): Response {
  const item = { type: "compaction", encrypted_content: "fresh-successful-checkpoint" };
  return sse([created, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-success", status: "completed", output: [item],
      usage: { input_tokens: 23, output_tokens: 7, total_tokens: 30 } } }]);
}

function failedEvent(code: string, message: string | number, headers?: Readonly<Record<string, string>>) {
  return { type: "response.failed", response: { status: "failed", error: { code, message, headers } } };
}

function failed(code: string, message = "Fixture provider error"): Response {
  return sse([created, failedEvent(code, message)]);
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

function assertTransientWithCause(error: unknown): boolean {
  assert.ok(error instanceof RemoteCompactionTransientError);
  assert.ok(error.cause instanceof Error);
  return true;
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

const compactionConfig = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const summaryModelId = "fixture-text-summary";

function hasTrigger(payload: JsonObject): boolean {
  return Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
}

const responsesApis = ["openai-responses", "openai-codex-responses"] as const;

test("only Codex Responses reads past an SSE error name carrying a progress event", async () => {
  const body = `event: error\n${frames([{ type: "response.in_progress" }])}` +
    frames([failedEvent("server_error", "Transient response failure")]);
  for (const [api, error, attempts] of [
    ["openai-responses", { constructor: Error }, 1],
    ["openai-codex-responses", assertTransientWithCause, 3],
  ] as const) {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => new Response(body, { headers: streamHeaders })) }), error);
    f.assertAttempts(attempts);
  }
});

test("uses response.done as a terminal event only on Codex Responses", async () => {
  const events = [partialDone,
    { type: "response.done", response: { id: "resp-alias", status: "completed", output: [partialItem],
      usage: { input_tokens: 23, output_tokens: 1, total_tokens: 24 } } },
    { type: "response.completed", response: { id: "resp-alias", status: "completed", output: [partialItem],
      usage: { input_tokens: 91, output_tokens: 1, total_tokens: 92 } } },
  ];
  const usages = await Promise.all(responsesApis.map(async (api) => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(() => sse(events)) });
    assert.deepEqual(result.item, partialItem);
    f.assertAttempts(1);
    return result.usage.input;
  }));
  assert.deepEqual(usages, [91, 23]);
});

const codexAliasOutcomes = [
  ["completed", undefined],
  ["incomplete", /Response incomplete without a provider reason/],
  ["failed", /An unknown error occurred/],
  ["cancelled", /An unknown error occurred/],
  ["in_progress", /ended without response\.completed/],
  [undefined, /ended without response\.completed/],
] as const;
for (const api of responsesApis) {
  for (const [status, codexError] of codexAliasOutcomes) {
    test(`${api}: handles response.done with ${status ?? "missing status"} and no response.completed`, async () => {
      const f = await fixture(api);
      const result = requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(() => sse([
        created, partialDone,
        { type: "response.done", response: { id: "resp-alias", status, output: [partialItem],
          usage: { input_tokens: 23, output_tokens: 1, total_tokens: 24 } } },
      ])) });

      if (api === "openai-responses") {
        await assert.rejects(result, /ended before a terminal response event/);
        f.assertAttempts(3);
        return;
      }
      if (codexError) await assert.rejects(result, codexError);
      else assert.deepEqual((await result).item, partialItem);
      f.assertAttempts(1);
    });
  }
}

const layouts = [
  ...responsesApis.map((api) => [[api], "LF", "\n", "same chunk", "text/event-stream"] as const),
  [["openai-responses"], "LF", "\n", "separate chunks", "text/event-stream"],
  [["openai-responses"], "CRLF", "\r\n", "same chunk", "text/event-stream"],
  [["openai-responses"], "CRLF", "\r\n", "separate chunks", "text/event-stream"],
  [responsesApis, "LF", "\n", "same chunk", undefined],
  [responsesApis, "LF", "\n", "same chunk", "text/plain"],
] as const;
for (const [apis, lineEnding, newline, layout, contentType] of layouts) {
  for (const tail of ["response.completed", "response.failed"] as const) {
    const format = contentType === "text/event-stream" ? "SSE" : `SSE with ${contentType ?? "no Content-Type"}`;
    test(`${apis.join(" and ")}: first ${format} completion wins over ${tail} (${lineEnding}, ${layout})`,
      { timeout: 20_000 }, async (t) => {
        for (const api of apis) {
          const firstItem = { type: "compaction", encrypted_content: "first-checkpoint" };
          const laterItem = { type: "compaction", encrypted_content: "later-checkpoint" };
          const first = frames([created, { type: "response.output_item.done", output_index: 0, item: firstItem },
            { type: "response.completed", response: { id: "resp-first", status: "completed", output: [firstItem],
              usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 } } }], newline);
          const later = frames([tail === "response.completed"
            ? { type: tail, response: { id: "resp-later", status: "completed", output: [laterItem],
              usage: { input_tokens: 99, output_tokens: 1, total_tokens: 100 } } }
            : { type: tail, response: { status: "failed", error: { code: "server_error", message: "Late failure" } } }], newline);
          const fixture = await sessionFixture({
            api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
            models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
            settings: { retry: { enabled: false, provider: { maxRetries: 1 } } },
            respond: ({ payload }) => {
              if (!hasTrigger(payload)) return;
              const chunks = layout === "same chunk" ? [first + later] : [first, later];
              return chunkedSse(chunks, contentType === undefined ? {} : { "content-type": contentType });
            },
          });
          t.after(() => fixture.close());
          await mkdir(dirname(compactionConfig), { recursive: true });
          await writeFile(compactionConfig, JSON.stringify({ version: 2,
            summaryModel: { provider: fixture.model.provider, model: summaryModelId, thinkingLevel: "low" } }));
          for (let turn = 1; turn <= 3; turn++) {
            await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
          }
          const start = fixture.requests.length;
          await fixture.session.compact();
          const entry = getLatestCompactionEntry(fixture.session.sessionManager.getBranch());
          assert.deepEqual({
            requests: fixture.requests.slice(start).map(({ payload }) => ({ model: payload.model, v2: hasTrigger(payload) })),
            item: entry && parseCheckpointDetails(entry.details)?.replacementHistory.at(-1),
            inputTokens: entry?.usage?.input,
          }, { requests: [{ model: fixture.model.id, v2: true }], item: firstItem, inputTokens: 11 });
        }
      });
  }
}

for (const api of responsesApis) {
  for (const abort of [false, true]) {
    test(`${api}: ${abort ? "aborts" : "finishes"} compaction while source cancellation is pending`,
      { timeout: 20_000 }, async (t) => {
        const cancelStarted = Promise.withResolvers<void>();
        const sourceCancel = Promise.withResolvers<void>();
        const bytes = Buffer.from(frames([partialDone, { type: "response.completed", response: {
          id: "resp-cancel", status: "completed", output: [partialItem],
          usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 },
        } }]));
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(bytes); },
          cancel() {
            cancelStarted.resolve();
            return sourceCancel.promise;
          },
        });
        const f = await sessionFixture({
          api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
          respond: ({ payload }) => hasTrigger(payload) ? new Response(body, { headers: streamHeaders }) : undefined,
        });
        t.after(() => f.close());
        for (let turn = 1; turn <= 3; turn++) {
          await f.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
        }
        const start = f.requests.length;
        const run = f.session.compact();
        const outcome = abort ? assert.rejects(run, /Compaction cancelled/) : run;
        const deadline = delay(2_000, "deadline", { ref: false });
        try {
          assert.equal(await Promise.race([cancelStarted.promise, outcome.then(() => "settled"), deadline]), undefined,
            "the source receives cancel after streaming completion");
          if (abort) f.session.abortCompaction();
          assert.equal(await Promise.race([outcome.then(() => "settled"), deadline]), "settled",
            "Pi compaction settles while the source cancel promise is pending");
          assert.equal(f.session.isCompacting, false);
          assert.equal(body.locked, false);
          assert.equal(f.requests.length - start, 1);
          const entry = getLatestCompactionEntry(f.session.sessionManager.getBranch());
          if (abort) assert.equal(entry, null);
          else assert.equal(entry?.usage?.input, 11);
        } finally {
          sourceCancel.resolve();
          await Promise.allSettled([outcome]);
        }
      });
  }

  test(`${api}: trims tool output to the actual prepared model's physical window`, async () => {
    const f = await fixture(api, undefined, false, (model) => ({ ...model, contextWindow: 512 }));
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
    const retainedOutput = result.promptInput.find((item) => item.type === "function_call_output");
    assert.ok(retainedOutput);
    assert.equal(typeof retainedOutput.output, "string");
    assert.notEqual(retainedOutput.output, output);
    assert.ok(String(retainedOutput.output).length < output.length);
    assert.doesNotMatch(JSON.stringify(f.payloads[0]), /x{16000}/);
    f.assertAttempts(1);
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
      ["HTTP invalid request", () => httpError(400, "1", "invalid_request_error")],
      ["oversized HTTP quota", () => new Response(JSON.stringify({
        padding: "x".repeat(1_048_576), error: { code: "insufficient_quota", message: "Fixture quota exceeded" },
      }), { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } })],
      ["conflicting permanent and transient codes", () => sse([created, {
        type: "error", code: "insufficient_quota", error: { code: "server_error" },
      }])],
      ["policy", () => failed("cyber_policy")],
      ["missing event type", () => sse([created, { arbitrary: "value" }])],
      ["unknown event only", () => sse([{ type: "response.fixture_unknown" }])],
      ["malformed JSON", () => new Response(frames([created]) + "data: {not-json}\n\n", { headers: streamHeaders })],
      ["malformed error", () => sse([created, { type: "error", error: { code: 429 } }])],
    ];
    for (const [label, reply] of cases) {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }), Error, label);
      f.assertAttempts(1);
    }
  });

  test(`${api}: retries HTTP 503 with an unknown error code and uses the successful retry`, async () => {
    const f = await fixture(api);
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) =>
      attempt === 1 ? httpError(503, "1", "unknown_fixture_error") : success()) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    f.assertAttempts(2);
  });

  test(`${api}: retries content filtering but not the output limit before [DONE]`, async () => {
    for (const [reason, error, attempts] of [
      ["content_filter", assertTransientWithCause, 3],
      ["max_output_tokens", CodexCompactionProtocolError, 1],
    ] as const) {
      const f = await fixture(api);
      const body = frames([created, { type: "response.incomplete", response: {
        status: "incomplete", incomplete_details: { reason },
      } }]) + "data: [DONE]\n\n";
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => new Response(body, { headers: streamHeaders })) }), error);
      f.assertAttempts(attempts);
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

  test(`${api}: rejects a numeric message on a capacity failure as a protocol error`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => sse([created, failedEvent("server_is_overloaded", 42, { "retry-after": "0" })])) }),
    CodexCompactionProtocolError);
    f.assertAttempts(1);
  });

  test(`${api}: rate-limit wording cannot make an unknown response.failed code retryable`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => failed("unknown_fixture_failure", "Rate limit. Please try again in 0.001s.")) }),
    CodexCompactionProtocolError);
    f.assertAttempts(1);
  });

  test(`${api}: applies the first terminal retry advice regardless of chunk boundaries`, async () => {
    for (const [firstAdvice, secondAdvice, attempts] of [["0", "60", 3], ["60", "0", 1]] as const) {
      const first = frames([created, failedEvent("server_error", "First failure", { "retry-after": firstAdvice })]);
      const laterRecords = [
        frames([failedEvent("server_error", "Later failure", { "retry-after": secondAdvice })]),
        frames([failedEvent("insufficient_quota", "Later quota error")]),
      ];
      for (const later of laterRecords) {
        for (const chunks of [[first + later], [first, later]]) {
          const f = await fixture(api);
          await assert.rejects(requestRemoteCompaction({ ...f.request,
            fetch: f.fetchReplies(() => chunkedSse(chunks)) }), assertTransientWithCause);
          f.assertAttempts(attempts);
        }
      }
    }
  });

  test(`${api}: capacity failures require valid advice to resend but stay transient`, async () => {
    for (const [advice, attempts] of [[undefined, 1], ["0", 3], ["\u000b0\u000b", 1]] as const) {
      const f = await fixture(api);
      const headers = advice === undefined ? undefined : { "retry-after-ms": advice };
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => sse([created, failedEvent("server_is_overloaded", "Capacity failure", headers)])) }),
      assertTransientWithCause);
      f.assertAttempts(attempts);
    }
  });

  test(`${api}: stream retry headers take precedence over a known rate-limit message`, async () => {
    const f = await fixture(api);
    const reply = () => sse([created, failedEvent("rate_limit_exceeded", "Please try again in 500ms.", { "retry-after": "0" })]);
    await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }), assertTransientWithCause);
    f.assertAttempts(3);
  });

  test(`${api}: refuses documented rate-limit retry advice above the delay cap`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => failed("rate_limit_exceeded", "Please try again in 500ms.")) }),
    assertTransientWithCause);
    f.assertAttempts(1);
  });

  for (const named of [false, true]) {
    test(`${api}: does not retry a standalone ${named ? "named SSE error" : "nested error"} followed by EOF`, async () => {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => errorEvent("server_error", named)) }), { constructor: Error });
      f.assertAttempts(1);
    });

    test(`${api}: does not retry a permanent ${named ? "SSE event:error" : "nested error"}`, async () => {
      const f = await fixture(api);
      await assert.rejects(requestRemoteCompaction({ ...f.request,
        fetch: f.fetchReplies(() => errorEvent(named ? "insufficient_quota" : "cyber_policy", named)) }), Error);
      f.assertAttempts(1);
    });
  }

  test(`${api}: vetoes retry on [DONE] at EOF with or without a trailing blank line`, async () => {
    for (const trailingLf of [0, 1, 2]) {
      const f = await fixture(api);
      const reply = () => new Response(frames([created]) + "data: [DONE]" + "\n".repeat(trailingLf), { headers: streamHeaders });
      await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }), { constructor: Error });
      f.assertAttempts(1);
    }
  });

  test(`${api}: keeps complete HTTP 503 error evidence when the response body resets`, async () => {
    for (const [code, error] of [
      ["insufficient_quota", { constructor: Error }],
      ["server_error", assertTransientWithCause],
    ] as const) {
      const f = await fixture(api);
      const reply = () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code, message: "Fixture HTTP failure" } })));
          },
          pull(controller) {
            controller.error(new TypeError("Fixture HTTP body reset", {
              cause: Object.assign(new Error("Fixture reset"), { code: "ECONNRESET" }),
            }));
          },
        });
        return new Response(body, { status: 503, headers: { "content-type": "application/json", "retry-after": "60" } });
      };
      await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }), error);
      f.assertAttempts(1);
    }
  });

  test(`${api}: HTTP 429 needs valid advice to become retryable`, async () => {
    for (const [advice, attempts] of [[{}, 1], [{ "retry-after": "0" }, 3],
      [{ "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" }, 3]] as const) {
      const f = await fixture(api);
      const reply = () => new Response("Fixture rate limit", { status: 429, headers: advice });
      await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(reply) }),
        attempts === 1 ? { constructor: Error } : assertTransientWithCause);
      f.assertAttempts(attempts);
    }
  });

  test(`${api}: ignores a five-digit HTTP-date year and retries with backoff`, async () => {
    const f = await fixture(api);
    const fiveDigitDate = new Date("+010000-01-01T00:00:00.000Z").toUTCString();
    const result = await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) => attempt === 1
      ? new Response("Fixture outage", { status: 503, headers: { "retry-after": fiveDigitDate } })
      : success()) });
    assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
    f.assertAttempts(2);
  });

  for (const code of [undefined, null, "server_error"] as const) {
    test(`${api}: retries a server_error type with code=${String(code)}`, async () => {
      const f = await fixture(api);
      await requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies((attempt) => attempt === 1
        ? new Response(JSON.stringify({ error: { type: "server_error", code } }), {
          status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" },
        }) : success()) });
      f.assertAttempts(2);
    });
  }

  test(`${api}: a permanent string code overrides a transient error type`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request, fetch: f.fetchReplies(() =>
      new Response(JSON.stringify({ error: { type: "server_error", code: "insufficient_quota" } }), {
        status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" },
      })) }), Error);
    f.assertAttempts(1);
  });

  test(`${api}: never retries HTTP authentication errors`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => httpError(401, "1", "invalid_api_key")) }), Error);
    f.assertAttempts(1);
  });

  test(`${api}: preserves redirect mode for Request transports and endpoint overrides`, async () => {
    for (const endpoint of [undefined, "https://retry.example/custom/responses"]) {
      const f = await fixture(api, undefined, true);
      const model = { ...f.request.model, compat: { ...f.request.model.compat, supportsStore: false,
        remoteCompaction: { protocol: "v2", ...(endpoint ? { endpoint } : {}) } } };
      const replies = f.fetchReplies(success);
      await requestRemoteCompaction({ ...f.request, model, fetch: (input, init) => {
        const outgoing = new Request(input, init);
        assert.equal(outgoing.redirect, "follow");
        return replies(outgoing);
      } });
      if (endpoint) assert.equal(f.urls[0], endpoint);
      f.assertAttempts(1);
    }
  });

  test(`${api}: follows redirects for provider URLs and endpoint overrides`, { timeout: 10_000 }, async (t) => {
    const successfulBody = await success().text();
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      request.resume();
      if (request.url === "/final") {
        response.writeHead(200, streamHeaders);
        response.end(successfulBody);
      } else {
        response.writeHead(307, { location: "/final" });
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const endpoint of [undefined, `${origin}/custom/responses`]) {
      paths.length = 0;
      const f = await fixture(api);
      const model = { ...f.request.model, baseUrl: `${origin}/backend-api`,
        compat: { ...f.request.model.compat, supportsStore: false,
          remoteCompaction: { protocol: "v2", ...(endpoint ? { endpoint } : {}) } } };
      const result = await requestRemoteCompaction({ ...f.request, model });
      assert.equal(result.item.encrypted_content, "fresh-successful-checkpoint");
      assert.equal(f.options.length, 1, "Following a redirect is still one provider attempt");
      assert.deepEqual(paths, [endpoint ? "/custom/responses" : api === "openai-responses"
        ? "/backend-api/responses" : "/backend-api/codex/responses", "/final"]);
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
      fetch: f.fetchReplies(() => httpError(503, "500")) }),
    assertTransientWithCause);
    f.assertAttempts(1);
  });

  test(`${api}: overflowing numeric retry advice does not fall back to an earlier retry`, async () => {
    const f = await fixture(api);
    await assert.rejects(requestRemoteCompaction({ ...f.request,
      fetch: f.fetchReplies(() => httpError(503, "9".repeat(400))) }),
    assertTransientWithCause);
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
