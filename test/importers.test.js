// Lap finding from gates, the VBO importer, the generic CSV importer, session
// merging and role guessing. Synthetic data only (no real GPS traces in the repo).

import { test } from "node:test";
import assert from "node:assert/strict";
import { bearing, findLaps, gateAt, gateCrossings, sessionTrack } from "../src/core/laps.js";
import { guessRole } from "../src/core/roles.js";
import { mergeSessions } from "../src/core/session.js";
import { parseRaceChronoV3 } from "../src/importers/racechrono-csv-v3.js";
import { parseVbo } from "../src/importers/vbo.js";
import { beaconMarkers, buildSession, guessMapping, sniffTable } from "../src/importers/generic-csv.js";
import { syntheticCsv } from "./synthetic.js";

const LAT0 = 40, LON0 = -100, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const at = (x, y) => ({ lat: LAT0 + y / 111320, lon: LON0 + x / KX });

/** A stage driven twice along y = 0 eastwards (x 0 → 1000 m at 20 m/s), returning west along y = 8 m. */
function stageTrack(t0 = 1_700_000_000) {
  const times = [], lats = [], lons = [];
  let t = t0;
  const push = (x, y) => { const p = at(x, y); times.push(t); lats.push(p.lat); lons.push(p.lon); t += 0.1; };
  for (let run = 0; run < 2; run++) {
    for (let x = 0; x <= 1000; x += 2) push(x, 0); // out, 20 m/s
    for (let x = 1000; x >= 0; x -= 2) push(x, 8); // back, close to the gates but the other way
  }
  return { times: Float64Array.from(times), lats: Float64Array.from(lats), lons: Float64Array.from(lons) };
}

test("gates count crossings only in their direction and within their width", () => {
  const tr = stageTrack();
  const east = { ...at(100, 0), heading: 90, width: 10 };
  assert.equal(gateCrossings(tr.times, tr.lats, tr.lons, east).length, 2, "two runs out");
  assert.equal(gateCrossings(tr.times, tr.lats, tr.lons, { ...east, heading: 270 }).length, 0, "the westbound returns pass 8 m to the side: outside a 10 m gate");
  const west = { ...at(100, 8), heading: 270, width: 10 };
  assert.equal(gateCrossings(tr.times, tr.lats, tr.lons, west).length, 2, "two returns");
  assert.equal(gateCrossings(tr.times, tr.lats, tr.lons, { ...east, width: 30 }).length, 2, "wider still only counts eastbound passes");
  assert.equal(gateCrossings(tr.times, tr.lats, tr.lons, { ...at(100, 40), heading: 90, width: 10 }).length, 0, "too far to the side");
});

test("separate start and finish: one run per start, timed to the next finish", () => {
  const tr = stageTrack();
  const laps = findLaps(tr, { start: { ...at(100, 0), heading: 90, width: 10 }, finish: { ...at(900, 0), heading: 90, width: 10 } });
  assert.equal(laps.length, 2);
  for (const l of laps) assert.ok(Math.abs(l.end - l.start - 40) < 0.01, `run ${l.end - l.start} s`); // 800 m at 20 m/s
});

test("a circuit gate on the synthetic loop gives RaceChrono's lap times", () => {
  const { text, t0, pre } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  const track = sessionTrack(s);
  const gate = gateAt(track, s.channel("@latitude").at(t0 + pre), s.channel("@longitude").at(t0 + pre));
  const laps = findLaps(track, { start: gate }, s.fragments);
  assert.deepEqual(laps.map((l) => Math.round(l.end - l.start)), [40, 36]);
  assert.equal(findLaps(track, { start: { ...gate, heading: (gate.heading + 180) % 360 } }, s.fragments).length, 0, "facing the wrong way: no laps");
});

// ── VBO ──

function vboText({ gatesAsLine = false, startSod = 23 * 3600 + 59 * 60 + 50, date = "15/11/2026" } = {}) {
  const lines = [`File created on ${date} at 23:59:50`, "", "[header]", "satellites", "time", "latitude", "longitude", "velocity kmh", "heading", "long accel g", "", "[laptiming]"];
  const deg2min = (d) => (d * 60).toFixed(6);
  const s = at(100, 0), f = at(900, 0), sBack = at(50, 0), fBack = at(850, 0);
  // RaceChrono's way: the crossing point, then a point 50 m back along the approach (longitude minutes, + = west).
  if (!gatesAsLine) {
    lines.push(`Start   ${deg2min(-s.lon)} ${deg2min(s.lat)} ${deg2min(-sBack.lon)} ${deg2min(sBack.lat)} ¬ Start`);
    lines.push(`Finish  ${deg2min(-f.lon)} ${deg2min(f.lat)} ${deg2min(-fBack.lon)} ${deg2min(fBack.lat)} ¬ Finish`);
  } else {
    const a = at(100, -10), b = at(100, 10), c = at(900, -10), d = at(900, 10);
    lines.push(`Start   ${deg2min(-a.lon)} ${deg2min(a.lat)} ${deg2min(-b.lon)} ${deg2min(b.lat)}`);
    lines.push(`Finish  ${deg2min(-c.lon)} ${deg2min(c.lat)} ${deg2min(-d.lon)} ${deg2min(d.lat)}`);
  }
  lines.push("", "[session data]", "name Test stage", "", "[column names]", "sats time lat long velocity heading longacc", "", "[data]");
  const tr = stageTrack(0);
  for (let i = 0; i < tr.times.length; i++) {
    const sod = startSod + tr.times[i]; // by default crosses midnight after 10 s
    const s2 = sod % 86400;
    const hh = Math.floor(s2 / 3600), mm = Math.floor((s2 % 3600) / 60), ss = s2 % 60;
    const time = `${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}${ss.toFixed(2).padStart(5, "0")}`;
    lines.push(`012 ${time} +${(tr.lats[i] * 60).toFixed(6)} +${(-tr.lons[i] * 60).toFixed(6)} 072.000 090.00 +000.100`);
  }
  return lines.join("\r\n");
}

test("VBO: units, west-positive longitude, midnight rollover, laps from RaceChrono-style gates", () => {
  const s = parseVbo(vboText(), "test.vbo");
  assert.equal(s.meta.title, "Test stage");
  assert.ok(Math.abs(s.channel("@longitude").values[0] - LON0) < 1e-6, "longitude sign");
  assert.ok(Math.abs(s.channel("@speed").values[0] - 20) < 1e-9, "72 km/h = 20 m/s");
  assert.equal(s.channel("@lon_g").values[0], 0.1);
  assert.equal(s.start, Date.UTC(2026, 10, 15, 23, 59, 50) / 1000);
  const T = s.channel("@latitude").times;
  assert.ok(T[T.length - 1] > Date.UTC(2026, 10, 16) / 1000, "times continue past midnight");
  assert.equal(s.laps.length, 2);
  for (const l of s.laps) assert.ok(Math.abs(l.duration - 40) < 0.01);
});

test("VBO: gates written as a line across the track also work", () => {
  const s = parseVbo(vboText({ gatesAsLine: true }), "test.vbo");
  assert.equal(s.laps.length, 2);
  for (const l of s.laps) assert.ok(Math.abs(l.duration - 40) < 0.01);
});

test("sessions split across files merge, with laps and fragments renumbered", () => {
  const a = parseVbo(vboText(), "a.vbo");
  const b = parseVbo(vboText({ date: "16/11/2026", startSod: 2 * 3600 }), "b.vbo"); // two hours later
  const m = mergeSessions([b, a]);
  assert.equal(m.fragments.length, a.fragments.length + b.fragments.length);
  assert.deepEqual(m.laps.map((l) => l.number), [1, 2, 3, 4]);
  assert.equal(m.meta.fileName, "a.vbo + b.vbo");
  assert.equal(m.channel("@speed").times.length, a.channel("@speed").times.length + b.channel("@speed").times.length);
});

// ── Generic CSV ──

const rowsOf = (n, f) => Array.from({ length: n }, (_, i) => f(i).join(",")).join("\n");

test("generic CSV: TrackAddict-style (UTC column preferred, MPH, lap column)", () => {
  const text = "Time,UTC Time,Lap,Latitude,Longitude,Speed (MPH),Engine RPM (RPM) *OBD\n" +
    rowsOf(400, (i) => [(i / 10).toFixed(2), (1.7e9 + i / 10).toFixed(2), i < 150 ? 0 : i < 300 ? 1 : 2, 40, -100, 45, 3000]);
  const t = sniffTable(text), m = guessMapping(t);
  assert.equal(t.headers[m.time], "UTC Time");
  assert.equal(m.timeKind, "unix-s");
  assert.equal(m.speedUnit, "MPH");
  const s = buildSession(t, m, "ta.csv");
  assert.equal(s.start, 1.7e9);
  assert.ok(Math.abs(s.channel("@speed").values[0] - 20.1168) < 1e-3, "45 mph in m/s");
  assert.ok(s.channel("@rpm"));
  assert.deepEqual(s.laps.map((l) => Math.round(l.duration)), [15], "lap 0 is the out-lap, the last block is unfinished");
});

test("generic CSV: RaceCapture-style header cells and empty cells at lower sample rates", () => {
  const text = '"Interval"|"ms"|1,"Utc"|"ms"|1,"LapCount"|""|1,"Latitude"|"Degrees"|10,"Longitude"|"Degrees"|10,"Speed"|"mph"|10\n' +
    rowsOf(300, (i) => [i * 100, 1.7e12 + i * 100, Math.floor(i / 100), i % 2 ? "" : 40, i % 2 ? "" : -100, 50]);
  const t = sniffTable(text), m = guessMapping(t);
  assert.deepEqual(t.headers.slice(0, 3), ["Interval", "Utc", "LapCount"]);
  assert.equal(t.headers[m.time], "Utc");
  assert.equal(m.timeKind, "unix-ms");
  const s = buildSession(t, m, "rc.csv");
  assert.equal(s.channel("@latitude").times.length, 150, "only rows with a value");
  assert.equal(s.laps.length, 1);
});

test("generic CSV: current RaceCapture header cells (label|units|min|max|rate)", () => {
  const text = '"Interval"|"ms"|0|0|1,"Utc"|"ms"|0|0|1,"Latitude"|"Degrees"|-180.000000|180.000000|10,"Longitude"|"Degrees"|-180.000000|180.000000|10,"Speed"|"mph"|0.00|150.00|10\n' +
    rowsOf(50, (i) => [i * 100, 1.7e12 + i * 100, 40, -100, 30]);
  const t = sniffTable(text), m = guessMapping(t);
  assert.deepEqual(t.headers, ["Interval", "Utc", "Latitude", "Longitude", "Speed"]);
  assert.deepEqual(t.units, ["ms", "ms", "Degrees", "Degrees", "mph"]);
  assert.equal(t.headers[m.time], "Utc");
  assert.equal(m.speedUnit, "mph");
});

test("generic CSV: AiM-style metadata, units row and beacon markers", () => {
  const text = '"Format","AiM CSV File"\n"Venue","Test"\n"Beacon Markers",10.5,40.2,71.0\n\n"Time","Distance","GPS Speed","GPS Latitude","GPS Longitude"\n"s","km","km/h","deg","deg"\n' +
    rowsOf(800, (i) => [(i / 10).toFixed(1), (i * 0.003).toFixed(3), 72, 40, -100]);
  const t = sniffTable(text), m = guessMapping(t);
  assert.equal(t.headerIndex, 4);
  assert.equal(t.headers[m.time], "Time");
  assert.equal(m.timeKind, "seconds");
  assert.equal(t.headers[m.distance], "Distance");
  m.beacons = beaconMarkers(t);
  const s = buildSession(t, { ...m, startTime: 1.7e9 }, "aim.csv");
  assert.equal(s.start, 1.7e9);
  assert.ok(Math.abs(s.channel("@speed").values[0] - 20) < 1e-9);
  assert.ok(Math.abs(s.channel("@distance").values[10] - 30) < 1e-9, "km to m");
  assert.deepEqual(s.laps.map((l) => +l.duration.toFixed(1)), [29.7, 30.8]);
});

test("generic CSV: semicolons, and nothing for a file with no table", () => {
  const t = sniffTable("time;lat;lon;speed\n" + Array.from({ length: 20 }, (_, i) => `${i};40;-100;10`).join("\n"));
  assert.equal(t.delimiter, ";");
  assert.equal(sniffTable("just some notes\nnothing tabular here"), null);
});

test("role guesses from column names", () => {
  const cases = { lat: "latitude", long: "longitude", "velocity kmh": "speed", longacc: "lon_g", "long accel g": "lon_g", "Lateral G": "lat_g", "Speed (MPH)": "speed", "Engine RPM (RPM) *OBD": "rpm", "Throttle Position (%)": "throttle", "Accel X": undefined, heading: "heading", "Distance (m)": "distance" };
  for (const [name, role] of Object.entries(cases)) assert.equal(guessRole(name), role, name);
  assert.ok(Math.abs(bearing(at(0, 0), at(100, 0)) - 90) < 0.01);
});
