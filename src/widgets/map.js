// Track / course map: the GPS path of the current lap (or fragment, or whole
// session) with a dot at the current position.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { drawPanel, drawText } from "../render/draw.js";
import { P } from "./common.js";

const MAX_POINTS = 3000;

widgets.register({
  id: "trackmap",
  label: "Track map",
  description: "GPS path with a position dot. Scope: the current lap/run, its fragment, or the whole session. The driven part can be colored by where you gained (green) or lost (red) time against a comparison.",
  defaults: {
    w: 900,
    h: 900,
    props: {
      scope: "lap", rotate: 0, line: "track", lineWidth: 12, driven: "neutral", showDriven: true, dot: "marker", dotSize: 22, mirror: false, panel: false,
      drivenStyle: "delta", deltaCompare: "auto", gainColor: "good", lossColor: "bad", neutralBand: 0.03, showLegend: true,
    },
  },
  props: [
    { key: "scope", label: "Path shown", type: "select", options: ["lap", "fragment", "session"] },
    { key: "rotate", label: "Rotate (deg)", type: "number", step: 1 },
    { key: "mirror", label: "Mirror", type: "bool" },
    P.color("line", "Line color"),
    { key: "lineWidth", label: "Line width", type: "number", min: 1, max: 100, step: 1 },
    { key: "showDriven", label: "Highlight driven part", type: "bool" },
    { key: "drivenStyle", label: "Driven part", type: "select", options: [
      { value: "delta", label: "Gain/loss colors (vs. comparison)" },
      { value: "solid", label: "One color" },
    ] },
    { key: "deltaCompare", label: "Gain/loss compared against", type: "select", options: [
      { value: "auto", label: "Auto: session best; theoretical on the best lap" },
      { value: "session", label: "Session best (theoretical on the best lap)" },
      { value: "so-far", label: "Best so far (theoretical on the first lap)" },
      { value: "theoretical", label: "Theoretical best" },
      { value: "template", label: "Template setting" },
    ] },
    P.color("gainColor", "Gaining color"),
    P.color("lossColor", "Losing color"),
    { key: "neutralBand", label: "Even band (s lost/gained per s)", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "showLegend", label: "Show what it compares against", type: "bool" },
    P.color("driven", "Driven color (one color, or even stretches)"),
    P.color("dot", "Dot color"),
    { key: "dotSize", label: "Dot radius", type: "number", min: 1, max: 200, step: 1 },
    P.panel,
  ],
  draw(ctx, { w, h, props, theme, frame, cache }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const s = frame.session;
    if (!s) return;
    const lat = s.channel("@latitude"), lon = s.channel("@longitude");
    if (!lat || !lon) return;
    const range = scopeRange(props.scope, frame);
    if (!range) return;

    const key = [props.scope, range[0], range[1], box.w, box.h, props.rotate, props.mirror, props.lineWidth, props.dotSize].join("|");
    let m = cache.get("map");
    if (!m || m.key !== key) {
      m = buildMap(lat, lon, range, box, props);
      m.key = key;
      cache.set("map", m);
    }
    if (!m.path) return;

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = props.lineWidth;
    ctx.strokeStyle = color(theme, props.line);
    ctx.stroke(m.path);

    const t = Math.min(range[1], Math.max(range[0], frame.t));
    let legend = null;
    if (props.showDriven && frame.t > range[0]) {
      const n = upTo(m.times, t);
      const here = m.project(lat.at(t), lon.at(t));
      const classes = props.drivenStyle === "delta" ? gainLoss(m, frame, props, cache) : null;
      if (classes) legend = classes.label;
      if (n > 1) {
        const colorOf = (c) => color(theme, c < 0 ? props.gainColor : c > 0 ? props.lossColor : props.driven);
        // Consecutive segments of the same class are stroked as one path.
        let i = 1;
        while (i < n) {
          const c = classes ? classes.cls[i] : 0;
          ctx.beginPath();
          ctx.moveTo(m.xs[i - 1], m.ys[i - 1]);
          while (i < n && (classes ? classes.cls[i] : 0) === c) { ctx.lineTo(m.xs[i], m.ys[i]); i++; }
          if (i === n && here) ctx.lineTo(here.x, here.y);
          ctx.strokeStyle = colorOf(c);
          ctx.stroke();
        }
      }
    }
    if (legend && props.showLegend) drawLegend(ctx, theme, box, props, legend);
    const p = m.project(lat.at(t), lon.at(t));
    if (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, props.dotSize, 0, Math.PI * 2);
      ctx.fillStyle = color(theme, props.dot);
      ctx.fill();
      ctx.lineWidth = props.dotSize * 0.25;
      ctx.strokeStyle = color(theme, "panel");
      ctx.stroke();
    }
  },
});

/**
 * Per path point: -1 gaining, +1 losing, 0 about even, against the chosen
 * comparison over roughly the last second (how fast the delta is changing).
 * Only points on the current lap are classed. Cached per lap and comparison.
 */
function gainLoss(m, frame, props, cache) {
  const tc = frame.timing, engine = frame.engine;
  const lap = tc && tc.lap;
  if (!engine || !lap || tc.state === "before") return null;
  const pick = engine.comparisonWithFallback(props.deltaCompare, lap);
  if (!pick) return null;
  const key = [m.key, lap.number, pick.label, pick.cmp.number, pick.cmp.duration, props.neutralBand].join("|");
  let g = cache.get("gainLoss");
  if (g && g.key === key) return g;

  const n = m.times.length;
  const d = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const t = m.times[i];
    if (t >= lap.start && t < lap.end) d[i] = engine.deltaAgainst(pick.cmp, lap, "in", t).delta;
  }
  const cls = new Int8Array(n);
  const half = 0.5; // seconds either side
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(d[i])) continue;
    const t = m.times[i];
    while (a < i && (m.times[a] < t - half || !Number.isFinite(d[a]))) a++;
    if (b < i) b = i;
    while (b + 1 < n && m.times[b + 1] <= t + half && Number.isFinite(d[b + 1])) b++;
    const dt = m.times[b] - m.times[a];
    if (dt <= 0) continue;
    const rate = (d[b] - d[a]) / dt; // seconds lost per second driven
    cls[i] = rate < -props.neutralBand ? -1 : rate > props.neutralBand ? 1 : 0;
  }
  g = { key, cls, label: pick.label };
  cache.set("gainLoss", g);
  return g;
}

function drawLegend(ctx, theme, box, props, label) {
  const size = Math.max(14, Math.min(box.h * 0.045, 48));
  const y = box.y + box.h - size * 0.4;
  let x = box.x;
  drawText(ctx, theme, `vs ${label}`, x, y, { role: "label", size, color: "text" });
  x += ctx.measureText(`vs ${label}`).width + size;
  for (const [text, col] of [["GAIN", props.gainColor], ["LOSS", props.lossColor]]) {
    ctx.fillStyle = color(theme, col);
    ctx.beginPath();
    ctx.roundRect(x, y - size * 0.55, size * 1.4, size * 0.4, size * 0.2);
    ctx.fill();
    x += size * 1.8;
    drawText(ctx, theme, text, x, y, { role: "label", size: size * 0.8, color: "muted" });
    x += ctx.measureText(text).width + size;
  }
}

function scopeRange(scope, frame) {
  const s = frame.session;
  const tc = frame.timing;
  if (scope === "lap" && tc && tc.lap) return [tc.lap.start, tc.lap.end];
  if (scope !== "session") {
    const f = s.fragmentAt(frame.t) || (tc && tc.lap && s.fragments.find((x) => x.id === tc.lap.fragment));
    if (f) return [f.start, f.end];
  }
  return [s.start, s.end];
}

function upTo(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildMap(lat, lon, [t0, t1], box, props) {
  const i0 = Math.max(0, lat.indexAt(t0)), i1 = lat.indexAt(t1);
  const count = i1 - i0 + 1;
  if (count < 2) return { path: null };
  const step = Math.max(1, Math.floor(count / MAX_POINTS));
  const pts = [];
  for (let i = i0; i <= i1; i += step) {
    const t = lat.times[i];
    const la = lat.values[i], lo = lon.at(t);
    if (Number.isFinite(la) && Number.isFinite(lo)) pts.push([t, la, lo]);
  }
  if (pts.length < 2) return { path: null };
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const rot = (props.rotate * Math.PI) / 180;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const raw = (la, lo) => {
    let x = (lo - pts[0][2]) * kx, y = -(la - pts[0][1]);
    if (props.mirror) x = -x;
    return [x * cr - y * sr, x * sr + y * cr];
  };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const rp = pts.map((p) => {
    const r = raw(p[1], p[2]);
    minX = Math.min(minX, r[0]); maxX = Math.max(maxX, r[0]);
    minY = Math.min(minY, r[1]); maxY = Math.max(maxY, r[1]);
    return r;
  });
  const pad = props.lineWidth / 2 + props.dotSize;
  const bw = Math.max(1, box.w - 2 * pad), bh = Math.max(1, box.h - 2 * pad);
  const sc = Math.min(bw / (maxX - minX || 1e-9), bh / (maxY - minY || 1e-9));
  const ox = box.x + pad + (bw - (maxX - minX) * sc) / 2, oy = box.y + pad + (bh - (maxY - minY) * sc) / 2;
  const toScreen = (r) => ({ x: ox + (r[0] - minX) * sc, y: oy + (r[1] - minY) * sc });
  const xs = new Float64Array(rp.length), ys = new Float64Array(rp.length), times = new Float64Array(rp.length);
  const path = new Path2D();
  rp.forEach((r, i) => {
    const q = toScreen(r);
    xs[i] = q.x; ys[i] = q.y; times[i] = pts[i][0];
    if (i) path.lineTo(q.x, q.y);
    else path.moveTo(q.x, q.y);
  });
  return {
    path, xs, ys, times,
    project: (la, lo) => (Number.isFinite(la) && Number.isFinite(lo) ? toScreen(raw(la, lo)) : null),
  };
}
