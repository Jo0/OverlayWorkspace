// Drawing helpers shared by widgets: themed panels, text (with tabular digits
// so numbers don't jitter), fitting text into a box.

import { shapes } from "../core/registry.js";
import { applyFont, color, fontRole } from "../core/theme.js";

/** Builds the path of a registered shape. Returns false for shape "none". */
export function shapePath(ctx, shapeId, x, y, w, h, opts) {
  const shape = shapes.get(shapeId) || shapes.get("rounded");
  ctx.beginPath();
  if (shape.empty) return false;
  shape.path(ctx, x, y, w, h, opts);
  return true;
}

/**
 * Draws the element's background panel from theme.panel (shape, fill, stroke,
 * shadow). `over` overrides panel settings for this call. Returns the inner
 * content box after padding: { x, y, w, h }.
 */
export function drawPanel(ctx, w, h, theme, over = {}) {
  const p = { ...theme.panel, ...over };
  const pad = p.padding ?? 0;
  const inner = { x: pad, y: pad, w: Math.max(0, w - 2 * pad), h: Math.max(0, h - 2 * pad) };
  if (p.enabled === false) return inner;
  if (!shapePath(ctx, p.shape, 0, 0, w, h, p)) return inner;
  ctx.save();
  if (p.fill && p.fill !== "none") {
    if (p.shadow && p.shadow.color) {
      ctx.shadowColor = color(theme, p.shadow.color);
      ctx.shadowBlur = p.shadow.blur || 0;
      ctx.shadowOffsetX = p.shadow.x || 0;
      ctx.shadowOffsetY = p.shadow.y || 0;
    }
    ctx.fillStyle = color(theme, p.fill);
    ctx.fill();
  }
  ctx.restore();
  if (p.stroke && p.stroke !== "none" && p.strokeWidth > 0) {
    ctx.save();
    ctx.lineWidth = p.strokeWidth;
    ctx.strokeStyle = color(theme, p.stroke);
    ctx.stroke();
    ctx.restore();
  }
  return inner;
}

const digitWidthCache = new Map();

function digitWidth(ctx) {
  const key = ctx.font;
  let w = digitWidthCache.get(key);
  if (w === undefined) {
    w = 0;
    for (let d = 0; d <= 9; d++) w = Math.max(w, ctx.measureText(String(d)).width);
    digitWidthCache.set(key, w);
  }
  return w;
}

/** Width of `str` in the current font, with every digit as wide as the widest. */
function tabularWidth(ctx, str) {
  const dw = digitWidth(ctx);
  let w = 0;
  for (const ch of str) w += ch >= "0" && ch <= "9" ? dw : ctx.measureText(ch).width;
  return w;
}

export function measureText(ctx, theme, role, size, str) {
  const f = applyFont(ctx, theme, role, size);
  return f.tabular ? tabularWidth(ctx, str) : ctx.measureText(str).width;
}

/**
 * Draws text. opts: { role, size, color, align ("left"|"center"|"right"),
 * baseline (canvas textBaseline, default "alphabetic") }.
 */
export function drawText(ctx, theme, str, x, y, opts = {}) {
  const role = opts.role || "display";
  const size = opts.size || 40;
  const f = applyFont(ctx, theme, role, size);
  ctx.textBaseline = opts.baseline || "alphabetic";
  const align = opts.align || "left";
  // Optional outline and shadow from theme.text, so text stays readable
  // without a panel behind it (bright sky, white walls).
  const fx = theme.text || {};
  const stroke = fx.stroke && fx.stroke.width > 0 ? fx.stroke : null;
  const shadow = fx.shadow && fx.shadow.color ? fx.shadow : null;
  const fillColor = color(theme, opts.color, "text");

  const paint = (s, px) => {
    if (shadow) {
      ctx.shadowColor = color(theme, shadow.color);
      ctx.shadowBlur = (shadow.blur || 0) * size;
      ctx.shadowOffsetX = (shadow.x || 0) * size;
      ctx.shadowOffsetY = (shadow.y || 0) * size;
    }
    if (stroke) {
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke.width * size;
      ctx.strokeStyle = color(theme, stroke.color);
      ctx.strokeText(s, px, y);
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(s, px, y);
    if (shadow) ctx.shadowColor = "transparent";
  };

  if (!f.tabular) {
    ctx.textAlign = align;
    paint(str, x);
    return;
  }
  const dw = digitWidth(ctx);
  const total = tabularWidth(ctx, str);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  ctx.textAlign = "center";
  for (const ch of str) {
    const isDigit = ch >= "0" && ch <= "9";
    const w = isDigit ? dw : ctx.measureText(ch).width;
    paint(ch, cx + w / 2);
    cx += w;
  }
}

/** Largest font size ≤ maxSize at which `str` fits in maxWidth. */
export function fitSize(ctx, theme, role, str, maxWidth, maxSize) {
  if (!str) return maxSize;
  const w = measureText(ctx, theme, role, maxSize, str);
  return w <= maxWidth ? maxSize : Math.max(1, Math.floor((maxSize * maxWidth) / w));
}

/** Font metrics used to vertically center numerals: cap height ≈ 0.72em. */
export const CAP = 0.72;

export function roleIsTabular(theme, role) {
  return !!fontRole(theme, role).tabular;
}
