// Theme editor, shown in the inspector when nothing is selected. Edits go into
// the template's themeOverrides (so they're saved with the template); "Save as
// theme…" turns the result into a theme file of its own and adds it to your
// themes, "Open theme…" loads one.

import { nearestWeight, primaryFamily, pruneFontFaces, withFontFace } from "../core/fonts.js";
import { shapes } from "../core/registry.js";
import { h, pickFile, saveTextFile } from "./dom.js";
import { catalogEntry, catalogReady, ensureCatalog, openFontPicker } from "./font-picker.js";
import { checkbox, colorInput, numberInput, row, selectInput, textInput } from "./inputs.js";
import { commitSoon, history, refreshTheme, setStatus, state } from "./state.js";
import { addUserTheme, bakeTheme, countOverrides, isBuiltin, removeUserTheme, slug, uniqueThemeId, validateTheme } from "./theme-library.js";

const ROLE_HELP = { display: "names, labels in panels", number: "speeds, times, deltas", label: "small captions" };

export function buildThemeEditor(root, rebuild) {
  const t = state.template;
  const th = state.theme;
  const base = state.baseTheme || {};
  // Created on the first change, so an untouched template keeps no empty object.
  const overrides = () => (t.themeOverrides = t.themeOverrides || {});
  const setOver = (path, v, { now = false } = {}) => {
    let o = overrides();
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]] = o[path[i]] || {};
    if (v === "" || v == null) delete o[path[path.length - 1]];
    else o[path[path.length - 1]] = v;
    refreshTheme();
    if (now) history.push(); else commitSoon();
  };
  const useTheme = (theme) => {
    t.theme = theme.id;
    t.themeOverrides = null;
    state.baseTheme = theme;
    refreshTheme();
    history.push();
    rebuild();
  };
  if (!catalogReady()) ensureCatalog().then(() => { if (catalogReady() && !state.selection.length) rebuild(); });

  // ── Theme: pick, save, open ──
  const builtins = [...state.themes.values()].filter((x) => isBuiltin(x.id));
  const mine = [...state.themes.values()].filter((x) => !isBuiltin(x.id));
  const pick = h("select", {},
    h("optgroup", { label: "Built in" }, builtins.map((x) => h("option", { value: x.id }, x.name))),
    mine.length ? h("optgroup", { label: "Your themes" }, mine.map((x) => h("option", { value: x.id }, x.name))) : null);
  pick.value = t.theme;
  pick.addEventListener("change", () => {
    t.theme = pick.value;
    state.baseTheme = state.themes.get(pick.value);
    refreshTheme();
    history.push();
    rebuild();
  });
  const n = countOverrides(t.themeOverrides);
  const custom = !isBuiltin(base.id) && state.themes.has(base.id);
  const nameInput = h("input", { type: "text", value: custom ? base.name : `${base.name || "Theme"} (mine)` });

  const saveAs = async () => {
    const name = nameInput.value.trim() || "My theme";
    const id = uniqueThemeId(name, custom && name === base.name ? base.id : null);
    const theme = bakeTheme(name, id);
    const r = await saveTextFile(JSON.stringify(theme, null, 2), `${slug(name)}.theme.json`);
    if (r.status === "cancelled") return;
    useTheme(addUserTheme(theme));
    const file = r.status === "saved" ? `Saved ${r.name}` : r.reason ? `Couldn't write the chosen file (${r.reason}), so it downloaded as ${r.name}` : `Downloaded ${r.name}`;
    setStatus(`${file}. "${name}" is now in your themes and this template uses it.`, r.reason ? "warn" : "ok");
  };
  const open = async () => {
    const f = await pickFile(".json,application/json");
    if (!f) return;
    try {
      const theme = validateTheme(JSON.parse(await f.text()));
      if (countOverrides(t.themeOverrides) && !confirm(`Use "${theme.name}" and drop this template's ${countOverrides(t.themeOverrides)} theme change(s)?`)) return;
      useTheme(addUserTheme(theme));
      setStatus(`Opened ${f.name}: "${theme.name}" is now in your themes and this template uses it.`, "ok");
    } catch (e) {
      setStatus(`Couldn't open ${f.name} as a theme: ${e.message}`, "error");
    }
  };
  const remove = () => {
    if (!confirm(`Remove "${base.name}" from your themes? This template switches to the Default theme (your theme file, if you saved one, stays).`)) return;
    removeUserTheme(base.id);
    useTheme(state.themes.get("default"));
  };

  root.append(h("section", { class: "insp-section" }, h("h3", {}, "Theme"),
    row("Theme", pick),
    h("p", { class: "muted small" }, n
      ? `This template changes ${n} setting${n === 1 ? "" : "s"} of "${base.name}". Below, edit them further, or save the result as a theme of its own.`
      : `Colors, fonts and panels below change "${base.name}" for this template only, until you save them as a theme.`),
    row("Name for the theme file", nameInput),
    h("div", { class: "row-inline wrap" },
      h("button", { class: "primary", onclick: saveAs, title: "Writes a .theme.json file and adds the theme to your themes" }, "Save as theme…"),
      h("button", { onclick: open, title: "Loads a .theme.json file" }, "Open theme…"),
      n ? h("button", { onclick: () => { t.themeOverrides = null; refreshTheme(); history.push(); rebuild(); } }, "Reset changes") : null,
      custom ? h("button", { class: "danger", onclick: remove }, "Remove from your themes") : null)));

  // ── Colors ──
  const colors = h("section", { class: "insp-section" }, h("h3", {}, "Colors"), h("p", { class: "muted small" }, "Named colors every element can use. good/bad mean gaining/losing time; keep neutral, marker and track clearly apart from them."));
  for (const [name, value] of Object.entries(th.colors)) {
    colors.append(row(name, colorInput(value, (v) => setOver(["colors", name], v), false)));
  }
  const newName = h("input", { type: "text", placeholder: "new color name" });
  colors.append(h("div", { class: "row-inline" }, newName, h("button", { onclick: () => { const nn = newName.value.trim(); if (nn) { setOver(["colors", nn], "#FFFFFF", { now: true }); rebuild(); } } }, "Add color")));
  root.append(colors);

  // ── Fonts ──
  const fonts = h("section", { class: "insp-section" }, h("h3", {}, "Fonts"));
  for (const [role, f] of Object.entries(th.fonts)) {
    const entry = catalogEntry(primaryFamily(f.family));
    const choose = h("button", { onclick: () => openFontPicker({ roleLabel: `"${role}"`, current: f, onPick: (p) => applyFont(role, p) }) }, "Choose…");
    const weight = entry
      ? selectInput(entry.w.map((w) => ({ value: w, label: String(w) })), String(nearestWeight(entry.w, f.weight || 400)), (v) => setOver(["fonts", role, "weight"], Number(v)))
      : numberInput(f.weight, { step: 100, min: 100, max: 900 }, (v) => setOver(["fonts", role, "weight"], v));
    fonts.append(h("div", { class: "font-row" },
      h("div", { class: "font-row-head" }, h("strong", {}, role), h("span", { class: "muted small" }, ROLE_HELP[role] || "")),
      h("div", { class: "font-family-row" }, row("Family", textInput(f.family, (v) => setOver(["fonts", role, "family"], v))), choose),
      h("div", { class: "grid-2" },
        row(entry ? "Weight" : "Weight (100–900)", weight),
        row("Letter spacing (em)", numberInput(f.letterSpacing ?? 0, { step: 0.01 }, (v) => setOver(["fonts", role, "letterSpacing"], v || null)))),
      h("label", { class: "field check" }, checkbox(!!f.tabular, (v) => setOver(["fonts", role, "tabular"], v)), h("span", {}, "Fixed-width digits")),
      entry ? h("p", { class: "muted small" }, `Google font · ${entry.w.length} weight${entry.w.length === 1 ? "" : "s"}`) : null));
  }
  root.append(fonts);

  /** Puts a picked font on one role (or all), adding its web-font stylesheet and dropping ones no longer used. */
  function applyFont(role, p) {
    const roles = p.allRoles ? Object.keys(th.fonts) : [role];
    const over = overrides();
    for (const r of roles) {
      const o = (over.fonts = over.fonts || {});
      o[r] = o[r] || {};
      o[r].family = p.stack;
      o[r].weight = r === role ? p.weight : nearestWeight(p.weights, (th.fonts[r] && th.fonts[r].weight) || 400);
    }
    const faces = p.css ? withFontFace(th.fontFaces, p.family, p.css) : th.fontFaces || [];
    const fontsAfter = Object.fromEntries(Object.entries(th.fonts).map(([r, f]) => [r, roles.includes(r) ? { ...f, family: p.stack } : f]));
    over.fontFaces = pruneFontFaces(faces, fontsAfter);
    refreshTheme();
    history.push();
    rebuild();
    setStatus(`${roles.length > 1 ? "All font roles use" : `"${role}" uses`} ${p.family} now.${p.css ? " Loading it from Google Fonts…" : ""}`, "ok");
  }

  // ── Panels ──
  const p = th.panel;
  const sh = p.shadow || {};
  const panels = h("section", { class: "insp-section" }, h("h3", {}, "Panels"),
    row("Shape", selectInput(shapes.list().map((s) => ({ value: s.id, label: s.label })), p.shape, (v) => { setOver(["panel", "shape"], v, { now: true }); rebuild(); })),
    h("div", { class: "grid-2" },
      row(p.shape === "chamfer" ? "Cut size" : "Corner radius", numberInput(p.radius ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "radius"], v))),
      p.shape === "skew" ? row("Skew", numberInput(p.skew ?? 0, { step: 1 }, (v) => setOver(["panel", "skew"], v))) : row("Padding", numberInput(p.padding ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "padding"], v)))),
    p.shape === "chamfer" ? row("Cut corners", selectInput(
      [["tl br", "top-left + bottom-right"], ["tr bl", "top-right + bottom-left"], ["all", "all four"], ["tl", "top-left"], ["tr", "top-right"], ["tl tr", "both top"], ["bl br", "both bottom"]].map(([value, label]) => ({ value, label })),
      p.corners || "tl br", (v) => setOver(["panel", "corners"], v), true)) : null,
    p.shape === "skew" ? row("Padding", numberInput(p.padding ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "padding"], v))) : null,
    row("Fill", colorInput(p.fill, (v) => setOver(["panel", "fill"], v))),
    h("div", { class: "grid-2" },
      row("Border", colorInput(p.stroke, (v) => setOver(["panel", "stroke"], v))),
      row("Border width", numberInput(p.strokeWidth ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "strokeWidth"], v)))),
    row("Shadow", colorInput(sh.color || "", (v) => setOver(["panel", "shadow", "color"], v))),
    h("div", { class: "grid-3" },
      row("Blur", numberInput(sh.blur ?? 0, { step: 1, min: 0 }, (v) => setOver(["panel", "shadow", "blur"], v))),
      row("X", numberInput(sh.x ?? 0, { step: 1 }, (v) => setOver(["panel", "shadow", "x"], v))),
      row("Y", numberInput(sh.y ?? 0, { step: 1 }, (v) => setOver(["panel", "shadow", "y"], v)))));
  root.append(panels);

  // ── Text effects ──
  const tx = th.text || {};
  const st = tx.stroke || {}, ts = tx.shadow || {};
  root.append(h("section", { class: "insp-section" }, h("h3", {}, "Text outline and shadow"),
    h("p", { class: "muted small" }, "Keep text readable without a panel behind it (bright sky, white walls). Sizes are in em: 0.08 is 8% of the text size. Width 0 turns the outline off."),
    h("div", { class: "grid-2" },
      row("Outline", colorInput(st.color || "rgba(0,0,0,0.6)", (v) => setOver(["text", "stroke", "color"], v))),
      row("Outline width (em)", numberInput(st.width ?? 0, { step: 0.01, min: 0 }, (v) => {
        // An outline with no color would fall back to the text color (white).
        if (v > 0 && !st.color) setOver(["text", "stroke", "color"], "rgba(0,0,0,0.6)");
        setOver(["text", "stroke", "width"], v);
      }))),
    row("Shadow", colorInput(ts.color || "", (v) => setOver(["text", "shadow", "color"], v))),
    h("div", { class: "grid-3" },
      row("Blur (em)", numberInput(ts.blur ?? 0, { step: 0.01, min: 0 }, (v) => setOver(["text", "shadow", "blur"], v))),
      row("X (em)", numberInput(ts.x ?? 0, { step: 0.01 }, (v) => setOver(["text", "shadow", "x"], v))),
      row("Y (em)", numberInput(ts.y ?? 0, { step: 0.01 }, (v) => setOver(["text", "shadow", "y"], v))))));
}
