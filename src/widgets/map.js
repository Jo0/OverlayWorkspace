// Track / course map: the GPS path of the current lap (or fragment, or whole
// session) with a dot at the current position.

import { widgets } from "../core/registry.js";
import { color } from "../core/theme.js";
import { drawPanel } from "../render/draw.js";
import { P } from "./common.js";

const MAX_POINTS = 3000;

widgets.register({
  id: "trackmap",
  label: "Track map",
  description: "GPS path with a position dot. Scope: the current lap/run, its fragment, or the whole session.",
  defaults: {
    w: 900,
    h: 900,
    props: { scope: "lap", rotate: 0, line: "track", lineWidth: 12, driven: "accent", showDriven: true, dot: "marker", dotSize: 22, mirror: false, panel: false },
  },
  props: [
    { key: "scope", label: "Path shown", type: "select", options: ["lap", "fragment", "session"] },
    { key: "rotate", label: "Rotate (deg)", type: "number", step: 1 },
    { key: "mirror", label: "Mirror", type: "bool" },
    P.color("line", "Line color"),
    { key: "lineWidth", label: "Line width", type: "number", min: 1, max: 100, step: 1 },
    { key: "showDriven", label: "Highlight driven part", type: "bool" },
    P.color("driven", "Driven color"),
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
    if (props.showDriven && frame.t > range[0]) {
      const n = upTo(m.times, t);
      if (n > 1) {
        ctx.beginPath();
        ctx.moveTo(m.xs[0], m.ys[0]);
        for (let i = 1; i < n; i++) ctx.lineTo(m.xs[i], m.ys[i]);
        const p = m.project(lat.at(t), lon.at(t));
        if (p) ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = color(theme, props.driven);
        ctx.stroke();
      }
    }
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
