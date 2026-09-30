import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { imageTokenCounts } from "./image-budget.js";

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
  const costs = await imageTokenCounts([{ role: "user", content: [image] }], new AbortController().signal);
  assert.equal(costs.get(image), 1844);
});

test("decodes original images through Pi and counts 32px patches", async () => {
  const image = { type: "input_image", image_url: pngUrl(33, 65), detail: "original" };
  const costs = await imageTokenCounts([{ role: "user", content: [image] }], new AbortController().signal);
  assert.equal(costs.get(image), 6);
});

test("uses the original file cap and ordinary fallback for undecodable inline images", async () => {
  const file = { type: "input_image", file_id: "file-fixture", detail: "original" };
  const invalid = { type: "input_image", image_url: "data:image/png;base64,bm90IGEgcG5n", detail: "original" };
  const remote = { type: "input_image", image_url: "https://example.test/original", detail: "original" };
  const costs = await imageTokenCounts([{ role: "user", content: [file, invalid, remote] }], new AbortController().signal);
  assert.equal(costs.get(file), 10_000);
  assert.equal(costs.get(invalid), 1844);
  assert.equal(costs.get(remote), 1844);
});

test("checks cancellation before starting another image decode", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(imageTokenCounts([{ content: [{ type: "input_image" }] }], controller.signal), /abort/i);
});
