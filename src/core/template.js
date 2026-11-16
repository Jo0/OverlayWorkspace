// Templates: the overlay layout for a kind of session (autocross, track day,
// rally stage...). A template is JSON: a design canvas size, a theme
// reference, and a list of elements with exact pixel positions on that
// canvas. See docs/EXTENDING.md for the schema.

import { widgets } from "./registry.js";

export const TEMPLATE_SCHEMA = "overlay-template/1";

export const ANCHORS = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

let idCounter = 0;
export function newElementId(type) {
  idCounter += 1;
  return `${type}-${Date.now().toString(36)}-${idCounter}`;
}

/** Fills in defaults and checks a parsed template. Throws on bad input. */
export function normalizeTemplate(t) {
  if (!t || typeof t !== "object") throw new Error("Template must be a JSON object");
  if (t.schema && t.schema !== TEMPLATE_SCHEMA) throw new Error(`Unsupported template schema "${t.schema}"`);
  const canvas = t.canvas || {};
  const out = {
    schema: TEMPLATE_SCHEMA,
    id: t.id || "custom",
    name: t.name || "Untitled template",
    sessionType: t.sessionType || "custom",
    description: t.description || "",
    canvas: { width: Number(canvas.width) || 3840, height: Number(canvas.height) || 2160 },
    theme: t.theme || "default",
    themeOverrides: t.themeOverrides || null,
    timing: { comparison: "best", ...(t.timing || {}) },
    elements: [],
  };
  for (const raw of t.elements || []) {
    if (!raw || !raw.type) continue;
    const def = widgets.get(raw.type);
    const d = (def && def.defaults) || {};
    out.elements.push({
      id: raw.id || newElementId(raw.type),
      type: raw.type,
      name: raw.name || (def ? def.label : raw.type),
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      w: num(raw.w, d.w ?? 400),
      h: num(raw.h, d.h ?? 200),
      anchor: ANCHORS.includes(raw.anchor) ? raw.anchor : "tl",
      rotation: num(raw.rotation, 0),
      opacity: raw.opacity == null ? 1 : Math.min(1, Math.max(0, Number(raw.opacity))),
      hidden: !!raw.hidden,
      locked: !!raw.locked,
      props: { ...(d.props || {}), ...(raw.props || {}) },
      style: raw.style || null,
    });
  }
  if (!(t.colorRoles >= COLOR_ROLES)) migrateColorRoles(out.elements);
  out.colorRoles = COLOR_ROLES;
  return out;
}

// Version of the theme color roles that element props refer to.
//  2: "neutral" added. Before it, the map's even/one-color trail, the run
//     timer's finished time and trace line 3 defaulted to "accent", which in a
//     theme with a red accent (Broadcast) looked exactly like a loss.
const COLOR_ROLES = 2;
const NEUTRAL_MIGRATION = { trackmap: ["driven"], laptimer: ["finishedColor"], trace: ["color3"] };

/** Moves props still at the old "accent" default onto "neutral". Saved
 *  templates keep every prop explicit, so changing a default alone wouldn't
 *  reach them. */
function migrateColorRoles(elements) {
  for (const el of elements) {
    for (const key of NEUTRAL_MIGRATION[el.type] || []) {
      if (el.props[key] === "accent") el.props[key] = "neutral";
    }
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** A template as JSON text for saving. Keeps every prop explicit (easier to
 *  hand-edit) but drops element fields that are at their default. */
export function serializeTemplate(t) {
  return JSON.stringify(
    {
      ...t,
      elements: t.elements.map((e) => {
        const o = { ...e };
        if (!o.style) delete o.style;
        if (!o.hidden) delete o.hidden;
        if (!o.locked) delete o.locked;
        if (o.rotation === 0) delete o.rotation;
        if (o.opacity === 1) delete o.opacity;
        return o;
      }),
      themeOverrides: t.themeOverrides || undefined,
    },
    null,
    2,
  );
}

/**
 * Where an element lands on an output canvas of a different size/aspect.
 * Elements are scaled uniformly (so they keep their shape) and stay pinned to
 * their anchor: a "br" element keeps its distance from the bottom-right corner.
 * Returns { x, y, s }: output position of the element's top-left and the scale.
 */
export function placeElement(el, design, outW, outH) {
  const s = Math.min(outW / design.width, outH / design.height);
  const h = el.anchor[1], v = el.anchor[0];
  let x, y;
  if (h === "l") x = el.x * s;
  else if (h === "r") x = outW - (design.width - el.x) * s;
  else x = outW / 2 + (el.x - design.width / 2) * s;
  if (v === "t") y = el.y * s;
  else if (v === "b") y = outH - (design.height - el.y) * s;
  else y = outH / 2 + (el.y - design.height / 2) * s;
  return { x, y, s };
}
