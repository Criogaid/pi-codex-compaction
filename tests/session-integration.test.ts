import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { createCodexCompactionExtension } from "../src/index.js";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { isObject } from "../src/protocol.js";
import { isolateAgentConfig, legacyCheckpointSummary, sessionFixture } from "./helpers.js";

isolateAgentConfig();

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`real ${api} session saves, restores, and recompacts V2 history`, { timeout: 20_000 }, async () => {
    const fixture = await sessionFixture({ api, extensions: [createCodexCompactionExtension()] });
    try {
      for (let turn = 1; turn <= 3; turn++) {
        await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
      }
      const sessionId = fixture.session.sessionManager.getSessionId();
      await fixture.session.compact();
      const firstEntry = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(firstEntry);
      const first = parseCheckpointDetails(firstEntry.details);
      assert.ok(first, "Real session compaction must save an opaque V2 checkpoint");
      assert.equal(fixture.session.model?.id, fixture.model.id);
      assert.equal(fixture.session.thinkingLevel, "low");

      await fixture.session.prompt("Continue the task after compaction. ".repeat(40));
      const continuation = fixture.requests.at(-1)?.payload;
      assert.ok(continuation && Array.isArray(continuation.input));
      assert.ok(continuation.input.some((item) => isObject(item) && item.type === "compaction"));
      assert.ok(!JSON.stringify(continuation).includes("PI_CODEX_REMOTE_CHECKPOINT"));
      assert.ok(!JSON.stringify(continuation).includes("Fixture reply 1."));

      await fixture.reopen();
      assert.equal(fixture.session.sessionManager.getSessionId(), sessionId);
      await fixture.session.prompt("Resume the saved session and preserve its decisions. ".repeat(40));
      const restored = fixture.requests.at(-1)?.payload;
      assert.ok(restored && Array.isArray(restored.input));
      assert.ok(restored.input.some((item) => isObject(item) && item.type === "compaction"));
      assert.ok(!JSON.stringify(restored).includes("PI_CODEX_REMOTE_CHECKPOINT"));

      await fixture.session.compact();
      const secondEntry = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(secondEntry);
      const second = parseCheckpointDetails(secondEntry.details);
      assert.ok(second);
      assert.notEqual(second.checkpointId, first.checkpointId);
      const compactRequests = fixture.requests.filter(({ payload }) => Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
      assert.equal(compactRequests.length, 2);
      const secondRequest = compactRequests[1];
      assert.ok(Array.isArray(secondRequest.payload.input));
      assert.ok(secondRequest.payload.input.some((item) => isObject(item) && item.type === "compaction"));
      for (const request of compactRequests) {
        assert.match(request.headers.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
      }
      await fixture.session.prompt("Continue after the second compaction.");
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}

function requestTransform(onReady?: (pi: ExtensionAPI) => void): ExtensionFactory {
  return (pi) => {
    const parameters = { type: "object", properties: {} };
    for (const name of ["router", "internal_read"]) {
      pi.registerTool({
        name, label: name, description: `Fixture ${name}`, parameters,
        prepareLoadout: name === "router" ? () => ({ hiddenDeclarations: ["internal_read"] }) : undefined,
        execute: async () => ({ content: [{ type: "text", text: "fixture-result" }], details: {} }),
      });
    }
    pi.on("session_start", () => { pi.setActiveTools(["router", "internal_read"]); onReady?.(pi); });
    pi.on("before_provider_request", (event) => {
      assert.ok(isObject(event.payload));
      return { ...event.payload, instructions: "fixture-wire-instructions",
        reasoning: { effort: "medium", summary: "auto" }, prompt_cache_key: "fixture-cache-key",
        prompt_cache_retention: "24h", service_tier: "priority", text: { verbosity: "low" },
        previous_response_id: "fixture-response-anchor", max_output_tokens: 123,
      };
    });
  };
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`real ${api} compaction reuses observed instructions and cache fields without schemas or old response state`, { timeout: 20_000 }, async () => {
    const fixture = await sessionFixture({ api, extensions: [requestTransform(), createCodexCompactionExtension()] });
    try {
      for (let turn = 1; turn <= 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Preserve the implementation constraints. ".repeat(60)}`);
      const ordinary = fixture.requests.at(-1)?.payload;
      assert.ok(ordinary);
      await fixture.session.compact();
      const compacting = fixture.requests.at(-1)?.payload;
      assert.ok(compacting && Array.isArray(compacting.input));
      assert.ok(compacting.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
      for (const field of ["instructions", "reasoning", "prompt_cache_key", "prompt_cache_retention", "service_tier", "text"]) {
        assert.deepEqual(compacting[field], ordinary[field], `Compaction must preserve the observed ${field}`);
      }
      assert.ok(Array.isArray(ordinary.tools) && ordinary.tools.length > 0);
      assert.equal(compacting.tools, undefined, "V2 cannot verify the current Pi tool visibility");
      assert.ok(Array.isArray(ordinary.input));
      assert.deepEqual(compacting.input.slice(0, ordinary.input.length), ordinary.input);
      assert.equal(compacting.previous_response_id, undefined);
      assert.notEqual(compacting.max_output_tokens, ordinary.max_output_tokens);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}

test("real session drops observed request fields when thinking or active tools change", { timeout: 20_000 }, async () => {
  for (const change of ["thinking", "tools"] as const) {
    let controls: ExtensionAPI | undefined;
    const fixture = await sessionFixture({ extensions: [requestTransform((pi) => { controls = pi; }), createCodexCompactionExtension()] });
    try {
      for (let turn = 1; turn <= 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the current decisions. ".repeat(80)}`);
      assert.ok(controls);
      if (change === "thinking") fixture.session.setThinkingLevel("high");
      else controls.setActiveTools(["router"]);
      await fixture.session.compact();
      const payload = fixture.requests.at(-1)?.payload;
      assert.ok(payload && Array.isArray(payload.input));
      assert.ok(payload.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
      assert.equal(payload.service_tier, undefined);
      assert.notEqual(payload.prompt_cache_key, "fixture-cache-key");
      if (change === "thinking") assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  }
});

test("a saved v1 checkpoint resumes through a real session after the package rename", { timeout: 20_000 }, async () => {
  const fixture = await sessionFixture({ extensions: [createCodexCompactionExtension()] });
  try {
    for (let turn = 1; turn <= 3; turn++) await fixture.session.prompt(`Task ${turn}. ${"Keep the existing history. ".repeat(80)}`);
    await fixture.session.compact();
    const file = fixture.session.sessionManager.getSessionFile();
    assert.ok(file);
    const persisted = await readFile(file, "utf8");
    let changed = 0;
    const legacy = persisted.split("\n").map((line) => {
      if (!line.trim()) return line;
      const entry: unknown = JSON.parse(line);
      if (!isObject(entry) || entry.type !== "compaction") return line;
      const details = parseCheckpointDetails(entry.details);
      assert.ok(details);
      changed++;
      return JSON.stringify({ ...entry, summary: legacyCheckpointSummary(details.checkpointId) });
    }).join("\n");
    assert.equal(changed, 1);
    await writeFile(file, legacy);
    await fixture.reopen();
    await fixture.session.prompt("Continue using the saved history.");
    const payload = fixture.requests.at(-1)?.payload;
    assert.ok(payload && Array.isArray(payload.input));
    assert.ok(payload.input.some((item) => isObject(item) && item.type === "compaction"));
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});
