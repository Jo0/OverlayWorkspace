// Form controls shared by the inspector and the theme editor.

import { h } from "./dom.js";
import { state } from "./state.js";

export function row(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("small", { class: "hint" }, hint) : null);
}

export function textInput(value, onChange) {
  const i = h("input", { type: "text", value: value ?? "" });
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

export function textArea(value, onChange) {
  const i = h("textarea", { rows: 3 }, value ?? "");
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

export function numberInput(value, p, onChange) {
  const i = h("input", { type: "number", value: value ?? 0, step: p.step ?? "any", min: p.min, max: p.max });
  i.addEventListener(p.lazy ? "change" : "input", () => {
    const v = Number(i.value);
    if (i.value !== "" && Number.isFinite(v)) onChange(v);
  });
  return i;
}

export function checkbox(value, onChange) {
  const i = h("input", { type: "checkbox" });
  i.checked = !!value;
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}

export function selectInput(options, value, onChange, allowMissing = false) {
  const s = h("select", {}, options.map((o) => h("option", { value: o.value }, o.label)));
  if (value != null && !options.some((o) => String(o.value) === String(value)) && allowMissing) s.append(h("option", { value }, String(value)));
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

let listCounter = 0;
export function datalistInput(value, choices, onChange) {
  const id = `dl-${++listCounter}`;
  const i = h("input", { type: "text", value: value ?? "", list: id });
  const dl = h("datalist", { id }, choices.map((c) => h("option", { value: c.value }, c.label)));
  i.addEventListener("change", () => onChange(i.value.trim()));
  return h("div", {}, i, dl);
}

/** A color reference: theme color name or CSS color, with a swatch and picker. */
export function colorInput(value, onChange, allowNames = true) {
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

export function toHex(css) {
  if (!css) return null;
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000";
  c.fillStyle = css;
  const v = c.fillStyle;
  if (v.startsWith("#")) return v.length === 7 ? v : null;
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("") : null;
}
