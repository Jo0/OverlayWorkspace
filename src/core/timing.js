// Lap timing derived from a Session: current lap, elapsed time, last/best
// laps, and the delta to a comparison lap (matched by distance into the lap,
// the way lap timers do it).

import { Channel } from "./session.js";

export class Timing {
  constructor(session) {
    this.session = session;
    this.comparison = "best"; // "best", "theoretical" or a lap number
    this.sections = 10; // for "theoretical"
    this.distance = session.channel("@distance") || integrateSpeed(session);
    this._profiles = new Map();
    this._theo = undefined;
  }

  setComparison(ref, sections) {
    this.comparison = ref === "best" || ref == null ? "best" : ref === "theoretical" ? "theoretical" : Number(ref);
    const n = Math.round(Number(sections));
    if (Number.isFinite(n) && n >= 1 && n !== this.sections) {
      this.sections = Math.min(500, n);
      this._theo = undefined;
    }
  }

  /** Call after laps change (Skip toggled): drops cached profiles and the theoretical lap. */
  invalidate() {
    this._profiles.clear();
    this._theo = undefined;
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
    if (this.comparison === "theoretical") return this.theoreticalLap() || this.bestLap();
    return this.session.laps.find((l) => l.number === this.comparison) || this.bestLap();
  }

  /** Short name of what the delta compares against, for labels ("{cmp}"). */
  comparisonLabel() {
    const c = this.comparisonLap();
    if (!c) return "";
    if (c.theoretical) return "THEO";
    // "theoretical" with too few laps falls back to the session's best lap
    if (this.comparison === "best" || this.comparison === "theoretical") return "SESSION";
    return `LAP ${c.number}`;
  }

  /**
   * The lap to compare `lap` against, for a comparison mode:
   *   "session"     best lap of the whole session (hindsight: may come later)
   *   "so-far"      best lap finished before `lap` started (what a live lap
   *                 timer would have shown)
   *   "theoretical" the theoretical best (null with fewer than two laps)
   *   "template"    whatever the template's comparison setting says
   */
  comparisonFor(mode, lap) {
    switch (mode) {
      case "session": return this.bestLap();
      case "so-far": return lap ? this.bestLap(lap.start) : null;
      case "theoretical": return this.theoreticalLap();
      default: return this.comparisonLap();
    }
  }

  /**
   * Delta of `lap` (in `state` at time t) against `cmp`.
   * Returns { delta, self }: self is true when the lap would be compared with
   * itself (watching the best lap against "best"), where there's no meaningful
   * delta, so delta is NaN and widgets show "-.--".
   */
  deltaAgainst(cmp, lap, state, t) {
    if (!cmp || !lap) return { delta: NaN, self: false };
    if (cmp === lap) return { delta: NaN, self: true };
    if (state === "after") return { delta: lap.duration - cmp.duration, self: false };
    if (state !== "in") return { delta: NaN, self: false };
    const prof = this.profile(cmp);
    const distance = this.lapDistance(lap, t);
    if (!prof || !Number.isFinite(distance)) return { delta: NaN, self: false };
    // Every lap's driven line is a little longer or shorter, so compare at the
    // same fraction of the lap rather than the same metre. We know the whole
    // lap (this runs after the session), so the delta ends exactly at the
    // final time difference instead of jumping at the finish.
    const own = this.profile(lap);
    const scaled = own && own.total > 0 ? distance * (prof.total / own.total) : distance;
    return { delta: (t - lap.start) - timeAtDistance(prof, scaled), self: false };
  }

  /**
   * The theoretical best: each lap is cut into `sections` equal parts by
   * fraction of the lap, the fastest time through each part is taken from any
   * non-skipped lap, and those parts are joined into one target. Within a part
   * the target follows the pace of the lap that was fastest there. Returns a
   * lap-like object { number: "T", theoretical: true, duration, sections,
   * profile } or null with fewer than two usable laps. Assumes every lap is the
   * same course (true for one track or autocross layout).
   */
  theoreticalLap() {
    if (this._theo !== undefined) return this._theo;
    const laps = this.validLaps().map((l) => ({ lap: l, p: this.profile(l) })).filter((x) => x.p && x.p.total > 0);
    if (laps.length < 2) return (this._theo = null);
    const n = this.sections;
    const at = (x, f) => timeAtDistance(x.p, f * x.p.total);
    const parts = [];
    let cum = 0;
    for (let k = 0; k < n; k++) {
      const f0 = k / n, f1 = (k + 1) / n;
      let best = null, bestT = Infinity;
      for (const x of laps) {
        const dt = at(x, f1) - at(x, f0);
        if (dt < bestT) { bestT = dt; best = x; }
      }
      parts.push({ f0, f1, from: best, start: cum, time: bestT, lap: best.lap.number });
      cum += bestT;
    }
    // Dense time-vs-distance curve over a reference length; the delta code
    // rescales by fraction of the lap, so the reference length doesn't matter.
    const total = laps.reduce((a, x) => a + x.p.total, 0) / laps.length;
    const m = n * 50;
    const t = new Float64Array(m + 1), d = new Float64Array(m + 1);
    for (let i = 0; i <= m; i++) {
      const f = i / m;
      const part = parts[Math.min(n - 1, Math.floor(f * n))];
      t[i] = Math.max(i ? t[i - 1] : 0, part.start + at(part.from, f) - at(part.from, part.f0));
      d[i] = f * total;
    }
    this._theo = {
      number: "T",
      theoretical: true,
      excluded: false,
      start: NaN,
      end: NaN,
      duration: cum,
      sections: parts.map(({ f0, f1, time, lap }) => ({ f0, f1, time, lap })),
      profile: { t, d, total, duration: cum },
    };
    return this._theo;
  }

  /** Distance/time profile of a lap: arrays of (distance from start, time from start). */
  profile(lap) {
    if (lap && lap.theoretical) return lap.profile;
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
    const { delta, self: deltaSelf } = this.deltaAgainst(cmp, lap, state, t);
    let distance = NaN, progress = NaN, remaining = NaN, predicted = NaN;
    if (lap && state === "in") {
      distance = this.lapDistance(lap, t);
      const own = this.profile(lap);
      const total = own ? own.total : prof ? prof.total : NaN;
      if (Number.isFinite(distance) && total > 0) {
        progress = Math.min(1, Math.max(0, distance / total));
        remaining = Math.max(0, total - distance);
      }
      if (cmp) predicted = deltaSelf ? lap.duration : cmp.duration + delta;
    } else if (lap && state === "after") {
      distance = this.lapDistance(lap, lap.end);
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
      comparisonLabel: this.comparisonLabel(),
      delta,
      deltaSelf,
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
