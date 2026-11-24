import assert from "node:assert/strict";
import fs, { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { COMPACTION_SETTINGS_RELATIVE_PATH } from "../src/fallback-settings.js";
import codexCompaction from "../src/index.js";
import { isObject, isObjectArray, type JsonObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
beforeEach(async () => {
  await rm(dirname(settingsPath), { recursive: true, force: true });
  await mkdir(dirname(settingsPath), { recursive: true });
});

const settings = (enabled: boolean) => ({ version: 2, reasoningEffortUpdates: { enabled } });
const writeEffortSwitch = (enabled: boolean) => writeFile(settingsPath, JSON.stringify(settings(enabled)));
const update = { type: "configuration_update", reasoning: { effort: "medium" } };

async function startFixture(t: TestContext, ...extensions: ExtensionFactory[]) {
  const fixture = await sessionFixture({
    extensions: extensions.length ? extensions : [codexCompaction],
    // A synthetic effort update distinguishes pass-through from rewriting independently of adapter shapes.
    serializePayload: (payload) => ({ ...payload, input: [...payload.input, update] }),
  });
  t.after(() => fixture.close());
  return fixture;
}

function responsesPayload(payload: JsonObject | undefined) {
  assert.ok(payload && isObjectArray(payload.input) && isObject(payload.reasoning));
  return { input: payload.input, effort: payload.reasoning.effort };
}

const withoutSessionStart: ExtensionFactory = (pi) => {
  // Withhold just this lifecycle event from the extension; the request still runs through Pi.
  codexCompaction({ ...pi,
    on(event: string, handler: unknown): () => void {
      return event === "session_start" ? () => {} : Reflect.apply(pi.on, pi, [event, handler]);
    },
  });
};

test("the first ordinary request reads the effort switch without session_start", { timeout: 20_000 }, async (t) => {
  await writeEffortSwitch(true);
  const fixture = await startFixture(t, withoutSessionStart);
  await fixture.session.prompt("Start the task without a startup notification.");
  assert.equal(fixture.requests.length, 1);
  assert.equal(responsesPayload(fixture.requests[0].payload).effort, "medium");
  assert.deepEqual(fixture.errors, []);
});

test("an in-flight compaction keeps its effort switch and cannot overwrite a menu save", { timeout: 20_000 }, async (t) => {
  await writeEffortSwitch(true);
  const fixture = await startFixture(t);
  const notices: string[] = [];
  await fixture.session.bindExtensions({ mode: "rpc", uiContext: {
    async select(_title, options) {
      return options.find((option) => option.startsWith("Codex reasoning effort updates:"));
    },
    notify(message, _level) { notices.push(message); },
    setStatus(_key, _text) {},
  } as ExtensionUIContext });
  for (let turn = 1; turn <= 3; turn++) {
    await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
  }
  assert.equal(responsesPayload(fixture.requests.at(-1)?.payload).effort, "medium");
  const beforeCompaction = fixture.requests.length;

  const readFinished = Promise.withResolvers<void>();
  const resumeRead = Promise.withResolvers<void>();
  const open = fs.open;
  let gateNextRead = true;
  const mockOpen = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (gateNextRead && args[0] === settingsPath) {
      gateNextRead = false;
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        // The old bytes are in memory and the handle is closed, so the menu can replace the file on Windows.
        await close();
        readFinished.resolve();
        await resumeRead.promise;
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  const compacting = fixture.session.compact();
  try {
    await Promise.race([readFinished.promise, compacting.then(() => assert.fail("Compaction skipped the settings read"))]);
    await fixture.session.prompt("/codex-compaction");
    const saved: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(isObject(saved));
    assert.deepEqual(saved.reasoningEffortUpdates, settings(false).reasoningEffortUpdates);
    assert.equal(notices.length, 1);
    assert.equal(fixture.requests.length, beforeCompaction);
  } finally {
    resumeRead.resolve();
    mockOpen.mock.restore();
    syncBuiltinESMExports();
    await compacting;
  }

  assert.equal(fixture.requests.length, beforeCompaction + 1);
  const v2 = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.equal(v2.input.at(-1)?.type, "compaction_trigger");
  assert.equal(v2.effort, "medium");

  await fixture.session.prompt("Continue after changing the effort switch.");
  const chat = responsesPayload(fixture.requests.at(-1)?.payload);
  assert.ok(chat.input.some((item) => item.type === "compaction"));
  assert.equal(chat.effort, "low");
  assert.deepEqual(chat.input.at(-1), update);
  assert.deepEqual(fixture.errors, []);
});

test("session_start during reload adopts the edited effort switch before the next request", { timeout: 20_000 }, async (t) => {
  await writeEffortSwitch(false);
  const fixture = await startFixture(t);
  await fixture.session.prompt("Start the task with the rewrite disabled.");
  assert.equal(responsesPayload(fixture.requests.at(-1)?.payload).effort, "low");

  await writeEffortSwitch(true);
  await fixture.session.reload();
  // A lazy read at request time would see Off again.
  await writeEffortSwitch(false);
  await fixture.session.prompt("Continue after reloading the session.");
  assert.equal(fixture.requests.length, 2);
  assert.equal(responsesPayload(fixture.requests.at(-1)?.payload).effort, "medium");
  assert.deepEqual(fixture.errors, []);
});

test("corrupt settings at reload warn once and leave subsequent requests as Pi sent them", { timeout: 20_000 }, async (t) => {
  await writeEffortSwitch(true);
  let piPayload: unknown;
  const observePiPayload: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", ({ payload }) => { piPayload = structuredClone(payload); });
  };
  const fixture = await startFixture(t, observePiPayload, codexCompaction);
  const notices: { message: string; level: string | undefined }[] = [];
  await fixture.session.bindExtensions({ mode: "rpc", uiContext: {
    notify(message, level) { notices.push({ message, level }); },
    setStatus(_key, _text) {},
  } as ExtensionUIContext });
  await fixture.session.prompt("Start the task with the rewrite enabled.");
  assert.equal(responsesPayload(fixture.requests.at(-1)?.payload).effort, "medium");
  assert.equal(notices.length, 0);

  await writeFile(settingsPath, "{");
  await fixture.session.reload();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "warning");
  assert.match(notices[0].message, /reasoning effort updates are Off/);

  for (const prompt of ["Continue with the broken config.", "Finish the task with the broken config."]) {
    await fixture.session.prompt(prompt);
    const expected: unknown = JSON.parse(JSON.stringify(piPayload));
    assert.deepEqual(fixture.requests.at(-1)?.payload, expected);
  }
  assert.equal(fixture.requests.length, 3);
  assert.equal(notices.length, 1);
  assert.deepEqual(fixture.errors, []);
});
