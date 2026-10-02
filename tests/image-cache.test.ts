// Isolate Node's experimental module mock flag so the package test command stays unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { resizeImage } from "@earendil-works/pi-coding-agent";

const mockFlag = "--experimental-test-module-mocks";
if (!process.execArgv.includes(mockFlag)) {
  test("image decoder cache and cancellation contracts", () => {
    const child = spawnSync(process.execPath, [mockFlag, "--test", fileURLToPath(import.meta.url)], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  test("shares a 32-entry LRU across requests, caches failures, and bounds original estimates", async (t) => {
    const decoded: number[] = [];
    const controller = new AbortController();
    const resize: typeof resizeImage = async (bytes) => {
      const id = bytes[0];
      decoded.push(id);
      if (id === 0) return null;
      if (id === 250) controller.abort(new Error("cancelled during decode"));
      const dimension = id === 249 ? 3_201 : 32;
      return { data: "fixture", mimeType: "image/png", originalWidth: dimension, originalHeight: dimension,
        width: dimension, height: dimension, wasResized: false };
    };
    t.mock.module("@earendil-works/pi-coding-agent", { namedExports: { resizeImage: resize } });
    const { estimateImages } = await import("../src/image-budget.js");
    const image = (id: number) => ({ type: "input_image", detail: "original",
      image_url: `data:image/png;base64,${Buffer.from([id]).toString("base64")}` });
    const estimate = (ids: number[]) => estimateImages([{ content: ids.map(image) }], new AbortController().signal);

    const first = await estimate([1, 1]);
    assert.equal(first.bytes(image(1)), 4);
    assert.deepEqual(decoded, [1], "duplicate parts decode once");
    await estimate(Array.from({ length: 31 }, (_, index) => index + 2));
    assert.equal(decoded.length, 32);
    await estimate([1]);
    assert.equal(decoded.length, 32, "a later request reuses the URL estimate and refreshes recency");
    await estimate([33, 1]);
    assert.equal(decoded.length, 33, "the refreshed oldest image stays cached");
    await estimate([2]);
    assert.equal(decoded.length, 34, "the least recently used image was evicted at entry 33");
    assert.deepEqual(decoded.slice(-2), [33, 2]);
    assert.equal(first.bytes(image(1)), 4, "an earlier request keeps its own lookup snapshot");

    const failed = await estimate([0]);
    assert.equal(failed.bytes(image(0)), 7_373);
    await estimate([0]);
    assert.equal(decoded.length, 35, "failed decodes are cached across requests");
    await estimate(Array.from({ length: 32 }, (_, index) => index + 64));
    await estimate([0]);
    assert.equal(decoded.length, 68, "a failed entry is also subject to the 32-entry bound");
    assert.equal(failed.bytes(image(0)), 7_373);

    const capped = await estimate([249]);
    assert.equal(capped.bytes(image(249)), 40_000);
    const beforeMalformed = decoded.length;
    const malformed = { ...image(1), image_url: "data:image/png;base64,AR==" };
    const fallback = await estimateImages([{ content: [malformed] }], new AbortController().signal);
    assert.equal(fallback.bytes(malformed), 7_373);
    assert.equal(decoded.length, beforeMalformed, "noncanonical trailing bits never reach the decoder");

    await assert.rejects(estimateImages([{ content: [image(250), image(251)] }], controller.signal), (error) => error === controller.signal.reason);
    assert.equal(decoded.at(-1), 250);
    assert.ok(!decoded.includes(251), "cancellation stops before the next decode");
  });
}
