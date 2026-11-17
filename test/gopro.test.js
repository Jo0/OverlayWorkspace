// GoPro GPMF GPS reader (src/video/gopro-gps.js) and GoPro auto-sync.
//
// fixtures/gopro/hero6-gps-payload.bin is one GPMF payload from GoPro's own
// HERO6 sample clip (github.com/gopro/gpmf-parser, Apache-2.0 or MIT, see
// fixtures/gopro/LICENSE.txt). GPS9 (HERO11/HERO13) has no public sample, so
// it's tested with payloads built here from GoPro's documented layout. If
// GoPro's sample clips are in samples/gopro/ (git-ignored), they're read too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openAsBlob, readFileSync } from "node:fs";
import { klv, parseGpsu, payloadFixes, readGoProTrack } from "../src/video/gopro-gps.js";
import { matchClockOffset } from "../src/core/gps-sync.js";
import { parseRaceChronoV3 } from "../src/importers/racechrono-csv-v3.js";
import { syntheticCsv } from "./synthetic.js";

// ── A small GPMF writer, from the spec ──
const enc = new TextEncoder();
function item(key, type, size, repeat, data) {
  const len = size * repeat;
  const out = new Uint8Array(8 + ((len + 3) & ~3));
  out.set(enc.encode(key), 0);
  out[4] = type ? type.charCodeAt(0) : 0;
  out[5] = size;
  out[6] = repeat >> 8;
  out[7] = repeat & 255;
  out.set(data.subarray(0, len), 8);
  return out;
}
const cat = (...parts) => { const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const nest = (key, ...children) => { const body = cat(...children); return item(key, null, 1, body.length, body); };
function ints(type, rowsIn) {
  const sz = { l: 4, L: 4, S: 2, s: 2 }[type];
  const width = rowsIn[0].length;
  const dv = new DataView(new ArrayBuffer(sz * width * rowsIn.length));
  rowsIn.flat().forEach((v, i) => {
    if (type === "l") dv.setInt32(i * 4, v); else if (type === "L") dv.setUint32(i * 4, v);
    else if (type === "S") dv.setUint16(i * 2, v); else dv.setInt16(i * 2, v);
  });
  return item("XXXX", type, sz * width, rowsIn.length, new Uint8Array(dv.buffer));
}
const named = (key, it) => { it.set(enc.encode(key), 0); return it; };
const str = (key, s) => item(key, "c", 1, s.length, enc.encode(s));

/** A GPS5 payload (HERO5-HERO11 style). */
function gps5Payload(points, { gpsu = "180124192758.674", fix = 3, dop = 150 } = {}) {
  return nest("DEVC", str("DVNM", "Test HERO"), nest("STRM",
    named("GPSF", ints("L", [[fix]])),
    item("GPSU", "U", 16, 1, enc.encode(gpsu)),
    named("GPSP", ints("S", [[dop]])),
    named("SCAL", ints("l", [[1e7], [1e7], [1000], [1000], [100]])),
    named("GPS5", ints("l", points.map((p) => [Math.round(p.lat * 1e7), Math.round(p.lon * 1e7), 0, 0, 0])))));
}

/** A GPS9 payload (HERO11/HERO13 style): per-sample time, DOP and fix. */
function gps9Payload(points) {
  const types = "lllllllSS";
  const dv = new DataView(new ArrayBuffer(32 * points.length));
  points.forEach((p, i) => {
    const o = i * 32;
    const days = Math.floor((p.utc - Date.UTC(2000, 0, 1) / 1000) / 86400);
    const secs = p.utc - Date.UTC(2000, 0, 1) / 1000 - days * 86400;
    dv.setInt32(o, Math.round(p.lat * 1e7)); dv.setInt32(o + 4, Math.round(p.lon * 1e7));
    dv.setInt32(o + 8, 0); dv.setInt32(o + 12, 0); dv.setInt32(o + 16, 0);
    dv.setInt32(o + 20, days); dv.setInt32(o + 24, Math.round(secs * 1000));
    dv.setUint16(o + 28, p.dop ?? 120); dv.setUint16(o + 30, p.fix ?? 3);
  });
  const scal = new DataView(new ArrayBuffer(36));
  [1e7, 1e7, 1000, 1000, 100, 1, 1000, 100, 1].forEach((v, i) => scal.setInt32(i * 4, v));
  return nest("DEVC", str("DVNM", "HERO13 Black"), nest("STRM",
    item("SCAL", "l", 4, 9, new Uint8Array(scal.buffer)),
    str("TYPE", types),
    item("GPS9", "?", 32, points.length, new Uint8Array(dv.buffer))));
}

test("reads a real HERO6 GPS payload", () => {
  const b = new Uint8Array(readFileSync(new URL("./fixtures/gopro/hero6-gps-payload.bin", import.meta.url)));
  const p = payloadFixes(b, 10, 1);
  assert.equal(p.device, "Hero6 Black");
  assert.equal(p.fixes.length, 17);
  const f = p.fixes[0];
  assert.ok(Math.abs(f.lat - 33.126515) < 1e-6 && Math.abs(f.lon - -117.3271676) < 1e-6, `${f.lat}, ${f.lon}`);
  assert.equal(new Date(f.utc * 1000).toISOString(), "2018-01-24T19:27:58.674Z");
  assert.equal(f.video, 10);
  assert.ok(Math.abs(p.fixes[16].video - (10 + 16 / 17)) < 1e-9, "samples spread across the payload");
});

test("GPMF items are walked with 4-byte padding and nesting", () => {
  const b = cat(str("ABCD", "x"), item("EFGH", "L", 4, 1, new Uint8Array([0, 0, 0, 7])));
  assert.deepEqual([...klv(b)].map((i) => [i.key, i.type, i.end - i.start]), [["ABCD", "c", 1], ["EFGH", "L", 4]]);
  assert.equal(parseGpsu("191118234215.025"), Date.UTC(2019, 10, 18, 23, 42, 15) / 1000 + 0.025);
});

test("GPS5 without a fix, or with poor precision, gives no fixes", () => {
  const pts = Array.from({ length: 18 }, (_, i) => ({ lat: 33 + i * 1e-5, lon: -117 }));
  assert.equal(payloadFixes(gps5Payload(pts), 0, 1).fixes.length, 18);
  assert.equal(payloadFixes(gps5Payload(pts, { fix: 0 }), 0, 1).fixes.length, 0, "GPSF 0: no lock (cameras still write a position)");
  assert.equal(payloadFixes(gps5Payload(pts, { dop: 9999 }), 0, 1).fixes.length, 0, "GPSP 9999: no precision");
});

test("GPS9 carries UTC, fix and DOP in every sample", () => {
  const t0 = Date.UTC(2026, 10, 15, 18, 0, 0) / 1000;
  const pts = Array.from({ length: 10 }, (_, i) => ({ lat: 40 + i * 1e-5, lon: -100, utc: t0 + i * 0.1, fix: i === 3 ? 0 : 3, dop: i === 4 ? 900 : 120 }));
  const p = payloadFixes(gps9Payload(pts), 5, 1);
  assert.equal(p.device, "HERO13 Black");
  assert.equal(p.fixes.length, 8, "sample 3 has no fix, sample 4 a DOP of 9");
  assert.ok(Math.abs(p.fixes[0].utc - t0) < 1e-6);
  assert.ok(Math.abs(p.fixes[7].utc - (t0 + 0.9)) < 1e-6);
  assert.ok(Math.abs(p.fixes[0].lat - 40) < 1e-7);
});

test("GoPro auto-sync: a camera that stored local time as UTC (8 h off) still syncs exactly", () => {
  const { text, t0, pre } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const lat = s.channel("@latitude"), lon = s.channel("@longitude");
  // Video second 0 is data time T0. The camera wrote its local time (UTC-8)
  // as if it were UTC, and its clock was 3.7 s fast besides. GPS time runs
  // 0.15 s behind the truth (receiver latency).
  const T0 = t0 + pre - 2;
  const created = T0 - 8 * 3600 + 3.7;
  const fixes = [];
  for (let k = 0; k < 35; k++) {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const t = T0 + k + i / 10;
      return { lat: lat.at(t), lon: lon.at(t), utc: t - 0.15 };
    });
    for (const f of payloadFixes(gps9Payload(pts), k, 1).fixes) fixes.push({ t: created + f.video, lat: f.lat, lon: f.lon, utc: f.utc });
  }
  const utcOffset = fixes.map((f) => f.utc - f.t).sort((a, b) => a - b)[fixes.length >> 1];
  assert.ok(Math.abs(utcOffset - (8 * 3600 - 3.7 - 0.15)) < 0.01, `GPS time puts the camera ${utcOffset} s off`);
  const m = matchClockOffset(s, [fixes], { center: utcOffset, maxOffset: 30 });
  assert.ok(Math.abs(m.offset - (T0 - created)) <= 0.06, `offset ${m.offset}, want ${T0 - created}`);
  assert.ok(m.error < 1, `error ${m.error} m`);
  // Without the GPS time, an 8 h error is outside the default ±1 h search.
  assert.throws(() => matchClockOffset(s, [fixes]), /doesn't line up/);
});

const SAMPLES = new URL("../samples/gopro/", import.meta.url);
test("GoPro's sample clips (if downloaded to samples/gopro/)", { skip: !existsSync(new URL("hero6.mp4", SAMPLES)) && "samples/gopro/ not present" }, async () => {
  const hero6 = await readGoProTrack(await openAsBlob(new URL("hero6.mp4", SAMPLES)));
  assert.equal(hero6.device, "Hero6 Black");
  assert.ok(hero6.fixes.length > 100);
  // The camera stored Pacific standard time as UTC: GPS time is 8 h later.
  assert.ok(Math.abs(hero6.utcOffset - 8 * 3600) < 60, `utcOffset ${hero6.utcOffset}`);
  if (existsSync(new URL("hero8.mp4", SAMPLES))) {
    const hero8 = await readGoProTrack(await openAsBlob(new URL("hero8.mp4", SAMPLES)));
    assert.equal(hero8.fixes.length, 0, "HERO8 sample never got a fix (it writes a made-up position)");
  }
});
