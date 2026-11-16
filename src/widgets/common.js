// Shared bits for widget definitions: common prop descriptors and value formatting.

import { convert, formatDelta, formatLapTime, formatNumber } from "../core/units.js";

/** Prop descriptor types the inspector knows how to edit:
 *  number, text, textarea, bool, color, select, channel, unit, font, shape, image */
export const P = {
  panel: { key: "panel", label: "Background panel", type: "bool" },
  channel: (label = "Channel") => ({ key: "channel", label, type: "channel" }),
  unit: (of = "channel") => ({ key: "unit", label: "Display unit", type: "unit", of }),
  decimals: { key: "decimals", label: "Decimals", type: "number", min: 0, max: 4, step: 1 },
  label: { key: "label", label: "Label", type: "text" },
  color: (key = "color", label = "Color") => ({ key, label, type: "color" }),
  align: { key: "align", label: "Align", type: "select", options: ["left", "center", "right"] },
};

/** Formats a channel value for display according to its dimension. */
export function formatValue(frame, ref, { unit, decimals = 0, timeFormat = "auto" } = {}) {
  const v = frame.value(ref);
  const dim = frame.dimension(ref);
  if (ref === "timing.delta") return formatDelta(v, decimals);
  if (dim === "time") return formatLapTime(v, decimals, timeFormat);
  return formatNumber(convert(v, dim, unit), decimals);
}

/** Value of a channel in its display unit (NaN when unavailable). */
export function displayValue(frame, ref, unit) {
  return convert(frame.value(ref), frame.dimension(ref), unit);
}

/** A string as wide as the widest value of `digits` integer digits, for stable text sizing. */
export function sampleNumber(digits = 3, decimals = 0) {
  return "0".repeat(Math.max(1, digits)) + (decimals > 0 ? "." + "0".repeat(decimals) : "");
}
