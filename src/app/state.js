// App state and a tiny event bus. UI modules read `state` and listen for
// events; anything that changes state calls emit() with what changed.
//
// Events: "session", "template" (structure: elements added/removed/reordered,
// settings), "element" (an element's fields or props), "selection", "time",
// "video", "theme", "status".

import { Timing } from "../core/timing.js";
import { serializeTemplate, normalizeTemplate } from "../core/template.js";
import { resolveTheme } from "../core/theme.js";

export const state = {
  session: null,
  timing: null,
  template: null,
  baseTheme: null, // the theme file the template refers to
  theme: null, // baseTheme + template.themeOverrides
  themes: new Map(), // id -> theme JSON
  templateList: [], // [{ id, name, sessionType, file }]
  selectedId: null,
  time: 0,
  video: null, // { file, url, name, duration, cameraStart, clipStart, width, height, flip }
  playing: false,
  ui: { grid: 10, showGrid: false, previewBackground: "checker" },
};

const bus = new EventTarget();

export function on(name, fn) {
  bus.addEventListener(name, (e) => fn(e.detail));
}

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function setStatus(text, kind = "info") {
  emit("status", { text, kind });
}

export function selected() {
  return state.template && state.template.elements.find((e) => e.id === state.selectedId);
}

export function select(id) {
  state.selectedId = id;
  emit("selection", id);
}

export function setSession(session) {
  state.session = session;
  state.timing = session ? new Timing(session) : null;
  applyComparison();
  if (session) state.time = session.laps.length ? session.laps[0].start : session.start;
  emit("session", session);
  emit("time", state.time);
}

export function applyComparison() {
  if (state.timing && state.template) state.timing.setComparison(state.template.timing.comparison, state.template.timing.sections);
}

export function setTime(t) {
  state.time = t;
  emit("time", t);
}

export function refreshTheme() {
  state.theme = resolveTheme(state.baseTheme || {}, state.template && state.template.themeOverrides);
  emit("theme", state.theme);
}

export function setTemplate(t, { keepHistory = false } = {}) {
  state.template = normalizeTemplate(t);
  state.baseTheme = state.themes.get(state.template.theme) || state.themes.get("default") || {};
  if (!keepHistory) history.reset(serializeTemplate(state.template));
  if (!state.template.elements.some((e) => e.id === state.selectedId)) state.selectedId = null;
  applyComparison();
  refreshTheme();
  emit("template", state.template);
  emit("selection", state.selectedId);
  autosave();
}

// ── Undo / redo (template snapshots) ─────────────────────────────────────────

export const history = {
  stack: [],
  index: -1,
  reset(snapshot) {
    this.stack = [snapshot];
    this.index = 0;
  },
  push() {
    const snap = serializeTemplate(state.template);
    if (this.stack[this.index] === snap) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snap);
    if (this.stack.length > 200) this.stack.shift();
    this.index = this.stack.length - 1;
    autosave();
  },
  undo() {
    if (this.index <= 0) return;
    this.index--;
    setTemplate(JSON.parse(this.stack[this.index]), { keepHistory: true });
  },
  redo() {
    if (this.index >= this.stack.length - 1) return;
    this.index++;
    setTemplate(JSON.parse(this.stack[this.index]), { keepHistory: true });
  },
};

/** Records an undo step after a burst of edits (typing, dragging) settles. */
let commitTimer = null;
export function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => history.push(), 400);
}

// ── Local persistence (per browser; a convenience, files are the real save) ──

const LS_KEY = "overlayworkspace.template";

export function autosave() {
  try {
    if (state.template) localStorage.setItem(LS_KEY, serializeTemplate(state.template));
  } catch { /* storage unavailable */ }
}

export function loadAutosave() {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
