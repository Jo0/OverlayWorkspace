// Right-hand inspector. With one element selected: its exact position/size and
// the widget's props (built from the widget's prop descriptors). With several:
// their bounds, align/distribute and grouping. With nothing selected:
// template settings and theme overrides.

import { ALIGN_EDGES, align, bounds, distribute, groupMembers, normalizeGroups, scaleInto, units } from "../core/arrange.js";
import { channelChoices } from "../core/frame.js";
import { shapes, widgets } from "../core/registry.js";
import { ANCHORS } from "../core/template.js";
import { unitsFor, DIMENSIONS } from "../core/units.js";
import { clear, h } from "./dom.js";
import { checkbox, colorInput, datalistInput, numberInput, row, selectInput, textArea, textInput } from "./inputs.js";
import { buildThemeEditor } from "./theme-editor.js";
import { commitSoon, emit, history, on, selected, selectedElements, setSelection, state, applyComparison } from "./state.js";

let root;

export function initInspector() {
  root = document.getElementById("inspector");
  on("selection", build);
  on("template", build);
  on("session", build);
  on("layers-changed", () => { if (state.selection.length > 1) build(); });
  on("theme", () => { if (!state.selection.length) return; build(); });
  // Keep position fields live while dragging, without rebuilding the form.
  on("element", (el) => {
    if (state.selection.length > 1) {
      const b = bounds(selectedElements());
      for (const k of ["x", "y", "w", "h"]) {
        const input = root.querySelector(`[data-sgeom="${k}"]`);
        if (input && b && document.activeElement !== input) input.value = Math.round(b[k]);
      }
      return;
    }
    if (!el || el.id !== state.selectedId) return;
    for (const k of ["x", "y", "w", "h"]) {
      const input = root.querySelector(`[data-geom="${k}"]`);
      if (input && document.activeElement !== input) input.value = el[k];
    }
  });
}


function changed(el) {
  emit("element", el);
  commitSoon();
}

function build() {
  if (!root) return;
  clear(root);
  const els = selectedElements();
  if (els.length > 1) buildSelection(els);
  else if (els.length === 1) buildElement(els[0]);
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

  if (el.group) root.append(groupNote(el));
  root.append(arrangeSection([el]));

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
    case "action": // a button that asks another panel to do something
      return h("div", { class: "field" }, h("button", { class: "small", onclick: () => emit(p.event) }, p.label), p.hint ? h("small", { class: "hint" }, p.hint) : null);
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

// ── Arrange (alignment, groups, several elements) ────────────────────────────

const ALIGN_ICONS = {
  left: '<path d="M2 1v14"/><rect x="4" y="3" width="9" height="3"/><rect x="4" y="9" width="6" height="3"/>',
  hcenter: '<path d="M8 1v14"/><rect x="3" y="3" width="10" height="3"/><rect x="5" y="9" width="6" height="3"/>',
  right: '<path d="M14 1v14"/><rect x="3" y="3" width="9" height="3"/><rect x="6" y="9" width="6" height="3"/>',
  top: '<path d="M1 2h14"/><rect x="3" y="4" width="3" height="9"/><rect x="9" y="4" width="3" height="6"/>',
  vcenter: '<path d="M1 8h14"/><rect x="3" y="3" width="3" height="10"/><rect x="9" y="5" width="3" height="6"/>',
  bottom: '<path d="M1 14h14"/><rect x="3" y="3" width="3" height="9"/><rect x="9" y="6" width="3" height="6"/>',
  x: '<path d="M1 2v12M15 2v12"/><rect x="3" y="5" width="3" height="6"/><rect x="10" y="5" width="3" height="6"/>',
  y: '<path d="M2 1h12M2 15h12"/><rect x="5" y="3" width="6" height="3"/><rect x="5" y="10" width="6" height="3"/>',
};
const ALIGN_LABELS = { left: "Align left edges", hcenter: "Align horizontal centers", right: "Align right edges", top: "Align top edges", vcenter: "Align vertical centers", bottom: "Align bottom edges", x: "Distribute horizontally (equal gaps)", y: "Distribute vertically (equal gaps)" };

function iconButton(kind, onClick, disabled = false) {
  const b = h("button", { class: "icon-btn", type: "button", title: ALIGN_LABELS[kind], disabled, onclick: onClick });
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ALIGN_ICONS[kind]}</svg>`;
  b.setAttribute("aria-label", ALIGN_LABELS[kind]);
  return b;
}

function canvasRect() {
  const c = state.template.canvas;
  return { x: 0, y: 0, w: c.width, h: c.height };
}

function arranged(els) {
  for (const el of els) emit("element", el);
  history.push();
  build();
}

/**
 * Align/distribute buttons. With one unit (an element, or one group) it
 * aligns to the canvas; with more, to the selection unless "Canvas" is picked.
 */
let alignTo = "selection";
function arrangeSection(els) {
  const us = units(els);
  const multi = us.length > 1;
  const sec = h("section", { class: "insp-section" }, h("h3", {}, multi ? "Align and distribute" : "Align to canvas"));
  let toSel = null;
  if (multi) {
    toSel = selectInput([{ value: "selection", label: "the selection" }, { value: "canvas", label: "the canvas" }], alignTo, (v) => { alignTo = v; });
    sec.append(h("label", { class: "field inline-field" }, h("span", { class: "field-label" }, "Relative to"), toSel));
  }
  const ref = () => (multi && alignTo === "selection" ? bounds(els) : canvasRect());
  const row1 = h("div", { class: "icon-row" });
  for (const edge of ALIGN_EDGES) row1.append(iconButton(edge, () => { if (align(us, edge, ref())) arranged(els); }));
  sec.append(row1);
  if (multi) {
    const few = us.length < 3;
    sec.append(h("div", { class: "icon-row" },
      iconButton("x", () => { if (distribute(us, "x")) arranged(els); }, few),
      iconButton("y", () => { if (distribute(us, "y")) arranged(els); }, few),
      h("span", { class: "muted small" }, few ? "Distribute needs 3 or more." : "Equal gaps; the outermost stay put.")));
  }
  if (us.some((u) => u.locked)) sec.append(h("p", { class: "muted small" }, "Locked elements stay where they are."));
  return sec;
}

/** Inspector for two or more selected elements. */
function buildSelection(els) {
  const t = state.template;
  const gids = [...new Set(els.map((e) => e.group).filter(Boolean))];
  const oneGroup = gids.length === 1 && els.every((e) => e.group === gids[0]) && groupMembers(t, gids[0]).length === els.length;
  root.append(h("div", { class: "insp-head" },
    h("h2", {}, oneGroup ? "Group" : `${els.length} elements`),
    h("p", { class: "muted small" }, oneGroup
      ? "Moves, resizes and aligns as one. Ctrl-click or double-click an element on the stage to edit it alone."
      : "Drag any of them to move them all; the handles resize them together. Shift-click adds or removes.")));

  if (oneGroup) {
    root.append(h("section", { class: "insp-section" },
      row("Group name", textInput(t.groups[gids[0]].name, (v) => { t.groups[gids[0]].name = v; commitSoon(); emit("layers-changed"); }))));
  }

  // The selection's bounds: X/Y move everything, W/H scale everything.
  const b = bounds(els);
  const geom = h("div", { class: "grid-4" });
  for (const k of ["x", "y", "w", "h"]) {
    const input = h("input", { type: "number", step: 1, value: Math.round(b[k]), dataset: { sgeom: k } });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const movable = els.filter((e) => !e.locked);
      const cur = bounds(movable);
      if (!cur) return;
      const to = { ...cur };
      to[k] = k === "w" || k === "h" ? Math.max(1, Math.round(v)) : Math.round(v);
      scaleInto(movable, movable.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })), cur, to);
      arranged(movable);
    });
    geom.append(h("label", { class: "field compact" }, h("span", { class: "field-label" }, k.toUpperCase()), input));
  }
  root.append(h("section", { class: "insp-section" }, h("h3", {}, "Bounds (design px)"), geom,
    h("p", { class: "muted small" }, "X/Y move them all; W/H scale them all from the top-left.")));

  root.append(arrangeSection(els));

  const anyHidden = els.some((e) => e.hidden), allLocked = els.every((e) => e.locked);
  root.append(h("div", { class: "insp-actions" },
    oneGroup ? h("button", { onclick: () => emit("ungroup", els), title: "Ctrl+Shift+G" }, "Ungroup")
      : h("button", { onclick: () => emit("group", els), title: "Ctrl+G" }, "Group"),
    !oneGroup && gids.length ? h("button", { onclick: () => emit("ungroup", els), title: "Ctrl+Shift+G" }, "Ungroup") : null,
    h("button", { onclick: () => emit("duplicate-element", els), title: "Ctrl+D" }, "Duplicate"),
    h("button", { onclick: () => { for (const e of els) e.hidden = !anyHidden; emit("element", null); history.push(); emit("layers-changed"); build(); } }, anyHidden ? "Show" : "Hide"),
    h("button", { onclick: () => { for (const e of els) e.locked = !allLocked; emit("element", null); history.push(); emit("layers-changed"); build(); } }, allLocked ? "Unlock" : "Lock"),
    h("button", { class: "danger", onclick: () => emit("delete-element", els) }, "Delete"),
  ));
}

/** For one element that's in a group: say so, with a way out. */
function groupNote(el) {
  const t = state.template;
  const g = t.groups[el.group];
  return h("section", { class: "insp-section group-note" },
    h("p", { class: "small" }, "In group ", h("strong", {}, (g && g.name) || "Group"), "."),
    h("div", { class: "row-inline" },
      h("button", { onclick: () => setSelection(groupMembers(t, el.group).map((m) => m.id)) }, "Select group"),
      h("button", { onclick: () => {
        delete el.group;
        normalizeGroups(t);
        emit("template", t);
        setSelection([el.id]);
        history.push();
      } }, "Remove from group")));
}

// ── Template + theme ─────────────────────────────────────────────────────────

const SESSION_TYPES = ["autocross", "track", "rally", "karting", "drag", "hillclimb", "custom"];

function buildTemplate() {
  const t = state.template;
  if (!t) return;
  const commit = () => { emit("template", t); history.push(); };
  root.append(h("div", { class: "insp-head" }, h("h2", {}, "Template"), h("p", { class: "muted small" }, "Click an element on the stage to edit it; Shift-click or drag a box to select several (Ctrl+A: all). Arrow keys nudge 1 px (Shift: 10 px). Alt while dragging disables snapping.")));
  root.append(h("section", { class: "insp-section" },
    row("Name", textInput(t.name, (v) => { t.name = v; commitSoon(); })),
    row("Session type", selectInput(SESSION_TYPES.map((s) => ({ value: s, label: s })), t.sessionType, (v) => { t.sessionType = v; commitSoon(); }, true)),
    row("Description", textArea(t.description, (v) => { t.description = v; commitSoon(); })),
    h("div", { class: "grid-2" },
      row("Canvas width", numberInput(t.canvas.width, { step: 1, min: 16, lazy: true }, (v) => { t.canvas.width = Math.round(v); commit(); })),
      row("Canvas height", numberInput(t.canvas.height, { step: 1, min: 16, lazy: true }, (v) => { t.canvas.height = Math.round(v); commit(); }))),
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

  buildThemeEditor(root, build);
}

function comparisonChoices() {
  const out = [
    { value: "best", label: "Session best lap (excluding skipped laps)" },
    { value: "theoretical", label: "Theoretical best (fastest sections of all laps)" },
  ];
  if (state.session) for (const l of state.session.laps) out.push({ value: String(l.number), label: `Lap ${l.number}` });
  return out;
}
