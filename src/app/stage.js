// The preview stage: your video, the overlay rendered on top at the current
// time, and an editing layer for selecting, dragging and resizing elements
// with exact design-pixel coordinates.

import { makeFrame } from "../core/frame.js";
import { Renderer } from "../render/renderer.js";
import { $ } from "./dom.js";
import { commitSoon, emit, history, on, select, selected, state } from "./state.js";

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

const dpr = () => window.devicePixelRatio || 1;

function rectOf(el) {
  return { x: el.x * scale, y: el.y * scale, w: el.w * scale, h: el.h * scale };
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
  for (const el of t.elements) {
    if (el.hidden) continue;
    const r = rectOf(el);
    const sel = el.id === state.selectedId;
    uctx.strokeStyle = sel ? "#4da3ff" : hoverId === el.id ? "rgba(77,163,255,0.6)" : "transparent";
    uctx.lineWidth = sel ? 1.5 : 1;
    uctx.setLineDash(el.locked ? [4, 3] : []);
    uctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    uctx.setLineDash([]);
    if (sel && !el.locked) {
      uctx.fillStyle = "#fff";
      uctx.strokeStyle = "#4da3ff";
      for (const hd of handles(r)) {
        uctx.fillRect(hd.x - HANDLE / 2, hd.y - HANDLE / 2, HANDLE, HANDLE);
        uctx.strokeRect(hd.x - HANDLE / 2 + 0.5, hd.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
      }
    }
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
  if (drag) return;
  const p = pointerPos(e);
  const sel = selected();
  if (sel && !sel.locked) {
    const hd = handles(rectOf(sel)).find((q) => Math.abs(q.x - p.x) <= HANDLE && Math.abs(q.y - p.y) <= HANDLE);
    if (hd) { ui.style.cursor = `${hd.name}-resize`; return; }
  }
  const el = hitElement(p);
  ui.style.cursor = el ? (el.locked ? "pointer" : "move") : "default";
  const id = el ? el.id : null;
  if (id !== hoverId) { hoverId = id; dirty = true; }
}

let drag = null;
let guides = [];

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = pointerPos(e);
  const sel = selected();
  let mode = null, target = null;
  if (sel && !sel.locked) {
    const hd = handles(rectOf(sel)).find((q) => Math.abs(q.x - p.x) <= HANDLE && Math.abs(q.y - p.y) <= HANDLE);
    if (hd) { mode = hd.name; target = sel; }
  }
  if (!target) {
    target = hitElement(p);
    if (target && target.locked && target.id === state.selectedId) {
      // click-through to an element underneath a locked one
    }
    if (!target) { select(null); return; }
    select(target.id);
    if (target.locked) return;
    mode = "move";
  }
  ui.setPointerCapture(e.pointerId);
  drag = { mode, el: target, p0: p, start: { x: target.x, y: target.y, w: target.w, h: target.h }, moved: false };
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
  const el = drag.el, s = drag.start, m = drag.mode;
  guides = [];
  if (m === "move") {
    el.x = snap(s.x + dx, e);
    el.y = snap(s.y + dy, e);
    smartGuides(el, e);
  } else {
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (m.includes("w")) x0 = snap(s.x + dx, e);
    if (m.includes("e")) x1 = snap(s.x + s.w + dx, e);
    if (m.includes("n")) y0 = snap(s.y + dy, e);
    if (m.includes("s")) y1 = snap(s.y + s.h + dy, e);
    if (e.shiftKey && m.length === 2) {
      const ar = s.w / s.h;
      const w = x1 - x0, h = y1 - y0;
      if (Math.abs(w / ar) > Math.abs(h)) {
        const nh = w / ar;
        if (m.includes("n")) y0 = y1 - nh; else y1 = y0 + nh;
      } else {
        const nw = h * ar;
        if (m.includes("w")) x0 = x1 - nw; else x1 = x0 + nw;
      }
    }
    el.x = Math.round(Math.min(x0, x1));
    el.y = Math.round(Math.min(y0, y1));
    el.w = Math.max(1, Math.round(Math.abs(x1 - x0)));
    el.h = Math.max(1, Math.round(Math.abs(y1 - y0)));
  }
  emit("element", el);
}

/** Snaps a moving element's edges/center to the canvas center and other elements (within 8 screen px). */
function smartGuides(el, e) {
  if (e.altKey) return;
  const tol = 8 / scale;
  const t = state.template;
  const xs = [0, t.canvas.width / 2, t.canvas.width], ys = [0, t.canvas.height / 2, t.canvas.height];
  for (const o of t.elements) {
    if (o === el || o.hidden) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (cands, edges) => {
    let hit = null;
    for (const c of cands) for (const [off, v] of edges) {
      const d = c - v;
      if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, v: c, off };
    }
    return hit;
  };
  const hx = best(xs, [[0, el.x], [el.w / 2, el.x + el.w / 2], [el.w, el.x + el.w]]);
  if (hx) { el.x = Math.round(el.x + hx.d); guides.push({ axis: "x", v: hx.v }); }
  const hy = best(ys, [[0, el.y], [el.h / 2, el.y + el.h / 2], [el.h, el.y + el.h]]);
  if (hy) { el.y = Math.round(el.y + hy.d); guides.push({ axis: "y", v: hy.v }); }
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

function inField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKey(e) {
  if (inField(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); history.redo(); return; }
  const el = selected();
  if (!el) return;
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key] && !el.locked) {
    e.preventDefault();
    el.x += moves[e.key][0];
    el.y += moves[e.key][1];
    emit("element", el);
    commitSoon();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    emit("delete-element", el);
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    emit("duplicate-element", el);
  } else if (e.key === "Escape") {
    select(null);
  }
}
