// Any CSV (or tab/semicolon-separated text) with a header row: TrackAddict,
// AiM Race Studio exports, RaceCapture logs, spreadsheets... Columns are
// matched by guessing (time, latitude, longitude, speed, lap), and the app
// lets you confirm or change the guess; the choice is remembered for files
// with the same columns. Everything else numeric becomes a channel.
//
// The parsing here is pure (text in, Session out) so it's testable; the
// mapping dialog lives in src/app/csv-mapping-dialog.js.

import { importers } from "../core/registry.js";
import { guessRole } from "../core/roles.js";
import { Channel, Session } from "../core/session.js";
import { classifyUnit, normalizeValues } from "../core/units.js";

const DELIMS = [",", ";", "\t", "|"];

function split(line, d) {
  if (line.indexOf('"') < 0) return line.split(d).map((x) => x.trim());
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const isNum = (s) => s !== "" && Number.isFinite(Number(s));
const isClock = (s) => /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s);
const isValue = (s) => isNum(s) || isClock(s) || s === "";

/**
 * Finds the table in the text: delimiter, header row (with an optional units
 * row under it), and the data rows. Lines above the header (metadata) are
 * returned as `preamble`. Returns null if there's no table.
 */
export function sniffTable(text, maxRows = Infinity) {
  const lines = text.split(/\r?\n/);
  let best = null;
  for (const d of DELIMS) {
    // The header is the first line followed by a run of numeric rows with as many fields.
    for (let h = 0; h < Math.min(lines.length, 200); h++) {
      const head = split(lines[h], d);
      if (head.length < 2 || head.filter((x) => x && !isNum(x)).length < head.length / 2) continue;
      let r = h + 1, units = null;
      // A units row ("s", "km/h"...) may sit between header and data.
      for (let k = 0; k < 2 && r < lines.length; k++) {
        const f = split(lines[r], d);
        if (f.length === head.length && f.some((x) => x && !isValue(x))) { if (!units) units = f; r++; } else break;
      }
      let ok = 0;
      for (let i = r; i < Math.min(lines.length, r + 8); i++) {
        const f = split(lines[i], d);
        if (Math.abs(f.length - head.length) <= 1 && f.slice(0, head.length).filter(isValue).length >= head.length * 0.8) ok++;
      }
      if (ok >= Math.min(3, lines.length - r) && ok > 0) {
        const score = head.length * 10 + ok;
        // Keep looking: a short metadata line above the real header can look like one too.
        if (!best || score > best.score) best = { score, delimiter: d, headerIndex: h, dataIndex: r, headers: head.map((x, i) => x || `Column ${i + 1}`), units };
      }
    }
  }
  if (!best) return null;
  // RaceCapture writes each header cell as "Label"|"units"|min|max|sampleRate
  // (src/logger/fileWriter.c in its open-source firmware; older logs seen
  // with just "Label"|"units"|rate).
  if (best.headers.every((h) => /^[^|]+\|[^|]*(\|-?[\d.]+)+$/.test(h))) {
    const parts = best.headers.map((h) => h.split("|"));
    best.headers = parts.map((p) => p[0]);
    best.units = parts.map((p) => p[1]);
  }
  const rows = [];
  for (let i = best.dataIndex; i < lines.length && rows.length < maxRows; i++) {
    if (!lines[i].trim() || lines[i].startsWith("#")) continue;
    const f = split(lines[i], best.delimiter);
    if (f.length >= best.headers.length - 1) rows.push(f);
  }
  return { ...best, rows, preamble: lines.slice(0, best.headerIndex).filter((l) => l.trim()) };
}

/** Unit written in a header ("Speed (MPH)", "speed [km/h]", "velocity kmh") or the units row. */
export function unitOf(table, col) {
  const h = table.headers[col] || "";
  const m = /[([]\s*([^)\]]+?)\s*[)\]]/.exec(h);
  if (m && classifyUnit(m[1])) return m[1];
  const last = h.trim().split(/[\s_]+/).pop();
  if (last && last !== h.trim() && classifyUnit(last)) return last;
  const u = table.units && table.units[col];
  return u && classifyUnit(u) ? u : "";
}

const TIME_NAMES = /^(utc([_\s-]?time)?|timestamp|time([_\s-]?stamp)?|unix([_\s-]?time)?|epoch|date[_\s-]?time|gps[_\s-]?time|interval|elapsed([_\s-]?time)?|session[_\s-]?time|t)$/i;
const LAP_NAMES = /^(lap|lap[_\s-]?(number|no|num|#|count)|lapcount|current[_\s-]?lap)$/i;
const bare = (h) => String(h).replace(/\s*[([].*$/, "").trim();

/** Time column kinds and how to turn a cell into seconds. */
export const TIME_KINDS = {
  "unix-s": { label: "Unix time (s)", abs: true },
  "unix-ms": { label: "Unix time (ms)", abs: true },
  "seconds": { label: "Seconds from the start", abs: false },
  "ms": { label: "Milliseconds from the start", abs: false },
  "clock": { label: "Time of day (hh:mm:ss, UTC)", abs: false },
};

function timeKindFor(table, col) {
  const vals = table.rows.slice(0, 50).map((r) => r[col]).filter(Boolean);
  if (vals.length && vals.every(isClock)) return "clock";
  const nums = vals.map(Number).filter(Number.isFinite);
  const v = nums.length ? nums[0] : 0;
  const unit = (unitOf(table, col) || (table.units && table.units[col]) || bare(table.headers[col])).toLowerCase();
  if (v > 1e11) return "unix-ms";
  if (v > 1e8) return "unix-s";
  if (/(^|\b)ms\b|millis|interval/.test(unit + " " + table.headers[col].toLowerCase())) return "ms";
  return "seconds";
}

/**
 * A first guess at which column is what: { time, timeKind, lat, lon, speed,
 * speedUnit, distance, distanceUnit, lap } (column indexes, or -1).
 */
export function guessMapping(table) {
  const H = table.headers;
  const find = (pred) => H.findIndex((h, i) => pred(bare(h), i));
  const byRole = (role) => find((h, i) => guessRole(H[i]) === role);
  // Of several time columns, prefer one with real clock time (unix): auto-sync needs it.
  const times = H.map((h, i) => i).filter((i) => TIME_NAMES.test(bare(H[i])));
  const time = times.find((i) => TIME_KINDS[timeKindFor(table, i)].abs) ?? (times.length ? times[0] : -1);
  const speed = byRole("speed"), distance = byRole("distance");
  return {
    time,
    timeKind: time >= 0 ? timeKindFor(table, time) : "seconds",
    lat: byRole("latitude"),
    lon: byRole("longitude"),
    speed,
    speedUnit: speed >= 0 ? unitOf(table, speed) || "" : "",
    distance,
    distanceUnit: distance >= 0 ? unitOf(table, distance) || "m" : "m",
    lap: find((h) => LAP_NAMES.test(h)),
    startTime: null, // unix s, for relative time kinds
  };
}

/** A key for remembering a mapping: the column names. */
export function layoutKey(table) {
  return table.headers.map((h) => h.toLowerCase()).join("|");
}

function toSeconds(cell, kind) {
  if (cell == null || cell === "") return NaN;
  if (kind === "clock") {
    const p = cell.split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }
  const v = Number(cell);
  if (kind === "unix-ms" || kind === "ms") return v / 1000;
  return v;
}

/** Builds a Session from a sniffed table and a mapping. */
export function buildSession(table, map, fileName = "", fallbackStart = 0) {
  if (!(map.time >= 0)) throw new Error("Pick which column is the time.");
  const kind = map.timeKind;
  const absolute = TIME_KINDS[kind] && TIME_KINDS[kind].abs;
  const base = absolute ? 0 : Number.isFinite(map.startTime) ? map.startTime : fallbackStart;
  // Rows with a time, in order (some loggers write a few rows out of order or blank).
  const rows = table.rows.filter((r) => Number.isFinite(toSeconds(r[map.time], kind)));
  const times = new Float64Array(rows.length);
  let dayOffset = 0, prev = -Infinity;
  rows.forEach((r, i) => {
    let t = toSeconds(r[map.time], kind);
    if (kind === "clock") { if (t + dayOffset < prev - 43200) dayOffset += 86400; t += dayOffset; prev = t; }
    times[i] = base + t;
  });

  const channels = [], used = new Set();
  const special = { [map.lat]: "latitude", [map.lon]: "longitude", [map.speed]: "speed", [map.distance]: "distance" };
  table.headers.forEach((h, c) => {
    if (c === map.time || c === map.lap) return;
    // Columns with no numbers at all (names, notes) aren't channels.
    const sample = rows.slice(0, 200).map((r) => r[c]).filter((x) => x !== "" && x != null);
    if (!sample.length || sample.filter(isNum).length < sample.length * 0.8) return;
    // Loggers that sample channels at different rates leave cells empty:
    // keep only the rows where this channel has a value.
    const ts = [], vs = [];
    rows.forEach((r, i) => { const v = Number(r[c]); if (r[c] !== "" && Number.isFinite(v)) { ts.push(times[i]); vs.push(v); } });
    if (!ts.length) return;
    const values = Float64Array.from(vs);
    const forced = special[c];
    const unitName = c === map.speed ? map.speedUnit : c === map.distance ? map.distanceUnit : forced === "latitude" || forced === "longitude" ? "deg" : unitOf(table, c);
    const { dimension, unit } = normalizeValues(values, unitName);
    let role = forced || guessRole(h);
    if (!forced && (role === "latitude" || role === "longitude" || role === "speed" || role === "distance")) role = undefined; // the mapping decides those
    if (role && used.has(role)) role = undefined;
    if (role) used.add(role);
    channels.push(new Channel({ id: `c${c}`, name: bare(h) || h, unit, dimension, role, source: "csv", maxGap: 2 }, Float64Array.from(ts), values));
  });

  // Fragments at gaps over 10 s; laps from the lap column if there is one.
  const fragments = [];
  let fs = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || times[i] - times[i - 1] > 10) { if (times.length) fragments.push({ id: fragments.length, start: times[fs], end: times[i - 1] }); fs = i; }
  }
  const fragOf = (t) => (fragments.find((f) => t >= f.start && t <= f.end) || { id: 0 }).id;
  const laps = [];
  if (map.lap >= 0) {
    let cur = null;
    rows.forEach((r, i) => {
      const n = Number(r[map.lap]);
      if (cur && n !== cur.n) { if (cur.n > 0) laps.push({ number: cur.n, start: cur.start, end: times[i], fragment: fragOf(cur.start) }); cur = null; }
      if (!cur && Number.isFinite(n)) cur = { n, start: times[i] };
    });
    // The last block may be an unfinished lap: leave it out.
  } else if (map.beacons && map.beacons.length > 1) {
    // AiM's "Beacon Markers": seconds from the start at each lap line.
    for (let i = 0; i + 1 < map.beacons.length; i++) {
      const a = base + map.beacons[i], b = base + map.beacons[i + 1];
      laps.push({ number: i + 1, start: a, end: b, fragment: fragOf(a) });
    }
  }
  return new Session({
    meta: { title: fileName.replace(/\.[^.]+$/, ""), fileName, timeIsUtc: absolute || (kind === "clock"), csvLayout: layoutKey(table) },
    channels,
    laps: laps.filter((l) => l.end - l.start >= 5).map((l, i) => ({ ...l, number: i + 1 })),
    fragments,
  });
}

/** AiM exports list lap-line times in the preamble: "Beacon Markers",72.31,144.62,... */
export function beaconMarkers(table) {
  for (const l of table.preamble) {
    const f = split(l, table.delimiter);
    if (/^beacon[_\s-]?markers?$/i.test(f[0])) return f.slice(1).map(Number).filter(Number.isFinite);
  }
  return null;
}

/** Start time for relative times: a date/time in the preamble, else the file's modified time minus the log's length. */
function guessStart(table, file, map) {
  // Absolute times: the first one (used if you switch the kind to a relative one).
  if (TIME_KINDS[map.timeKind] && TIME_KINDS[map.timeKind].abs) {
    const first = table.rows.length ? toSeconds(table.rows[0][map.time], map.timeKind) : NaN;
    if (Number.isFinite(first)) return first;
  }
  for (const l of table.preamble) {
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(l);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  }
  if (map.timeKind === "clock") {
    const d = new Date(file && file.lastModified ? file.lastModified : Date.now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  }
  const last = table.rows.length ? toSeconds(table.rows[table.rows.length - 1][map.time], map.timeKind) : 0;
  return Math.round(((file && file.lastModified) || Date.now()) / 1000 - (Number.isFinite(last) ? last : 0));
}

importers.register({
  id: "generic-csv",
  label: "Other CSV / text (pick the columns)",
  extensions: [".csv", ".txt", ".tsv"],
  help: "Any CSV with a header row (TrackAddict, AiM Race Studio export, RaceCapture, a spreadsheet...): you confirm which column is time, position, speed and lap, once per layout.",
  // Low, so a dedicated importer always wins.
  detect: (head) => (sniffTable(head, 10) ? 0.1 : 0),
  /** ctx.askMapping(table, guess, { remembered }) -> mapping or null (cancel). */
  async parse(file, ctx = {}) {
    const table = sniffTable(await file.text());
    if (!table) throw new Error(`${file.name}: couldn't find a table with a header row.`);
    let map = guessMapping(table);
    map.startTime = guessStart(table, file, map);
    map.beacons = beaconMarkers(table);
    if (ctx.askMapping) {
      map = await ctx.askMapping(table, map, file);
      if (!map) throw Object.assign(new Error("Import cancelled."), { cancelled: true });
    }
    return buildSession(table, map, file.name, map.startTime);
  },
});
