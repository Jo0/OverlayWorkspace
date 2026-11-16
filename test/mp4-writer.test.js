// Structural test of the MP4 writer with fake encoder chunks: the box tree is
// well-formed, sample sizes/offsets point at the right bytes, and the 64-bit
// mdat size is patched. (Real encoding is covered by the browser export test
// described in README.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp4Writer } from "../src/export/mp4-writer.js";
import { MemorySink } from "../src/export/sinks.js";

function fakeChunk(i, payloadLen) {
  const data = new Uint8Array(payloadLen).fill(i & 0xff);
  return { timestamp: i * 16683, byteLength: payloadLen, type: i % 4 === 0 ? "key" : "delta", copyTo: (dst) => dst.set(data) };
}

function readBoxes(buf, start, end, out = {}, path = "") {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    let hdr = 8;
    if (size === 1) { size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12); hdr = 16; }
    assert.ok(size >= hdr && p + size <= end, `box ${path}/${type} fits`);
    const key = path ? `${path}/${type}` : type;
    out[key] = { pos: p, size, hdr };
    if (["moov", "trak", "mdia", "minf", "stbl", "dinf"].includes(type)) readBoxes(buf, p + hdr, p + size, out, key);
    p += size;
  }
  return out;
}

test("writes a well-formed MP4 with correct sample table", async () => {
  const sink = new MemorySink();
  const w = new Mp4Writer(sink, { width: 1920, height: 1080, fps: { num: 60000, den: 1001 }, creationTime: 1_700_000_000 });
  await w.start();
  const sizes = [];
  for (let i = 0; i < 10; i++) {
    const len = 100 + i * 7;
    sizes.push(len);
    await w.addChunk(fakeChunk(i, len), i === 0 ? { decoderConfig: { codec: "avc1.640028", description: new Uint8Array([1, 0x64, 0, 0x28, 0xff]).buffer } } : undefined);
  }
  await w.finish();
  const buf = new Uint8Array(await sink.blob.arrayBuffer());
  const boxes = readBoxes(buf, 0, buf.length);
  for (const k of ["ftyp", "mdat", "moov", "moov/mvhd", "moov/trak/mdia/minf/stbl/stsz", "moov/trak/mdia/minf/stbl/stco"]) assert.ok(boxes[k], `has ${k}`);
  assert.equal(boxes.mdat.size, sizes.reduce((a, b) => a + b, 0) + 16);

  const dv = new DataView(buf.buffer);
  const stsz = boxes["moov/trak/mdia/minf/stbl/stsz"].pos + 8;
  assert.equal(dv.getUint32(stsz + 8), 10);
  const stco = boxes["moov/trak/mdia/minf/stbl/stco"].pos + 8;
  for (let i = 0; i < 10; i++) {
    assert.equal(dv.getUint32(stsz + 12 + 4 * i), sizes[i]);
    const off = dv.getUint32(stco + 8 + 4 * i);
    assert.equal(buf[off], i & 0xff, `sample ${i} offset points at its bytes`);
  }
  const stss = boxes["moov/trak/mdia/minf/stbl/stss"].pos + 8;
  assert.equal(dv.getUint32(stss + 4), 3); // samples 1, 5, 9
  // mvhd creation time is seconds since 1904
  assert.equal(dv.getUint32(boxes["moov/mvhd"].pos + 12), 1_700_000_000 + 2082844800);
});
