// Lap timing widgets: running lap/run timer with last/best, and delta bar.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { formatDelta, formatLapTime } from "../core/units.js";
import { CAP, drawPanel, drawText, fitSize, measureText, shapePath } from "../render/draw.js";
import { P } from "./common.js";

widgets.register({
  id: "laptimer",
  label: "Lap / run timer",
  description: "Running time of the current lap or run. Holds the final time after the finish. Optional last and best rows.",
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

    if (props.title) {
      const title = props.title.replace("{lap}", tc && Number.isFinite(tc.lapNumber) ? tc.lapNumber : "-");
      drawText(ctx, theme, title, x, y + titleH * CAP + titleH * 0.1, { role: "label", size: titleH, color: "muted", align: props.align });
      y += titleH * 1.3;
    }

    const elapsed = tc ? tc.elapsed : NaN;
    const state = tc ? tc.state : "none";
    const text = formatLapTime(Number.isFinite(elapsed) ? elapsed : 0, props.decimals, props.format);
    const sample = formatLapTime(88.888, props.decimals, props.format === "auto" ? "m:ss" : props.format).replace(/\d/g, "0");
    const size = fitSize(ctx, theme, "number", sample, box.w, mainH / CAP);
    const col = state === "after" ? props.finishedColor : state === "in" ? props.color : props.waitingColor;
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

widgets.register({
  id: "delta",
  label: "Delta to comparison lap",
  description: "Time gained or lost against the comparison lap (session best by default), as a number and a bar.",
  defaults: {
    w: 1200,
    h: 260,
    props: { label: "Δ {cmp}", decimals: 2, range: 2, showBar: true, gainColor: "good", lossColor: "bad", panel: true, barShape: "rounded" },
  },
  props: [
    { key: "label", label: "Label ({cmp} = BEST / THEO / LAP n)", type: "text" },
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
    const d = frame.timing ? frame.timing.delta : NaN;
    const col = !Number.isFinite(d) ? "muted" : d <= 0 ? props.gainColor : props.lossColor;
    const barH = props.showBar ? box.h * 0.26 : 0;
    const textH = box.h - (barH ? barH * 1.35 : 0);
    const labelSize = props.label ? textH * 0.36 : 0; // sized from the template text
    const valText = formatDelta(d, props.decimals);
    const label = (props.label || "").replace("{cmp}", (frame.timing && frame.timing.comparisonLabel) || "BEST");
    const valSize = fitSize(ctx, theme, "number", "+00." + "0".repeat(props.decimals), box.w * 0.6, (textH / CAP) * 0.9);
    const baseline = box.y + (textH + valSize * CAP) / 2;
    if (props.label) {
      drawText(ctx, theme, label, box.x, baseline, { role: "label", size: labelSize, color: "muted" });
      drawText(ctx, theme, valText, box.x + box.w, baseline, { role: "number", size: valSize, color: col, align: "right" });
    } else {
      drawText(ctx, theme, valText, box.x + box.w / 2, baseline, { role: "number", size: valSize, color: col, align: "center" });
    }
    if (barH) {
      const by = box.y + box.h - barH;
      shapePath(ctx, props.barShape, box.x, by, box.w, barH, { radius: barH / 2 });
      ctx.fillStyle = color(theme, "grid");
      ctx.fill();
      if (Number.isFinite(d)) {
        const frac = Math.max(-1, Math.min(1, d / props.range));
        const mid = box.x + box.w / 2;
        const len = (box.w / 2) * Math.abs(frac);
        // Losing time fills to the right, gaining to the left.
        const x0 = frac >= 0 ? mid : mid - len;
        if (len > 0.5) {
          shapePath(ctx, props.barShape, x0, by, len, barH, { radius: Math.min(barH / 2, len / 2) });
          ctx.fillStyle = color(theme, col);
          ctx.fill();
        }
      }
      ctx.fillStyle = color(theme, "text");
      ctx.fillRect(box.x + box.w / 2 - 2, by - barH * 0.15, 4, barH * 1.3);
    }
  },
});
