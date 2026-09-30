import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { capableModel, deriveEndpoint, normalizeUrl, sameBackend, sameModel } from "./capability.js";

function model(overrides: Record<string, unknown> = {}): Model<Api> {
  return {
    id: "gpt-example",
    name: "GPT Example",
    api: "openai-codex-responses",
    provider: "custom-codex",
    baseUrl: "https://codex-gateway.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    ...overrides,
  } as Model<Api>;
}

const configuredCompat = {
  remoteCompaction: {
    protocol: "v2",
    endpoint: "https://codex-gateway.example/v1/responses",
  },
};

test("enables the official OpenAI Codex endpoint without model metadata", () => {
  const supported = capableModel(
    model({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: undefined,
    }),
  );
  assert.ok(supported);
  assert.equal(
    supported?.identity.endpoint,
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("derives an OpenAI Responses endpoint from models.json capability metadata", () => {
  const supported = capableModel(
    model({
      api: "openai-responses",
      compat: { remoteCompaction: { protocol: "v2" } },
    }),
  );
  assert.equal(supported?.model.api, "openai-responses");
  assert.equal(supported?.identity.baseUrl, "https://codex-gateway.example/v1");
  assert.deepEqual(supported?.identity, {
    provider: "custom-codex", api: "openai-responses", modelId: "gpt-example",
    baseUrl: "https://codex-gateway.example/v1",
    endpoint: "https://codex-gateway.example/v1/responses",
  });
});

test("preserves the base path used by Pi's OpenAI Responses adapter", () => {
  assert.equal(
    deriveEndpoint("https://codex-gateway.example", "openai-responses"),
    "https://codex-gateway.example/responses",
  );
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/v1", "openai-responses"),
    "https://codex-gateway.example/v1/responses",
  );
});

test("derives the endpoint used by the Codex Responses API", () => {
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/backend-api", "openai-codex-responses"),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/backend-api/codex", "openai-codex-responses"),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
  assert.equal(
    deriveEndpoint(
      "https://codex-gateway.example/backend-api/codex/responses",
      "openai-codex-responses",
    ),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
});

test("allows an explicit same-origin endpoint override", () => {
  const supported = capableModel(model({ compat: configuredCompat }));
  assert.equal(
    supported?.identity.endpoint,
    "https://codex-gateway.example/v1/responses",
  );

  const unversioned = capableModel(
    model({
      baseUrl: "https://codex-gateway.example",
      api: "openai-responses",
      compat: {
        remoteCompaction: {
          protocol: "v2",
          endpoint: "https://codex-gateway.example/responses",
        },
      },
    }),
  );
  assert.equal(unversioned?.identity.endpoint, "https://codex-gateway.example/responses");
});

test("accepts capabilities inherited from providers or applied by modelOverrides", () => {
  const inherited = model({ compat: configuredCompat });
  const overridden = model({ compat: { ...configuredCompat, supportsToolSearch: true } });
  assert.ok(capableModel(inherited));
  assert.ok(capableModel(overridden));
});

test("rejects missing, malformed, cross-origin, and unsupported capabilities", () => {
  assert.equal(capableModel(model()), undefined);
  assert.equal(capableModel(model({ compat: { remoteCompaction: true } })), undefined);
  assert.equal(
    capableModel(
      model({ compat: { remoteCompaction: { protocol: "v2", endpoint: 42 } } }),
    ),
    undefined,
  );
  assert.equal(
    capableModel(
      model({
        compat: {
          remoteCompaction: {
            protocol: "v3",
            endpoint: "https://codex-gateway.example/v1/responses",
          },
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    capableModel(
      model({
        compat: {
          remoteCompaction: {
            protocol: "v2",
            endpoint: "https://other.example/v1/responses",
          },
        },
      }),
    ),
    undefined,
  );
  assert.equal(capableModel(model({ api: "openai-completions", compat: configuredCompat })), undefined);
});

test("normalizes safe URLs and rejects ambiguous endpoint identities", () => {
  assert.equal(normalizeUrl("https://example.test/v1/"), "https://example.test/v1");
  assert.throws(() => normalizeUrl("https://user:pass@example.test/v1"), /credentials/);
  assert.throws(() => normalizeUrl("https://example.test/v1?route=a"), /query/);
});

test("compares provider, API and model ID independently of endpoint identity", () => {
  const identity = { provider: "custom-codex", api: "openai-responses" as const, modelId: "fixture",
    baseUrl: "https://configured.example/v1", endpoint: "https://configured.example/v1/responses" };
  const prepared = { provider: identity.provider, api: identity.api, id: identity.modelId, baseUrl: "https://resolved.example/v1" };
  assert.equal(sameModel(identity, prepared), true);
  assert.equal(sameModel(identity, { ...prepared, provider: "other" }), false);
  assert.equal(sameModel(identity, { ...prepared, api: "openai-codex-responses" }), false);
  assert.equal(sameModel(identity, { ...prepared, id: "other" }), false);
  assert.equal(sameBackend(identity, { ...identity }), true);
  assert.equal(sameBackend(identity, { ...identity, modelId: "other" }), true);
  assert.equal(sameBackend(identity, { ...identity, provider: "other" }), false);
  assert.equal(sameBackend(identity, { ...identity, api: "openai-codex-responses" }), false);
  assert.equal(sameBackend(identity, { ...identity, baseUrl: prepared.baseUrl }), false);
  assert.equal(sameBackend(identity, { ...identity, endpoint: "https://configured.example/other" }), false);
});
