// Structural test of the MP4 writer with fake encoder chunks: the box tree is
// well-formed, sample sizes/offsets point at the right bytes, and the 64-bit
// mdat size is patched. (Real encoding is covered by the browser export test
// described in README.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Mp4Writer, makeAvcC } from "../src/export/mp4-writer.js";
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

function boxAt(buf, boxes, key) {
  const b = boxes[key];
  return b && buf.subarray(b.pos + b.hdr, b.pos + b.size);
}

test("B-frames (decode order != display order) get ctts and an edit list", async () => {
  const sink = new MemorySink();
  const fps = { num: 60000, den: 1001 };
  const w = new Mp4Writer(sink, { width: 64, height: 64, fps });
  await w.start();
  const frameUs = (fps.den / fps.num) * 1e6;
  // Display order 0..6, handed over in decode order I0 P2 B1 P4 B3 P6 B5 (Firefox's pattern).
  const order = [0, 2, 1, 4, 3, 6, 5];
  for (const [k, f] of order.entries()) {
    const c = fakeChunk(k, 10);
    c.timestamp = Math.round(f * frameUs);
    c.type = k === 0 ? "key" : "delta";
    await w.addChunk(c, k === 0 ? { decoderConfig: { codec: "avc1.640028", description: new Uint8Array([1, 0x64, 0, 0x28, 0xff]).buffer } } : undefined);
  }
  await w.finish();
  const buf = new Uint8Array(await sink.blob.arrayBuffer());
  const boxes = readBoxes(buf, 0, buf.length);
  const delta = w.delta;
  // ctts: run-length (count, offset); offsets are (display - decode + shift) frames, shift = 1.
  const ctts = new DataView(boxAt(buf, boxes, "moov/trak/mdia/minf/stbl/ctts").slice().buffer);
  const n = ctts.getUint32(4);
  const offsets = [];
  for (let i = 0; i < n; i++) for (let c = 0; c < ctts.getUint32(8 + 8 * i); c++) offsets.push(ctts.getUint32(12 + 8 * i) / delta);
  assert.deepEqual(offsets, order.map((f, k) => f - k + 1));
  // Presentation = decode + offset - edit shift reproduces the display order.
  assert.deepEqual(offsets.map((o, k) => k + o - 1), order);
  readBoxes(buf, boxes["moov/trak"].pos + 8, boxes["moov/trak"].pos + boxes["moov/trak"].size, boxes, "trak");
  const elst = new DataView(buf.slice(boxes["trak/edts"].pos + 8).buffer);
  assert.equal(elst.getUint32(8 + 4), 1, "one edit");
  assert.equal(elst.getUint32(8 + 12), delta, "media_time skips the one-frame shift");
});

test("in-order chunks write no ctts or edit list", async () => {
  const sink = new MemorySink();
  const w = new Mp4Writer(sink, { width: 64, height: 64, fps: { num: 30, den: 1 } });
  await w.start();
  for (let i = 0; i < 4; i++) {
    const c = fakeChunk(i, 10);
    c.timestamp = Math.round(i * 1e6 / 30);
    await w.addChunk(c, i === 0 ? { decoderConfig: { codec: "avc1.640028", description: new Uint8Array([1, 0x64, 0, 0x28, 0xff]).buffer } } : undefined);
  }
  await w.finish();
  const buf = new Uint8Array(await sink.blob.arrayBuffer());
  const boxes = readBoxes(buf, 0, buf.length);
  assert.ok(!boxes["moov/trak/mdia/minf/stbl/ctts"]);
  assert.ok(!boxes["moov/trak/edts"]);
});

// Firefox 160's description for a 1080p High export: each parameter set has its header byte twice.
const hex = (s) => Uint8Array.from(s.split(" ").map((x) => parseInt(x, 16)));
const FF_SPS = "67 64 00 2a ac 2c ac 07 80 22 7e 58 40 00 00 03 00 40 00 00 1d 83 68 22 11 4e";
const FF_PPS = "68 ce 3c 30";
const FF_DESC = hex(`01 64 00 2a 03 01 00 1b 67 ${FF_SPS} 01 00 05 68 ${FF_PPS}`);
const lenPrefixed = (...nals) => Uint8Array.from(nals.flatMap((n) => [0, 0, (n.length >> 8) & 255, n.length & 255, ...n]));
const GOOD_AVCC = hex(`01 64 00 2a ff e1 00 1a ${FF_SPS} 01 00 04 ${FF_PPS} fd f8 f8 00`);

test("avcC is rebuilt from the keyframe's in-band SPS/PPS", () => {
  const sample = lenPrefixed(hex("09 10"), hex(FF_SPS), hex(FF_PPS), hex("65 88 84 00"));
  assert.deepEqual(makeAvcC(FF_DESC, sample), GOOD_AVCC);
});

test("Firefox's doubled header bytes are repaired when there are no in-band parameter sets", () => {
  assert.deepEqual(makeAvcC(FF_DESC, lenPrefixed(hex("65 88 84 00"))), GOOD_AVCC);
});

test("a valid avcC passes through unchanged", () => {
  assert.equal(makeAvcC(GOOD_AVCC, lenPrefixed(hex("65 88 84 00"))), GOOD_AVCC);
});
