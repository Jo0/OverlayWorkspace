// Panel shapes. A shape builds a path for a w×h box at (x, y); panels, bars
// and decorative "shape" elements all use them. Register more in your own
// module with shapes.register({...}). See docs/EXTENDING.md.

import { shapes } from "../core/registry.js";

shapes.register({
  id: "none",
  label: "None",
  path() {},
  empty: true,
});

shapes.register({
  id: "rect",
  label: "Rectangle",
  path(ctx, x, y, w, h) {
    ctx.rect(x, y, w, h);
  },
});

shapes.register({
  id: "rounded",
  label: "Rounded rectangle",
  path(ctx, x, y, w, h, o = {}) {
    const r = Math.max(0, Math.min(o.radius ?? 24, w / 2, h / 2));
    ctx.roundRect(x, y, w, h, r);
  },
});

shapes.register({
  id: "pill",
  label: "Pill",
  path(ctx, x, y, w, h) {
    ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  },
});

shapes.register({
  id: "chamfer",
  label: "Chamfered (cut corners)",
  // o.radius = cut size; o.corners = which corners to cut, e.g. "tl br" (default) or "all"
  path(ctx, x, y, w, h, o = {}) {
    const c = Math.max(0, Math.min(o.radius ?? 24, w / 2, h / 2));
    const want = (o.corners || "tl br").split(/[\s,]+/);
    const all = want.includes("all");
    const has = (k) => all || want.includes(k);
    const tl = has("tl") ? c : 0, tr = has("tr") ? c : 0, br = has("br") ? c : 0, bl = has("bl") ? c : 0;
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.lineTo(x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.lineTo(x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.lineTo(x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.closePath();
  },
});

shapes.register({
  id: "skew",
  label: "Parallelogram (skewed)",
  // o.skew = horizontal lean in px (negative leans the other way); default h/4
  path(ctx, x, y, w, h, o = {}) {
    const s = o.skew ?? h / 4;
    const a = Math.max(0, s), b = Math.max(0, -s);
    ctx.moveTo(x + a, y);
    ctx.lineTo(x + w - b, y);
    ctx.lineTo(x + w - a, y + h);
    ctx.lineTo(x + b, y + h);
    ctx.closePath();
  },
});

shapes.register({
  id: "ellipse",
  label: "Ellipse / circle",
  path(ctx, x, y, w, h) {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  },
});
