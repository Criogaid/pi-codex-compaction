import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture, type SessionRequest } from "./helpers.js";

const configPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const summaryModelId = "fixture-text-summary";
const hasTrigger = ({ payload }: SessionRequest) => Array.isArray(payload.input) &&
  payload.input.some((item) => isObject(item) && item.type === "compaction_trigger");
const checkpointItems = (payload: JsonObject) => {
  assert.ok(Array.isArray(payload.input));
  return payload.input.filter((item) => isObject(item) && item.type === "compaction");
};
const occurrences = (value: unknown, text: string) => JSON.stringify(value).split(text).length - 1;
const work = (marker: string) => `${marker} ${"Preserve this implementation decision. ".repeat(100)}`;

async function configure(provider: string, enabled = true) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 2, remoteCompaction: { enabled },
    summaryModel: { provider, model: summaryModelId, thinkingLevel: "low" } }));
}

const responsesApis = ["openai-responses", "openai-codex-responses"] as const;
type ResponsesApi = typeof responsesApis[number];

function httpFailure(status: number, error: JsonObject, retryAfter?: string) {
  return new Response(JSON.stringify({ error }), { status, headers: {
    "content-type": "application/json",
    ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
  } });
}

function resetAfterHttpBody(error: JsonObject, retryAfter: string) {
  const bytes = Buffer.from(JSON.stringify({ error }));
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(Object.assign(new Error("Fixture connection reset"), { code: "ECONNRESET" }));
        return;
      }
      controller.enqueue(bytes);
      sent = true;
    },
  }, { highWaterMark: 0 }), { status: 503, headers: {
    "content-type": "application/json", "retry-after": retryAfter,
  } });
}

const dataFrame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const failedFrame = (code: string, fields: JsonObject = {}) => dataFrame({
  type: "response.failed", response: { status: "failed", error: { code, ...fields } },
});
function sseFailure(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function checkpointRetryOutcome(api: ResponsesApi, reply: () => Response) {
  let failRemote = false;
  const fixture = await sessionFixture({
    api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
    models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
    settings: { retry: { enabled: false, provider: { maxRetries: 2, maxRetryDelayMs: 1 } } },
    respond: (request) => failRemote && hasTrigger(request) ? reply() : undefined,
  });
  const dropped = ["new-dropped-one", "new-dropped-two"];
  const retained = "new-retained-tail";
  try {
    await configure(fixture.model.provider);
    for (const marker of ["prior-checkpoint-one", "prior-checkpoint-two", "prior-checkpoint-tail"]) {
      await fixture.session.prompt(work(marker));
    }
    await fixture.session.compact();
    for (const marker of [...dropped, retained]) await fixture.session.prompt(work(marker));
    const checkpoint = checkpointItems(fixture.requests.at(-1)!.payload);
    assert.equal(checkpoint.length, 1, "The first V2 creates a replayable checkpoint");

    const start = fixture.requests.length;
    failRemote = true;
    let cancelled = false;
    try {
      await fixture.session.compact();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Compaction cancelled") throw error;
      cancelled = true;
    }
    const requests = fixture.requests.slice(start);
    const attempts = requests.filter(hasTrigger);
    const summaries = requests.filter(({ payload }) => payload.model === summaryModelId);
    assert.equal(requests.length, attempts.length + summaries.length, "Only V2 and the configured summary model run");
    for (const { payload } of attempts) assert.deepEqual(checkpointItems(payload), checkpoint);
    assert.equal(cancelled, summaries.length === 0);
    const summaryInput = summaries.map(({ payload }) => payload.input);
    if (summaries.length > 0) {
      for (const marker of dropped) assert.equal(occurrences(summaryInput, marker), 1);
      for (const marker of ["prior-checkpoint-", "encrypted_content", retained]) {
        assert.equal(occurrences(summaryInput, marker), 0, "The summary receives only newly dropped plaintext");
      }
    }

    await fixture.session.prompt("Continue after the V2 failure.");
    const replay = fixture.requests.at(-1)!.payload;
    assert.deepEqual(checkpointItems(replay), checkpoint);
    assert.equal(occurrences(replay.input, retained), 1);
    for (const marker of dropped) assert.equal(occurrences(replay.input, marker), cancelled ? 1 : 0);
    for (const summary of summaries) {
      const replyText = `Fixture reply ${fixture.requests.indexOf(summary) + 1}.`;
      assert.equal(occurrences(replay.input, replyText), 1, "Replay the supplemental summary once");
    }
    assert.deepEqual(fixture.errors, []);
    return { attempts: attempts.length, summaries: summaries.length };
  } finally {
    await fixture.close();
    await rm(configPath, { force: true });
  }
}

async function checkCheckpointRetryCases(api: ResponsesApi, cases: readonly (readonly [
  name: string, reply: () => Response, attempts: number, summaries: number,
])[]) {
  const actual = [];
  for (const [name, reply] of cases) actual.push({ name, ...await checkpointRetryOutcome(api, reply) });
  assert.deepEqual(actual, cases.map(([name, , attempts, summaries]) => ({ name, attempts, summaries })));
}

test("real Responses adapters distinguish terminal errors from skipped SSE records", { timeout: 30_000 }, async () => {
  const namedError = () => sseFailure(
    `event: error\n${dataFrame({ type: "response.in_progress" })}${failedFrame("server_error")}`,
  );
  const created = dataFrame({ type: "response.created", response: { id: "resp-fixture" } });
  const emptyData = "data:\n\n";
  const failure = failedFrame("server_error");
  for (const [api, attempts, summaries] of [
    ["openai-responses", 1, 0],
    ["openai-codex-responses", 3, 1],
  ] as const) {
    await checkCheckpointRetryCases(api, [
      [`${api}: named error containing progress`, namedError, attempts, summaries],
      [`${api}: empty data in one chunk`, () => sseFailure(created + emptyData + failure), attempts, summaries],
      [`${api}: empty data in split chunks`, () => sseFailure(created, emptyData, failure), attempts, summaries],
      [`${api}: SSE comment`, () => sseFailure(created + ": ping\n\n" + failure), 3, 1],
    ]);
  }
});

const nonAsciiRetryAfter = "\u00a00\u00a0";

for (const api of responsesApis) {
  test(`real ${api} keeps the checkpoint on quota and invalid V2 output`, { timeout: 30_000 }, async () => {
    const capacityFailure = (fields: JsonObject) =>
      sseFailure(failedFrame("server_is_overloaded", { message: "busy", ...fields }));
    await checkCheckpointRetryCases(api, [
      ["HTTP quota code overrides a transient type",
        () => httpFailure(503, { code: "insufficient_quota", type: "server_error" }, "0"), 1, 0],
      ["HTTP transient type without the quota code",
        () => httpFailure(503, { type: "server_error" }, "0"), 3, 1],
      ["HTTP usage_not_included overrides 503", () => httpFailure(503, { code: "usage_not_included" }, "0"), 1, 0],
      ["HTTP usage_limit_reached overrides 503", () => httpFailure(503, { code: "usage_limit_reached" }, "0"), 1, 0],
      ["HTTP usage_not_included in code alone overrides 429 with advice",
        () => httpFailure(429, { code: "usage_not_included" }, "0"), 1, 0],
      ["HTTP model_not_found leaves 503 retryable", () => httpFailure(503, { code: "model_not_found" }, "0"), 3, 1],
      ["SSE capacity code with a numeric message",
        () => sseFailure(failedFrame("server_is_overloaded", { message: 42 })), 1, 0],
      ["SSE capacity code with a numeric type", () => capacityFailure({ type: 42 }), 1, 0],
      ["SSE capacity code with an object plan_type despite zero advice",
        () => capacityFailure({ plan_type: {}, headers: { "retry-after": "0" } }), 1, 0],
      ["SSE capacity code with a string resets_at", () => capacityFailure({ resets_at: "bogus" }), 1, 0],
      ["SSE capacity code with an integer resets_at", () => capacityFailure({ resets_at: 1_700_000_000 }), 1, 1],
      ["Unknown SSE code with rate-limit prose",
        () => sseFailure(failedFrame("fixture_unknown", { message: "Rate limit. Please try again in 0.001s." })), 1, 0],
    ]);
  });

  test(`real ${api} layers capacity failures when retry advice is absent or unusable`, { timeout: 30_000 }, async () => {
    await checkCheckpointRetryCases(api, [
      ["HTTP capacity with no advice", () => httpFailure(503, { code: "server_is_overloaded" }), 1, 1],
      ["HTTP capacity above the wait cap", () => httpFailure(503, { code: "server_is_overloaded" }, "60"), 1, 1],
      ["HTTP capacity with zero advice", () => httpFailure(503, { code: "server_is_overloaded" }, "0"), 3, 1],
      ["SSE capacity with no advice", () => sseFailure(failedFrame("policy_capacity_unavailable")), 1, 1],
      ["SSE capacity with invalid header bytes",
        () => sseFailure(failedFrame("policy_capacity_unavailable", { headers: { "retry-after": "\u000b0\u000b" } })), 1, 1],
      ["SSE capacity with NBSP around zero advice", () => sseFailure(failedFrame("policy_capacity_unavailable", {
        headers: { "retry-after": nonAsciiRetryAfter },
      })), 1, 1],
      ["SSE capacity with zero advice",
        () => sseFailure(failedFrame("policy_capacity_unavailable", { headers: { "retry-after": "0" } })), 3, 1],
    ]);
  });

  test(`real ${api} needs retry advice to resend or layer an ordinary 429`, { timeout: 30_000 }, async () => {
    await checkCheckpointRetryCases(api, [
      ["No advice", () => httpFailure(429, { message: "Fixture rate limit" }), 1, 0],
      ["Zero advice", () => httpFailure(429, { message: "Fixture rate limit" }, "0"), 3, 1],
      ["NBSP around zero advice", () => httpFailure(429, { message: "Fixture rate limit" }, nonAsciiRetryAfter), 1, 0],
      ["Above-cap advice of 2^63 seconds",
        () => httpFailure(429, { message: "Fixture rate limit" }, (2n ** 63n).toString()), 1, 1],
      ["Above-cap advice of u64::MAX seconds",
        () => httpFailure(429, { message: "Fixture rate limit" }, (2n ** 64n - 1n).toString()), 1, 1],
    ]);
  });

  test(`real ${api} layers rate limits even when the advised wait exceeds the cap`, { timeout: 30_000 }, async () => {
    const message = "Please try again in 500ms.";
    await checkCheckpointRetryCases(api, [
      ["Above-cap message advice", () => sseFailure(failedFrame("rate_limit_exceeded", { message })), 1, 1],
      ["NBSP in text ignores the above-cap advice and uses local backoff",
        () => sseFailure(failedFrame("rate_limit_exceeded", { message: "try again in\u00a0500ms" })), 3, 1],
      ["Vertical tab in text preserves the above-cap advice",
        () => sseFailure(failedFrame("rate_limit_exceeded", { message: "try again in\u000b500ms" })), 1, 1],
      ["Zero header advice overrides the message", () => sseFailure(failedFrame("rate_limit_exceeded", {
        message, headers: { "retry-after": "0" },
      })), 3, 1],
    ]);
  });

  test(`real ${api} layers content filtering only on a genuine incomplete terminal frame`, { timeout: 30_000 }, async () => {
    const incomplete = (type: string, reason: string) => sseFailure(dataFrame({
      type, response: { status: "incomplete", incomplete_details: { reason } },
    }) + "data: [DONE]\n\n");
    await checkCheckpointRetryCases(api, [
      ["Content filter", () => incomplete("response.incomplete", "content_filter"), 3, 1],
      ["Output limit", () => incomplete("response.incomplete", "max_output_tokens"), 1, 0],
      ...(api === "openai-codex-responses"
        ? [["Unsuccessful Codex alias", () => incomplete("response.done", "content_filter"), 1, 0] as const] : []),
    ]);
  });

  test(`real ${api} preserves quota and retry advice evidence after an HTTP body reset`, { timeout: 30_000 }, async () => {
    await checkCheckpointRetryCases(api, [
      ["Complete quota body before reset",
        () => resetAfterHttpBody({ code: "insufficient_quota", type: "server_error" }, "0"), 1, 0],
      ["Above-cap advice before reset", () => resetAfterHttpBody({ code: "server_error" }, "60"), 1, 1],
    ]);
  });

  test(`real ${api} uses the first terminal frame's retry advice before layering`, { timeout: 30_000 }, async () => {
    const frame = (retryAfter: string) => failedFrame("server_error", { headers: { "retry-after": retryAfter } });
    await checkCheckpointRetryCases(api, [
      ["Zero then above-cap advice", () => sseFailure(frame("0") + frame("60")), 3, 1],
      ["Above-cap then zero advice", () => sseFailure(frame("60") + frame("0")), 1, 1],
    ]);
  });

  test(`real ${api} layers failed V2 text fallback over A without losing or duplicating history`, { timeout: 30_000 }, async () => {
    let failRemote = false;
    const fixture = await sessionFixture({
      api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
      models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
      respond: (request) => failRemote && hasTrigger(request)
        ? new Response("Temporary fixture outage", { status: 503 }) : undefined,
    });
    try {
      await configure(fixture.model.provider);
      await fixture.session.prompt(work("before-A-one"));
      await fixture.session.prompt(work("before-A-two"));
      await fixture.session.prompt(work("before-A-tail"));
      await fixture.session.compact();
      await fixture.session.prompt(work("discarded-after-A-one"));
      const initial = fixture.requests.at(-1)!.payload;
      const a = checkpointItems(initial);
      assert.equal(a.length, 1, "The first successful V2 creates A");
      await fixture.session.prompt(work("discarded-after-A-two"));
      await fixture.session.prompt(work("retained-after-A-tail"));
      const beforeFallback = fixture.requests.length;
      failRemote = true;
      await fixture.session.compact();
      const attempted = fixture.requests.slice(beforeFallback);
      assert.equal(attempted.filter(hasTrigger).length, 1);
      const summaries = attempted.filter(({ payload }) => payload.model === summaryModelId);
      assert.ok(summaries.length > 0, "The configured text model handles the failed V2 request");
      const summaryInput = summaries.map(({ payload }) => payload.input);
      assert.equal(occurrences(summaryInput, "before-A-"), 0, "The text model must not summarize plaintext already represented by A");
      assert.equal(occurrences(summaryInput, "encrypted_content"), 0, "Opaque A never enters text summarization");
      for (const marker of ["discarded-after-A-one", "discarded-after-A-two"]) {
        assert.equal(occurrences(summaryInput, marker), 1, "Each discarded post-A message is summarized once");
      }
      assert.equal(occurrences(summaryInput, "retained-after-A-tail"), 0, "The retained tail stays outside the summary");
      const summaryTexts = summaries.map((request) => `Fixture reply ${fixture.requests.indexOf(request) + 1}.`);
      const retiredSummaryTexts: string[] = [];
      let retainedMarker = "retained-after-A-tail";
      const discardedMarkers = ["discarded-after-A-one", "discarded-after-A-two"];
      const assertReplay = (payload: JsonObject) => {
        assert.deepEqual(checkpointItems(payload), a, "Replay A exactly once");
        for (const summary of summaryTexts) assert.equal(occurrences(payload.input, summary), 1, "Replay the cumulative text summary once");
        for (const summary of retiredSummaryTexts) assert.equal(occurrences(payload.input, summary), 0, "The cumulative summary replaces its predecessor");
        assert.equal(occurrences(payload.input, retainedMarker), 1, "Replay the retained tail once");
        for (const marker of discardedMarkers) {
          assert.equal(occurrences(payload.input, marker), 0, "Summarized messages must not also survive verbatim");
        }
      };
      await fixture.session.prompt("Continue immediately after layered fallback.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.reopen();
      await fixture.session.prompt("Continue after reopening layered fallback.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.session.prompt(work("second-layer-discarded"));
      await fixture.session.prompt(work("second-layer-tail"));
      const secondStart = fixture.requests.length;
      await fixture.session.compact();
      const secondSummaries = fixture.requests.slice(secondStart).filter(({ payload }) => payload.model === summaryModelId);
      assert.ok(secondSummaries.length > 0);
      const secondInput = secondSummaries.map(({ payload }) => payload.input);
      for (const marker of [retainedMarker, "second-layer-discarded"]) assert.equal(occurrences(secondInput, marker), 1);
      for (const summary of summaryTexts) assert.equal(occurrences(secondInput, summary), 1, "The summary model receives the previous plaintext summary once");
      for (const marker of [...discardedMarkers, "before-A-", "second-layer-tail", "encrypted_content"]) {
        assert.equal(occurrences(secondInput, marker), 0, "A new layer summarizes only newly discarded history");
      }
      discardedMarkers.push(retainedMarker, "second-layer-discarded");
      retainedMarker = "second-layer-tail";
      retiredSummaryTexts.push(...summaryTexts);
      summaryTexts.splice(0, summaryTexts.length, ...secondSummaries.map((request) => `Fixture reply ${fixture.requests.indexOf(request) + 1}.`));
      await fixture.session.prompt("Continue after repeated text layering.");
      assertReplay(fixture.requests.at(-1)!.payload);
      await fixture.reopen();
      await fixture.session.prompt("Resume the repeated layers.");
      assertReplay(fixture.requests.at(-1)!.payload);
      failRemote = false;
      await fixture.session.prompt(work("work-before-V2-recovery"));
      await fixture.session.prompt(work("tail-before-V2-recovery"));
      await fixture.session.compact();
      const resumed = fixture.requests.at(-1)!;
      assert.ok(hasTrigger(resumed), "A later V2 can compact the layered history");
      assertReplay(resumed.payload);
      await fixture.session.prompt("Continue after successful V2 recovery.");
      const recovered = checkpointItems(fixture.requests.at(-1)!.payload);
      assert.equal(recovered.length, 1);
      assert.notDeepEqual(recovered, a, "Successful V2 replaces A rather than stacking both opaque items");
      for (const summary of [...summaryTexts, ...retiredSummaryTexts]) {
        assert.equal(occurrences(fixture.requests.at(-1)!.payload.input, summary), 0, "Successful V2 absorbs old text layers");
      }
      assert.equal(fixture.session.model?.id, fixture.model.id);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
      await rm(configPath, { force: true });
    }
  });

  for (const enabled of [true, false]) {
    test(`real ${api} keeps native text fallback without A, V2 enabled=${enabled}`, { timeout: 20_000 }, async () => {
      const fixture = await sessionFixture({
        api, extensions: (fetch) => [createCodexCompactionExtension({ fetch })],
        models: (base) => [base, { ...base, id: summaryModelId, name: "Fixture text summary" }],
        respond: (request) => hasTrigger(request) ? new Response("Fixture rejection", { status: 400 }) : undefined,
      });
      try {
        await configure(fixture.model.provider, enabled);
        await fixture.session.prompt(work("native-discarded-one"));
        await fixture.session.prompt(work("native-discarded-two"));
        await fixture.session.prompt(work("native-retained-tail"));
        const start = fixture.requests.length;
        await fixture.session.compact();
        const attempts = fixture.requests.slice(start);
        assert.equal(attempts.filter(hasTrigger).length, enabled ? 1 : 0);
        const summaries = attempts.filter(({ payload }) => payload.model === summaryModelId);
        assert.ok(summaries.length > 0);
        for (const marker of ["native-discarded-one", "native-discarded-two"]) {
          assert.equal(occurrences(summaries.map(({ payload }) => payload.input), marker), 1);
        }
        await fixture.session.prompt("Continue native text history.");
        assert.equal(checkpointItems(fixture.requests.at(-1)!.payload).length, 0);
        assert.equal(occurrences(fixture.requests.at(-1)!.payload.input, "native-retained-tail"), 1);
        assert.equal(fixture.session.model?.id, fixture.model.id);
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
        await rm(configPath, { force: true });
      }
    });
  }
}
