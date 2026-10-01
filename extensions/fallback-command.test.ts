import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createCodexCompactionExtension } from "./codex-compaction.js";
import { FALLBACK_SETTINGS_RELATIVE_PATH } from "./fallback-settings.js";
import { isolateAgentConfig, testRegistry } from "./test-registry.test.js";

const settingsPath = join(isolateAgentConfig(), FALLBACK_SETTINGS_RELATIVE_PATH);
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
  const current = await fixture([firstChoice, firstChoice, "high"]);
  const chatModel = current.ctx.model;
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
  assert.equal(current.ctx.model, chatModel);
  assert.equal(current.ctx.thinkingLevel, "off");
  assert.ok(current.notices.some((notice) => notice.message.includes("cheap/cheap/model (high)") && notice.level === "info"));
  assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
});

for (const stage of ["action", "model", "thinking"] as const) {
  test(`cancelling the ${stage} selector preserves existing settings byte for byte`, async () => {
    await writeSettings();
    const choices = stage === "action" ? [undefined] : stage === "model" ? [firstChoice, undefined] : [firstChoice, firstChoice, undefined];
    const current = await fixture(choices);
    await current.run();
    assert.equal(await readFile(settingsPath, "utf8"), currentSettings);
    assert.match(current.dialogs[0].title, /cheap\/cheap\/model \(low\)/);
    assert.deepEqual(current.notices, []);
  });
}

test("cancelling an unconfigured command creates no configuration file", async () => {
  const current = await fixture([firstChoice, firstChoice, undefined]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});

test("fallback can be switched off and back on without losing the saved model or thinking level", async () => {
  await writeSettings();
  const disabled = await fixture([switchChoice]);
  await disabled.run();
  assert.equal(disabled.dialogs[0].options[1], "Fallback model: On");
  assert.equal(disabled.dialogs.length, 1);
  const selection = { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "low" };
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, fallback: selection });
  assert.match(disabled.notices[0].message, /Pi will use the chat model/);

  const enabled = await fixture([switchChoice]);
  await enabled.run();
  assert.equal(enabled.dialogs[0].options[1], "Fallback model: Off");
  assert.equal(enabled.dialogs.length, 1);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, fallback: { ...selection, enabled: true } });
  assert.match(enabled.notices[0].message, /cheap\/cheap\/model \(low\)/);
});

test("enabling without a model saves only the switch and remains inactive", async () => {
  const current = await fixture([switchChoice]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, fallback: { enabled: true } });
  assert.equal(current.dialogs.length, 1);
  assert.match(current.notices[0].message, /No fallback model configured; inactive/);
});

test("configuring a model after enabling the switch preserves the on state", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { enabled: true } }));
  const current = await fixture([firstChoice, firstChoice, "high"]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
});

test("changing the model or thinking level while disabled preserves the off state", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { enabled: false, provider: "removed", model: "old", thinkingLevel: "low" } }));
  const current = await fixture([firstChoice, firstChoice, "high"]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
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
  const current = await fixture([firstChoice, firstChoice, firstChoice], { ...model, reasoning: false });
  await current.run();
  assert.deepEqual(current.dialogs[2].options, ["off"]);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).fallback.thinkingLevel, "off");
});

test("a thinking level outside the offered choices cannot be saved", async () => {
  const current = await fixture([firstChoice, firstChoice, "high"], { ...model, reasoning: false });
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.equal(current.notices[0].level, "error");
});

test("a model outside the offered choices cannot be saved", async () => {
  const current = await fixture([firstChoice, "unlisted model"]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.equal(current.notices[0].level, "error");
});

test("an unavailable saved model can be replaced without being used for authentication or completion", async () => {
  await writeSettings(JSON.stringify({ version: 1, fallback: { provider: "removed", model: "old", thinkingLevel: "high" } }));
  const current = await fixture([firstChoice, firstChoice, "off"]);
  await current.run();
  assert.match(current.dialogs[0].title, /removed\/old \(high\)/);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).fallback.provider, model.provider);
});

test("external edits made during the menu are preserved and reported as a conflict", async () => {
  await writeSettings();
  const replacement = JSON.stringify({ version: 1, fallback: { provider: "other", model: "changed", thinkingLevel: "off" } });
  const current = await fixture([firstChoice, firstChoice, async () => {
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
  const current = await fixture([firstChoice, firstChoice, async () => {
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
  const current = await fixture([firstChoice, firstChoice, "high"]);
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
  const current = await fixture([firstChoice, firstChoice, "high"]);
  await current.run();
  assert.equal(await readFile(target, "utf8"), currentSettings);
  assert.match(current.notices[0].message, /symbolic link/);
  assert.deepEqual(await readdir(settingsDirectory), ["config.json", "target.json"]);
});

type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];

function driveTui(current: Awaited<ReturnType<typeof fixture>>, screens: readonly (readonly string[])[]) {
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
  const rendered = driveTui(current, [["\r"], ["\r"], ["\u001b"]]);
  await current.run();
  assert.equal(current.notices.length, 2);
  assert.equal(current.dialogs.length, 0);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, fallback: { enabled: true, provider: model.provider, model: model.id, thinkingLevel: "low" },
  });
  assert.match(rendered.join("\n"), /Fallback model/);
});

test("TUI fuzzy search filters models by name while keeping the switch off", async () => {
  const current = await fixture(["high"], model, true, [{ ...model, id: "aaa-unrelated", name: "Unrelated" }]);
  const rendered = driveTui(current, [["\u001b[B", "\r"], ["CheapModel", "\r"], ["\u001b"]]);
  await current.run();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1, fallback: { enabled: false, provider: model.provider, model: model.id, thinkingLevel: "high" },
  });
  assert.match(rendered.join("\n"), /type to search/);
});

test("TUI an unmatched search cannot select a model and Escape leaves settings unchanged", async () => {
  const current = await fixture([]);
  driveTui(current, [["\u001b[B", "\r"], ["no-such-model", "\r", "\u001b"], ["\u001b"]]);
  await current.run();
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  assert.deepEqual(current.notices, []);
});

test("RPC model search filters the offered choices", async () => {
  const current = await fixture([firstChoice, undefined]);
  current.ctx.ui.input = async () => "no-such-model";
  await current.run();
  assert.deepEqual(current.dialogs[1].options, []);
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
});
