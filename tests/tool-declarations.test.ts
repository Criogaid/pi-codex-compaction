import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createCodexCompactionExtension } from "../src/index.js";
import { isObject, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

function hiddenLoadout(initial: string[], onReady: (pi: ExtensionAPI) => void, hideInternal = () => true): ExtensionFactory {
  return (pi) => {
    for (const name of ["router", "internal_read", "visible_read", "retired_read"]) {
      pi.registerTool({
        name, label: name, description: `Fixture ${name}`, parameters: { type: "object", properties: {} },
        prepareLoadout: name === "router" ? () => ({ hiddenDeclarations: hideInternal() ? ["internal_read"] : [] }) : undefined,
        execute: async () => ({ content: [{ type: "text", text: "fixture-result" }], details: {} }),
      });
    }
    pi.registerTool({
      name: "grammar_read", label: "grammar_read", description: "Read with a grammar-constrained input",
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
      constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } },
      execute: async (_id, parameters) => {
        assert.deepEqual(parameters, { code: "fixture" });
        return { content: [{ type: "text", text: "grammar-result" }], details: {} };
      },
    });
    pi.on("session_start", () => { pi.setActiveTools(initial); onReady(pi); });
  };
}

function declarations(payload: JsonObject) {
  assert.ok(Array.isArray(payload.input) && payload.input.every(isObject));
  return {
    tools: payload.tools ?? [],
    additions: payload.input.filter((item) => item.type === "additional_tools" || item.type === "tool_search_output"),
  };
}

function toolHistory(payload: JsonObject) {
  assert.ok(Array.isArray(payload.input) && payload.input.every(isObject));
  return payload.input.filter((item) => item.type === "function_call" || item.type === "function_call_output"
    || item.type === "custom_tool_call" || item.type === "custom_tool_call_output");
}

function toolCallResponse(): Response {
  const functionCall = { type: "function_call", id: "fc_fixture_router", call_id: "call_fixture_router", name: "router", arguments: "{}", status: "completed" };
  const customCall = { type: "custom_tool_call", id: "ctc_fixture_grammar", call_id: "call_fixture_grammar", name: "grammar_read", input: "fixture", status: "completed" };
  const events = [
    { type: "response.created", response: { id: "resp_fixture_router" } },
    { type: "response.output_item.added", output_index: 0, item: { ...functionCall, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
    { type: "response.output_item.done", output_index: 0, item: functionCall },
    { type: "response.output_item.added", output_index: 1, item: { ...customCall, input: "", status: "in_progress" } },
    { type: "response.custom_tool_call_input.delta", output_index: 1, delta: "fixture" },
    { type: "response.output_item.done", output_index: 1, item: customCall },
    { type: "response.completed", response: { id: "resp_fixture_router", status: "completed", output: [functionCall, customCall],
      usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const prompt = (turn: number) => `Task ${turn}. ${"Preserve the current implementation constraints. ".repeat(60)}`;

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  for (const change of ["thinking", "additions", "removal", "tool search"] as const) {
    test(`${api} compaction omits schemas after ${change} while ordinary requests keep their visible declarations`, { timeout: 20_000 }, async () => {
      let controls: ExtensionAPI | undefined;
      const additive = change === "additions" || change === "tool search";
      const initial = additive ? ["router"]
        : change === "removal" ? ["router", "internal_read", "retired_read"] : ["router", "internal_read", "grammar_read"];
      let calledTools = false;
      const fixture = await sessionFixture({ api, extensions: [
        hiddenLoadout(initial, (pi) => { controls = pi; }), createCodexCompactionExtension(),
      ], respond: () => {
        if (change !== "thinking" || calledTools) return undefined;
        calledTools = true;
        return toolCallResponse();
      } });
      try {
        if (change === "tool search") Object.assign(fixture.model.compat ??= {}, { supportsAdditionalTools: false, supportsToolSearch: true });
        if (change === "thinking") Object.assign(fixture.model.compat ??= {}, { supportsOpenAIGrammarTools: true });
        await fixture.session.prompt(prompt(1));
        assert.ok(controls);
        if (change !== "thinking") controls.setActiveTools(["router", "internal_read", "visible_read"]);
        await fixture.session.prompt(prompt(2));
        await fixture.session.prompt(prompt(3));
        const ordinaryPayload = fixture.requests.at(-1)!.payload;
        const ordinary = declarations(ordinaryPayload);
        assert.doesNotMatch(JSON.stringify(ordinary), /internal_read/);
        if (change !== "thinking") assert.match(JSON.stringify(ordinary), /visible_read/);
        if (additive) {
          assert.equal(ordinary.additions.length, 1, "ordinary tool additions stay anchored in history");
          assert.equal(ordinary.additions[0].type, change === "tool search" ? "tool_search_output" : "additional_tools");
        }
        if (change === "removal") assert.equal(ordinary.additions.length, 0, "Pi flattens non-additive tool changes");
        if (change === "thinking") {
          const history = toolHistory(ordinaryPayload);
          assert.equal(history.length, 4, "the real agent executed both provider-issued tool calls");
          assert.equal(history.find((item) => item.type === "function_call_output")?.output, "fixture-result");
          assert.equal(history.find((item) => item.type === "custom_tool_call")?.input, "fixture");
          assert.equal(history.find((item) => item.type === "custom_tool_call_output")?.output, "grammar-result");
          fixture.session.setThinkingLevel("high");
        }
        await fixture.session.compact();
        const compacting = fixture.requests.at(-1)!.payload;
        assert.ok(Array.isArray(compacting.input) && compacting.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
        assert.deepEqual(declarations(compacting), { tools: [], additions: [] });
        assert.deepEqual(toolHistory(compacting), toolHistory(ordinaryPayload), "compaction retains actual tool calls and results");
        if (change === "thinking") assert.deepEqual(compacting.reasoning, { effort: "high", summary: "auto" });
        if (change === "tool search") assert.ok(!compacting.input.some((item) => isObject(item) && item.type === "tool_search_call"), "removing synthetic tool-search declarations leaves no orphaned call");
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
      }
    });
  }

  for (const change of ["reload", "unobserved loadout"] as const) {
    test(`${api} compacts without schemas after ${change}`, { timeout: 20_000 }, async () => {
      let controls: ExtensionAPI | undefined;
      const fixture = await sessionFixture({ api, extensions: [
        hiddenLoadout(["router", "internal_read"], (pi) => { controls = pi; }), createCodexCompactionExtension(),
      ] });
      try {
        for (let turn = 1; turn <= 3; turn++) await fixture.session.prompt(prompt(turn));
        const ordinary = declarations(fixture.requests.at(-1)!.payload);
        assert.match(JSON.stringify(ordinary), /router/);
        assert.doesNotMatch(JSON.stringify(ordinary), /internal_read/);
        if (change === "reload") await fixture.reopen();
        else {
          assert.ok(controls);
          controls.setActiveTools(["router", "internal_read", "visible_read"]);
        }
        await fixture.session.compact();
        const compacting = fixture.requests.at(-1)!.payload;
        assert.ok(Array.isArray(compacting.input) && compacting.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
        assert.deepEqual(declarations(compacting), { tools: [], additions: [] });
        assert.ok(fixture.session.sessionManager.getBranch().some((entry) => entry.type === "compaction" && isObject(entry.details) && entry.details.kind === "pi-codex-compaction"));
        assert.deepEqual(fixture.errors, []);
      } finally {
        await fixture.close();
      }
    });
  }

  test(`${api} immediate compaction omits schemas after a hide-only command leaves public state unchanged`, { timeout: 20_000 }, async () => {
    let controls: ExtensionAPI | undefined;
    let context: ExtensionContext | undefined;
    let hidden = false;
    const fixture = await sessionFixture({ api, extensions: [
      hiddenLoadout(["router", "internal_read"], (pi) => { controls = pi; }, () => hidden),
      (pi) => {
        pi.registerCommand("hide-internal", { description: "Hide the internal schema", handler: async () => {
          hidden = true;
          pi.setActiveTools(["router", "internal_read"]);
        } });
        pi.on("session_start", (_event, ctx) => { context = ctx; });
      },
      createCodexCompactionExtension(),
    ] });
    try {
      for (let turn = 1; turn <= 3; turn++) await fixture.session.prompt(prompt(turn));
      assert.ok(controls && context);
      const pi = controls;
      const ctx = context;
      assert.match(JSON.stringify(declarations(fixture.requests.at(-1)!.payload)), /internal_read/);
      const publicState = () => JSON.stringify({
        model: ctx.model, activeTools: pi.getActiveTools(), tools: pi.getAllTools(), settings: pi.getSettings(),
        thinkingLevel: pi.getThinkingLevel(), systemPrompt: ctx.getSystemPrompt(), branchEntries: ctx.sessionManager.getBranch(),
      });
      const before = publicState();
      const requestCount = fixture.requests.length;
      await fixture.session.prompt("/hide-internal");
      assert.equal(hidden, true);
      assert.equal(fixture.requests.length, requestCount, "the command does not prepare another ordinary request");
      assert.equal(publicState(), before, "Pi exposes no revision for this hidden-declaration change");
      await fixture.session.compact();
      const compacting = fixture.requests.at(-1)!.payload;
      assert.ok(Array.isArray(compacting.input) && compacting.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
      assert.deepEqual(declarations(compacting), { tools: [], additions: [] });
      await fixture.session.prompt("Continue with the current visible tool loadout.");
      const ordinary = declarations(fixture.requests.at(-1)!.payload);
      assert.match(JSON.stringify(ordinary), /router/);
      assert.doesNotMatch(JSON.stringify(ordinary), /internal_read/);
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}
