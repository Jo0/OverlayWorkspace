// What a widget sees when drawing one video frame: the time, channel values
// at that time, and lap timing. Timing values are exposed as virtual channels
// ("timing.delta" etc.) so any widget that shows a channel can show them too.

export const VIRTUAL_CHANNELS = {
  "timing.elapsed": { label: "Lap time (running)", dimension: "time" },
  "timing.delta": { label: "Delta to comparison lap", dimension: "time" },
  "timing.predicted": { label: "Predicted lap time", dimension: "time" },
  "timing.last": { label: "Last lap time", dimension: "time" },
  "timing.best": { label: "Best lap time so far", dimension: "time" },
  "timing.target": { label: "Comparison lap time (best, theoretical or chosen lap)", dimension: "time" },
  "timing.lap": { label: "Lap number", dimension: "none" },
  "timing.progress": { label: "Lap progress", dimension: "percent" },
  "timing.distance": { label: "Distance into lap", dimension: "distance" },
  "timing.remaining": { label: "Distance to finish", dimension: "distance" },
};

export function makeFrame(session, timing, t, cache) {
  const tc = timing ? timing.context(t) : null;
  return {
    t,
    session,
    timing: tc,
    cache,
    value(ref) {
      if (!ref) return NaN;
      if (ref.startsWith("timing.")) return timingValue(tc, ref);
      const ch = session && session.channel(ref);
      if (!ch) return NaN;
      return ch.role === "gear" ? ch.stepAt(t) : ch.at(t);
    },
    dimension(ref) {
      if (!ref) return "none";
      if (VIRTUAL_CHANNELS[ref]) return VIRTUAL_CHANNELS[ref].dimension;
      const ch = session && session.channel(ref);
      return ch ? ch.dimension || "none" : "none";
    },
  };
}

function timingValue(tc, ref) {
  if (!tc) return NaN;
  switch (ref) {
    case "timing.elapsed": return tc.elapsed;
    case "timing.delta": return tc.delta;
    case "timing.predicted": return tc.predicted;
    case "timing.last": return tc.last ? tc.last.duration : NaN;
    case "timing.best": return tc.best ? tc.best.duration : NaN;
    case "timing.target": return tc.comparison ? tc.comparison.duration : NaN;
    case "timing.lap": return tc.lapNumber;
    case "timing.progress": return tc.progress * 100;
    case "timing.distance": return tc.distance;
    case "timing.remaining": return tc.remaining;
    default: return NaN;
  }
}

/** Every channel reference a template could pick from, for the inspector. */
export function channelChoices(session) {
  const out = [];
  if (session) {
    const roles = [...session.byRole.keys()];
    for (const r of roles) out.push({ value: `@${r}`, label: `@${r} (${session.byRole.get(r).name})` });
    for (const c of session.channels) out.push({ value: c.id, label: c.source ? `${c.name} [${c.source}]` : c.name });
  }
  for (const [id, v] of Object.entries(VIRTUAL_CHANNELS)) out.push({ value: id, label: v.label });
  return out;
}
