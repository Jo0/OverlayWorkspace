// Minimal NMEA reader: position fixes from $--RMC sentences. Used for the
// camera-side GPS track that CameraWorkflow writes next to each flipped clip
// (<clip>.nmea, timestamped by the camera clock), or any GPS logger's NMEA.

function coord(v, hemi) {
  const d = parseFloat(v);
  if (!Number.isFinite(d)) return NaN;
  const deg = Math.floor(d / 100);
  const x = deg + (d - deg * 100) / 60;
  return hemi === "S" || hemi === "W" ? -x : x;
}

/** @returns [{ t (unix s), lat, lon }] in file order. */
export function parseNmea(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\$..RMC,/.test(line)) continue;
    const p = line.split("*")[0].split(",");
    if (p[2] !== "A") continue;
    const tm = p[1], dt = p[9];
    if (!tm || !dt || dt.length < 6) continue;
    const t = Date.UTC(2000 + Number(dt.slice(4, 6)), Number(dt.slice(2, 4)) - 1, Number(dt.slice(0, 2)),
      Number(tm.slice(0, 2)), Number(tm.slice(2, 4)), 0) / 1000 + parseFloat(tm.slice(4));
    const lat = coord(p[3], p[4]), lon = coord(p[5], p[6]);
    if (Number.isFinite(t) && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ t, lat, lon });
  }
  return out;
}
