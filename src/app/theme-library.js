// Themes you made or opened ("your themes"), next to the built-in ones from
// themes/. They're kept in this browser (localStorage) and in theme files you
// save. A template that uses one of them carries a copy (themeData) when it's
// saved, so the template file works on another computer too.

import { DEFAULT_THEME, deepMerge, resolveTheme } from "../core/theme.js";
import { pruneFontFaces } from "../core/fonts.js";
import { state } from "./state.js";

const LS_KEY = "overlayworkspace.themes";
export const THEME_SCHEMA = "overlay-theme/1";

/** Ids of the themes that ship with the app (set when the library loads). */
export const builtinThemes = new Set();

export function isBuiltin(id) {
  return builtinThemes.has(id);
}

function readStore() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}

/** Adds the themes saved in this browser to state.themes. Call after the built-ins load. */
export function loadUserThemes() {
  for (const t of Object.values(readStore())) {
    if (t && t.id && !isBuiltin(t.id)) state.themes.set(t.id, t);
  }
}

export function slug(name) {
  return String(name || "theme").toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "theme";
}

/**
 * Checks a parsed theme file and returns a clean copy. Throws with a
 * readable message if it isn't a theme.
 */
export function validateTheme(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("not a JSON object");
  if (t.elements) throw new Error("this is a template, not a theme: use Open… at the top instead");
  if (t.schema && t.schema !== THEME_SCHEMA) throw new Error(`unsupported schema "${t.schema}" (expected ${THEME_SCHEMA})`);
  if (!t.colors && !t.fonts && !t.panel) throw new Error("no colors, fonts or panel settings in it");
  const name = String(t.name || t.id || "Imported theme");
  return { ...JSON.parse(JSON.stringify(t)), schema: THEME_SCHEMA, name, id: String(t.id || slug(name)) };
}

/**
 * Adds a theme to "your themes" (replacing one with the same id). A theme
 * whose id belongs to a built-in gets a new id, so built-ins can't be
 * overwritten. Returns the stored theme.
 */
export function addUserTheme(theme) {
  let t = validateTheme(theme);
  if (isBuiltin(t.id)) {
    let n = 2;
    while (state.themes.has(`${t.id}-${n}`)) n++;
    t = { ...t, id: `${t.id}-${n}` };
  }
  state.themes.set(t.id, t);
  const store = readStore();
  store[t.id] = t;
  writeStore(store);
  return t;
}

export function removeUserTheme(id) {
  if (isBuiltin(id)) return false;
  state.themes.delete(id);
  const store = readStore();
  delete store[id];
  writeStore(store);
  return true;
}

/** An id for a new theme from its name, not clashing with any existing theme. */
export function uniqueThemeId(name, keep = null) {
  const base = slug(name);
  if (base === keep || !state.themes.has(base)) return base;
  let n = 2;
  while (state.themes.has(`${base}-${n}`) && `${base}-${n}` !== keep) n++;
  return `${base}-${n}`;
}

/**
 * The template's current look as a standalone theme: its base theme with the
 * template's changes applied, every setting written out.
 */
export function bakeTheme(name, id) {
  const merged = resolveTheme(state.baseTheme || {}, state.template && state.template.themeOverrides);
  const full = deepMerge(DEFAULT_THEME, merged);
  full.fontFaces = pruneFontFaces(full.fontFaces, full.fonts);
  return { schema: THEME_SCHEMA, id, name, ...stripMeta(full) };
}

function stripMeta(t) {
  const { schema, id, name, ...rest } = t;
  return rest;
}

/** How many settings the template changes in its theme (for "N changes" hints). */
export function countOverrides(o) {
  if (!o || typeof o !== "object") return 0;
  let n = 0;
  for (const v of Object.values(o)) n += v && typeof v === "object" && !Array.isArray(v) ? countOverrides(v) : 1;
  return n;
}
