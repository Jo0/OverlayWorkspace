// Right-hand inspector. With an element selected: its exact position/size and
// the widget's props (built from the widget's prop descriptors). With nothing
// selected: template settings and theme overrides.

import { channelChoices } from "../core/frame.js";
import { shapes, widgets } from "../core/registry.js";
import { ANCHORS } from "../core/template.js";
import { unitsFor, DIMENSIONS } from "../core/units.js";
import { clear, h } from "./dom.js";
import { commitSoon, emit, history, on, refreshTheme, selected, state, applyComparison } from "./state.js";

let root;

export function initInspector() {
  root = document.getElementById("inspector");
  on("selection", build);
  on("template", build);
  on("session", build);
  on("theme", () => { if (!selected()) return; build(); });
  // Keep position fields live while dragging, without rebuilding the form.
  on("element", (el) => {
    if (!el || el.id !== state.selectedId) return;
    for (const k of ["x", "y", "w", "h"]) {
      const input = root.querySelector(`[data-geom="${k}"]`);
      if (input && document.activeElement !== input) input.value = el[k];
    }
  });
}

function row(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("small", { class: "hint" }, hint) : null);
}

function changed(el) {
  emit("element", el);
  commitSoon();
}

function build() {
  if (!root) return;
  clear(root);
  const el = selected();
  if (el) buildElement(el);
  else buildTemplate();
}

// ── Element ──────────────────────────────────────────────────────────────────

function buildElement(el) {
  const def = widgets.get(el.type);
  root.append(
    h("div", { class: "insp-head" },
      h("h2", {}, def ? def.label : el.type),
      def && def.description ? h("p", { class: "muted small" }, def.description) : null),
  );

  const geom = h("div", { class: "grid-4" });
  for (const k of ["x", "y", "w", "h"]) {
    const input = h("input", { type: "number", step: 1, value: el[k], dataset: { geom: k } });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      el[k] = k === "w" || k === "h" ? Math.max(1, Math.round(v)) : Math.round(v);
      changed(el);
    });
    geom.append(h("label", { class: "field compact" }, h("span", { class: "field-label" }, k.toUpperCase()), input));
  }
  root.append(h("section", { class: "insp-section" },
    h("h3", {}, "Position (design px)"),
    geom,
    row("Name", textInput(el.name, (v) => { el.name = v; changed(el); emit("layers-changed"); })),
    row("Anchor", selectInput(ANCHORS.map((a) => ({ value: a, label: anchorLabel(a) })), el.anchor, (v) => { el.anchor = v; changed(el); }),
      "Which corner/edge it stays pinned to when exporting at a different aspect ratio."),
    h("div", { class: "grid-2" },
      row("Rotation °", numberInput(el.rotation, { step: 1 }, (v) => { el.rotation = v; changed(el); })),
      row("Opacity", numberInput(el.opacity, { step: 0.05, min: 0, max: 1 }, (v) => { el.opacity = Math.min(1, Math.max(0, v)); changed(el); }))),
  ));

  if (def && def.props) {
    const sec = h("section", { class: "insp-section" }, h("h3", {}, "Settings"));
    for (const p of def.props) sec.append(propField(el, p));
    root.append(sec);
  }

  const style = h("textarea", { rows: 6, spellcheck: false, class: "mono" }, el.style ? JSON.stringify(el.style, null, 2) : "");
  const err = h("small", { class: "hint error" });
  style.addEventListener("input", () => {
    const txt = style.value.trim();
    if (!txt) { el.style = null; err.textContent = ""; changed(el); return; }
    try {
      const v = JSON.parse(txt);
      el.style = v && typeof v === "object" ? v : null;
      err.textContent = "";
      changed(el);
    } catch (e) {
      err.textContent = e.message;
    }
  });
  root.append(h("section", { class: "insp-section" },
    h("h3", {}, "Style override (JSON)"),
    h("p", { class: "muted small" }, 'Merged over the theme for this element only, e.g. {"panel":{"shape":"chamfer","radius":40},"colors":{"accent":"#00B7FF"}}'),
    style, err));

  root.append(h("div", { class: "insp-actions" },
    h("button", { onclick: () => emit("duplicate-element", el) }, "Duplicate"),
    h("button", { onclick: () => { el.hidden = !el.hidden; changed(el); emit("layers-changed"); build(); } }, el.hidden ? "Show" : "Hide"),
    h("button", { onclick: () => { el.locked = !el.locked; changed(el); emit("layers-changed"); build(); } }, el.locked ? "Unlock" : "Lock"),
    h("button", { class: "danger", onclick: () => emit("delete-element", el) }, "Delete"),
  ));
}

function anchorLabel(a) {
  const v = { t: "top", m: "middle", b: "bottom" }[a[0]];
  const hz = { l: "left", c: "center", r: "right" }[a[1]];
  return a === "mc" ? "center" : `${v} ${hz}`;
}

function propField(el, p) {
  const val = el.props[p.key];
  const set = (v) => { el.props[p.key] = v; changed(el); };
  switch (p.type) {
    case "number":
      return row(p.label, numberInput(val, p, set));
    case "bool":
      return h("label", { class: "field check" }, checkbox(val, set), h("span", {}, p.label));
    case "select":
      return row(p.label, selectInput(p.options.map((o) => (typeof o === "object" ? o : { value: o, label: o })), val, set));
    case "color":
      return row(p.label, colorInput(val, set));
    case "channel":
      return row(p.label, datalistInput(val, channelChoices(state.session), (v) => { set(v); build(); }), "@role (works with any data source), a column name, or timing.*");
    case "unit": {
      const ch = el.props[p.of || "channel"];
      const dim = dimensionOf(ch);
      return row(p.label, selectInput(unitsFor(dim).map((u) => ({ value: u, label: u || "(none)" })), val, set, true));
    }
    case "font":
      return row(p.label, selectInput(Object.keys((state.theme && state.theme.fonts) || { display: 1 }).map((f) => ({ value: f, label: f })), val, set));
    case "shape":
      return row(p.label, selectInput(shapes.list().map((s) => ({ value: s.id, label: s.label })), val, set));
    case "image": {
      const file = h("input", { type: "file", accept: "image/*" });
      file.addEventListener("change", () => {
        const f = file.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { set(r.result); build(); };
        r.readAsDataURL(f);
      });
      return row(p.label, h("div", { class: "stack" }, file, val ? h("button", { onclick: () => { set(""); build(); } }, "Remove image") : null),
        "Embedded in the template file as a data URL.");
    }
    case "textarea":
      return row(p.label, textArea(val, set));
    default:
      return row(p.label, textInput(val, set));
  }
}

function dimensionOf(ref) {
  if (!ref) return "none";
  if (ref.startsWith("timing.")) {
    return { "timing.progress": "percent", "timing.distance": "distance", "timing.remaining": "distance", "timing.lap": "none" }[ref] || "time";
  }
  const ch = state.session && state.session.channel(ref);
  if (ch) return ch.dimension || "none";
  const role = ref.startsWith("@") ? ref.slice(1) : null;
  const guess = { speed: "speed", distance: "distance", altitude: "distance", lat_g: "accel", lon_g: "accel", combined_g: "accel", rpm: "rpm", throttle: "percent", brake: "percent", coolant_temp: "temperature", oil_temp: "temperature", steering: "angle", heading: "angle", lean: "angle" }[role];
  return guess && DIMENSIONS[guess] ? guess : "none";
}

// ── Template + theme ─────────────────────────────────────────────────────────

const SESSION_TYPES = ["autocross", "track", "rally", "karting", "drag", "hillclimb", "custom"];

function buildTemplate() {
  const t = state.template;
  if (!t) return;
  const commit = () => { emit("template", t); history.push(); };
  root.append(h("div", { class: "insp-head" }, h("h2", {}, "Template"), h("p", { class: "muted small" }, "Click an element on the stage to edit it. Arrow keys nudge 1 px (Shift: 10 px). Alt while dragging disables snapping.")));
  root.append(h("section", { class: "insp-section" },
    row("Name", textInput(t.name, (v) => { t.name = v; commitSoon(); })),
    row("Session type", selectInput(SESSION_TYPES.map((s) => ({ value: s, label: s })), t.sessionType, (v) => { t.sessionType = v; commitSoon(); }, true)),
    row("Description", textArea(t.description, (v) => { t.description = v; commitSoon(); })),
    h("div", { class: "grid-2" },
      row("Canvas width", numberInput(t.canvas.width, { step: 1, min: 16, lazy: true }, (v) => { t.canvas.width = Math.round(v); commit(); })),
      row("Canvas height", numberInput(t.canvas.height, { step: 1, min: 16, lazy: true }, (v) => { t.canvas.height = Math.round(v); commit(); }))),
    row("Theme", selectInput([...state.themes.values()].map((th) => ({ value: th.id, label: th.name })), t.theme, (v) => {
      t.theme = v;
      state.baseTheme = state.themes.get(v);
      refreshTheme();
      history.push();
      build();
    })),
    row("Delta compares against (when a delta uses \"Template setting\")", selectInput(comparisonChoices(), String(t.timing.comparison), (v) => {
      t.timing.comparison = v === "best" || v === "theoretical" ? v : Number(v);
      applyComparison();
      emit("element", null);
      emit("comparison-changed");
      history.push();
      build();
    })),
    t.timing.comparison === "theoretical"
      ? row("Theoretical: sections per lap", numberInput(t.timing.sections ?? 10, { step: 1, min: 1, max: 500, lazy: true }, (v) => {
          t.timing.sections = Math.max(1, Math.round(v));
          applyComparison();
          emit("element", null);
          emit("comparison-changed");
          history.push();
        }), "The lap is cut into this many equal parts; the fastest time through each part, from any lap, makes the target. More parts give a lower (more optimistic) target.")
      : null,
  ));

  const th = state.theme;
  const over = (t.themeOverrides = t.themeOverrides || {});
  const setOver = (path, v) => {
    let o = over;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]] = o[path[i]] || {};
    if (v === "" || v == null) delete o[path[path.length - 1]];
    else o[path[path.length - 1]] = v;
    refreshTheme();
    commitSoon();
  };

  const colors = h("section", { class: "insp-section" }, h("h3", {}, "Colors"), h("p", { class: "muted small" }, "Named colors every element can use. Changes apply to this template only."));
  for (const [name, value] of Object.entries(th.colors)) {
    colors.append(row(name, colorInput(value, (v) => setOver(["colors", name], v), false)));
  }
  const newName = h("input", { type: "text", placeholder: "new color name" });
  colors.append(h("div", { class: "row-inline" }, newName, h("button", { onclick: () => { const n = newName.value.trim(); if (n) { setOver(["colors", n], "#FFFFFF"); build(); } } }, "Add color")));
  root.append(colors);

  const fonts = h("section", { class: "insp-section" }, h("h3", {}, "Fonts"), h("p", { class: "muted small" }, "CSS font families per role. Use installed fonts, or add web fonts in the theme file (fontFaces)."));
  for (const [role, f] of Object.entries(th.fonts)) {
    fonts.append(h("div", { class: "font-row" },
      h("strong", {}, role),
      row("Family", textInput(f.family, (v) => setOver(["fonts", role, "family"], v))),
      h("div", { class: "grid-2" },
        row("Weight", numberInput(f.weight, { step: 100, min: 100, max: 900 }, (v) => setOver(["fonts", role, "weight"], v))),
        h("label", { class: "field check" }, checkbox(!!f.tabular, (v) => setOver(["fonts", role, "tabular"], v)), h("span", {}, "Fixed-width digits")))));
  }
  root.append(fonts);

  const p = th.panel;
  root.append(h("section", { class: "insp-section" }, h("h3", {}, "Panels"),
    row("Shape", selectInput(shapes.list().map((s) => ({ value: s.id, label: s.label })), p.shape, (v) => setOver(["panel", "shape"], v))),
    h("div", { class: "grid-2" },
      row("Radius / cut", numberInput(p.radius ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "radius"], v))),
      row("Skew", numberInput(p.skew ?? 0, { step: 1 }, (v) => setOver(["panel", "skew"], v))),
      row("Padding", numberInput(p.padding ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "padding"], v))),
      row("Border width", numberInput(p.strokeWidth ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "strokeWidth"], v)))),
    row("Fill", colorInput(p.fill, (v) => setOver(["panel", "fill"], v))),
    row("Border", colorInput(p.stroke, (v) => setOver(["panel", "stroke"], v))),
    h("button", { onclick: () => { t.themeOverrides = null; refreshTheme(); history.push(); build(); } }, "Reset theme changes"),
  ));
}

function comparisonChoices() {
  const out = [
    { value: "best", label: "Session best lap (excluding skipped laps)" },
    { value: "theoretical", label: "Theoretical best (fastest sections of all laps)" },
  ];
  if (state.session) for (const l of state.session.laps) out.push({ value: String(l.number), label: `Lap ${l.number}` });
  return out;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

function textInput(value, onChange) {
  const i = h("input", { type: "text", value: value ?? "" });
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function textArea(value, onChange) {
  const i = h("textarea", { rows: 3 }, value ?? "");
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function numberInput(value, p, onChange) {
  const i = h("input", { type: "number", value: value ?? 0, step: p.step ?? "any", min: p.min, max: p.max });
  i.addEventListener(p.lazy ? "change" : "input", () => {
    const v = Number(i.value);
    if (i.value !== "" && Number.isFinite(v)) onChange(v);
  });
  return i;
}

function checkbox(value, onChange) {
  const i = h("input", { type: "checkbox" });
  i.checked = !!value;
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}

function selectInput(options, value, onChange, allowMissing = false) {
  const s = h("select", {}, options.map((o) => h("option", { value: o.value }, o.label)));
  if (value != null && !options.some((o) => String(o.value) === String(value)) && allowMissing) s.append(h("option", { value }, String(value)));
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

let listCounter = 0;
function datalistInput(value, choices, onChange) {
  const id = `dl-${++listCounter}`;
  const i = h("input", { type: "text", value: value ?? "", list: id });
  const dl = h("datalist", { id }, choices.map((c) => h("option", { value: c.value }, c.label)));
  i.addEventListener("change", () => onChange(i.value.trim()));
  return h("div", {}, i, dl);
}

/** A color reference: theme color name or CSS color, with a swatch and picker. */
function colorInput(value, onChange, allowNames = true) {
  const id = `cl-${++listCounter}`;
  const text = h("input", { type: "text", value: value ?? "", list: allowNames ? id : null, class: "color-text" });
  const swatch = h("span", { class: "swatch" });
  const picker = h("input", { type: "color", class: "color-pick", title: "Pick a color" });
  const update = () => {
    const resolved = state.theme && state.theme.colors[text.value] ? state.theme.colors[text.value] : text.value;
    swatch.style.background = resolved || "transparent";
    const hex = toHex(resolved);
    if (hex) picker.value = hex;
  };
  text.addEventListener("input", () => { update(); onChange(text.value.trim()); });
  picker.addEventListener("input", () => { text.value = picker.value.toUpperCase(); update(); onChange(text.value); });
  update();
  const dl = allowNames ? h("datalist", { id }, Object.keys((state.theme && state.theme.colors) || {}).map((n) => h("option", { value: n }))) : null;
  return h("div", { class: "color-field" }, swatch, text, picker, dl);
}

function toHex(css) {
  if (!css) return null;
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000";
  c.fillStyle = css;
  const v = c.fillStyle;
  if (v.startsWith("#")) return v.length === 7 ? v : null;
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("") : null;
}
