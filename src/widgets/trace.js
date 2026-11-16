// Trace graph (also called an input trace or strip chart): channels drawn as
// lines scrolling right to left over the last few seconds, e.g. throttle and
// brake. Because the whole session is known, it can also show a little of
// what's coming ("look ahead").

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { convert } from "../core/units.js";
import { drawPanel, drawText } from "../render/draw.js";
import { P } from "./common.js";

const SLOTS = [1, 2, 3];

function seriesProps(n, channel, colorRef, label, min, max, unit) {
  return {
    [`ch${n}`]: channel, [`color${n}`]: colorRef, [`label${n}`]: label,
    [`min${n}`]: min, [`max${n}`]: max, [`unit${n}`]: unit,
  };
}

widgets.register({
  id: "trace",
  label: "Trace graph (throttle/brake…)",
  description: "Up to three channels as lines scrolling across the last few seconds, e.g. throttle and brake inputs. Each line has its own channel, color, range and label; leave a channel empty to turn that line off.",
  defaults: {
    w: 1100,
    h: 360,
    props: {
      seconds: 6,
      ahead: 0,
      lineWidth: 8,
      fill: true,
      grid: true,
      legend: true,
      nowDot: true,
      panel: true,
      ...seriesProps(1, "@throttle", "good", "THR", 0, 100, "%"),
      ...seriesProps(2, "@brake", "bad", "BRK", 0, 100, "%"),
      ...seriesProps(3, "", "accent", "", 0, 100, ""),
    },
  },
  props: [
    { key: "seconds", label: "History shown (s)", type: "number", min: 0.5, max: 120, step: 0.5 },
    { key: "ahead", label: "Look ahead (s)", type: "number", min: 0, max: 60, step: 0.5 },
    { key: "lineWidth", label: "Line width", type: "number", min: 1, max: 60, step: 1 },
    { key: "fill", label: "Shade under lines", type: "bool" },
    { key: "grid", label: "Grid lines", type: "bool" },
    { key: "legend", label: "Labels", type: "bool" },
    { key: "nowDot", label: "Dot at the current value", type: "bool" },
    P.panel,
    ...SLOTS.flatMap((n) => [
      { key: `ch${n}`, label: `Line ${n}: channel (empty = off)`, type: "channel" },
      { key: `unit${n}`, label: `Line ${n}: unit`, type: "unit", of: `ch${n}` },
      { key: `min${n}`, label: `Line ${n}: bottom of graph`, type: "number", step: 1 },
      { key: `max${n}`, label: `Line ${n}: top of graph`, type: "number", step: 1 },
      { key: `color${n}`, label: `Line ${n}: color`, type: "color" },
      { key: `label${n}`, label: `Line ${n}: label`, type: "text" },
    ]),
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const session = frame.session;
    const past = Math.max(0.1, Number(props.seconds) || 6);
    const ahead = Math.max(0, Number(props.ahead) || 0);
    const span = past + ahead;
    const nowX = box.x + box.w * (past / span);
    const lw = props.lineWidth;
    const hasLabels = props.legend && SLOTS.some((n) => props[`ch${n}`] && props[`label${n}`]);
    const legendSize = Math.min(box.h * 0.16, 60);
    // Labels get their own strip above the plot so lines never run through them.
    const plotTop = box.y + (hasLabels ? legendSize * 1.45 : 0);
    // Keep lines inside the plot: their thickness shouldn't poke out.
    const top = plotTop + lw / 2, bottom = box.y + box.h - lw / 2, plotH = Math.max(1, bottom - top);

    if (props.grid) {
      ctx.strokeStyle = color(theme, "grid");
      ctx.lineWidth = Math.max(1, lw * 0.25);
      ctx.beginPath();
      for (const f of [0, 0.5, 1]) {
        const y = bottom - f * plotH;
        ctx.moveTo(box.x, y);
        ctx.lineTo(box.x + box.w, y);
      }
      ctx.stroke();
      if (ahead > 0) {
        ctx.lineWidth = Math.max(1, lw * 0.35);
        ctx.beginPath();
        ctx.moveTo(nowX, plotTop);
        ctx.lineTo(nowX, box.y + box.h);
        ctx.stroke();
      }
    }

    const samples = Math.max(60, Math.min(600, Math.round(box.w / 3)));
    const legends = [];
    for (const n of SLOTS) {
      const ref = props[`ch${n}`];
      if (!ref) continue;
      const lo = Number(props[`min${n}`]), hi = Number(props[`max${n}`]);
      const range = hi - lo || 1;
      const unit = props[`unit${n}`];
      const col = color(theme, props[`color${n}`]);
      const ch = session && !ref.startsWith("timing.") ? session.channel(ref) : null;
      const dim = frame.dimension(ref);
      // Values over the window; virtual timing channels only have a "now".
      const value = (t) => convert(ch ? (ch.role === "gear" ? ch.stepAt(t) : ch.at(t)) : NaN, dim, unit);
      const yOf = (v) => bottom - Math.max(0, Math.min(1, (v - lo) / range)) * plotH;

      const pts = [];
      for (let i = 0; i <= samples; i++) {
        const t = frame.t - past + (span * i) / samples;
        const v = value(t);
        pts.push(Number.isFinite(v) ? [box.x + (box.w * i) / samples, yOf(v)] : null);
      }

      // Shaded area, then the line; a gap in the data breaks both.
      const runs = [];
      let run = [];
      for (const p of pts) {
        if (p) run.push(p);
        else if (run.length) { runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
      for (const r of runs) {
        if (props.fill && r.length > 1) {
          ctx.beginPath();
          ctx.moveTo(r[0][0], bottom);
          for (const [x, y] of r) ctx.lineTo(x, y);
          ctx.lineTo(r[r.length - 1][0], bottom);
          ctx.closePath();
          ctx.globalAlpha *= 0.2;
          ctx.fillStyle = col;
          ctx.fill();
          ctx.globalAlpha /= 0.2;
        }
        ctx.beginPath();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = lw;
        ctx.strokeStyle = col;
        r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }

      const now = value(frame.t);
      if (props.nowDot && Number.isFinite(now)) {
        ctx.beginPath();
        ctx.arc(nowX, yOf(now), lw * 1.1, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      }
      if (props.legend && props[`label${n}`]) legends.push([props[`label${n}`], props[`color${n}`], Number.isFinite(now)]);
    }

    if (props.legend && legends.length) {
      const size = legendSize;
      let x = box.x;
      for (const [text, colRef, hasData] of legends) {
        // A label whose channel has no data is muted, so a missing CAN feed is obvious.
        drawText(ctx, theme, text, x, box.y + size, { role: "label", size, color: hasData ? colRef : "muted" });
        x += ctx.measureText(text).width + size * 0.8; // drawText left the label font set
      }
    }
  },
});
