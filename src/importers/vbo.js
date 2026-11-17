// VBO: Racelogic's VBOX text format, also exported by RaceChrono, Harry's
// LapTimer and TrackAddict. Structure (developers.racelogic.co.uk, "VBO file
// structure"): a "File created on dd/mm/yyyy" line, then sections:
//   [header]        one line per channel: name and unit ("velocity kmh")
//   [laptiming]     optional timing gates (see gatesFromVbo)
//   [session data]  optional, e.g. "name <session name>"
//   [column names]  one line, space-separated short names
//   [data]          one sample per line, space-separated
// Conventions (checked against RaceChrono's CSV of the same session: same
// positions to millimetres, same speeds):
//   time   hhmmss.ss, UTC time of day (the date is in the first line)
//   lat    minutes, + = north;  long  minutes, + = WEST (opposite to usual)
//   velocity km/h, heading deg, height m, latacc/longacc G
// Laps aren't in the data: they're found from the [laptiming] gates.

import { importers } from "../core/registry.js";
import { bearing, findLaps, DEFAULT_GATE_WIDTH } from "../core/laps.js";
import { guessRole } from "../core/roles.js";
import { Channel, Session, mergeSessions } from "../core/session.js";
import { normalizeValues } from "../core/units.js";

const KNOWN = {
  time: { skip: true },
  sats: { name: "Satellites" },
  lat: { name: "Latitude", unit: "deg", role: "latitude", convert: (v) => v / 60 },
  long: { name: "Longitude", unit: "deg", role: "longitude", convert: (v) => -v / 60 },
  velocity: { name: "Speed", unit: "km/h", role: "speed" },
  heading: { name: "Heading", unit: "deg", role: "heading" },
  height: { name: "Altitude", unit: "m", role: "altitude" },
  latacc: { name: "Lateral G", unit: "g", role: "lat_g" },
  longacc: { name: "Longitudinal G", unit: "g", role: "lon_g" },
};

function sections(text) {
  const out = { _pre: [] };
  let cur = out._pre;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^\[([^\]]+)\]$/.exec(line);
    if (m) { cur = out[m[1].toLowerCase()] = []; continue; }
    if (line) cur.push(line);
  }
  return out;
}

/** "File created on 15/11/2026 at 17:16:20" -> unix seconds of that day's 00:00 UTC, or NaN. */
function fileDate(lines) {
  for (const l of lines) {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(l);
    if (m) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return Date.UTC(y, +m[2] - 1, +m[1]) / 1000;
    }
  }
  return NaN;
}

function hms(s) {
  const v = Number(s);
  if (!Number.isFinite(v)) return NaN;
  const h = Math.floor(v / 10000), m = Math.floor((v % 10000) / 100);
  return h * 3600 + m * 60 + (v % 100);
}

/**
 * Gates from [laptiming] lines: "Start lon1 lat1 lon2 lat2 ¬ label". In
 * RaceChrono's files the car crosses at point 1 and point 2 lies 50 m back
 * along the approach, so the gate faces from 2 to 1. Other writers may mean
 * a line from point 1 to point 2; `asLine` reads it that way instead.
 */
export function gatesFromVbo(lines, { asLine = false, reverse = false } = {}) {
  const gates = {};
  for (const l of lines || []) {
    const m = /^(\w+)\s+([-+]?[\d.]+)\s+([-+]?[\d.]+)\s+([-+]?[\d.]+)\s+([-+]?[\d.]+)/.exec(l);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (kind !== "start" && kind !== "finish") continue;
    const p1 = { lon: -Number(m[2]) / 60, lat: Number(m[3]) / 60 }, p2 = { lon: -Number(m[4]) / 60, lat: Number(m[5]) / 60 };
    let gate;
    if (!asLine) gate = { ...p1, heading: bearing(p2, p1), width: DEFAULT_GATE_WIDTH };
    else {
      const mid = { lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2 };
      const len = Math.hypot((p2.lat - p1.lat) * 111320, (p2.lon - p1.lon) * 111320 * Math.cos((mid.lat * Math.PI) / 180));
      gate = { ...mid, heading: (bearing(p1, p2) + (reverse ? 270 : 90)) % 360, width: Math.max(len, 5) };
    }
    gates[kind] = { name: kind === "start" ? "Start" : "Finish", ...gate };
  }
  return gates.start ? gates : null;
}

export function parseVbo(text, fileName = "") {
  const sec = sections(text);
  const day = fileDate(sec._pre);
  const names = (sec["column names"] && sec["column names"][0] ? sec["column names"][0].split(/\s+/) : (sec.header || []).map((h) => h.split(/\s+/)[0])).map((n) => n.toLowerCase());
  const header = sec.header || [];
  const rows = sec.data || [];
  if (!names.length || !rows.length) throw new Error("This VBO file has no [column names] or no [data].");
  const ti = names.indexOf("time");
  if (ti < 0) throw new Error("This VBO file has no time column.");

  // Parse columns; times roll over at midnight.
  const n = rows.length, cols = names.map(() => new Float64Array(n)), times = new Float64Array(n);
  let k = 0, dayOffset = 0, prevSod = -Infinity;
  for (const line of rows) {
    const f = line.split(/\s+/);
    if (f.length < names.length) continue;
    let sod = hms(f[ti]);
    if (!Number.isFinite(sod)) continue;
    if (sod + dayOffset < prevSod - 43200) dayOffset += 86400;
    sod += dayOffset;
    prevSod = sod;
    times[k] = (Number.isFinite(day) ? day : 0) + sod;
    for (let c = 0; c < names.length; c++) cols[c][k] = Number(f[c]);
    k++;
  }
  const T = times.subarray(0, k);

  const channels = [], used = new Set();
  names.forEach((name, c) => {
    const known = KNOWN[name];
    if (known && known.skip) return;
    const values = cols[c].subarray(0, k).slice();
    if (known && known.convert) for (let i = 0; i < values.length; i++) values[i] = known.convert(values[i]);
    // Unit: the known one, else the header line's last word ("velocity-calc kmh").
    const hdr = header[c] || "";
    const hdrUnit = hdr.split(/\s+/).length > 1 ? hdr.split(/\s+/).pop() : "";
    const { dimension, unit } = normalizeValues(values, (known && known.unit) || hdrUnit);
    let role = (known && known.role) || guessRole(hdr || name);
    if (role && used.has(role)) role = undefined;
    if (role) used.add(role);
    channels.push(new Channel({ id: name, name: (known && known.name) || hdr || name, unit, dimension, role, source: "vbo", maxGap: 1 }, T, values));
  });

  // Fragments: split where the logger paused (gaps over 10 s).
  const fragments = [];
  let fs = 0;
  for (let i = 1; i <= k; i++) {
    if (i === k || T[i] - T[i - 1] > 10) { fragments.push({ id: fragments.length, start: T[fs], end: T[i - 1] }); fs = i; }
  }

  const sessionName = (sec["session data"] || []).map((l) => /^name\s+(.*)$/i.exec(l)).find(Boolean);
  const meta = {
    title: sessionName ? sessionName[1] : fileName.replace(/\.vbo$/i, ""),
    generator: (sec.comments || []).find((l) => /generated|created/i.test(l)) || "",
    fileName,
    timeIsUtc: Number.isFinite(day),
  };

  // Laps from the gates. Try the RaceChrono reading first, then a line.
  let gates = null, laps = [];
  const latC = channels.find((c) => c.role === "latitude"), lonC = channels.find((c) => c.role === "longitude");
  if (latC && lonC && sec.laptiming) {
    const track = { times: T, lats: latC.values, lons: lonC.values };
    for (const opts of [{}, { asLine: true }, { asLine: true, reverse: true }]) {
      const g = gatesFromVbo(sec.laptiming, opts);
      if (!g) break;
      const found = findLaps(track, g, fragments);
      if (found.length) { gates = g; laps = found; break; }
      if (!gates) gates = g;
    }
  }
  const session = new Session({ meta, channels, laps, fragments });
  session.gates = gates;
  return session;
}

importers.register({
  id: "vbo",
  label: "VBO (VBOX, RaceChrono, Harry's LapTimer, TrackAddict)",
  extensions: [".vbo"],
  help: "VBO files from a Racelogic VBOX, or exported as VBO from RaceChrono, Harry's LapTimer or TrackAddict. A session split into several files (RaceChrono: _start, _resume…) can be loaded together: select them all.",
  tested: { level: "partial", text: "Tested with RaceChrono's VBO export. VBOs from a VBOX, Harry's LapTimer or TrackAddict are untested: their column names or start/finish lines may differ." },
  detect: (head) => (/^\[header\]/im.test(head) && /^\[(column names|data)\]/im.test(head) ? 0.95 : 0),
  async parse(file) {
    return parseVbo(await file.text(), file.name);
  },
  async parseMany(files) {
    return mergeSessions(await Promise.all(files.map(async (f) => parseVbo(await f.text(), f.name))));
  },
});
