// Exercise configuration writes in independent Pi processes without replacing filesystem operations.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings } from "../src/fallback-settings.js";
import { isolateAgentConfig } from "./helpers.js";

const settingsPath = join(isolateAgentConfig(), COMPACTION_SETTINGS_RELATIVE_PATH);
const settingsDirectory = dirname(settingsPath);
const initialSettings = '{"version":1,"remoteCompaction":{"enabled":true}}\n';
const settingsModule = new URL("../src/fallback-settings.js", import.meta.url).href;
const writerScript = `
const { loadCompactionSettings } = await import(process.argv[1]);
const settings = await loadCompactionSettings(process.argv[2]);
const model = process.argv[3];
process.once("message", async () => {
  try {
    await settings.save({ remoteCompactionEnabled: false,
      fallback: { enabled: true, provider: "fixture", model, thinkingLevel: "off" } });
    process.send({ ok: true, model });
  } catch (error) {
    process.send({ ok: false, model, error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
`;

beforeEach(() => rm(settingsDirectory, { recursive: true, force: true }));

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onMessage = (message: unknown) => { cleanup(); resolve(message); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Settings writer exited before replying")); };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

interface WriterResult {
  readonly ok: boolean;
  readonly model: string;
  readonly error?: string;
}

async function startWriter(t: TestContext, model: string) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", writerScript, settingsModule, settingsPath, model], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Settings writer exited with ${code}: ${stderr}`)));
  });
  // Register cleanup before waiting for startup, including failures to launch or import the module.
  void finished.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await finished.catch(() => {});
  });
  assert.deepEqual(await nextMessage(child), { ready: true });
  return {
    async save(): Promise<WriterResult> {
      const response = nextMessage(child);
      child.send("save");
      const result = await response;
      await finished;
      assert.ok(result !== null && typeof result === "object" && "ok" in result);
      return result as WriterResult;
    },
  };
}

for (const existing of [true, false]) {
  test(`independent settings writers allow only one save from the same ${existing ? "existing" : "absent"} revision`, { timeout: 20_000 }, async (t) => {
    let originalMode = 0o600;
    if (existing) {
      await mkdir(settingsDirectory, { recursive: true });
      await writeFile(settingsPath, initialSettings, { mode: 0o640 });
      originalMode = (await stat(settingsPath)).mode & 0o777;
    }
    // Both children load the old revision before either receives permission to save it.
    const writers = await Promise.all([startWriter(t, "left"), startWriter(t, "right")]);
    const results = await Promise.all(writers.map((writer) => writer.save()));
    const saved = results.filter((result) => result.ok);
    const conflicted = results.filter((result) => !result.ok);
    assert.equal(saved.length, 1, JSON.stringify(results));
    assert.equal(conflicted.length, 1, JSON.stringify(results));
    assert.match(conflicted[0].error ?? "", /changed while the menu was open/);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      version: 1, remoteCompaction: { enabled: false },
      fallback: { enabled: true, provider: "fixture", model: saved[0].model, thinkingLevel: "off" },
    });
    if (process.platform !== "win32") assert.equal((await stat(settingsPath)).mode & 0o777, originalMode);
    assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
  });
}

test("a lock held by another process makes saving fail without altering the file", { timeout: 20_000 }, async (t) => {
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(settingsPath, initialSettings);
  const release = await lockfile.lock(settingsPath, { realpath: false });
  try {
    const writer = await startWriter(t, "blocked");
    const result = await writer.save();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /being edited by another Pi process/);
    assert.equal(await readFile(settingsPath, "utf8"), initialSettings);
    assert.deepEqual(await readdir(settingsDirectory), ["config.json", "config.json.lock"]);
  } finally {
    await release();
  }
  // A failed acquisition must neither remove someone else's lock nor prevent a later save.
  await (await loadCompactionSettings(settingsPath)).save({ remoteCompactionEnabled: false });
  assert.equal((await loadCompactionSettings(settingsPath)).configuration.remoteCompactionEnabled, false);
  assert.deepEqual(await readdir(settingsDirectory), ["config.json"]);
});
