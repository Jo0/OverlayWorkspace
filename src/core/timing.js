// Lap timing derived from a Session: current lap, elapsed time, last/best
// laps, and the delta to a comparison lap (matched by distance into the lap,
// the way lap timers do it).

import { Channel } from "./session.js";

export class Timing {
  constructor(session) {
    this.session = session;
    this.comparison = "best"; // "best" or a lap number
    this.distance = session.channel("@distance") || integrateSpeed(session);
    this._profiles = new Map();
  }

  setComparison(ref) {
    this.comparison = ref === "best" || ref == null ? "best" : Number(ref);
  }

  validLaps() {
    return this.session.laps.filter((l) => !l.excluded);
  }

  /** Fastest non-excluded lap, optionally only among laps finished by `by`. */
  bestLap(by = Infinity) {
    let best = null;
    for (const l of this.validLaps()) {
      if (l.end <= by && (!best || l.duration < best.duration)) best = l;
    }
    return best;
  }

  comparisonLap() {
    if (this.comparison === "best") return this.bestLap();
    return this.session.laps.find((l) => l.number === this.comparison) || this.bestLap();
  }

  /** Distance/time profile of a lap: arrays of (distance from start, time from start). */
  profile(lap) {
    if (!lap || !this.distance) return null;
    let p = this._profiles.get(lap);
    if (p) return p;
    const ch = this.distance;
    const d0 = ch.at(lap.start);
    const d1 = ch.at(lap.end);
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) return null;
    const ts = [0], ds = [0];
    for (let i = Math.max(0, ch.indexAt(lap.start) + 1); i < ch.times.length && ch.times[i] < lap.end; i++) {
      ts.push(ch.times[i] - lap.start);
      ds.push(Math.max(ds[ds.length - 1], ch.values[i] - d0));
    }
    ts.push(lap.duration);
    ds.push(Math.max(ds[ds.length - 1], d1 - d0));
    p = { t: Float64Array.from(ts), d: Float64Array.from(ds), total: ds[ds.length - 1], duration: lap.duration };
    this._profiles.set(lap, p);
    return p;
  }

  /** Distance covered since the start of `lap` at session time t. */
  lapDistance(lap, t) {
    if (!this.distance) return NaN;
    return this.distance.at(t) - this.distance.at(lap.start);
  }

  /**
   * Everything a widget may want to know about lap timing at time t.
   * state: "in" (on a lap), "after" (finished, showing its final time),
   *        "before" (waiting for the next lap to start), "none".
   */
  context(t) {
    const laps = this.session.laps;
    let lap = laps.find((l) => t >= l.start && t < l.end) || null;
    let state = lap ? "in" : "none";
    if (!lap) {
      let prev = null, next = null;
      for (const l of laps) {
        if (l.end <= t) prev = l;
        else if (l.start > t && !next) next = l;
      }
      if (prev && (!next || t - prev.end <= next.start - t)) {
        lap = prev;
        state = "after";
      } else if (next) {
        lap = next;
        state = "before";
      }
    }

    let elapsed = NaN;
    if (state === "in") elapsed = t - lap.start;
    else if (state === "after") elapsed = lap.duration;
    else if (state === "before") elapsed = 0;

    let last = null;
    for (const l of laps) if (l.end <= t) last = l;

    const cmp = this.comparisonLap();
    const prof = this.profile(cmp);
    let delta = NaN, distance = NaN, progress = NaN, remaining = NaN, predicted = NaN;
    if (lap && state === "in") {
      distance = this.lapDistance(lap, t);
      if (prof && Number.isFinite(distance)) {
        // Every lap's driven line is a little longer or shorter, so compare at
        // the same fraction of the lap rather than the same metre. We know the
        // whole lap (this runs after the session), so the delta ends exactly
        // at the final time difference instead of jumping at the finish.
        const own = this.profile(lap);
        const scaled = own && own.total > 0 ? distance * (prof.total / own.total) : distance;
        delta = elapsed - timeAtDistance(prof, scaled);
        predicted = cmp.duration + delta;
        const total = own ? own.total : prof.total;
        progress = total > 0 ? Math.min(1, Math.max(0, distance / total)) : NaN;
        remaining = Math.max(0, total - distance);
      }
    } else if (lap && state === "after") {
      distance = this.lapDistance(lap, lap.end);
      if (cmp) delta = lap.duration - cmp.duration;
      progress = 1;
      remaining = 0;
    } else if (state === "before") {
      distance = 0;
      progress = 0;
      const p = this.profile(lap) || prof;
      remaining = p ? p.total : NaN;
    }

    const fragmentLaps = lap ? laps.filter((l) => l.fragment === lap.fragment) : [];
    return {
      t,
      state,
      lap,
      lapNumber: lap ? lap.number : NaN,
      lapInFragment: lap ? fragmentLaps.indexOf(lap) + 1 : NaN,
      fragmentLapCount: fragmentLaps.length,
      lapCount: laps.length,
      elapsed,
      last,
      best: this.bestLap(t),
      comparison: cmp,
      delta,
      predicted,
      distance,
      progress,
      remaining,
    };
  }
}

/** Time into the profiled lap at which it reached distance d. */
export function timeAtDistance(p, d) {
  const ds = p.d, ts = p.t;
  if (d <= 0) return 0;
  if (d >= p.total) return p.duration;
  let lo = 0, hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = ds[hi] - ds[lo];
  const a = span > 0 ? (d - ds[lo]) / span : 0;
  return ts[lo] + a * (ts[hi] - ts[lo]);
}

/** Builds a cumulative distance channel from speed, for importers without one. */
function integrateSpeed(session) {
  const sp = session.channel("@speed");
  if (!sp || sp.times.length < 2) return null;
  const n = sp.times.length;
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dt = sp.times[i] - sp.times[i - 1];
    d[i] = d[i - 1] + (dt > 0 && dt <= sp.maxGap ? 0.5 * (sp.values[i] + sp.values[i - 1]) * dt : 0);
  }
  return new Channel(
    { id: "derived.distance", name: "distance (from speed)", unit: "m", dimension: "distance", role: "distance", source: "derived", maxGap: sp.maxGap },
    sp.times,
    d,
  );
}
