import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { capableModel, type CompactionModelMetadata, type ProviderIdentity } from "../src/capability.js";
import { assessModelTransition } from "../src/model-transition.js";

const identity: ProviderIdentity = {
  provider: "custom-codex",
  api: "openai-responses",
  modelId: "gpt-source",
  baseUrl: "https://gateway.example/v1",
  endpoint: "https://gateway.example/v1/responses",
};

function target(overrides: Record<string, unknown> = {}, compactionModelHash?: string) {
  const model = {
    id: identity.modelId,
    name: "Fixture",
    provider: identity.provider,
    api: identity.api,
    baseUrl: identity.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    compat: { remoteCompaction: { protocol: "v2", compactionModelHash } },
    ...overrides,
  } as Model<Api>;
  const supported = capableModel(model);
  assert.ok(supported);
  return supported;
}

test("keeps legacy same-model replay distinct from verified compatibility", () => {
  assert.deepEqual(assessModelTransition(identity, target()), {
    compatibility: "same-model",
    modelChanged: false,
    targetContextWindow: 100_000,
    downsizing: undefined,
  });
  assert.equal(assessModelTransition({ ...identity, compactionModelHash: "source-hash" }, target()).compatibility, "same-model");
  assert.equal(assessModelTransition(identity, target({}, "target-hash")).compatibility, "same-model");
});

test("reports changed models without comparable hashes as unknown on both Responses backends", () => {
  for (const api of ["openai-responses", "openai-codex-responses"] as const) {
    const source = { ...identity, api, endpoint: api === "openai-responses"
      ? identity.endpoint : "https://gateway.example/v1/codex/responses" };
    for (const [sourceHash, targetHash] of [[undefined, undefined], ["family-A", undefined], [undefined, "family-A"]]) {
      const result = assessModelTransition({ ...source, compactionModelHash: sourceHash }, target({ api, id: "gpt-target" }, targetHash));
      assert.equal(result.compatibility, "unknown");
      assert.equal(result.modelChanged, true);
    }
  }
});

test("compares known hashes exactly and checks revisions even when the model ID stays the same", () => {
  const source = { ...identity, compactionModelHash: "family-A" };
  for (const id of [identity.modelId, "gpt-target"]) {
    assert.equal(assessModelTransition(source, target({ id }, "family-A")).compatibility, "matching-hash");
    for (const hash of ["family-B", "family-a"]) {
      assert.equal(assessModelTransition(source, target({ id }, hash)).compatibility, "mismatched-hash");
    }
  }
});

test("matching hashes never override a provider, API, or resolved endpoint boundary", () => {
  const source = { ...identity, compactionModelHash: "family-A" };
  for (const overrides of [
    { provider: "another-provider" },
    { api: "openai-codex-responses" },
    { baseUrl: "https://another-gateway.example/v1" },
    { compat: { remoteCompaction: { protocol: "v2", compactionModelHash: "family-A", endpoint: "https://gateway.example/other" } } },
  ]) {
    assert.equal(assessModelTransition(source, target(overrides, "family-A")).compatibility, "different-backend");
  }
  const supported = target({}, "family-A");
  const resolved = capableModel(supported.model, "https://resolved.example/v1");
  assert.ok(resolved);
  assert.equal(assessModelTransition(source, resolved).compatibility, "different-backend");
});

test("reports a smaller physical window separately from opaque compatibility", () => {
  const source = { ...identity, modelContextWindow: 200_000, compactionModelHash: "family-A" };
  for (const [contextWindow, downsizing] of [[100_000, true], [200_000, false], [300_000, false]] as const) {
    const result = assessModelTransition(source, target({ id: "gpt-target", contextWindow }, "family-A"));
    assert.deepEqual(result, {
      compatibility: "matching-hash", modelChanged: true,
      sourceContextWindow: 200_000, targetContextWindow: contextWindow, downsizing,
    });
  }
  assert.equal(assessModelTransition(source, target({ contextWindow: 100_000 }, "family-B")).downsizing, true);
  assert.equal(assessModelTransition(source, target({ contextWindow: 100_000 }, "family-B")).compatibility, "mismatched-hash");
});

test("leaves downsizing unknown when either optional window is missing or invalid", () => {
  for (const modelContextWindow of [undefined, 0, -1, NaN, Infinity]) {
    const source = { ...identity, modelContextWindow };
    const result = assessModelTransition(source, target({ id: "gpt-target", contextWindow: 1 }));
    assert.equal(result.downsizing, undefined);
    assert.equal(result.compatibility, "unknown");
    assert.equal(Object.hasOwn(result, "sourceContextWindow"), false);
  }
  const result = assessModelTransition({ ...identity, modelContextWindow: 200_000 }, target({ contextWindow: NaN }));
  assert.equal(result.downsizing, undefined);
  assert.equal(Object.hasOwn(result, "targetContextWindow"), false);
});

test("invalid compatibility metadata cannot make unknown models match", () => {
  const source: ProviderIdentity & CompactionModelMetadata = { ...identity, compactionModelHash: " padded-hash " };
  const result = assessModelTransition(source, target({ id: "gpt-target" }, " padded-hash "));
  assert.equal(result.compatibility, "unknown");
});
