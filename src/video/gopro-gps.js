// GPS track recorded inside GoPro clips (GPMF telemetry, "gpmd" metadata
// track). Format: https://github.com/gopro/gpmf-parser (Apache-2.0).
//
// Each sample of the metadata track is a GPMF payload covering a stretch of
// the video (about 1 s). GPMF is KLV: a 4-character key, a type character,
// a struct size and a repeat count (big-endian), then the data padded to 4
// bytes. Type 0 means the data is more KLV (DEVC device > STRM stream > ...).
//
// GPS streams:
//   GPS5 (HERO5-HERO11): lat, lon, alt, 2D speed, 3D speed as int32 / SCAL,
//     ~18 Hz (10 Hz on HERO11). Sticky GPSU (UTC, "yymmddhhmmss.sss"),
//     GPSF (fix: 0 none, 2 2D, 3 3D) and GPSP (DOP x100) apply to the payload.
//   GPS9 (HERO11, HERO13+): the same plus days since 2000, seconds since
//     midnight, DOP and fix in every sample (TYPE "lllllllSS").
//   The HERO12 Black, HERO11 Mini and HERO10 Bones have no GPS.
//
// Fix times are returned on the CAMERA's clock (file creation time + video
// time), like the DJI reader, so the same matcher works. GoPro GPS also gives
// real UTC, so utcOffset says roughly how far off the camera clock is: the
// matcher can then search a narrow window around it, whatever the camera's
// time zone setting.

import { findTrack, movieHeader, readMoov, readSamples, sampleTable, sampleTimes, type4 } from "./mp4-boxes.js";

const SIZES = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4, Q: 8, U: 16, F: 4, G: 16 };
const GPS_EPOCH_2000 = Date.UTC(2000, 0, 1) / 1000;
const MAX_DOP = 5; // GPSP under 500 is "good" per GoPro's docs

/** Iterates the KLV items in b[start, end). */
export function* klv(b, start = 0, end = b.length) {
  let p = start;
  while (p + 8 <= end) {
    const key = type4(b, p);
    const type = b[p + 4], size = b[p + 5], repeat = (b[p + 6] << 8) | b[p + 7];
    const len = size * repeat, data = p + 8;
    if (data + len > end) return;
    if (key !== "\0\0\0\0") yield { key, type: type ? String.fromCharCode(type) : null, size, repeat, start: data, end: data + len };
    p = data + ((len + 3) & ~3);
  }
}

function readOne(dv, o, t) {
  switch (t) {
    case "b": return dv.getInt8(o);
    case "B": case "c": return dv.getUint8(o);
    case "s": return dv.getInt16(o);
    case "S": return dv.getUint16(o);
    case "l": return dv.getInt32(o);
    case "L": return dv.getUint32(o);
    case "f": return dv.getFloat32(o);
    case "d": return dv.getFloat64(o);
    case "j": return Number(dv.getBigInt64(o));
    case "J": return Number(dv.getBigUint64(o));
    case "q": return dv.getInt32(o) / 65536;
    case "Q": return Number(dv.getBigInt64(o)) / 2 ** 32;
    default: return NaN;
  }
}

/**
 * The values of an item as rows (one per repeat). `types` is a string with
 * one type character per field: the item's own type repeated, or the TYPE
 * string for complex ("?") items.
 */
export function rows(b, item, types) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fieldTypes = item.type === "?" ? types : item.type.repeat(Math.max(1, item.size / (SIZES[item.type] || item.size)));
  const out = [];
  for (let r = 0; r < item.repeat; r++) {
    let o = item.start + r * item.size;
    const row = [];
    for (const t of fieldTypes) {
      row.push(readOne(dv, o, t));
      o += SIZES[t] || 0;
    }
    out.push(row);
  }
  return out;
}

function text(b, item) {
  return new TextDecoder().decode(b.subarray(item.start, item.end)).replace(/\0+$/, "");
}

/** "yymmddhhmmss.sss" -> unix seconds. */
export function parseGpsu(s) {
  const m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d(?:\.\d+)?)/.exec(s);
  if (!m) return NaN;
  return Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 + Number(m[6]);
}

function scaled(row, scal) {
  return row.map((v, i) => v / (scal.length > 1 ? scal[i] || 1 : scal[0] || 1));
}

/**
 * GPS fixes from one GPMF payload covering [t0, t0 + dur) of the video.
 * Returns { device, fixes: [{ video (s into the clip), lat, lon, utc }] }.
 */
export function payloadFixes(b, t0, dur) {
  const fixes = [];
  let device = "";
  for (const devc of klv(b)) {
    if (devc.key !== "DEVC") continue;
    for (const strm of klv(b, devc.start, devc.end)) {
      if (strm.key === "DVNM") device = text(b, strm);
      if (strm.key !== "STRM") continue;
      let scal = [1], types = "", gpsu = NaN, gpsf = 3, gpsp = 0, gps5 = null, gps9 = null;
      for (const it of klv(b, strm.start, strm.end)) {
        if (it.key === "SCAL") scal = rows(b, it).flat();
        else if (it.key === "TYPE") types = text(b, it);
        else if (it.key === "GPSU") gpsu = parseGpsu(text(b, it));
        else if (it.key === "GPSF") gpsf = rows(b, it)[0][0];
        else if (it.key === "GPSP") gpsp = rows(b, it)[0][0];
        else if (it.key === "GPS5") gps5 = { it, scal: [...scal] };
        else if (it.key === "GPS9") gps9 = { it, scal: [...scal], types };
      }
      if (gps9) {
        const rs = rows(b, gps9.it, gps9.types || "lllllllSS");
        rs.forEach((r, k) => {
          const v = scaled(r, gps9.scal);
          const [lat, lon, , , , days, secs, dop, fix] = v;
          if (fix < 2 || dop > MAX_DOP) return;
          fixes.push({ video: t0 + (dur * k) / rs.length, lat, lon, utc: GPS_EPOCH_2000 + r[5] * 86400 + secs });
        });
      } else if (gps5 && gpsf >= 2 && gpsp / 100 <= MAX_DOP) {
        const rs = rows(b, gps5.it);
        rs.forEach((r, k) => {
          const [lat, lon] = scaled(r, gps5.scal);
          // GPSU stamps the payload; samples are spread evenly across it.
          fixes.push({ video: t0 + (dur * k) / rs.length, lat, lon, utc: gpsu + (dur * k) / rs.length });
        });
      }
    }
  }
  return { device, fixes: fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && (f.lat || f.lon)) };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
}

/**
 * Reads the GPS track of a GoPro clip. Returns null if the file has no GPMF
 * track; otherwise { device, creationTime (unix s, camera clock), duration,
 * fixes: [{ t (camera clock), lat, lon, utc }], utcOffset (s to add to camera
 * time to get UTC, or null without GPS time) }. fixes is empty when the
 * camera has no GPS or never got a fix.
 */
export async function readGoProTrack(file) {
  const moov = await readMoov(file);
  if (!moov) return null;
  const { b } = moov;
  const head = movieHeader(b, moov.box);
  const track = head && findTrack(b, moov.box, "gpmd");
  if (!track) return null;
  const table = sampleTable(b, track.stbl);
  const times = sampleTimes(b, track.stbl, track.timescale);
  if (!table || !times) return null;
  const samples = await readSamples(file, table);
  const fixes = [];
  let device = "";
  samples.forEach((s, i) => {
    const p = payloadFixes(s, times.starts[i] ?? 0, times.durations[i] ?? 1);
    if (p.device) device = p.device;
    for (const f of p.fixes) fixes.push({ t: head.created + f.video, lat: f.lat, lon: f.lon, utc: f.utc });
  });
  const diffs = fixes.filter((f) => Number.isFinite(f.utc)).map((f) => f.utc - f.t);
  return {
    device,
    creationTime: head.created,
    duration: head.duration,
    fixes,
    utcOffset: diffs.length ? median(diffs) : null,
  };
}
