// Draws one overlay frame: every visible element of a template, through its
// registered widget, at its exact position. Used both for the live preview and
// for export, so what you see is what you export.

import { widgets } from "../core/registry.js";
import { placeElement } from "../core/template.js";
import { resolveTheme } from "../core/theme.js";

export class Renderer {
  constructor() {
    // Widgets keep expensive per-element data here (projected track maps...).
    this.cache = new Map();
    this._themeCache = new WeakMap();
  }

  invalidate() {
    this.cache.clear();
    this._themeCache = new WeakMap();
  }

  themeFor(baseTheme, el) {
    let perBase = this._themeCache.get(baseTheme);
    if (!perBase) {
      perBase = new Map();
      this._themeCache.set(baseTheme, perBase);
    }
    const key = el.style ? JSON.stringify(el.style) : "";
    let t = perBase.get(key);
    if (!t) {
      t = resolveTheme(baseTheme, el.style);
      perBase.set(key, t);
    }
    return t;
  }

  /**
   * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
   * @param {object} o { template, theme, frame, width, height, clear=true }
   */
  render(ctx, { template, theme, frame, width, height, clear = true }) {
    if (clear) ctx.clearRect(0, 0, width, height);
    for (const el of template.elements) {
      if (el.hidden) continue;
      const w = widgets.get(el.type);
      if (!w) continue;
      const { x, y, s } = placeElement(el, template.canvas, width, height);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      if (el.rotation) {
        ctx.translate(el.w / 2, el.h / 2);
        ctx.rotate((el.rotation * Math.PI) / 180);
        ctx.translate(-el.w / 2, -el.h / 2);
      }
      ctx.globalAlpha = el.opacity ?? 1;
      try {
        w.draw(ctx, {
          w: el.w,
          h: el.h,
          props: el.props,
          theme: this.themeFor(theme, el),
          frame,
          element: el,
          cache: this.cacheFor(el),
        });
      } catch (e) {
        console.error(`Widget ${el.type} (${el.id}) failed:`, e);
      }
      ctx.restore();
    }
  }

  cacheFor(el) {
    let c = this.cache.get(el.id);
    if (!c) {
      c = new Map();
      this.cache.set(el.id, c);
    }
    return c;
  }
}
