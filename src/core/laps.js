// Finding laps from timing gates: for data that has a GPS track but no laps
// (VBO, NMEA, generic CSV, camera GPS), or to redo laps a timer got wrong.
//
// A gate is a point on the course plus the direction you drive through it:
//   { name, lat, lon, heading (deg, direction of travel), width (m) }
// A crossing is when the track passes through the gate's line (through the
// point, square to the heading, `width` wide) going the gate's way. Driving
// the other way, or passing further out than width / 2, doesn't count, so
// a course that doubles back near the start doesn't trigger it.
//
// Circuits use one gate (start = finish): every crossing ends a lap and
// starts the next. Autocross and stages have separate start and finish
// gates: a run goes from a start crossing to the next finish crossing.

export const DEFAULT_GATE_WIDTH = 30; // m: a wide autocross start box, not the neighbouring lane

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Heading (deg, 0 = north, clockwise) from point a to point b. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Flat x/y in metres around `origin` (fine over a few km). */
function projector(origin) {
  const kx = (Math.PI / 180) * R * Math.cos(rad(origin.lat)), ky = (Math.PI / 180) * R;
  return (lat, lon) => [(lon - origin.lon) * kx, (lat - origin.lat) * ky];
}

/**
 * Times (unix s) where the track crosses `gate` in its direction.
 * @param times, lats, lons  arrays of equal length, times ascending
 * @param o.maxStep   samples further apart (s) aren't joined (data gaps)
 * @param o.minGap    crossings closer than this (s) are one crossing (GPS jitter at the line)
 */
export function gateCrossings(times, lats, lons, gate, { maxStep = 2, minGap = 5 } = {}) {
  const proj = projector(gate);
  const h = rad(gate.heading);
  const dx = Math.sin(h), dy = Math.cos(h); // along the direction of travel
  const half = (gate.width || DEFAULT_GATE_WIDTH) / 2;
  const out = [];
  let prev = null;
  for (let i = 0; i < times.length; i++) {
    const lat = lats[i], lon = lons[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) { prev = null; continue; }
    const [x, y] = proj(lat, lon);
    const along = x * dx + y * dy, across = x * dy - y * dx;
    const cur = { t: times[i], along, across };
    if (prev && cur.t - prev.t <= maxStep && prev.along < 0 && cur.along >= 0) {
      const f = prev.along === cur.along ? 0 : -prev.along / (cur.along - prev.along);
      const side = prev.across + f * (cur.across - prev.across);
      // Far from the gate, the projection isn't a line crossing at all.
      if (Math.abs(side) <= half && Math.abs(prev.along) < 200 && Math.abs(cur.along) < 200) {
        const t = prev.t + f * (cur.t - prev.t);
        if (!out.length || t - out[out.length - 1] >= minGap) out.push(t);
      }
    }
    prev = cur;
  }
  return out;
}

/**
 * Laps from gates. `gates` is { start, finish } (finish missing or the same
 * as start: a circuit). Returns [{ number, start, end, fragment }] for a
 * Session; laps never span two fragments.
 * @param track      { times, lats, lons }
 * @param fragments  [{ id, start, end }]
 * @param o.minLap   shorter laps are dropped (s)
 */
export function findLaps(track, gates, fragments = [], { minLap = 10, maxStep = 2 } = {}) {
  const { times, lats, lons } = track;
  const fragOf = (t) => {
    const f = fragments.find((x) => t >= x.start && t <= x.end);
    return f ? f.id : 0;
  };
  const starts = gateCrossings(times, lats, lons, gates.start, { maxStep });
  const circuit = !gates.finish || sameGate(gates.start, gates.finish);
  const pairs = [];
  if (circuit) {
    for (let i = 0; i + 1 < starts.length; i++) pairs.push([starts[i], starts[i + 1]]);
  } else {
    const finishes = gateCrossings(times, lats, lons, gates.finish, { maxStep });
    for (let i = 0; i < starts.length; i++) {
      const next = i + 1 < starts.length ? starts[i + 1] : Infinity;
      // The first finish after this start, before the next start: else it's a DNF.
      const f = finishes.find((t) => t > starts[i] && t < next);
      if (f != null) pairs.push([starts[i], f]);
    }
  }
  const laps = [];
  for (const [a, b] of pairs) {
    if (b - a < minLap || fragOf(a) !== fragOf(b)) continue;
    laps.push({ number: laps.length + 1, start: a, end: b, fragment: fragOf(a) });
  }
  return laps;
}

function sameGate(a, b) {
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7 && Math.abs(a.heading - b.heading) < 1e-3;
}

/** The track of a session (its @latitude/@longitude channels on the latitude channel's times), or null. */
export function sessionTrack(session) {
  const lat = session.channel("@latitude"), lon = session.channel("@longitude");
  if (!lat || !lon) return null;
  const lons = lat.times === lon.times ? lon.values : Float64Array.from(lat.times, (t) => lon.at(t));
  return { times: lat.times, lats: lat.values, lons };
}

/**
 * A gate where the track passes nearest to (lat, lon), facing the way the
 * car was going there: for placing gates by clicking a map.
 */
export function gateAt(track, lat, lon, width = DEFAULT_GATE_WIDTH) {
  const proj = projector({ lat, lon });
  let best = -1, bestD = Infinity;
  for (let i = 0; i < track.times.length; i++) {
    const [x, y] = proj(track.lats[i], track.lons[i]);
    const d = x * x + y * y;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  // Direction from a sample ~1 s back to ~1 s ahead.
  const t0 = track.times[best];
  let a = best, b = best;
  while (a > 0 && t0 - track.times[a] < 1) a--;
  while (b < track.times.length - 1 && track.times[b] - t0 < 1) b++;
  const p = { lat: track.lats[best], lon: track.lons[best] };
  return { lat: p.lat, lon: p.lon, heading: bearing({ lat: track.lats[a], lon: track.lons[a] }, { lat: track.lats[b], lon: track.lons[b] }), width };
}

/** Laps from gates in the shape a Session keeps them (with duration and Skip flag). */
export function lapsFromGates(session, gates, opts) {
  const track = sessionTrack(session);
  if (!track || !gates || !gates.start) return [];
  return findLaps(track, gates, session.fragments, opts).map((l) => ({ excluded: false, ...l, duration: l.end - l.start }));
}
