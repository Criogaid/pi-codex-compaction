import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, test } from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createCodexCompactionExtension } from "../src/index.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import { isolateAgentConfig, testRegistry } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const settingsDirectory = dirname(settingsPath);
const model: Model<"openai-responses"> = {
  id: "cheap/model", name: "Cheap model", provider: "cheap", api: "openai-responses",
  baseUrl: "https://example.test/v1", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 10_000,
};
const currentSettings = '\uFEFF{\r\n  "version": 1,\r\n  "fallback": {"provider":"cheap","model":"cheap/model","thinkingLevel":"low"}\r\n}\r\n';
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Choice = string | undefined | ((options: readonly string[]) => Promise<string | undefined>);
const firstChoice: Choice = async (options) => options[0];
const switchChoice: Choice = async (options) => options[1];
const modelChoice: Choice = async (options) => options[2];

beforeEach(() => rm(settingsDirectory, { recursive: true, force: true }));

async function writeSettings(text = currentSettings) {
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(settingsPath, text);
}

async function fixture(choices: readonly Choice[], availableModel: Model<"openai-responses"> = model, hasUI = true, additionalModels: readonly Model<"openai-responses">[] = []) {
  const commands = new Map<string, Command>();
  // Exercise registration through the real extension entrypoint; lifecycle handlers are not invoked here.
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on() {}, registerEntryRenderer() {},
  } as unknown as ExtensionAPI;
  createCodexCompactionExtension()(pi);
  const rejectCompletion = () => { throw new Error("The settings command must not request a completion"); };
  const provider: Provider<"openai-responses"> = {
    id: "cheap", name: "Cheap provider", baseUrl: model.baseUrl, auth: {} as Provider["auth"],
    getModels: () => [availableModel, ...additionalModels],
    stream: rejectCompletion, streamSimple: rejectCompletion,
  };
  const registry = await testRegistry(provider);
  await registry.refresh({ allowNetwork: false });
  const dialogs: Array<{ title: string; options: string[] }> = [];
  const notices: Array<{ message: string; level: string | undefined }> = [];
  const remaining = [...choices];
  const ctx = {
    hasUI, modelRegistry: registry, model: { ...model, id: "chat-model" }, thinkingLevel: "off",
    ui: {
      async input() { return ""; },
      async select(title: string, options: string[]) {
        dialogs.push({ title, options });
        const choice = remaining.shift();
        return typeof choice === "function" ? choice(options) : choice;
      },
      notify(message: string, level?: string) { notices.push({ message, level }); },
    },
  } as unknown as ExtensionCommandContext;
  const command = commands.get("codex-compaction");
  assert.ok(command);
  return { ctx, dialogs, notices, run: (args = "") => command.handler(args, ctx) };
}

test("the command saves an available model and its supported thinking level without changing the chat model", async () => {
  const current = await fixture([modelChoice, firstChoice, "high"]);
  const chatModel = current.ctx.model;
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
  assert.equal(current.ctx.model, chatModel);
  assert.equal(current.ctx.thinkingLevel, "off");
  assert.ok(current.notices.some((notice) => notice.message.includes("cheap/cheap/model (high)") && notice.level === "info"));
  assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
});

for (const stage of ["action", "model", "thinking"] as const) {
  test(`cancelling the ${stage} selector preserves existing settings byte for byte`, async () => {
    await writeSettings();
    const choices = stage === "action" ? [undefined] : stage === "model" ? [modelChoice, undefined] : [modelChoice, firstChoice, undefined];
    const current = await fixture(choices);
    await current.run();
    assert.equal(await readFile(settingsPath, "utf8"), currentSettings);
    assert.match(current.dialogs[0].title, /cheap\/cheap\/model \(low\)/);
    assert.deepEqual(current.notices, []);
  });
}

test("cancelling an unconfigured command creates no configuration file", async () => {
  const current = await fixture([modelChoice, firstChoice, undefined]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("fallback can be switched off and back on without losing the saved model or thinking level", async () => {
  await writeSettings();
  const disabled = await fixture([switchChoice]);
  await disabled.run();
  assert.equal(disabled.dialogs[0].options[1], "Use separate summary model: On");
  assert.equal(disabled.dialogs.length, 1);
  const selection = { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "low" };
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, remoteCompaction: { enabled: true }, fallback: selection });
  assert.match(disabled.notices[0].message, /Pi will use the chat model/);

  const enabled = await fixture([switchChoice]);
  await enabled.run();
  assert.equal(enabled.dialogs[0].options[1], "Use separate summary model: Off");
  assert.equal(enabled.dialogs.length, 1);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, remoteCompaction: { enabled: true }, fallback: { ...selection, enabled: true } });
  assert.match(enabled.notices[0].message, /cheap\/cheap\/model \(low\)/);
});

test("enabling without a model saves only the switch and remains inactive", async () => {
  const current = await fixture([switchChoice]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: true } });
  assert.equal(current.dialogs.length, 1);
  assert.match(current.notices[0].message, /No separate summary model configured; inactive/);
});

test("configuring a model after enabling the switch preserves the on state", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { enabled: true } }));
  const current = await fixture([modelChoice, firstChoice, "high"]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
});

test("changing the model or thinking level while disabled preserves the off state", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { enabled: false, provider: "removed", model: "old", thinkingLevel: "low" } }));
  const current = await fixture([modelChoice, firstChoice, "high"]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
  assert.match(current.notices[0].message, /Off/);
});

test("a settings action outside the offered choices cannot be saved", async () => {
  await writeSettings();
  const current = await fixture(["unlisted action"]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), currentSettings);
  assert.equal(current.notices[0].level, "error");
});

test("only off is offered for a model without reasoning", async () => {
  const current = await fixture([modelChoice, firstChoice, firstChoice], { ...model, reasoning: false });
  await current.run();
  assert.deepEqual(current.dialogs[2].options, ["off"]);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).fallback.thinkingLevel, "off");
});

test("a thinking level outside the offered choices cannot be saved", async () => {
  const current = await fixture([modelChoice, firstChoice, "high"], { ...model, reasoning: false });
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.equal(current.notices[0].level, "error");
});

test("a model outside the offered choices cannot be saved", async () => {
  const current = await fixture([modelChoice, "unlisted model"]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.equal(current.notices[0].level, "error");
});

test("an unavailable saved model can be replaced without being used for authentication or completion", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { provider: "removed", model: "old", thinkingLevel: "high" } }));
  const current = await fixture([modelChoice, firstChoice, "off"]);
  await current.run();
  assert.match(current.dialogs[0].title, /removed\/old \(high\)/);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).fallback.provider, model.provider);
});

test("external edits made during the menu are preserved and reported as a conflict", async () => {
  await writeSettings();
  const replacement = JSON.stringify({ version: 1, fallback: { provider: "other", model: "changed", thinkingLevel: "off" } });
  const current = await fixture([modelChoice, firstChoice, async () => {
    await writeFile(settingsPath, replacement);
    return "high";
  }]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), replacement);
  assert.match(current.notices[0].message, /changed while the menu was open/);
  assert.equal(current.notices[0].level, "error");
  assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
});

test("a newly created configuration is not overwritten by an older unconfigured menu", async () => {
  const current = await fixture([modelChoice, firstChoice, async () => {
    await writeSettings();
    return "high";
  }]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), currentSettings);
  assert.match(current.notices[0].message, /changed while the menu was open/);
});

test("malformed configuration is not overwritten or echoed to the UI", async () => {
  const secret = "private-invalid-configuration";
  await writeSettings(secret);
  const current = await fixture([modelChoice, firstChoice, "high"]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), secret);
  assert.deepEqual(current.dialogs, []);
  assert.equal(current.notices[0].level, "error");
  assert.doesNotMatch(current.notices[0].message, /private-invalid-configuration/);
});

test("headless invocation leaves settings untouched", async () => {
  const current = await fixture([], model, false);
  await current.run();
  assert.deepEqual(current.dialogs, []);
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.match(current.notices[0].message, /requires interactive or RPC mode/);
});

test("unexpected arguments return usage without changing settings", async () => {
  const current = await fixture([]);
  await current.run("unexpected");
  assert.deepEqual(current.dialogs, []);
  assert.match(current.notices[0].message, /Usage: \/codex-compaction/);
});

test("an atomic settings update does not replace a symbolic link", async (t) => {
  await mkdir(settingsDirectory, { recursive: true });
  const target = join(settingsDirectory, "target.json");
  await writeFile(target, currentSettings);
  try {
    await symlink(target, settingsPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Creating file symlinks requires platform privileges");
      return;
    }
    throw error;
  }
  const current = await fixture([modelChoice, firstChoice, "high"]);
  await current.run();
  assert.equal(await readFile(target, "utf8"), currentSettings);
  assert.match(current.notices[0].message, /symbolic link/);
  assert.deepEqual(await readdir(settingsDirectory), ["config.json", "target.json"]);
});

type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];

function driveTui(current: Awaited<ReturnType<typeof fixture>>, screens: readonly (readonly string[])[], observeFrame?: (lines: readonly string[]) => void) {
  initTheme("dark", false);
  current.ctx.mode = "tui";
  const remaining = [...screens];
  const rendered: string[] = [];
  current.ctx.ui.custom = async <T>(factory: (tui: Parameters<CustomFactory>[0], theme: Parameters<CustomFactory>[1], keys: Parameters<CustomFactory>[2], done: (result: T) => void) => ReturnType<CustomFactory>): Promise<T> => {
    const result = Promise.withResolvers<T>();
    // Supply only the host surface used by these real Pi widgets; no terminal is started.
    const component = await factory(
      { requestRender() {} } as Parameters<CustomFactory>[0],
      {} as Parameters<CustomFactory>[1],
      getKeybindings() as Parameters<CustomFactory>[2],
      result.resolve,
    );
    const keys = remaining.shift();
    assert.ok(keys, "Unexpected extra screen");
    for (const key of keys) {
      rendered.push(...component.render(80));
      const frame = component.render(1_000);
      rendered.push(...frame);
      observeFrame?.(frame);
      component.handleInput?.(key);
    }
    rendered.push(...component.render(32));
    component.dispose?.();
    return result.promise;
  };
  return rendered;
}

test("TUI Enter toggles twice on the same settings row without a secondary screen", async () => {
  await writeSettings();
  const current = await fixture([]);
  const rendered = driveTui(current, [["\u001b[B", "\r"], ["\r"], ["\u001b"]]);
  await current.run();
  assert.equal(current.notices.length, 2);
  assert.equal(current.dialogs.length, 0);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
  });
  assert.match(rendered.join("\n"), /Use separate summary model/);
});

test("TUI fuzzy search filters models by name while keeping the switch off", async () => {
  const current = await fixture(["high"], model, true, [{ ...model, id: "aaa-unrelated", name: "Unrelated" }]);
  const rendered = driveTui(current, [["\u001b[B", "\u001b[B", "\r"], ["CheapModel", "\r"], ["\u001b"]]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
  assert.match(rendered.join("\n"), /type to search/);
});

test("TUI an unmatched search cannot select a model and Escape leaves settings unchanged", async () => {
  const current = await fixture([]);
  driveTui(current, [["\u001b[B", "\u001b[B", "\r"], ["no-such-model", "\r", "\u001b"], ["\u001b"]]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.deepEqual(current.notices, []);
});

test("RPC model search filters the offered choices", async () => {
  const current = await fixture([modelChoice, undefined]);
  current.ctx.ui.input = async () => "no-such-model";
  await current.run();
  assert.deepEqual(current.dialogs[1].options, []);
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("RPC V2 toggle saves the switch and preserves the fallback selection", async () => {
  await writeSettings();
  const current = await fixture([firstChoice]);
  await current.run();
  assert.deepEqual(current.dialogs[0].options, [
    "Remote Compaction V2: On", "Use separate summary model: On", "Summary model and thinking level",
  ]);
  assert.equal(current.dialogs.length, 1);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: false },
    fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
  });
  assert.match(current.notices[0].message, /Remote Compaction V2 is Off/);
  const enabled = await fixture([firstChoice]);
  await enabled.run();
  assert.equal(enabled.dialogs[0].options[0], "Remote Compaction V2: Off");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true },
    fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
  });
});

test("TUI V2 Enter toggles twice on the same row without opening a secondary screen", async () => {
  await writeSettings();
  const current = await fixture([]);
  const rendered = driveTui(current, [["\r"], ["\r"], ["\u001b"]]);
  await current.run();
  assert.equal(current.notices.length, 2);
  assert.match(current.notices[0].message, /V2 is Off/);
  assert.match(current.notices[1].message, /V2 is On/);
  assert.equal(current.dialogs.length, 0);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: true }, fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
  });
  const menu = rendered.join("\n");
  assert.ok(menu.indexOf("Remote Compaction V2") < menu.indexOf("Use separate summary model"));
  assert.ok(menu.indexOf("Use separate summary model") < menu.indexOf("Summary model and thinking level"));
});

test("native settings descriptions explain V2 routing and the separate summary model switch", async () => {
  const current = await fixture([]);
  const frames: string[] = [];
  driveTui(current, [["\u001b[B", "\u001b[B", "\u001b"]], (lines) => {
    frames.push(lines.map(stripVTControlCharacters).join("\n"));
  });
  await current.run();
  assert.match(frames[0], /When On, try V2 with the chat model/);
  assert.match(frames[0], /The settings below choose their model/);
  assert.match(frames[1], /Text summaries are used when V2 is off, unsupported, or fails/);
  assert.match(frames[1], /No separate summary model configured; inactive/);
  assert.match(frames[2], /used when "Use separate summary model" is On/);
  assert.match(frames[2], /Choosing a model does not enable the switch or change the chat model/);
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("RPC settings explain when the separate summary model is used", async () => {
  await writeSettings();
  const current = await fixture([undefined]);
  await current.run();
  assert.match(current.dialogs[0].title, /Text summaries are used when V2 is off, unsupported, or fails/);
  assert.match(current.dialogs[0].title, /Text summaries will use/);
  assert.deepEqual(current.dialogs[0].options, [
    "Remote Compaction V2: On", "Use separate summary model: On", "Summary model and thinking level",
  ]);
});

test("changing the fallback model preserves the V2 off switch", async () => {
  await writeSettings(JSON.stringify({ version: 1, remoteCompaction: { enabled: false }, fallback: { enabled: true } }));
  const current = await fixture([modelChoice, firstChoice, "high"]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: false },
    fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
});

test("changing the fallback switch preserves the V2 off switch", async () => {
  await writeSettings(JSON.stringify({ version: 1, remoteCompaction: { enabled: false } }));
  const current = await fixture([switchChoice]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, remoteCompaction: { enabled: false }, fallback: { enabled: true },
  });
});

test("V2 switch saves reject intervening edits without replacing the new settings", async () => {
  await writeSettings();
  const edited = JSON.stringify({ version: 1, remoteCompaction: { enabled: false }, fallback: { enabled: false } });
  const current = await fixture([async (options) => {
    await writeFile(settingsPath, edited);
    return options[0];
  }]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), edited);
  assert.equal(current.notices[0].level, "error");
  assert.match(current.notices[0].message, /changed while the menu was open/);
  assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
});

test("an invalid V2 switch prevents menu edits without exposing file contents", async () => {
  const invalid = JSON.stringify({ version: 1, remoteCompaction: { enabled: "private-file-value" } });
  await writeSettings(invalid);
  const current = await fixture([switchChoice]);
  await current.run();
  assert.equal(await readFile(settingsPath, "utf8"), invalid);
  assert.equal(current.dialogs.length, 0);
  assert.match(current.notices[0].message, /boolean enabled/);
  assert.doesNotMatch(current.notices[0].message, /private-file-value/);
});

const invalidFallback = { enabled: true, provider: "x" };
const invalidFallbackSettings = `\uFEFF{\r\n  "version": 1,\r\n  "fallback": ${JSON.stringify(invalidFallback)}\r\n}\r\n`;
const invalidFallbackError = `Could not read compaction settings at ${settingsPath}; fallback.model must be a non-empty model ID without surrounding whitespace`;

function assertInvalidTuiMenu(rendered: readonly string[]) {
  const lines = rendered.map(stripVTControlCharacters);
  assert.match(lines.join("\n"), /Use separate summary model\s+Invalid/);
  assert.match(lines.join("\n"), /Summary model and thinking level\s+Invalid/);
  assert.ok(lines.some((line) => line.trim() === invalidFallbackError), "the fallback row describes the exact settings error");
}

test("RPC opens an invalid fallback menu with its validation error and leaves cancellation unchanged", async () => {
  await writeSettings(invalidFallbackSettings);
  const current = await fixture([undefined]);
  await current.run();
  assert.deepEqual(current.dialogs, [{
    title: invalidFallbackError,
    options: ["Remote Compaction V2: On", "Use separate summary model: Invalid", "Summary model and thinking level"],
  }]);
  assert.deepEqual(current.notices, []);
  assert.equal(await readFile(settingsPath, "utf8"), invalidFallbackSettings);
});

test("TUI opens an invalid fallback menu with its validation error and leaves cancellation unchanged", async () => {
  await writeSettings(invalidFallbackSettings);
  const current = await fixture([]);
  const rendered = driveTui(current, [["\u001b[B", "\u001b"]]);
  await current.run();
  assertInvalidTuiMenu(rendered);
  assert.deepEqual(current.notices, []);
  assert.equal(await readFile(settingsPath, "utf8"), invalidFallbackSettings);
});

for (const mode of ["rpc", "tui"] as const) {
  for (const enabled of [true, false]) {
    test(`${mode} toggles V2 from ${enabled} while preserving the invalid fallback`, async () => {
      await writeSettings(JSON.stringify({ version: 1, remoteCompaction: { enabled }, fallback: invalidFallback }));
      const current = await fixture(mode === "rpc" ? [firstChoice] : []);
      const rendered = mode === "tui" ? driveTui(current, [["\r"], ["\u001b[B", "\u001b"]]) : undefined;
      await current.run();
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        version: 1, remoteCompaction: { enabled: !enabled }, fallback: invalidFallback,
      });
      assert.equal(current.notices.length, 1);
      assert.equal(current.notices[0].level, "info");
      assert.match(current.notices[0].message, enabled ? /V2 is Off/ : /V2 is On/);
      if (rendered) assertInvalidTuiMenu(rendered);
      else {
        assert.equal(current.dialogs[0].title, invalidFallbackError);
        assert.equal(current.dialogs[0].options[1], "Use separate summary model: Invalid");
      }
    });
  }

  test(`${mode} rejects an invalid fallback switch without writing settings${mode === "tui" ? " and keeps the selected row open" : ""}`, async () => {
    await writeSettings(invalidFallbackSettings);
    const current = await fixture(mode === "rpc" ? [switchChoice] : []);
    const rendered = mode === "tui" ? driveTui(current, [["\u001b[B", "\r"], ["\r"], ["\u001b"]]) : undefined;
    await current.run();
    assert.equal(await readFile(settingsPath, "utf8"), invalidFallbackSettings);
    assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
    assert.deepEqual(current.notices, Array.from({ length: mode === "tui" ? 2 : 1 }, () => ({
      message: `${invalidFallbackError}. Choose a model to replace it, or edit the file directly.`, level: "error",
    })));
    if (rendered) assertInvalidTuiMenu(rendered);
    else assert.equal(current.dialogs[0].title, invalidFallbackError);
  });

  test(`${mode} replaces an invalid fallback with a disabled selected model`, async () => {
    await writeSettings(JSON.stringify({ version: 1, remoteCompaction: { enabled: false }, fallback: invalidFallback }));
    const current = await fixture(mode === "rpc" ? [modelChoice, firstChoice, "high"] : ["high"]);
    if (mode === "tui") driveTui(current, [["\u001b[B", "\u001b[B", "\r"], ["CheapModel", "\r"], ["\u001b"]]);
    await current.run();
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 1, remoteCompaction: { enabled: false },
      fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
    });
    assert.equal(current.notices.length, 1);
    assert.equal(current.notices[0].level, "info");
    assert.match(current.notices[0].message, /Separate summary model is Off/);
  });

  test(`${mode} toggling V2 writes a normalized valid legacy fallback with explicit enabled`, async () => {
    await writeSettings();
    const current = await fixture(mode === "rpc" ? [firstChoice] : []);
    if (mode === "tui") driveTui(current, [["\r"], ["\u001b"]]);
    await current.run();
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 1, remoteCompaction: { enabled: false },
      fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
    });
    assert.equal(current.notices[0].level, "info");
  });
}

test("TUI invalid fallback model row explains how to replace the invalid settings", async () => {
  await writeSettings(invalidFallbackSettings);
  const current = await fixture([]);
  let selectedFrame: readonly string[] = [];
  driveTui(current, [["\u001b[B", "\u001b[B", "\u001b"]], (frame) => { selectedFrame = frame; });
  await current.run();
  const lines = selectedFrame.map(stripVTControlCharacters);
  assert.match(lines.join("\n"), /Summary model and thinking level\s+Invalid/);
  const description = "Choose a model to replace the invalid fallback settings.";
  assert.ok(lines.some((line) => line.trim() === description),
    `Expected the model row to describe: ${description}\nRendered menu:\n${lines.join("\n")}`);
  assert.deepEqual(current.notices, []);
  assert.equal(await readFile(settingsPath, "utf8"), invalidFallbackSettings);
});
