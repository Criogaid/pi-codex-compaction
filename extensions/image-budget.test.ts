import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { estimateImages, RESIZED_IMAGE_BYTES_ESTIMATE } from "./image-budget.js";

function pngUrl(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

test("matches the ordinary image estimate regardless of the detail and encoded size", async () => {
  const image = { type: "input_image", image_url: "https://example.test/image", detail: "high" };
  const costs = await estimateImages([{ role: "user", content: [image] }], new AbortController().signal);
  assert.equal(costs.bytes(image), RESIZED_IMAGE_BYTES_ESTIMATE);
});

test("decodes original images through Pi and counts 32px patches", async () => {
  const image = { type: "input_image", image_url: pngUrl(33, 65), detail: "original" };
  const costs = await estimateImages([{ role: "user", content: [image] }], new AbortController().signal);
  assert.equal(costs.bytes(image), 24);
});

test("uses the original file cap and ordinary fallback for undecodable inline images", async () => {
  const file = { type: "input_image", file_id: "file-fixture", detail: "original" };
  const invalid = { type: "input_image", image_url: "data:image/png;base64,bm90IGEgcG5n", detail: "original" };
  const remote = { type: "input_image", image_url: "https://example.test/original", detail: "original" };
  const costs = await estimateImages([{ role: "user", content: [file, invalid, remote] }], new AbortController().signal);
  assert.equal(costs.bytes(file), 40_000);
  assert.equal(costs.bytes(invalid), RESIZED_IMAGE_BYTES_ESTIMATE);
  assert.equal(costs.bytes(remote), RESIZED_IMAGE_BYTES_ESTIMATE);
});

test("checks cancellation before starting another image decode", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(estimateImages([{ content: [{ type: "input_image" }] }], controller.signal), /abort/i);
});

test("rounds each original image dimension to 32px patches", async () => {
  for (const [width, height, bytes] of [[1, 1, 4], [32, 32, 4], [33, 32, 8], [31, 33, 8], [33, 33, 16]]) {
    const image = { type: "input_image", image_url: pngUrl(width, height), detail: "original" };
    const estimates = await estimateImages([{ role: "user", content: [image] }], new AbortController().signal);
    assert.equal(estimates.bytes(structuredClone(image)), bytes, `${width}x${height}`);
  }
});

test("uses the resized byte estimate for every non-original detail and prioritizes file IDs", async () => {
  const estimates = await estimateImages([], new AbortController().signal);
  assert.equal(RESIZED_IMAGE_BYTES_ESTIMATE, 7_373);
  for (const detail of [undefined, "auto", "low", "high"]) {
    assert.equal(estimates.bytes({ type: "input_image", detail, image_url: pngUrl(1, 1) }), 7_373);
  }
  assert.equal(estimates.bytes({ type: "input_image", detail: "original", file_id: "file", image_url: "unestimated" }), 40_000);
});

test("estimates original images in both tool output arrays and resolves cloned parts by URL", async () => {
  const image = { type: "input_image", detail: "original", image_url: pngUrl(65, 33) };
  for (const type of ["function_call_output", "custom_tool_call_output"]) {
    const estimates = await estimateImages([{ type, output: [null, "ignored", image, { ...image }] }], new AbortController().signal);
    assert.equal(estimates.bytes(structuredClone(image)), 24, type);
  }
  const ignored = await estimateImages([{ type: "function_call", output: [image] }], new AbortController().signal);
  assert.throws(() => ignored.bytes(image), /missing its byte estimate/);
});

test("falls back for malformed inline encodings and unsupported URLs", async () => {
  for (const image_url of [
    "data:image/png;base64", "data:image/png,raw", "data:text/plain;base64,YQ==",
    "data:image/png;base64,YQ", "data:image/png;base64,YR==", "data:image/png;base64,YQ==\n",
    "data:image/png;base64,%%%", "https://example.test/original",
  ]) {
    const image = { type: "input_image", detail: "original", image_url };
    const estimates = await estimateImages([{ content: [image] }], new AbortController().signal);
    assert.equal(estimates.bytes(image), 7_373, image_url);
  }
});

test("requires a request-local estimate even when a URL was decoded by an earlier request", async () => {
  const image = { type: "input_image", detail: "original", image_url: pngUrl(1, 2) };
  const prepared = await estimateImages([{ content: [image] }], new AbortController().signal);
  assert.equal(prepared.bytes(image), 4);
  const empty = await estimateImages([], new AbortController().signal);
  assert.throws(() => empty.bytes({ ...image }), /missing its byte estimate/);
});

test("rejects an already aborted request even when there are no images", async () => {
  const reason = new Error("image estimation cancelled");
  await assert.rejects(estimateImages([], AbortSignal.abort(reason)), (error) => error === reason);
});
