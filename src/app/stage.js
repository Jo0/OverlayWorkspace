// The preview stage: your video, the overlay rendered on top at the current
// time, and an editing layer for selecting (click, Shift-click, marquee),
// dragging and resizing elements with exact design-pixel coordinates.

import { makeFrame } from "../core/frame.js";
import { Renderer } from "../render/renderer.js";
import { $ } from "./dom.js";
import { bounds, expandToGroups, scaleInto } from "../core/arrange.js";
import { commitSoon, emit, history, on, select, selectedElements, setSelection, state, toggleSelect } from "./state.js";

export const renderer = new Renderer();

const HANDLE = 7; // screen px
let stageEl, videoEl, overlay, octx, ui, uctx, scale = 1, dirty = true;

export function initStage() {
  stageEl = $("#stage");
  videoEl = $("#video");
  overlay = $("#overlay-canvas");
  ui = $("#ui-canvas");
  octx = overlay.getContext("2d");
  uctx = ui.getContext("2d");

  new ResizeObserver(layout).observe($("#stage-wrap"));
  for (const ev of ["template", "element", "theme", "session", "time", "selection", "video"]) on(ev, invalidate);
  on("template", () => { renderer.invalidate(); layout(); });
  on("element", () => renderer.invalidate());
  on("theme", () => renderer.invalidate());
  on("fonts-loaded", () => { renderer.invalidate(); invalidate(); });
  on("session", () => renderer.invalidate());
  on("video", syncVideoElement);
  on("time", markOutOfClip);
  on("video", markOutOfClip);

  // Seeking the video by any means (its own controls, frame stepping) moves the data time with it.
  videoEl.addEventListener("seeked", () => {
    if (!state.video || state.playing) return;
    const t = state.video.clipStart + videoEl.currentTime;
    if (Math.abs(t - state.time) > 0.002) {
      state.time = t;
      emit("time", t);
    }
  });

  ui.addEventListener("pointerdown", onPointerDown);
  ui.addEventListener("pointermove", onHover);
  window.addEventListener("keydown", onKey);
  requestAnimationFrame(loop);
}

export function invalidate() {
  dirty = true;
}

export function getVideoElement() {
  return videoEl;
}

function layout() {
  if (!state.template) return;
  const wrap = $("#stage-wrap");
  const { width: dw, height: dh } = state.template.canvas;
  const availW = wrap.clientWidth - 24, availH = wrap.clientHeight - 24;
  scale = Math.max(0.05, Math.min(availW / dw, availH / dh));
  const cssW = Math.round(dw * scale), cssH = Math.round(dh * scale);
  stageEl.style.width = `${cssW}px`;
  stageEl.style.height = `${cssH}px`;
  const dpr = window.devicePixelRatio || 1;
  for (const c of [overlay, ui]) {
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
  }
  emit("stage-scale", scale);
  dirty = true;
}

function syncVideoElement() {
  const v = state.video;
  if (!v) {
    videoEl.removeAttribute("src");
    videoEl.load();
    stageEl.classList.remove("has-video");
    return;
  }
  if (videoEl.dataset.url !== v.url) {
    videoEl.src = v.url;
    videoEl.dataset.url = v.url;
  }
  stageEl.classList.add("has-video");
  videoEl.classList.toggle("flipped", !!v.flip);
}

function markOutOfClip() {
  const v = state.video;
  const inside = v && v.duration ? state.time >= v.clipStart && state.time <= v.clipStart + v.duration : true;
  stageEl.classList.toggle("out-of-clip", !inside);
}

function loop() {
  if (state.playing && state.video && !videoEl.paused) {
    const t = state.video.clipStart + videoEl.currentTime;
    if (Math.abs(t - state.time) > 1e-4) {
      state.time = t;
      emit("time", t);
    }
  }
  if (dirty && state.template) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(loop);
}

function draw() {
  const frame = makeFrame(state.session, state.timing, state.time, renderer.cache);
  renderer.render(octx, { template: state.template, theme: state.theme, frame, width: overlay.width, height: overlay.height });
  drawUi();
}

/** Seeks the video to match state.time (when not playing). */
export function seekVideoToTime() {
  const v = state.video;
  if (!v || state.playing) return;
  const vt = state.time - v.clipStart;
  if (vt >= 0 && vt <= (v.duration || Infinity) && Math.abs(videoEl.currentTime - vt) > 0.004) videoEl.currentTime = vt;
}

// ── Editing layer ────────────────────────────────────────────────────────────
//
// Click selects an element (its whole group if it has one). Shift-click adds
// or removes. Ctrl/Cmd-click or double-click picks one element inside a
// group. Dragging empty space draws a marquee. The handles resize the one
// selected element, or the whole selection together.

const dpr = () => window.devicePixelRatio || 1;

function rectOf(el) {
  return { x: el.x * scale, y: el.y * scale, w: el.w * scale, h: el.h * scale };
}

function toScreen(r) {
  return { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale };
}

/** The rect the handles sit on: the selected element, or the selection's bounds. Null if nothing can be resized. */
function handleRect() {
  const els = selectedElements();
  if (!els.length || els.some((e) => e.locked)) return null;
  return toScreen(bounds(els));
}

function drawUi() {
  const k = dpr();
  uctx.setTransform(k, 0, 0, k, 0, 0);
  uctx.clearRect(0, 0, ui.width, ui.height);
  const t = state.template;
  if (state.ui.showGrid && state.ui.grid > 0) {
    uctx.strokeStyle = "rgba(255,255,255,0.08)";
    uctx.lineWidth = 1;
    const g = state.ui.grid * scale;
    if (g >= 4) {
      uctx.beginPath();
      for (let x = 0; x <= t.canvas.width * scale; x += g) { uctx.moveTo(Math.round(x) + 0.5, 0); uctx.lineTo(Math.round(x) + 0.5, t.canvas.height * scale); }
      for (let y = 0; y <= t.canvas.height * scale; y += g) { uctx.moveTo(0, Math.round(y) + 0.5); uctx.lineTo(t.canvas.width * scale, Math.round(y) + 0.5); }
      uctx.stroke();
    }
  }
  const sel = new Set(state.selection);
  const multi = sel.size > 1;
  const hover = hoverId && t.elements.find((e) => e.id === hoverId);
  const hoverGroup = hover && hover.group && !sel.has(hover.id) ? hover.group : null;
  for (const el of t.elements) {
    if (el.hidden) continue;
    const r = rectOf(el);
    const isSel = sel.has(el.id);
    uctx.strokeStyle = isSel ? (multi ? "rgba(77,163,255,0.75)" : "#4da3ff")
      : hoverId === el.id || (hoverGroup && el.group === hoverGroup) ? "rgba(77,163,255,0.6)" : "transparent";
    uctx.lineWidth = isSel && !multi ? 1.5 : 1;
    uctx.setLineDash(el.locked ? [4, 3] : []);
    uctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    uctx.setLineDash([]);
  }
  // A hovered group shows its outline, so it's clear a click takes all of it.
  if (hoverGroup) {
    const members = t.elements.filter((e) => e.group === hoverGroup && !e.hidden);
    if (members.length) {
      const r = toScreen(bounds(members));
      uctx.strokeStyle = "rgba(77,163,255,0.6)";
      uctx.setLineDash([6, 4]);
      uctx.strokeRect(r.x - 3.5, r.y - 3.5, r.w + 7, r.h + 7);
      uctx.setLineDash([]);
    }
  }
  if (sel.size) {
    const hr = handleRect();
    const r = hr || toScreen(bounds(selectedElements()));
    if (multi) {
      uctx.strokeStyle = "#4da3ff";
      uctx.lineWidth = 1.5;
      uctx.setLineDash([6, 4]);
      uctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      uctx.setLineDash([]);
    }
    if (hr) {
      uctx.fillStyle = "#fff";
      uctx.strokeStyle = "#4da3ff";
      uctx.lineWidth = 1;
      for (const hd of handles(hr)) {
        uctx.fillRect(hd.x - HANDLE / 2, hd.y - HANDLE / 2, HANDLE, HANDLE);
        uctx.strokeRect(hd.x - HANDLE / 2 + 0.5, hd.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
      }
    }
  }
  if (marquee) {
    const r = toScreen(marquee.rect);
    uctx.fillStyle = "rgba(77,163,255,0.12)";
    uctx.strokeStyle = "#4da3ff";
    uctx.lineWidth = 1;
    uctx.fillRect(r.x, r.y, r.w, r.h);
    uctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
  }
  if (guides.length) {
    uctx.strokeStyle = "#ff3ea5";
    uctx.lineWidth = 1;
    uctx.beginPath();
    for (const g of guides) {
      if (g.axis === "x") { uctx.moveTo(g.v * scale + 0.5, 0); uctx.lineTo(g.v * scale + 0.5, t.canvas.height * scale); }
      else { uctx.moveTo(0, g.v * scale + 0.5); uctx.lineTo(t.canvas.width * scale, g.v * scale + 0.5); }
    }
    uctx.stroke();
  }
}

function handles(r) {
  const xs = [r.x, r.x + r.w / 2, r.x + r.w], ys = [r.y, r.y + r.h / 2, r.y + r.h];
  const out = [];
  const names = [["nw", "n", "ne"], ["w", null, "e"], ["sw", "s", "se"]];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if (names[j][i]) out.push({ x: xs[i], y: ys[j], name: names[j][i] });
  return out;
}

function handleAt(p) {
  const hr = handleRect();
  return hr ? handles(hr).find((q) => Math.abs(q.x - p.x) <= HANDLE && Math.abs(q.y - p.y) <= HANDLE) : null;
}

function pointerPos(e) {
  const b = ui.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

function hitElement(p) {
  const els = state.template.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.hidden) continue;
    const r = rectOf(el);
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return el;
  }
  return null;
}

let hoverId = null;
function onHover(e) {
  if (drag || marquee) return;
  const p = pointerPos(e);
  const hd = handleAt(p);
  if (hd) { ui.style.cursor = `${hd.name}-resize`; return; }
  const el = hitElement(p);
  ui.style.cursor = el ? (el.locked ? "pointer" : "move") : "default";
  const id = el ? el.id : null;
  if (id !== hoverId) { hoverId = id; dirty = true; }
}

let drag = null;
let guides = [];
let marquee = null;

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = pointerPos(e);
  const additive = e.shiftKey;
  const deep = e.ctrlKey || e.metaKey || e.detail >= 2; // one element inside a group
  let mode = null;
  const hd = !additive && handleAt(p);
  if (hd) mode = hd.name;
  else {
    const target = hitElement(p);
    if (!target) {
      // Empty space: marquee. Shift keeps what's already selected.
      if (!additive) setSelection([]);
      marquee = { p0: p, base: additive ? [...state.selection] : [], rect: { x: p.x / scale, y: p.y / scale, w: 0, h: 0 } };
      ui.setPointerCapture(e.pointerId);
      ui.addEventListener("pointermove", onMarqueeMove);
      ui.addEventListener("pointerup", onMarqueeEnd, { once: true });
      ui.addEventListener("pointercancel", onMarqueeEnd, { once: true });
      return;
    }
    if (additive) { toggleSelect(target.id, { single: deep }); return; }
    // Clicking inside the current selection keeps it, so several can be dragged.
    const inSel = state.selection.includes(target.id);
    if (!inSel || (deep && state.selection.length > 1)) select(target.id, { single: deep });
    mode = "move";
  }
  const els = selectedElements();
  const movable = els.filter((el) => !el.locked);
  if (!movable.length || (mode !== "move" && movable.length !== els.length)) return;
  ui.setPointerCapture(e.pointerId);
  drag = {
    mode, els: movable, p0: p, moved: false,
    start: movable.map((el) => ({ x: el.x, y: el.y, w: el.w, h: el.h })),
    box: bounds(movable),
  };
  ui.addEventListener("pointermove", onDragMove);
  ui.addEventListener("pointerup", onDragEnd, { once: true });
  ui.addEventListener("pointercancel", onDragEnd, { once: true });
}

function snap(v, e) {
  const g = state.ui.grid;
  return g > 0 && !e.altKey ? Math.round(v / g) * g : Math.round(v);
}

function onDragMove(e) {
  if (!drag) return;
  const p = pointerPos(e);
  const dx = (p.x - drag.p0.x) / scale, dy = (p.y - drag.p0.y) / scale;
  if (!drag.moved && Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) < 2) return;
  drag.moved = true;
  const b = drag.box, m = drag.mode;
  guides = [];
  if (m === "move") {
    // Snap the selection's box, then move every element by the same amount.
    const r = { x: snap(b.x + dx, e), y: snap(b.y + dy, e), w: b.w, h: b.h };
    smartGuides(r, new Set(drag.els.map((el) => el.id)), e);
    drag.els.forEach((el, i) => { el.x = drag.start[i].x + (r.x - b.x); el.y = drag.start[i].y + (r.y - b.y); });
  } else {
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    if (m.includes("w")) x0 = snap(b.x + dx, e);
    if (m.includes("e")) x1 = snap(b.x + b.w + dx, e);
    if (m.includes("n")) y0 = snap(b.y + dy, e);
    if (m.includes("s")) y1 = snap(b.y + b.h + dy, e);
    // Shift keeps proportions. A multi-selection always does from a corner,
    // so the text and gauges inside don't get squashed.
    if ((e.shiftKey || drag.els.length > 1) && m.length === 2) {
      const ar = b.w / b.h;
      const w = x1 - x0, h = y1 - y0;
      if (Math.abs(w / ar) > Math.abs(h)) {
        const nh = w / ar;
        if (m.includes("n")) y0 = y1 - nh; else y1 = y0 + nh;
      } else {
        const nw = h * ar;
        if (m.includes("w")) x0 = x1 - nw; else x1 = x0 + nw;
      }
    }
    const to = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    scaleInto(drag.els, drag.start, b, to);
  }
  for (const el of drag.els) emit("element", el);
}

/** Snaps a moving rect's edges/center to the canvas center and edges and to other elements (within 8 screen px). */
function smartGuides(r, exclude, e) {
  if (e.altKey) return;
  const tol = 8 / scale;
  const t = state.template;
  const xs = [0, t.canvas.width / 2, t.canvas.width], ys = [0, t.canvas.height / 2, t.canvas.height];
  for (const o of t.elements) {
    if (exclude.has(o.id) || o.hidden) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (cands, edges) => {
    let hit = null;
    for (const c of cands) for (const v of edges) {
      const d = c - v;
      if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, v: c };
    }
    return hit;
  };
  const hx = best(xs, [r.x, r.x + r.w / 2, r.x + r.w]);
  if (hx) { r.x = Math.round(r.x + hx.d); guides.push({ axis: "x", v: hx.v }); }
  const hy = best(ys, [r.y, r.y + r.h / 2, r.y + r.h]);
  if (hy) { r.y = Math.round(r.y + hy.d); guides.push({ axis: "y", v: hy.v }); }
}

function onDragEnd() {
  ui.removeEventListener("pointermove", onDragMove);
  if (drag && drag.moved) {
    renderer.invalidate();
    history.push();
  }
  drag = null;
  guides = [];
  dirty = true;
}

function onMarqueeMove(e) {
  if (!marquee) return;
  const p = pointerPos(e), p0 = marquee.p0;
  marquee.rect = { x: Math.min(p.x, p0.x) / scale, y: Math.min(p.y, p0.y) / scale, w: Math.abs(p.x - p0.x) / scale, h: Math.abs(p.y - p0.y) / scale };
  // Everything the box touches (visible, unlocked), with whole groups.
  const r = marquee.rect;
  const hit = state.template.elements
    .filter((el) => !el.hidden && !el.locked && el.x < r.x + r.w && el.x + el.w > r.x && el.y < r.y + r.h && el.y + el.h > r.y)
    .map((el) => el.id);
  setSelection([...marquee.base, ...expandToGroups(state.template, hit)]);
  dirty = true;
}

function onMarqueeEnd() {
  ui.removeEventListener("pointermove", onMarqueeMove);
  marquee = null;
  dirty = true;
}

function inField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKey(e) {
  if (inField(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === "z") { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
  if (mod && key === "y") { e.preventDefault(); history.redo(); return; }
  if (mod && key === "a" && state.template) {
    e.preventDefault();
    setSelection(state.template.elements.filter((el) => !el.hidden && !el.locked).map((el) => el.id));
    return;
  }
  const els = selectedElements();
  if (!els.length) return;
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    for (const el of els) {
      if (el.locked) continue;
      el.x += moves[e.key][0];
      el.y += moves[e.key][1];
      emit("element", el);
    }
    commitSoon();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    emit("delete-element", els);
  } else if (mod && key === "d") {
    e.preventDefault();
    emit("duplicate-element", els);
  } else if (mod && key === "g") {
    e.preventDefault();
    emit(e.shiftKey ? "ungroup" : "group", els);
  } else if (e.key === "Escape") {
    setSelection([]);
  }
}
