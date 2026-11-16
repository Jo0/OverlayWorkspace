// Lap timing widgets: running lap/run timer with last/best, and delta bar.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { formatDelta, formatLapTime } from "../core/units.js";
import { CAP, drawPanel, drawText, fitSize, measureText, shapePath } from "../render/draw.js";
import { P } from "./common.js";

widgets.register({
  id: "laptimer",
  label: "Lap / run timer",
  description: "Running time of the current lap or run. Holds the final time after the finish. Optional last and best rows. Can turn green/red while you're ahead of/behind a comparison.",
  defaults: {
    w: 1100,
    h: 420,
    props: {
      title: "LAP {lap}",
      decimals: 3,
      format: "auto",
      showLast: true,
      showBest: true,
      lastLabel: "LAST",
      bestLabel: "BEST",
      color: "text",
      finishedColor: "accent",
      waitingColor: "muted",
      panel: true,
      align: "left",
      colorByDelta: false,
      deltaCompare: "auto",
      deltaFinished: true,
      showCompare: true,
      gainColor: "good",
      lossColor: "bad",
    },
  },
  props: [
    { key: "title", label: "Title ({lap} = lap number)", type: "text" },
    { key: "decimals", label: "Decimals", type: "number", min: 0, max: 3, step: 1 },
    { key: "format", label: "Time format", type: "select", options: ["auto", "m:ss", "s"] },
    { key: "showLast", label: "Show last lap", type: "bool" },
    { key: "showBest", label: "Show best lap", type: "bool" },
    { key: "lastLabel", label: "Last label", type: "text" },
    { key: "bestLabel", label: "Best label", type: "text" },
    P.align,
    P.color("color", "Running color"),
    P.color("finishedColor", "Finished color"),
    P.color("waitingColor", "Waiting color"),
    { key: "colorByDelta", label: "Color the time by the delta (green ahead, red behind)", type: "bool" },
    { key: "deltaCompare", label: "Delta compared against", type: "select", options: [
      { value: "auto", label: "Auto: session best; theoretical on the best lap" },
      { value: "session", label: "Session best (theoretical on the best lap)" },
      { value: "so-far", label: "Best so far (theoretical on the first lap)" },
      { value: "theoretical", label: "Theoretical best" },
      { value: "template", label: "Template setting" },
    ] },
    { key: "deltaFinished", label: "Also color the final time by the delta", type: "bool" },
    { key: "showCompare", label: "Show what it compares against in the title", type: "bool" },
    P.color("gainColor", "Ahead color"),
    P.color("lossColor", "Behind color"),
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const tc = frame.timing;
    const rows = (props.showLast ? 1 : 0) + (props.showBest ? 1 : 0);
    const titleH = props.title ? box.h * 0.17 : 0;
    const rowH = rows ? box.h * 0.15 : 0;
    const mainH = box.h - titleH - rows * rowH - (titleH ? titleH * 0.3 : 0) - (rows ? rowH * 0.3 : 0);
    const x = props.align === "right" ? box.x + box.w : props.align === "center" ? box.x + box.w / 2 : box.x;
    let y = box.y;

    const elapsed = tc ? tc.elapsed : NaN;
    const state = tc ? tc.state : "none";
    // Optional: color by the delta against a comparison that is never the lap
    // itself (the best lap falls back to the theoretical best), like the map.
    let deltaColor = null, compareLabel = "";
    if (props.colorByDelta && tc && tc.lap && frame.engine && (state === "in" || state === "after")) {
      const pick = frame.engine.comparisonWithFallback(props.deltaCompare, tc.lap);
      if (pick) {
        compareLabel = pick.label;
        const { delta } = frame.engine.deltaAgainst(pick.cmp, tc.lap, state, frame.t);
        // Within half a hundredth it's even: keep the normal color, no flicker.
        if (Number.isFinite(delta) && Math.abs(delta) >= 0.005 && (state === "in" || props.deltaFinished)) {
          deltaColor = delta < 0 ? props.gainColor : props.lossColor;
        }
      }
    }

    if (props.title) {
      let title = props.title.replace("{lap}", tc && Number.isFinite(tc.lapNumber) ? tc.lapNumber : "-");
      if (compareLabel && props.showCompare) title += `  ·  vs ${compareLabel}`;
      drawText(ctx, theme, title, x, y + titleH * CAP + titleH * 0.1, { role: "label", size: titleH, color: "muted", align: props.align });
      y += titleH * 1.3;
    }

    const text = formatLapTime(Number.isFinite(elapsed) ? elapsed : 0, props.decimals, props.format);
    const sample = formatLapTime(88.888, props.decimals, props.format === "auto" ? "m:ss" : props.format).replace(/\d/g, "0");
    const size = fitSize(ctx, theme, "number", sample, box.w, mainH / CAP);
    const col = deltaColor || (state === "after" ? props.finishedColor : state === "in" ? props.color : props.waitingColor);
    drawText(ctx, theme, text, x, y + (mainH + size * CAP) / 2, { role: "number", size, color: col, align: props.align });
    y += mainH + (rows ? rowH * 0.3 : 0);

    const row = (label, lap) => {
      const val = lap ? formatLapTime(lap.duration, props.decimals, props.format) : "--";
      const ls = rowH;
      if (props.align === "left") {
        drawText(ctx, theme, label, box.x, y + ls * CAP, { role: "label", size: ls, color: "muted" });
        const lw = measureText(ctx, theme, "label", ls, label + "  ");
        drawText(ctx, theme, val, box.x + lw, y + ls * CAP, { role: "number", size: ls, color: "text" });
      } else {
        drawText(ctx, theme, `${label}  ${val}`, x, y + ls * CAP, { role: "number", size: ls, color: "text", align: props.align });
      }
      y += rowH;
    };
    if (props.showLast) row(props.lastLabel, tc && tc.last);
    if (props.showBest) row(props.bestLabel, tc && tc.best);
  },
});

const COMPARE_OPTIONS = [
  { value: "template", label: "Template setting" },
  { value: "session", label: "Session best (hindsight)" },
  { value: "so-far", label: "Best so far (what a live timer showed)" },
  { value: "theoretical", label: "Theoretical best" },
];

/**
 * How a delta is shown. No comparison (NaN, or the lap compared with itself,
 * e.g. the best lap against "best") shows "-.--" in the muted color. A value
 * that rounds to zero stays muted, so it doesn't flicker red/green.
 */
export function deltaDisplay({ delta, self }, decimals, gainColor, lossColor) {
  if (self || !Number.isFinite(delta)) return { text: `-.${"-".repeat(Math.max(1, decimals))}`, color: "muted", value: NaN };
  const text = formatDelta(delta, decimals);
  if (Number(text) === 0) return { text, color: "muted", value: 0 };
  return { text, color: delta < 0 ? gainColor : lossColor, value: delta };
}

function deltaBar(ctx, theme, x, y, w, hgt, value, range, colorRef, barShape) {
  shapePath(ctx, barShape, x, y, w, hgt, { radius: hgt / 2 });
  ctx.fillStyle = color(theme, "grid");
  ctx.fill();
  if (Number.isFinite(value) && value !== 0) {
    const frac = Math.max(-1, Math.min(1, value / range));
    const mid = x + w / 2;
    const len = (w / 2) * Math.abs(frac);
    // Losing time fills to the right, gaining to the left.
    const x0 = frac >= 0 ? mid : mid - len;
    if (len > 0.5) {
      shapePath(ctx, barShape, x0, y, len, hgt, { radius: Math.min(hgt / 2, len / 2) });
      ctx.fillStyle = color(theme, colorRef);
      ctx.fill();
    }
  }
  ctx.fillStyle = color(theme, "text");
  ctx.fillRect(x + w / 2 - 2, y - hgt * 0.15, 4, hgt * 1.3);
}

widgets.register({
  id: "delta",
  label: "Delta to comparison lap",
  description: "Time gained or lost against a comparison (template setting, session best, best so far, or theoretical), as a number and a bar. Shows -.-- when there's nothing to compare against, e.g. the best lap against itself.",
  defaults: {
    w: 1200,
    h: 260,
    props: { compare: "template", label: "Δ {cmp}", decimals: 2, range: 2, showBar: true, gainColor: "good", lossColor: "bad", panel: true, barShape: "rounded" },
  },
  props: [
    { key: "compare", label: "Compare against", type: "select", options: COMPARE_OPTIONS },
    { key: "label", label: "Label ({cmp} = SESSION / BEST / THEO / LAP n)", type: "text" },
    P.decimals,
    { key: "range", label: "Bar range (± seconds)", type: "number", min: 0.1, max: 30, step: 0.1 },
    { key: "showBar", label: "Show bar", type: "bool" },
    { key: "barShape", label: "Bar shape", type: "shape" },
    P.color("gainColor", "Gaining color"),
    P.color("lossColor", "Losing color"),
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const r = frame.deltaFor(props.compare);
    const shown = deltaDisplay(r, props.decimals, props.gainColor, props.lossColor);
    const barH = props.showBar ? box.h * 0.26 : 0;
    const textH = box.h - (barH ? barH * 1.35 : 0);
    const labelSize = props.label ? textH * 0.36 : 0;
    const label = (props.label || "").replace("{cmp}", r.label || "SESSION");
    const valSize = fitSize(ctx, theme, "number", "+00." + "0".repeat(props.decimals), box.w * 0.6, (textH / CAP) * 0.9);
    const baseline = box.y + (textH + valSize * CAP) / 2;
    if (props.label) {
      drawText(ctx, theme, label, box.x, baseline, { role: "label", size: labelSize, color: "muted" });
      drawText(ctx, theme, shown.text, box.x + box.w, baseline, { role: "number", size: valSize, color: shown.color, align: "right" });
    } else {
      drawText(ctx, theme, shown.text, box.x + box.w / 2, baseline, { role: "number", size: valSize, color: shown.color, align: "center" });
    }
    if (barH) deltaBar(ctx, theme, box.x, box.y + box.h - barH, box.w, barH, shown.value, props.range, shown.color, props.barShape);
  },
});

widgets.register({
  id: "deltas",
  label: "Delta pane (session / best / theoretical)",
  description: "Several deltas stacked in one panel: against the session best (hindsight), the best lap before this one (what a live timer showed), and the theoretical best. Each row shows -.-- when it has nothing to compare against.",
  defaults: {
    w: 1200,
    h: 420,
    props: {
      showSession: true, sessionLabel: "Δ SESSION",
      showBest: true, bestLabel: "Δ BEST",
      showTheo: true, theoLabel: "Δ THEO",
      decimals: 2, range: 2, showBars: true, gainColor: "good", lossColor: "bad", panel: true, barShape: "rounded",
    },
  },
  props: [
    { key: "showSession", label: "Row: session best (hindsight)", type: "bool" },
    { key: "sessionLabel", label: "Session label", type: "text" },
    { key: "showBest", label: "Row: best so far (live-timer view)", type: "bool" },
    { key: "bestLabel", label: "Best-so-far label", type: "text" },
    { key: "showTheo", label: "Row: theoretical best", type: "bool" },
    { key: "theoLabel", label: "Theoretical label", type: "text" },
    P.decimals,
    { key: "range", label: "Bar range (± seconds)", type: "number", min: 0.1, max: 30, step: 0.1 },
    { key: "showBars", label: "Show bars", type: "bool" },
    { key: "barShape", label: "Bar shape", type: "shape" },
    P.color("gainColor", "Gaining color"),
    P.color("lossColor", "Losing color"),
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const rows = [
      props.showSession && ["session", props.sessionLabel],
      props.showBest && ["so-far", props.bestLabel],
      props.showTheo && ["theoretical", props.theoLabel],
    ].filter(Boolean);
    if (!rows.length) return;
    const rowH = box.h / rows.length;
    const barH = props.showBars ? rowH * 0.16 : 0;
    const textH = rowH - (barH ? barH * 1.6 : 0);
    const valSize = fitSize(ctx, theme, "number", "+00." + "0".repeat(props.decimals), box.w * 0.55, (textH / CAP) * 0.78);
    const labelSize = Math.min(valSize * 0.5, textH * 0.42);
    rows.forEach(([mode, label], i) => {
      const y = box.y + i * rowH;
      const shown = deltaDisplay(frame.deltaFor(mode), props.decimals, props.gainColor, props.lossColor);
      const baseline = y + (textH + valSize * CAP) / 2;
      drawText(ctx, theme, label || "", box.x, baseline, { role: "label", size: labelSize, color: "muted" });
      drawText(ctx, theme, shown.text, box.x + box.w, baseline, { role: "number", size: valSize, color: shown.color, align: "right" });
      if (barH) deltaBar(ctx, theme, box.x, y + textH + barH * 0.2, box.w, barH, shown.value, props.range, shown.color, props.barShape);
    });
  },
});
