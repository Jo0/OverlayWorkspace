// Gauges: linear bar (throttle, brake, progress), arc dial (speed, RPM),
// and the G-force circle.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { formatNumber } from "../core/units.js";
import { CAP, drawPanel, drawText, fitSize, shapePath } from "../render/draw.js";
import { P, displayValue, formatValue, sampleNumber } from "./common.js";

widgets.register({
  id: "bar",
  label: "Bar gauge",
  description: "A channel as a filling bar: throttle, brake, RPM, lap progress. Optionally segmented.",
  defaults: {
    w: 160,
    h: 600,
    props: { channel: "@throttle", unit: "%", min: 0, max: 100, orientation: "vertical", label: "THR", fill: "good", segments: 0, showValue: false, decimals: 0, panel: false, barShape: "rounded" },
  },
  props: [
    P.channel(),
    P.unit(),
    { key: "min", label: "Min", type: "number", step: 1 },
    { key: "max", label: "Max", type: "number", step: 1 },
    { key: "orientation", label: "Orientation", type: "select", options: ["vertical", "horizontal"] },
    P.label,
    P.color("fill", "Fill"),
    { key: "barShape", label: "Bar shape", type: "shape" },
    { key: "segments", label: "Segments (0 = solid)", type: "number", min: 0, max: 100, step: 1 },
    { key: "showValue", label: "Show value", type: "bool" },
    P.decimals,
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const vertical = props.orientation !== "horizontal";
    const v = displayValue(frame, props.channel, props.unit);
    const frac = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - props.min) / (props.max - props.min || 1))) : 0;
    const labelSize = props.label || props.showValue ? (vertical ? Math.min(box.w * 0.45, box.h * 0.1) : box.h * 0.45) : 0;

    let bar;
    if (vertical) bar = { x: box.x, y: box.y, w: box.w, h: box.h - (labelSize ? labelSize * 1.4 : 0) };
    else bar = { x: box.x + (props.label ? box.w * 0.22 : 0), y: box.y, w: box.w - (props.label ? box.w * 0.22 : 0) - (props.showValue ? box.w * 0.18 : 0), h: box.h };

    const r = Math.min(bar.w, bar.h) / 2;
    const segs = Math.max(0, Math.round(props.segments));
    if (segs > 0) {
      const gap = (vertical ? bar.h : bar.w) * 0.12 / segs;
      const len = ((vertical ? bar.h : bar.w) - gap * (segs - 1)) / segs;
      for (let i = 0; i < segs; i++) {
        const on = (i + 0.5) / segs <= frac;
        const p = i * (len + gap);
        const sx = vertical ? bar.x : bar.x + p, sy = vertical ? bar.y + bar.h - p - len : bar.y;
        shapePath(ctx, props.barShape, sx, sy, vertical ? bar.w : len, vertical ? len : bar.h, { radius: Math.min(r, len / 2) });
        ctx.fillStyle = color(theme, on ? props.fill : "grid");
        ctx.fill();
      }
    } else {
      shapePath(ctx, props.barShape, bar.x, bar.y, bar.w, bar.h, { radius: r });
      ctx.fillStyle = color(theme, "grid");
      ctx.fill();
      if (frac > 0) {
        ctx.save();
        shapePath(ctx, props.barShape, bar.x, bar.y, bar.w, bar.h, { radius: r });
        ctx.clip();
        ctx.fillStyle = color(theme, props.fill);
        if (vertical) ctx.fillRect(bar.x, bar.y + bar.h * (1 - frac), bar.w, bar.h * frac);
        else ctx.fillRect(bar.x, bar.y, bar.w * frac, bar.h);
        ctx.restore();
      }
    }

    if (vertical) {
      const showV = props.showValue && Number.isFinite(v);
      const text = showV ? formatNumber(v, props.decimals) : props.label;
      if (text) drawText(ctx, theme, text, box.x + box.w / 2, box.y + box.h, { role: showV ? "number" : "label", size: labelSize, color: "muted", align: "center" });
    } else {
      if (props.label) drawText(ctx, theme, props.label, box.x, box.y + (box.h + labelSize * CAP) / 2, { role: "label", size: labelSize, color: "muted" });
      if (props.showValue && Number.isFinite(v)) drawText(ctx, theme, formatNumber(v, props.decimals), box.x + box.w, box.y + (box.h + labelSize * CAP) / 2, { role: "number", size: labelSize, color: "text", align: "right" });
    }
  },
});

widgets.register({
  id: "dial",
  label: "Dial gauge",
  description: "A channel on an arc with ticks and a big center value: speed, RPM. Optional redline.",
  defaults: {
    w: 700,
    h: 700,
    props: {
      channel: "@speed", unit: "mph", min: 0, max: 120, majorStep: 20, minorPerMajor: 4, startAngle: 135, sweep: 270,
      decimals: 0, digits: 3, label: "MPH", fill: "accent", redline: 0, redlineColor: "bad", arcWidth: 34, tickLabels: true, panel: false,
    },
  },
  props: [
    P.channel(),
    P.unit(),
    { key: "min", label: "Min", type: "number", step: 1 },
    { key: "max", label: "Max", type: "number", step: 1 },
    { key: "majorStep", label: "Major tick step", type: "number", min: 0, step: 1 },
    { key: "minorPerMajor", label: "Minor ticks per major", type: "number", min: 0, max: 20, step: 1 },
    { key: "startAngle", label: "Start angle (deg, 0 = right)", type: "number", step: 1 },
    { key: "sweep", label: "Sweep (deg)", type: "number", min: 10, max: 360, step: 1 },
    { key: "arcWidth", label: "Arc width", type: "number", min: 1, step: 1 },
    { key: "redline", label: "Redline from (0 = off)", type: "number", step: 1 },
    P.color("fill", "Arc color"),
    P.color("redlineColor", "Redline color"),
    { key: "tickLabels", label: "Tick labels", type: "bool" },
    P.decimals,
    { key: "digits", label: "Size for digits", type: "number", min: 1, max: 6, step: 1 },
    P.label,
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const R = Math.min(box.w, box.h) / 2 - props.arcWidth / 2;
    const a0 = (props.startAngle * Math.PI) / 180;
    const sweep = (props.sweep * Math.PI) / 180;
    const span = props.max - props.min || 1;
    const ang = (val) => a0 + sweep * Math.max(0, Math.min(1, (val - props.min) / span));
    const v = displayValue(frame, props.channel, props.unit);

    ctx.lineCap = "butt";
    ctx.lineWidth = props.arcWidth;
    ctx.strokeStyle = color(theme, "grid");
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.stroke();
    if (props.redline > props.min && props.redline < props.max) {
      ctx.strokeStyle = color(theme, props.redlineColor);
      ctx.globalAlpha *= 0.45;
      ctx.beginPath();
      ctx.arc(cx, cy, R, ang(props.redline), a0 + sweep);
      ctx.stroke();
      ctx.globalAlpha /= 0.45;
    }
    if (Number.isFinite(v) && v > props.min) {
      const over = props.redline > props.min && v >= props.redline;
      ctx.strokeStyle = color(theme, over ? props.redlineColor : props.fill);
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, ang(v));
      ctx.stroke();
    }

    if (props.majorStep > 0) {
      const tickIn = R - props.arcWidth / 2 - R * 0.02;
      const labelR = tickIn - R * 0.24;
      const ls = R * 0.11;
      ctx.strokeStyle = color(theme, "text");
      const minor = Math.max(0, Math.round(props.minorPerMajor));
      const step = minor ? props.majorStep / minor : props.majorStep;
      for (let k = 0, val = props.min; val <= props.max + 1e-9; k++, val = props.min + k * step) {
        const major = !minor || k % minor === 0;
        const a = ang(val);
        const len = major ? R * 0.09 : R * 0.045;
        ctx.lineWidth = major ? R * 0.018 : R * 0.009;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * tickIn, cy + Math.sin(a) * tickIn);
        ctx.lineTo(cx + Math.cos(a) * (tickIn - len), cy + Math.sin(a) * (tickIn - len));
        ctx.stroke();
        if (major && props.tickLabels) {
          drawText(ctx, theme, formatNumber(val, 0), cx + Math.cos(a) * labelR, cy + Math.sin(a) * labelR + (ls * CAP) / 2, { role: "label", size: ls, color: "muted", align: "center" });
        }
      }
    }

    const vs = fitSize(ctx, theme, "number", sampleNumber(props.digits, props.decimals), R * 1.0, (R * 0.42) / CAP);
    drawText(ctx, theme, formatValue(frame, props.channel, props), cx, cy + (vs * CAP) / 2, { role: "number", size: vs, color: "text", align: "center" });
    if (props.label) drawText(ctx, theme, props.label, cx, cy + vs * CAP / 2 + R * 0.24, { role: "label", size: R * 0.13, color: "muted", align: "center" });
  },
});

widgets.register({
  id: "gcircle",
  label: "G-force circle",
  description: "Lateral vs. longitudinal G as a dot in rings, with a fading trail.",
  defaults: {
    w: 600,
    h: 600,
    props: { latChannel: "@lat_g", lonChannel: "@lon_g", max: 1.5, rings: 3, trail: 1.0, invertX: false, invertY: false, dot: "marker", showValue: true, panel: false },
  },
  props: [
    { key: "latChannel", label: "Lateral channel", type: "channel" },
    { key: "lonChannel", label: "Longitudinal channel", type: "channel" },
    { key: "max", label: "Outer ring (G)", type: "number", min: 0.1, max: 6, step: 0.1 },
    { key: "rings", label: "Rings", type: "number", min: 1, max: 10, step: 1 },
    { key: "trail", label: "Trail (seconds)", type: "number", min: 0, max: 10, step: 0.1 },
    { key: "invertX", label: "Flip left/right", type: "bool" },
    { key: "invertY", label: "Flip up/down", type: "bool" },
    P.color("dot", "Dot color"),
    { key: "showValue", label: "Show total G", type: "bool" },
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const R = Math.min(box.w, box.h) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = color(theme, "panel");
    ctx.fill();
    ctx.strokeStyle = color(theme, "grid");
    ctx.lineWidth = Math.max(1, R * 0.012);
    for (let i = 1; i <= props.rings; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * i) / props.rings, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();

    const sx = props.invertX ? -1 : 1, sy = props.invertY ? -1 : 1;
    const pos = (t) => {
      const lat = frame.session ? sample(frame, props.latChannel, t) : NaN;
      const lon = frame.session ? sample(frame, props.lonChannel, t) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const k = R / props.max;
      let x = lat * k * sx, y = lon * k * sy;
      const m = Math.hypot(x, y);
      if (m > R) { x *= R / m; y *= R / m; }
      return { x: cx + x, y: cy + y, g: Math.hypot(lat, lon) };
    };

    const dotR = R * 0.07;
    if (props.trail > 0) {
      const steps = 24;
      for (let i = steps; i >= 1; i--) {
        const p = pos(frame.t - (props.trail * i) / steps);
        if (!p) continue;
        ctx.globalAlpha = 0.5 * (1 - i / (steps + 1));
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = color(theme, props.dot);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const p = pos(frame.t);
    if (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color(theme, props.dot);
      ctx.fill();
      if (props.showValue) {
        const s = R * 0.16;
        drawText(ctx, theme, `${p.g.toFixed(2)} G`, cx + R, cy + R, { role: "number", size: s, color: "text", align: "right" });
      }
    }
  },
});

function sample(frame, ref, t) {
  const ch = frame.session.channel(ref);
  return ch ? ch.at(t) : NaN;
}
