// Basic widgets: number readout, text with tokens, decorative shape, image.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { rawTime, resultMark } from "../core/results.js";
import { formatLapTime } from "../core/units.js";
import { CAP, drawPanel, drawText, fitSize, shapePath } from "../render/draw.js";
import { P, formatValue, sampleNumber } from "./common.js";

widgets.register({
  id: "readout",
  label: "Number readout",
  description: "One channel as a big number with a label: speed, RPM, gear, temperatures, any timing value.",
  defaults: {
    w: 560,
    h: 300,
    props: { channel: "@speed", unit: "mph", decimals: 0, digits: 3, label: "MPH", align: "center", color: "text", labelColor: "muted", panel: true, labelPosition: "below" },
  },
  props: [
    P.channel(),
    P.unit(),
    P.decimals,
    { key: "digits", label: "Size for digits", type: "number", min: 1, max: 6, step: 1 },
    P.label,
    { key: "labelPosition", label: "Label position", type: "select", options: ["below", "above", "none"] },
    P.align,
    P.color("color", "Value color"),
    P.color("labelColor", "Label color"),
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const hasLabel = props.label && props.labelPosition !== "none";
    const labelSize = hasLabel ? box.h * 0.2 : 0;
    const gap = hasLabel ? labelSize * 0.35 : 0;
    const valueH = box.h - labelSize - gap;
    const valueTop = props.labelPosition === "above" ? box.y + labelSize + gap : box.y;
    const text = formatValue(frame, props.channel, props);
    const size = fitSize(ctx, theme, "number", sampleNumber(props.digits, props.decimals), box.w, valueH / CAP);
    const x = props.align === "left" ? box.x : props.align === "right" ? box.x + box.w : box.x + box.w / 2;
    drawText(ctx, theme, text, x, valueTop + (valueH + size * CAP) / 2, { role: "number", size, color: props.color, align: props.align });
    if (hasLabel) {
      const ly = props.labelPosition === "above" ? box.y + labelSize * CAP : box.y + box.h;
      drawText(ctx, theme, props.label, x, ly, { role: "label", size: labelSize, color: props.labelColor, align: props.align });
    }
  },
});

/** Replaces {tokens} in a text template. */
export function fillTokens(str, frame) {
  const tc = frame.timing;
  const s = frame.session;
  const map = {
    lap: () => (tc && Number.isFinite(tc.lapNumber) ? String(tc.lapNumber) : "-"),
    laps: () => (tc ? String(tc.fragmentLapCount || tc.lapCount || 0) : "-"),
    lapInFragment: () => (tc && Number.isFinite(tc.lapInFragment) ? String(tc.lapInFragment) : "-"),
    totalLaps: () => (tc ? String(tc.lapCount) : "-"),
    title: () => (s && s.meta.title) || "",
    track: () => (s && s.meta.track) || "",
    driver: () => (s && s.meta.driver) || "",
    vehicle: () => (s && s.meta.vehicle) || "",
    date: () => (s && s.meta.date) || new Date(frame.t * 1000).toLocaleDateString(),
    time: () => new Date(frame.t * 1000).toLocaleTimeString(),
    state: () => (tc ? tc.state : ""),
    // Raw time (official if entered) with the results mark: "1:08.849 +2".
    best: () => (tc && tc.best ? `${formatLapTime(rawTime(tc.best))} ${resultMark(tc.best)}`.trim() : "--"),
    last: () => (tc && tc.last ? `${formatLapTime(rawTime(tc.last))} ${resultMark(tc.last)}`.trim() : "--"),
  };
  // {lap} style, or {value:<channel>:<unit>:<decimals>}
  return str.replace(/\{([^{}]+)\}/g, (m, key) => {
    if (key.startsWith("value:")) {
      const [, ref, unit, dec] = key.split(":");
      return formatValue(frame, ref, { unit, decimals: Number(dec) || 0 });
    }
    return map[key] ? map[key]() : m;
  });
}

widgets.register({
  id: "text",
  label: "Text",
  description: "Static or templated text. Tokens: {lap} {laps} {totalLaps} {title} {track} {driver} {vehicle} {date} {time} {best} {last} {value:@speed:mph:0}.",
  defaults: { w: 900, h: 120, props: { text: "LAP {lap}/{laps}", role: "label", color: "text", align: "left", fit: true, panel: false } },
  props: [
    { key: "text", label: "Text (tokens allowed)", type: "text" },
    { key: "role", label: "Font", type: "font" },
    P.color(),
    P.align,
    { key: "fit", label: "Shrink to fit width", type: "bool" },
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const text = fillTokens(props.text || "", frame);
    let size = box.h / CAP * 0.92;
    if (props.fit) size = fitSize(ctx, theme, props.role, text, box.w, size);
    const x = props.align === "right" ? box.x + box.w : props.align === "center" ? box.x + box.w / 2 : box.x;
    drawText(ctx, theme, text, x, box.y + (box.h + size * CAP) / 2, { role: props.role, size, color: props.color, align: props.align });
  },
});

widgets.register({
  id: "shape",
  label: "Shape",
  description: "A decorative filled shape: backgrounds, stripes, separators.",
  defaults: { w: 600, h: 40, props: { shape: "skew", fill: "accent", stroke: "none", strokeWidth: 0, radius: 24, skew: 20 } },
  props: [
    { key: "shape", label: "Shape", type: "shape" },
    P.color("fill", "Fill"),
    P.color("stroke", "Stroke"),
    { key: "strokeWidth", label: "Stroke width", type: "number", min: 0, max: 100, step: 1 },
    { key: "radius", label: "Corner radius / cut", type: "number", min: 0, max: 1000, step: 1 },
    { key: "skew", label: "Skew (parallelogram)", type: "number", min: -1000, max: 1000, step: 1 },
  ],
  draw(ctx, { w, h, props, theme }) {
    if (!shapePath(ctx, props.shape, 0, 0, w, h, props)) return;
    if (props.fill && props.fill !== "none") {
      ctx.fillStyle = color(theme, props.fill);
      ctx.fill();
    }
    if (props.stroke && props.stroke !== "none" && props.strokeWidth > 0) {
      ctx.lineWidth = props.strokeWidth;
      ctx.strokeStyle = color(theme, props.stroke);
      ctx.stroke();
    }
  },
});

const images = new Map(); // src -> { img, ready: Promise }

function loadImage(src) {
  let entry = images.get(src);
  if (!entry) {
    const img = new Image();
    const ready = new Promise((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
    });
    img.src = src;
    entry = { img, ready };
    images.set(src, entry);
  }
  return entry;
}

widgets.register({
  id: "image",
  label: "Image / logo",
  description: "A picture (logo, sponsor, car number). Pick a file; it's embedded in the template.",
  defaults: { w: 600, h: 300, props: { src: "", fit: "contain" } },
  props: [
    { key: "src", label: "Image", type: "image" },
    { key: "fit", label: "Fit", type: "select", options: ["contain", "cover", "stretch"] },
  ],
  prepare(el) {
    return el.props.src ? loadImage(el.props.src).ready : Promise.resolve(true);
  },
  draw(ctx, { w, h, props }) {
    if (!props.src) return;
    const { img } = loadImage(props.src);
    if (!img.complete || !img.naturalWidth) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (props.fit === "stretch") return ctx.drawImage(img, 0, 0, w, h);
    const s = props.fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.restore();
  },
});
