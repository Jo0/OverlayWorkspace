// Unit tests for the data model, importer, timing, units and template
// placement. Run with: node --test test/
// Uses synthetic data only (no real GPS traces in the repo).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRaceChronoV3, detectRaceChronoV3 } from "../src/importers/racechrono-csv-v3.js";
import { Timing } from "../src/core/timing.js";
import { formatLapTime, formatDelta, convert } from "../src/core/units.js";
import { placeElement } from "../src/core/template.js";
import { makeFrame } from "../src/core/frame.js";

/** A RaceChrono-style CSV v3: car circling a 100 m radius loop, 25 Hz.
 *  Lap 1 takes 40 s, lap 2 takes 36 s (faster), then 5 s of run-out. */
function syntheticCsv() {
  const R = 100, lat0 = 40, lon0 = -100;
  const circ = 2 * Math.PI * R;
  const lines = [
    "This file is created using RaceChrono Pro v10.3.2 ( http://racechrono.com/ ).",
    "Format,3",
    'Session title,"Test day"',
    "Session type,Lap timing",
    'Track name,"Test loop"',
    "Driver name,",
    "Created,01/01/2026,10:00",
    "Note,",
    "",
    "timestamp,fragment_id,lap_number,elapsed_time,distance_traveled,latitude,longitude,speed,lateral_acc,longitudinal_acc,speed",
    "unix time,,,s,m,deg,deg,m/s,G,G,m/s",
    ",,,,,100: gps,100: gps,100: gps,calc,calc,calc",
  ];
  const t0 = 1_700_000_000;
  let dist = 0;
  const pre = 5, lap1 = 40, lap2 = 36, post = 5;
  for (let i = 0; i <= (pre + lap1 + lap2 + post) * 25; i++) {
    const t = i / 25;
    let lap = "", v;
    if (t < pre) v = 5;
    else if (t < pre + lap1) { lap = "1"; v = circ / lap1; }
    else if (t < pre + lap1 + lap2) { lap = "2"; v = circ / lap2; }
    else v = 5;
    if (i) dist += v / 25;
    const a = dist / R;
    const lat = lat0 + (R * Math.sin(a)) / 111320;
    const lon = lon0 + (R * (1 - Math.cos(a))) / (111320 * Math.cos((lat0 * Math.PI) / 180));
    lines.push([(t0 + t).toFixed(2), 0, lap, t.toFixed(2), dist.toFixed(3), lat.toFixed(7), lon.toFixed(7), v.toFixed(3), (v * v / R / 9.81).toFixed(3), "0", v.toFixed(3)].join(","));
  }
  return { text: lines.join("\n") + "\n", t0, pre, lap1, lap2 };
}

test("detects RaceChrono CSV v3", () => {
  const { text } = syntheticCsv();
  assert.equal(detectRaceChronoV3(text.slice(0, 2000)), 1);
  assert.equal(detectRaceChronoV3("a,b,c\n1,2,3\n"), 0);
});

test("parses metadata, channels, roles and laps", () => {
  const { text, t0, pre, lap1, lap2 } = syntheticCsv();
  const s = parseRaceChronoV3(text, { fileName: "x.csv" });
  assert.equal(s.meta.title, "Test day");
  assert.equal(s.meta.track, "Test loop");
  assert.equal(s.laps.length, 2);
  assert.ok(Math.abs(s.laps[0].start - (t0 + pre)) < 0.05);
  assert.ok(Math.abs(s.laps[0].duration - lap1) < 0.1);
  assert.ok(Math.abs(s.laps[1].duration - lap2) < 0.1);
  // First "speed" column (GPS) gets the role; the repeated calc one keeps an id suffix.
  assert.equal(s.channel("@speed").id, "speed");
  assert.ok(s.channel("speed#2"));
  assert.equal(s.channel("@lat_g").dimension, "accel");
  assert.equal(s.channel("@distance").unit, "m");
});

test("timing: states, last/best and delta against the best lap", () => {
  const { text, t0, pre, lap1, lap2 } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const tm = new Timing(s);
  assert.equal(tm.comparisonLap().number, 2, "lap 2 is faster");

  const before = tm.context(t0 + 1);
  assert.equal(before.state, "before");
  assert.equal(before.elapsed, 0);

  const mid = tm.context(t0 + pre + lap1 / 2);
  assert.equal(mid.state, "in");
  assert.equal(mid.lapNumber, 1);
  // Halfway round lap 1 (20 s) vs. halfway round lap 2 (18 s) → about +2 s.
  assert.ok(Math.abs(mid.delta - 2) < 0.1, `delta ${mid.delta}`);

  const end1 = tm.context(t0 + pre + lap1 - 0.05);
  assert.ok(Math.abs(end1.delta - (lap1 - lap2)) < 0.15, `delta at finish ${end1.delta}`);

  const after = tm.context(t0 + pre + lap1 + lap2 + 2);
  assert.equal(after.state, "after");
  assert.equal(after.lapNumber, 2);
  assert.ok(Math.abs(after.elapsed - lap2) < 0.1);
  assert.equal(after.best.number, 2);
  assert.equal(after.last.number, 2);

  // Excluding lap 2 (e.g. cones) makes lap 1 the comparison.
  s.laps[1].excluded = true;
  tm._profiles.clear();
  assert.equal(tm.comparisonLap().number, 1);
});

test("frame exposes channels by role and timing as virtual channels", () => {
  const { text, t0, pre } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const f = makeFrame(s, new Timing(s), t0 + pre + 10, new Map());
  assert.ok(f.value("@speed") > 10);
  assert.ok(Math.abs(f.value("timing.elapsed") - 10) < 0.05);
  assert.equal(f.dimension("timing.delta"), "time");
  assert.ok(Number.isNaN(f.value("@rpm")), "missing channel is NaN, not an error");
});

test("units and formatting", () => {
  assert.equal(formatLapTime(68.849), "1:08.849");
  assert.equal(formatLapTime(9.5, 2), "9.50");
  assert.equal(formatLapTime(59.9996), "1:00.000");
  assert.equal(formatDelta(0.234), "+0.23");
  assert.equal(formatDelta(-0.004), "0.00");
  assert.ok(Math.abs(convert(10, "speed", "mph") - 22.369) < 0.001);
  assert.ok(Math.abs(convert(100, "temperature", "°F") - 212) < 1e-9);
});

test("placeElement keeps anchors when the output aspect changes", () => {
  const design = { width: 3840, height: 2160 };
  const el = { x: 3240, y: 1460, w: 500, h: 500, anchor: "br" };
  // Same aspect, half size: plain scaling.
  assert.deepEqual(placeElement(el, design, 1920, 1080), { x: 1620, y: 730, s: 0.5 });
  // Vertical 1080×1920: stays 100 design px from the right and 200 from the bottom.
  const p = placeElement(el, design, 1080, 1920);
  const s = 1080 / 3840;
  assert.ok(Math.abs(p.x + 500 * s - (1080 - 100 * s)) < 1e-9);
  assert.ok(Math.abs(p.y + 500 * s - (1920 - 200 * s)) < 1e-9);
});

test("gps-sync finds a camera clock offset from a shifted track", async () => {
  const { matchClockOffset } = await import("../src/core/gps-sync.js");
  const { text, t0, pre } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const lat = s.channel("@latitude"), lon = s.channel("@longitude");
  // Camera clock 169.4 s fast: a fix seen at data time T is stamped T + 169.4.
  const fixes = [];
  for (let t = t0 + pre - 3; t < t0 + pre + 30; t += 0.1) fixes.push({ t: t + 169.4, lat: lat.at(t), lon: lon.at(t) });
  const m = matchClockOffset(s, [fixes]);
  assert.ok(Math.abs(m.offset - -169.4) <= 0.06, `offset ${m.offset}`);
  assert.ok(m.error < 1, `error ${m.error}`);
  assert.throws(() => matchClockOffset(s, [fixes.map((f) => ({ ...f, lat: f.lat + 1 }))]), /doesn't line up/);
});

test("NMEA RMC parsing", async () => {
  const { parseNmea } = await import("../src/video/nmea.js");
  const fixes = parseNmea("$GPRMC,172514.500,A,3246.17281,N,09659.35402,W,0.03,290.09,151126,,,A*74\r\n$GPGGA,ignored\r\n$GPRMC,172515.000,V,,,,,,,151126,,,N*00\r\n");
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].t, Date.UTC(2026, 10, 15, 17, 25, 14) / 1000 + 0.5);
  assert.ok(Math.abs(fixes[0].lat - 32.7695468) < 1e-6);
  assert.ok(Math.abs(fixes[0].lon - -96.9892337) < 1e-6);
});

test("theoretical best stitches the fastest sections of different laps", async () => {
  const { Channel, Session } = await import("../src/core/session.js");
  // A 400 m lap, driven twice. Lap 1: first half at 20 m/s, second at 10 (10 s + 20 s).
  // Lap 2: the opposite (20 s + 10 s). Both are 30 s; the theoretical best is 10 + 10 = 20 s.
  const times = [], dist = [];
  let t = 0, d = 0;
  const drive = (meters, speed) => { for (let k = 0; k < meters; k++) { t += 1 / speed; d += 1; times.push(t); dist.push(d); } };
  times.push(0); dist.push(0);
  drive(200, 20); drive(200, 10); // lap 1: 0..30
  drive(200, 10); drive(200, 20); // lap 2: 30..60
  const ch = new Channel({ id: "d", name: "distance", unit: "m", dimension: "distance", role: "distance", maxGap: 5 }, Float64Array.from(times), Float64Array.from(dist));
  const s = new Session({ channels: [ch], laps: [{ number: 1, fragment: 0, start: 0, end: 30 }, { number: 2, fragment: 0, start: 30, end: 60 }], fragments: [{ id: 0, start: 0, end: 60 }] });
  const tm = new Timing(s);
  tm.setComparison("theoretical", 10);
  const theo = tm.comparisonLap();
  assert.ok(theo.theoretical);
  assert.ok(Math.abs(theo.duration - 20) < 0.05, `theoretical ${theo.duration}`);
  assert.equal(tm.comparisonLabel(), "THEO");
  // Watching lap 1: even at its fast half it matches the target; then it loses 10 s.
  assert.ok(Math.abs(tm.context(10).delta) < 0.05, `halfway ${tm.context(10).delta}`);
  assert.ok(Math.abs(tm.context(29.99).delta - 10) < 0.1, `finish ${tm.context(29.99).delta}`);
  assert.ok(Math.abs(tm.context(61).delta - 10) < 0.05, "after the last lap: its final difference");
  // Skipping a lap leaves one lap: falls back to the best lap.
  s.laps[1].excluded = true;
  tm.invalidate();
  assert.equal(tm.comparisonLap().number, 1);
  assert.equal(tm.comparisonLabel(), "SESSION");
});

test("delta modes: session, best so far, theoretical, and the lap compared with itself", async () => {
  const { makeFrame } = await import("../src/core/frame.js");
  const { deltaDisplay } = await import("../src/widgets/timing.js");
  const { text, t0, pre, lap1, lap2 } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const tm = new Timing(s);
  // Lap 2 (36 s) is the session best; lap 1 (40 s) came first.
  const inLap1 = makeFrame(s, tm, t0 + pre + 20, new Map());
  assert.ok(Math.abs(inLap1.deltaFor("session").delta - 2) < 0.1, "lap 1 halfway vs session best (lap 2)");
  const soFar1 = inLap1.deltaFor("so-far");
  assert.ok(Number.isNaN(soFar1.delta) && !soFar1.self, "nothing before lap 1 to compare with");
  assert.equal(soFar1.label, "BEST");

  const inLap2 = makeFrame(s, tm, t0 + pre + lap1 + 18, new Map());
  const self = inLap2.deltaFor("session");
  assert.ok(self.self && Number.isNaN(self.delta), "the session-best lap against itself has no delta");
  assert.ok(Math.abs(inLap2.deltaFor("so-far").delta - -2) < 0.1, "lap 2 halfway vs lap 1");
  assert.ok(Number.isFinite(inLap2.deltaFor("theoretical").delta), "theoretical is never the lap itself");
  assert.ok(inLap2.timing.deltaSelf, "template comparison (best) on the best lap: self");

  // Display: no comparison → "-.--" muted; rounding to zero → muted, not red/green.
  assert.deepEqual(deltaDisplay(self, 2, "good", "bad"), { text: "-.--", color: "muted", value: NaN });
  assert.equal(deltaDisplay({ delta: 0.004, self: false }, 2, "good", "bad").color, "muted");
  assert.equal(deltaDisplay({ delta: -0.004, self: false }, 2, "good", "bad").text, "0.00");
  assert.equal(deltaDisplay({ delta: -0.25, self: false }, 2, "good", "bad").color, "good");
  assert.equal(deltaDisplay({ delta: 0.25, self: false }, 2, "good", "bad").text, "+0.25");
});
