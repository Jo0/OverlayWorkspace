// Unit conversion and number/time formatting.
//
// Channels carry their source unit; widgets ask for a display unit. Each
// dimension has a base unit (what importers should normalize to) and a table
// of display units as [factor, offset] from the base: display = base*factor + offset.

export const DIMENSIONS = {
  speed: { base: "m/s", units: { "m/s": [1, 0], "km/h": [3.6, 0], mph: [2.2369362921, 0], kn: [1.9438444924, 0] } },
  distance: { base: "m", units: { m: [1, 0], km: [0.001, 0], mi: [0.000621371192, 0], ft: [3.280839895, 0] } },
  accel: { base: "G", units: { G: [1, 0], "m/s²": [9.80665, 0] } },
  angle: { base: "deg", units: { deg: [1, 0], rad: [Math.PI / 180, 0] } },
  temperature: { base: "°C", units: { "°C": [1, 0], "°F": [1.8, 32] } },
  percent: { base: "%", units: { "%": [1, 0] } },
  rpm: { base: "rpm", units: { rpm: [1, 0], "x1000 rpm": [0.001, 0] } },
  time: { base: "s", units: { s: [1, 0] } },
  none: { base: "", units: { "": [1, 0] } },
};

// Source unit spellings importers commonly see, mapped to [dimension, factor
// to base]. Lowercase keys.
const SOURCE_UNITS = {
  "m/s": ["speed", 1], "km/h": ["speed", 1 / 3.6], kmh: ["speed", 1 / 3.6], kph: ["speed", 1 / 3.6],
  mph: ["speed", 1 / 2.2369362921], kn: ["speed", 1 / 1.9438444924], knots: ["speed", 1 / 1.9438444924],
  m: ["distance", 1], km: ["distance", 1000], mi: ["distance", 1609.344], ft: ["distance", 0.3048],
  g: ["accel", 1], "m/s2": ["accel", 1 / 9.80665], "m/s²": ["accel", 1 / 9.80665],
  deg: ["angle", 1], "°": ["angle", 1], rad: ["angle", 180 / Math.PI],
  c: ["temperature", 1], "°c": ["temperature", 1], degc: ["temperature", 1],
  "%": ["percent", 1], rpm: ["rpm", 1], s: ["time", 1],
};

/** Classifies a source unit string: { dimension, toBase } or null. Fahrenheit
 *  needs an offset, so it's handled by normalizeValues instead. */
export function classifyUnit(unit) {
  const u = (unit || "").trim().toLowerCase();
  if (u === "f" || u === "°f" || u === "degf") return { dimension: "temperature", toBase: null, fahrenheit: true };
  const hit = SOURCE_UNITS[u];
  return hit ? { dimension: hit[0], toBase: hit[1] } : null;
}

/** Converts values in place from a source unit to its dimension's base unit.
 *  Returns { dimension, unit } describing the result. */
export function normalizeValues(values, unit) {
  const c = classifyUnit(unit);
  if (!c) return { dimension: "none", unit: unit || "" };
  if (c.fahrenheit) {
    for (let i = 0; i < values.length; i++) values[i] = (values[i] - 32) / 1.8;
  } else if (c.toBase !== 1) {
    for (let i = 0; i < values.length; i++) values[i] *= c.toBase;
  }
  return { dimension: c.dimension, unit: DIMENSIONS[c.dimension].base };
}

/** Converts a base-unit value to a display unit of the same dimension. */
export function convert(value, dimension, displayUnit) {
  const dim = DIMENSIONS[dimension];
  const f = dim && dim.units[displayUnit];
  return f ? value * f[0] + f[1] : value;
}

export function unitsFor(dimension) {
  return Object.keys((DIMENSIONS[dimension] || DIMENSIONS.none).units);
}

export function formatNumber(v, decimals = 0) {
  if (!Number.isFinite(v)) return "--";
  const s = v.toFixed(decimals);
  return s === "-0" || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/**
 * Lap/run time. format: "auto" (m:ss.fff once over a minute), "m:ss", "s".
 */
export function formatLapTime(seconds, decimals = 3, format = "auto") {
  if (!Number.isFinite(seconds)) return "--";
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const p = 10 ** decimals;
  s = Math.round(s * p) / p;
  let out;
  if (format === "s" || (format === "auto" && s < 60)) {
    out = s.toFixed(decimals);
  } else {
    const m = Math.floor(s / 60);
    const rest = (s - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
    out = `${m}:${rest}`;
  }
  return neg ? `-${out}` : out;
}

export function formatDelta(seconds, decimals = 2) {
  if (!Number.isFinite(seconds)) return "--";
  const s = seconds.toFixed(decimals);
  if (/^-?0\.?0*$/.test(s)) return (0).toFixed(decimals);
  return seconds > 0 ? `+${s}` : s;
}

export function formatClock(unixSeconds, withMillis = true) {
  if (!Number.isFinite(unixSeconds)) return "--";
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return withMillis ? `${hh}:${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, "0")}` : `${hh}:${mm}:${ss}`;
}
