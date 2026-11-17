// RaceChrono Pro "CSV v3" export (Export → CSV v3 (.csv), scope: whole session).
//
// Layout: a few "key,value" metadata lines, then three header rows (channel
// names, units, source device such as "100: gps" or "calc"), then one row per
// sample. Rows mix channels recorded at different rates; empty cells mean "no
// sample of this channel at this timestamp". Column names repeat when several
// devices record the same quantity (e.g. GPS speed and calculated speed).

import { importers } from "../core/registry.js";
import { Channel, Session } from "../core/session.js";
import { normalizeValues } from "../core/units.js";
import { ENGINE_ROLE_PATTERNS } from "../core/roles.js";

// Column name → role. First column with a given role wins (GPS before calc).
const ROLE_BY_NAME = {
  speed: "speed",
  latitude: "latitude",
  longitude: "longitude",
  altitude: "altitude",
  bearing: "heading",
  distance_traveled: "distance",
  lateral_acc: "lat_g",
  longitudinal_acc: "lon_g",
  combined_acc: "combined_g",
  lean_angle: "lean",
};
// Looser patterns for channels whose names depend on the user's CAN/OBD setup.
const ROLE_PATTERNS = ENGINE_ROLE_PATTERNS;
const SKIP = new Set(["timestamp", "fragment_id", "lap_number", "elapsed_time"]);

function splitCsvLine(line) {
  if (line.indexOf('"') < 0) return line.split(",");
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function detectRaceChronoV3(head) {
  const lines = head.split(/\r?\n/, 12);
  const isRc = /RaceChrono/i.test(lines[0] || "");
  const v3 = lines.some((l) => /^Format,\s*3\s*$/.test(l));
  const hdr = lines.some((l) => l.startsWith("timestamp,"));
  return isRc && v3 ? 1 : hdr && v3 ? 0.8 : 0;
}

/** Parses the CSV text into a Session. Pure function (no DOM), used by tests too. */
export function parseRaceChronoV3(text, { fileName = "" } = {}) {
  let pos = 0;
  const nextLine = () => {
    if (pos >= text.length) return null;
    let e = text.indexOf("\n", pos);
    if (e < 0) e = text.length;
    let line = text.slice(pos, e);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    pos = e + 1;
    return line;
  };

  const meta = { source: "RaceChrono CSV v3", fileName };
  let line, names = null;
  while ((line = nextLine()) !== null) {
    if (line.startsWith("timestamp,")) { names = splitCsvLine(line); break; }
    const [k, ...rest] = splitCsvLine(line);
    const v = rest.join(",").trim();
    if (/^This file is created using/i.test(k)) meta.generator = k.replace(/^This file is created using\s*/i, "").replace(/\s*\(.*$/, "");
    else if (k === "Session title") meta.title = v;
    else if (k === "Track name") meta.track = v;
    else if (k === "Driver name") meta.driver = v;
    else if (k === "Session type") meta.sessionType = v;
    else if (k === "Created") meta.date = rest.join(" ").trim();
    else if (k === "Note") meta.note = v;
  }
  if (!names) throw new Error("No 'timestamp,...' header row found: not a RaceChrono CSV v3 file?");
  const units = splitCsvLine(nextLine() || "");
  const sources = splitCsvLine(nextLine() || "");

  const col = (n) => names.indexOf(n);
  const iT = col("timestamp"), iFrag = col("fragment_id"), iLap = col("lap_number");

  // Pass 1: count rows to size the arrays.
  const dataStart = pos;
  let rows = 0;
  for (let i = dataStart; i < text.length; i++) if (text.charCodeAt(i) === 10) rows++;
  if (text.length && text.charCodeAt(text.length - 1) !== 10) rows++;

  const nCol = names.length;
  const cols = [];
  const seen = new Map();
  for (let c = 0; c < nCol; c++) {
    const name = names[c];
    if (SKIP.has(name) || !name) { cols.push(null); continue; }
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    const source = (sources[c] || "").trim();
    cols.push({ name, id: n === 1 ? name : `${name}#${n}`, unit: (units[c] || "").trim(), source, n: 0, t: new Float64Array(rows), v: new Float64Array(rows) });
  }

  const times = [];
  const frags = new Map(); // id -> {start,end}
  const laps = new Map(); // "frag|lap" -> {number, fragment, start, end}
  pos = dataStart;
  while ((line = nextLine()) !== null) {
    if (!line) continue;
    const cells = line.split(",");
    const t = parseFloat(cells[iT]);
    if (!Number.isFinite(t)) continue;
    times.push(t);
    const fid = iFrag >= 0 && cells[iFrag] !== "" ? Number(cells[iFrag]) : 0;
    let f = frags.get(fid);
    if (!f) frags.set(fid, (f = { id: fid, start: t, end: t }));
    else { if (t < f.start) f.start = t; if (t > f.end) f.end = t; }
    if (iLap >= 0 && cells[iLap] !== "" && cells[iLap] !== undefined) {
      const key = `${fid}|${cells[iLap]}`;
      let l = laps.get(key);
      if (!l) laps.set(key, (l = { number: Number(cells[iLap]), fragment: fid, start: t, end: t }));
      else { if (t < l.start) l.start = t; if (t > l.end) l.end = t; }
    }
    for (let c = 0; c < nCol; c++) {
      const cd = cols[c];
      if (!cd) continue;
      const s = cells[c];
      if (s === undefined || s === "") continue;
      const v = parseFloat(s);
      if (!Number.isFinite(v)) continue;
      cd.t[cd.n] = t;
      cd.v[cd.n] = v;
      cd.n++;
    }
  }

  const usedRoles = new Set();
  const channels = [];
  for (const cd of cols) {
    if (!cd || cd.n === 0) continue;
    const values = cd.v.slice(0, cd.n);
    const tArr = cd.t.slice(0, cd.n);
    const { dimension, unit } = normalizeValues(values, cd.unit);
    let role = ROLE_BY_NAME[cd.name];
    if (!role) for (const [re, r] of ROLE_PATTERNS) if (re.test(cd.name)) { role = r; break; }
    if (role && usedRoles.has(role)) role = undefined;
    if (role) usedRoles.add(role);
    // A channel's own sample spacing sets what counts as a gap (dropouts).
    const median = medianStep(tArr);
    channels.push(new Channel({ id: cd.id, name: cd.name, unit, dimension, source: cd.source, role, maxGap: Math.max(1, median * 10) }, tArr, values));
  }

  return new Session({
    meta,
    channels,
    laps: [...laps.values()],
    fragments: [...frags.values()],
  });
}

function medianStep(t) {
  if (t.length < 3) return 1;
  const n = Math.min(t.length - 1, 2001);
  const step = Math.max(1, Math.floor((t.length - 1) / n));
  const d = [];
  for (let i = step; i < t.length; i += step) d.push(t[i] - t[i - step]);
  d.sort((a, b) => a - b);
  return d[d.length >> 1] / step;
}

importers.register({
  id: "racechrono-csv-v3",
  label: "RaceChrono CSV v3",
  extensions: [".csv"],
  help: "In RaceChrono Pro: open the session → Export → CSV v3 (.csv), scope: whole session.",
  tested: { level: "real", text: "Tested with real RaceChrono Pro sessions." },
  detect: (head) => detectRaceChronoV3(head),
  async parse(file) {
    return parseRaceChronoV3(await file.text(), { fileName: file.name });
  },
});
