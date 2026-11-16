// The normalized data model every importer produces, whatever the lap timer.
//
// Times are seconds since the Unix epoch (floats), so data from different
// devices and video clocks can be lined up on one timeline.

/** Well-known channel roles. Templates refer to channels by role ("@speed")
 *  so they work with any importer; importers tag their channels with these. */
export const ROLES = {
  speed: { label: "Speed", dimension: "speed" },
  latitude: { label: "Latitude", dimension: "angle" },
  longitude: { label: "Longitude", dimension: "angle" },
  altitude: { label: "Altitude", dimension: "distance" },
  heading: { label: "Heading", dimension: "angle" },
  distance: { label: "Distance", dimension: "distance" },
  lat_g: { label: "Lateral G", dimension: "accel" },
  lon_g: { label: "Longitudinal G", dimension: "accel" },
  combined_g: { label: "Combined G", dimension: "accel" },
  lean: { label: "Lean angle", dimension: "angle" },
  rpm: { label: "Engine RPM", dimension: "rpm" },
  throttle: { label: "Throttle", dimension: "percent" },
  brake: { label: "Brake", dimension: "percent" },
  steering: { label: "Steering angle", dimension: "angle" },
  gear: { label: "Gear", dimension: "none" },
  coolant_temp: { label: "Coolant temp", dimension: "temperature" },
  oil_temp: { label: "Oil temp", dimension: "temperature" },
};

export class Channel {
  /**
   * @param {object} info  { id, name, unit, source, role, dimension }
   * @param {Float64Array} times  ascending
   * @param {Float64Array} values
   */
  constructor(info, times, values) {
    Object.assign(this, info);
    this.times = times;
    this.values = values;
    // Samples further apart than this are treated as a gap (no data between).
    this.maxGap = info.maxGap ?? 2;
  }

  get start() {
    return this.times.length ? this.times[0] : NaN;
  }

  get end() {
    return this.times.length ? this.times[this.times.length - 1] : NaN;
  }

  /** Index of the last sample at or before t, or -1. */
  indexAt(t) {
    const ts = this.times;
    let lo = 0, hi = ts.length - 1;
    if (hi < 0 || t < ts[0]) return -1;
    if (t >= ts[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Linearly interpolated value at t; NaN outside the data or inside a gap. */
  at(t) {
    const i = this.indexAt(t);
    if (i < 0) return NaN;
    const ts = this.times, vs = this.values;
    if (i === ts.length - 1) return t - ts[i] <= 1e-6 ? vs[i] : NaN;
    const dt = ts[i + 1] - ts[i];
    if (dt > this.maxGap) return NaN;
    const a = dt > 0 ? (t - ts[i]) / dt : 0;
    return vs[i] + a * (vs[i + 1] - vs[i]);
  }

  /** Value of the sample at or before t, without interpolation (for gears etc). */
  stepAt(t) {
    const i = this.indexAt(t);
    return i < 0 ? NaN : this.values[i];
  }
}

export class Session {
  /**
   * @param {object} o
   * @param {object} o.meta       { title, track, created, source, ... }
   * @param {Channel[]} o.channels
   * @param {object[]} o.laps     [{ number, start, end, fragment }]
   * @param {object[]} o.fragments [{ id, start, end }]
   */
  constructor({ meta = {}, channels = [], laps = [], fragments = [] }) {
    this.meta = meta;
    this.channels = channels;
    this.byId = new Map(channels.map((c) => [c.id, c]));
    this.byRole = new Map();
    for (const c of channels) {
      if (c.role && !this.byRole.has(c.role)) this.byRole.set(c.role, c);
    }
    this.laps = laps
      .map((l) => ({ excluded: false, ...l, duration: l.end - l.start }))
      .sort((a, b) => a.start - b.start);
    this.fragments = fragments.slice().sort((a, b) => a.start - b.start);
    const starts = channels.map((c) => c.start).filter(Number.isFinite);
    const ends = channels.map((c) => c.end).filter(Number.isFinite);
    this.start = starts.length ? Math.min(...starts) : 0;
    this.end = ends.length ? Math.max(...ends) : 0;
  }

  /** Channel by id, or by role when written "@role". */
  channel(ref) {
    if (!ref) return undefined;
    if (ref[0] === "@") return this.byRole.get(ref.slice(1));
    return this.byId.get(ref);
  }

  fragmentAt(t) {
    return this.fragments.find((f) => t >= f.start && t <= f.end);
  }

  lapsInFragment(fragmentId) {
    return this.laps.filter((l) => l.fragment === fragmentId);
  }
}
