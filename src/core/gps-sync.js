// Finds a camera's clock offset by matching the GPS track the camera recorded
// (camera clock) to the session's GPS track (logger clock). Port of
// CameraWorkflow/clock_offset.py.
//
// Coarse search in 1 s steps over ±maxOffset, then refined to 0.05 s. When
// several clips share the camera clock, searching them together avoids
// locking onto the wrong lap of a course that's driven over and over.

const CAP_M = 50; // per-clip error where the tracks don't line up
const MIN_COVERAGE = 0.8; // share of fixes that must land on session data

function makeScorer(session) {
  const lat = session.channel("@latitude"), lon = session.channel("@longitude");
  if (!lat || !lon) throw new Error("The session has no GPS position channels.");
  const kx = 111320 * Math.cos((lat.values[0] * Math.PI) / 180);
  /** Mean distance (m) between fixes shifted by `offset` s and the session track. */
  return (fixes, offset) => {
    let total = 0, n = 0;
    for (const f of fixes) {
      const t = f.t + offset;
      const a = lat.at(t), b = lon.at(t);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      total += Math.hypot((a - f.lat) * 111320, (b - f.lon) * kx);
      n++;
    }
    if (n < MIN_COVERAGE * fixes.length || n === 0) return CAP_M;
    return Math.min(total / n, CAP_M);
  };
}

function search(score, sets, lo, hi, step) {
  const out = [];
  const n = Math.round((hi - lo) / step);
  for (let k = 0; k <= n; k++) {
    const off = lo + k * step;
    let s = 0;
    for (const f of sets) s += score(f, off);
    out.push({ error: s / sets.length, offset: off });
  }
  return out.sort((a, b) => a.error - b.error);
}

/** Every `step` seconds of fixes, for the coarse pass. */
function thin(fixes, every = 1) {
  const out = [];
  let next = -Infinity;
  for (const f of fixes) if (f.t >= next) { out.push(f); next = f.t + every; }
  return out;
}

const MOD = 900; // 15 min: covers every real-world time zone offset

function circDist(a, b) {
  const d = (((a - b) % MOD) + MOD) % MOD;
  return Math.min(d, MOD - d);
}

/** Offset implied by the GPS device's own clock, modulo 15 min, or null.
 *  Uses fixes that carry gpsClock (whole seconds) and frameTime (camera clock). */
function clockHint(sets) {
  let sx = 0, sy = 0, n = 0;
  for (const set of sets) for (const f of set) {
    if (!Number.isFinite(f.gpsClock) || !Number.isFinite(f.frameTime)) continue;
    // The clock string only has whole seconds: on average it reads 0.5 s early.
    const a = ((((f.gpsClock + 0.5 - f.frameTime) % MOD) + MOD) % MOD) / MOD * 2 * Math.PI;
    sx += Math.cos(a); sy += Math.sin(a); n++;
  }
  if (n < 10) return null;
  const r = Math.hypot(sx, sy) / n;
  if (r < 0.9) return null; // inconsistent clock readings: don't trust them
  return ((Math.atan2(sy, sx) / (2 * Math.PI)) * MOD + MOD) % MOD;
}

/**
 * @param session  Session with @latitude/@longitude
 * @param fixSets  one array of { t (camera clock), lat, lon } per clip
 * @returns { offset, error, clips: [{ offset, error }], ambiguous: { offset, error } | null }
 *   offset: seconds to ADD to camera time to get data time (negative = camera fast)
 *   error:  mean distance in metres between the tracks at that offset
 *   Throws if nothing lines up.
 */
export function matchClockOffset(session, fixSets, { maxOffset = 3600 } = {}) {
  const score = makeScorer(session);
  const sets = fixSets.filter((f) => f.length >= 20);
  if (!sets.length) throw new Error("Not enough camera GPS fixes (was the GPS remote connected and locked?).");
  const coarse = search(score, sets.map((f) => thin(f)), -maxOffset, maxOffset, 0.5);
  if (coarse[0].error >= CAP_M) {
    throw new Error("The camera's GPS track doesn't line up with this session anywhere within ±" + Math.round(maxOffset / 60) + " min. Same day and place?");
  }
  // A course driven over and over matches at several offsets (one per run),
  // and a coarse grid can land up to a step away from the true one, which at
  // speed costs metres. So refine the best few distinct candidates finely and
  // only then pick.
  const candidates = [];
  for (const c of coarse) {
    if (c.error >= CAP_M || candidates.length >= 5) break;
    if (candidates.every((k) => Math.abs(k.offset - c.offset) > 10)) candidates.push(c);
  }
  const refined = candidates
    .map((c) => search(score, sets, c.offset - 1, c.offset + 1, 0.05)[0])
    .sort((a, b) => a.error - b.error);

  // If the GPS source carries its own clock (DJI GPS remote), keep only the
  // candidates that agree with it. Its time zone can be wrong, so compare
  // modulo 15 minutes; candidates (other runs) are minutes apart.
  const hint = clockHint(sets);
  let pool = refined;
  if (hint != null) {
    const agree = refined.filter((c) => circDist(c.offset, hint) <= 3);
    if (agree.length) pool = agree;
  }
  const fine = pool[0];
  const runner = pool.find((c) => c !== fine);
  const clips = sets.map((f) => search(score, [f], fine.offset - 3, fine.offset + 3, 0.05)[0]);
  return {
    offset: fine.offset,
    error: fine.error,
    clips,
    usedGpsClock: hint != null && circDist(fine.offset, hint) <= 3,
    ambiguous: runner && runner.error < 1.5 * fine.error ? { offset: runner.offset, error: runner.error } : null,
  };
}
