// Font picker: choose a font role's family from Google Fonts (searchable,
// previewed in each font) or from the fonts installed on this computer.
//
// Previews load under a private alias ("owp-…"), never under the real family
// name, so a preview's partial glyph set can't stand in for the full font
// when the overlay is drawn.

import { fontStack, googleCssUrl, googlePreviewUrl, nearestWeight, primaryFamily } from "../core/fonts.js";
import { $, clear, h } from "./dom.js";

const SAMPLE = "RUN 3   1:08.849   +0.42   87 MPH";

// Shown first when the search is empty: condensed and technical faces that
// read well over video. Names missing from the catalog are skipped.
const SUGGESTED = [
  "Oswald", "Bebas Neue", "Barlow Condensed", "Barlow Semi Condensed", "Barlow", "Rajdhani", "Teko",
  "Saira Condensed", "Saira", "Titillium Web", "Exo 2", "Chakra Petch", "Orbitron", "Russo One",
  "Roboto Condensed", "Archivo Narrow", "Anton", "Big Shoulders Display", "Kanit", "Michroma",
  "Sarpanch", "Squada One", "Audiowide", "Inter", "Montserrat", "Roboto Mono", "JetBrains Mono", "Share Tech Mono",
];

const CATEGORY_LABEL = { sans: "Sans serif", serif: "Serif", display: "Display", mono: "Monospace", handwriting: "Handwriting", other: "Other" };

let catalog = null; // [{ f, c, w, i }]
async function loadCatalog() {
  if (!catalog) {
    const r = await fetch("data/google-fonts.json");
    if (!r.ok) throw new Error(`font list: HTTP ${r.status}`);
    catalog = await r.json();
  }
  return catalog;
}

/** Looks a family up in the Google Fonts catalog (null if it isn't one, or the list isn't loaded yet). */
export function catalogEntry(family) {
  if (!catalog || !family) return null;
  const f = String(family).toLowerCase();
  return catalog.find((e) => e.f.toLowerCase() === f) || null;
}

export function catalogReady() {
  return !!catalog;
}

export async function ensureCatalog() {
  try { await loadCatalog(); } catch { /* picker shows the error */ }
}

const aliases = new Map(); // css url -> Promise<alias family>
let aliasCount = 0;

/** Loads a Google Fonts stylesheet under a private family name; resolves to that name. */
function loadAliased(url, family) {
  if (!aliases.has(url)) {
    aliases.set(url, (async () => {
      const css = await (await fetch(url)).text();
      const alias = `owp-${++aliasCount}`;
      const quoted = new RegExp(`font-family:\\s*['"]${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`, "g");
      const style = document.createElement("style");
      style.textContent = css.replace(quoted, `font-family: '${alias}'`);
      document.head.append(style);
      return alias;
    })().catch((e) => { aliases.delete(url); throw e; }));
  }
  return aliases.get(url);
}

let dialog = null;

/**
 * Opens the picker.
 * @param o { roleLabel, current: { family, weight }, onPick({ family, stack, weight, weights, css, allRoles }) }
 *          css is the stylesheet URL for a Google font, null for an installed one.
 */
export function openFontPicker(o) {
  dialog = dialog || $("#font-dialog");
  const body = clear($("#font-body"));
  $("#font-title").textContent = `Font for ${o.roleLabel}`;

  let source = "google"; // or "local"
  let choice = null; // { family, category, weights, css }
  let localFamilies = null;
  const search = h("input", { type: "search", placeholder: "Search fonts…", class: "font-search" });
  const cat = h("select", {}, h("option", { value: "" }, "All styles"), Object.entries(CATEGORY_LABEL).map(([v, l]) => h("option", { value: v }, l)));
  const list = h("ul", { class: "font-list", tabindex: "-1" });
  const status = h("p", { class: "muted small font-status" });
  const weightSel = h("select", {});
  const preview = h("div", { class: "font-preview" }, SAMPLE);
  const previewName = h("div", { class: "small muted" }, "Pick a font from the list.");
  const allRoles = h("input", { type: "checkbox" });
  const useBtn = h("button", { class: "primary", disabled: true }, "Use font");
  const tabG = h("button", { class: "seg on", type: "button" }, "Google Fonts");
  const tabL = h("button", { class: "seg", type: "button" }, "Installed on this computer");
  const typed = h("input", { type: "text", placeholder: "Font name as installed, e.g. Bahnschrift" });
  const localBox = h("div", { class: "font-local", hidden: true });

  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      const fam = en.target.dataset.family;
      loadAliased(googlePreviewUrl(fam), fam).then((alias) => { en.target.querySelector(".font-name").style.fontFamily = `'${alias}', sans-serif`; }).catch(() => {});
    }
  }, { root: list, rootMargin: "100px" });

  const setChoice = (c) => {
    choice = c;
    for (const li of list.children) li.classList.toggle("sel", c && li.dataset.family === c.family);
    useBtn.disabled = !c;
    if (!c) { previewName.textContent = "Pick a font from the list."; return; }
    const ws = c.weights || [100, 200, 300, 400, 500, 600, 700, 800, 900];
    const want = nearestWeight(ws, Number(o.current.weight) || 700);
    weightSel.replaceChildren(...ws.map((w) => h("option", { value: w }, String(w))));
    weightSel.value = String(want);
    previewName.textContent = c.css ? `${c.family} · Google Fonts · ${CATEGORY_LABEL[c.category] || ""}` : `${c.family} · installed font`;
    updatePreview();
  };

  const updatePreview = async () => {
    if (!choice) return;
    const w = Number(weightSel.value) || 400;
    preview.style.fontWeight = String(w);
    if (choice.css) {
      try {
        const alias = await loadAliased(googleCssUrl(choice.family, choice.weights), choice.family);
        preview.style.fontFamily = `'${alias}', sans-serif`;
      } catch {
        preview.style.fontFamily = "";
        status.textContent = "Couldn't reach Google Fonts for the preview. Are you offline?";
      }
    } else {
      preview.style.fontFamily = `'${choice.family}', sans-serif`;
    }
  };
  weightSel.addEventListener("change", updatePreview);

  const row = (c) => {
    const li = h("li", { dataset: { family: c.family }, onclick: () => setChoice(c) },
      h("span", { class: "font-name" }, c.family),
      h("span", { class: "muted small" }, c.css ? `${CATEGORY_LABEL[c.category] || ""} · ${c.weights.length} weight${c.weights.length > 1 ? "s" : ""}` : "installed"));
    if (choice && choice.family === c.family) li.classList.add("sel");
    return li;
  };

  const renderGoogle = () => {
    clear(list);
    if (!catalog) return;
    const q = search.value.trim().toLowerCase();
    let items = catalog;
    if (cat.value) items = items.filter((e) => e.c === cat.value);
    if (q) items = items.filter((e) => e.f.toLowerCase().includes(q));
    else {
      const sug = SUGGESTED.map((n) => items.find((e) => e.f === n)).filter(Boolean);
      items = [...sug, ...items.filter((e) => !SUGGESTED.includes(e.f))];
    }
    const shown = items.slice(0, 150);
    for (const e of shown) {
      const li = row({ family: e.f, category: e.c, weights: e.w, css: googleCssUrl(e.f, e.w) });
      list.append(li);
      observer.observe(li);
    }
    status.textContent = items.length > shown.length
      ? `${items.length} fonts; showing the first ${shown.length}${q ? "" : " (suggestions for overlays first)"}. Search to narrow it down.`
      : `${items.length} font${items.length === 1 ? "" : "s"}${q ? "" : " (suggestions for overlays first)"}.`;
  };

  const renderLocal = () => {
    clear(list);
    if (!localFamilies) { status.textContent = ""; return; }
    const q = search.value.trim().toLowerCase();
    const items = localFamilies.filter((f) => !q || f.toLowerCase().includes(q));
    for (const f of items.slice(0, 300)) list.append(row({ family: f, category: "sans", weights: null, css: null }));
    status.textContent = `${items.length} installed font famil${items.length === 1 ? "y" : "ies"}.`;
  };

  const render = () => (source === "google" ? renderGoogle() : renderLocal());
  search.addEventListener("input", render);
  cat.addEventListener("change", render);

  const canList = typeof window.queryLocalFonts === "function";
  const listBtn = h("button", { type: "button" }, "List the fonts on this computer");
  listBtn.addEventListener("click", async () => {
    try {
      const fonts = await window.queryLocalFonts();
      localFamilies = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      listBtn.hidden = true;
      renderLocal();
    } catch (e) {
      status.textContent = `The browser didn't allow listing fonts (${e.name}). Type the name instead.`;
    }
  });
  typed.addEventListener("input", () => {
    const f = typed.value.trim();
    setChoice(f ? { family: f, category: "sans", weights: null, css: null } : null);
  });
  localBox.append(
    h("p", { class: "small" }, "An installed font only works on computers that have it. Your own exports are fine; a template or theme you share will fall back to another font elsewhere."),
    canList ? listBtn : h("p", { class: "muted small" }, "This browser can't list installed fonts (Chrome and Edge can). Type the name exactly as it's installed:"),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Font name"), typed));

  const setSource = (s) => {
    source = s;
    tabG.classList.toggle("on", s === "google");
    tabL.classList.toggle("on", s === "local");
    cat.hidden = s !== "google";
    localBox.hidden = s !== "local";
    setChoice(null);
    render();
  };
  tabG.addEventListener("click", () => setSource("google"));
  tabL.addEventListener("click", () => setSource("local"));

  useBtn.addEventListener("click", () => {
    if (!choice) return;
    o.onPick({
      family: choice.family,
      stack: fontStack(choice.family, choice.category),
      weight: Number(weightSel.value) || 400,
      weights: choice.weights,
      css: choice.css,
      allRoles: allRoles.checked,
    });
    dialog.close();
  });

  body.append(
    h("div", { class: "seg-row" }, tabG, tabL),
    localBox,
    h("div", { class: "font-filter" }, search, cat),
    list, status,
    h("div", { class: "font-preview-box" }, previewName, preview,
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Weight"), weightSel),
        h("label", { class: "field check" }, allRoles, h("span", {}, "Use for all font roles")))),
    h("p", { class: "muted small" }, "Google Fonts are free to use in your videos (open licences). They're loaded from fonts.googleapis.com whenever a theme uses them, so the editor needs internet access for them."),
    h("div", { class: "dialog-actions" }, h("button", { onclick: () => dialog.close() }, "Cancel"), useBtn),
  );

  status.textContent = "Loading the font list…";
  loadCatalog().then(() => {
    // Start on the current font when it's a Google font.
    const cur = catalogEntry(primaryFamily(o.current.family));
    if (cur) setChoice({ family: cur.f, category: cur.c, weights: cur.w, css: googleCssUrl(cur.f, cur.w) });
    render();
  }).catch((e) => { status.textContent = `Couldn't load the font list (${e.message}).`; });
  dialog.showModal();
  search.focus();
}
