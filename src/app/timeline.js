// Bottom timeline: play/pause, scrubbing, lap markers, and the current time
// in data time, video time and lap time.

import { formatClock, formatLapTime } from "../core/units.js";
import { $, h } from "./dom.js";
import { getVideoElement, seekVideoToTime } from "./stage.js";
import { on, setStatus, setTime, state } from "./state.js";

let slider, marks, readout, playBtn, viewSel;
let view = "auto"; // "auto" | "video" | "session" | "lap:<n>"
let lastFrameTs = 0;

export function initTimeline() {
  const root = $("#timeline");
  playBtn = h("button", { class: "icon play", title: "Play / pause (Space)", onclick: togglePlay }, "▶");
  slider = h("input", { type: "range", min: 0, max: 100000, step: 1, value: 0, class: "scrub" });
  marks = h("canvas", { class: "marks" });
  readout = h("div", { class: "readout mono" });
  viewSel = h("select", { title: "Timeline range" });
  viewSel.addEventListener("change", () => { view = viewSel.value; update(); });
  root.append(playBtn, h("div", { class: "scrub-wrap" }, marks, slider), readout, viewSel);

  slider.addEventListener("input", () => {
    const [a, b] = range();
    setTime(a + (b - a) * (slider.value / 100000));
    seekVideoToTime();
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
  });
  new ResizeObserver(drawMarks).observe(marks);
  on("time", updatePosition);
  on("session", () => { view = "auto"; buildViews(); update(); });
  let lastUrl = null;
  on("video", (v) => {
    if (v && v.url !== lastUrl) view = "video"; // a newly loaded clip becomes the timeline range
    lastUrl = v ? v.url : null;
    buildViews();
    update();
  });
  on("view-video", () => { if (state.video) { view = "video"; buildViews(); update(); } });
  on("view-lap", (lap) => { if (!state.video) { view = `lap:${lap.number}`; buildViews(); update(); } });
  const v = getVideoElement();
  v.addEventListener("pause", () => { state.playing = false; playBtn.textContent = "▶"; });
  v.addEventListener("ended", () => { state.playing = false; playBtn.textContent = "▶"; });
  buildViews();
  update();
}

function buildViews() {
  const opts = [];
  if (state.video) opts.push(["video", "Video clip"]);
  if (state.session) {
    opts.push(["session", "Whole session"]);
    for (const l of state.session.laps) opts.push([`lap:${l.number}`, `Lap ${l.number}`]);
  }
  viewSel.replaceChildren(...opts.map(([v, l]) => h("option", { value: v }, l)));
  if (view === "auto" || !opts.some((o) => o[0] === view)) view = opts.length ? opts[0][0] : "auto";
  if (state.session && !state.video && view === "session" && state.session.laps.length) view = `lap:${state.session.laps[0].number}`;
  viewSel.value = view;
}

/** Visible time range [t0, t1] of the timeline. */
export function range() {
  const s = state.session, v = state.video;
  if (view === "video" && v) return [v.clipStart, v.clipStart + (v.duration || 60)];
  if (view.startsWith("lap:") && s) {
    const lap = s.laps.find((l) => `lap:${l.number}` === view);
    if (lap) return [lap.start - 5, lap.end + 5];
  }
  if (s) return [s.start, s.end];
  return [state.time - 30, state.time + 30];
}

function update() {
  drawMarks();
  updatePosition();
}

function updatePosition() {
  const [a, b] = range();
  slider.value = String(Math.round(((state.time - a) / (b - a || 1)) * 100000));
  const tc = state.timing ? state.timing.context(state.time) : null;
  const parts = [formatClock(state.time)];
  if (state.video) parts.push(`video ${(state.time - state.video.clipStart).toFixed(2)} s`);
  if (tc && tc.lap) parts.push(`lap ${tc.lap.number} ${tc.state === "in" ? formatLapTime(tc.elapsed) : tc.state}`);
  readout.textContent = parts.join("  ·  ");
}

function drawMarks() {
  const dpr = window.devicePixelRatio || 1;
  const w = marks.clientWidth, hh = marks.clientHeight;
  if (!w) return;
  marks.width = Math.round(w * dpr);
  marks.height = Math.round(hh * dpr);
  const c = marks.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, hh);
  const s = state.session;
  if (!s) return;
  const [a, b] = range();
  const x = (t) => ((t - a) / (b - a)) * w;
  for (const f of s.fragments) {
    c.fillStyle = "rgba(255,255,255,0.06)";
    c.fillRect(x(f.start), 0, Math.max(1, x(f.end) - x(f.start)), hh);
  }
  const cmp = state.timing.comparisonLap();
  for (const l of s.laps) {
    const x0 = x(l.start), x1 = x(l.end);
    if (x1 < 0 || x0 > w) continue;
    // Lap box with solid start/finish edges and a "Lap N" label inside.
    const col = l === cmp ? "255,176,0" : l.excluded ? "255,77,77" : "77,163,255";
    c.fillStyle = `rgba(${col},0.22)`;
    c.fillRect(x0, 4, Math.max(1, x1 - x0), hh - 8);
    c.fillStyle = `rgba(${col},0.95)`;
    c.fillRect(x0, 4, 2, hh - 8);
    c.fillRect(x1 - 2, 4, 2, hh - 8);
    c.fillStyle = "#e6eaf0";
    c.font = "11px system-ui";
    const label = `Lap ${l.number}${l === cmp ? " (cmp)" : ""}`;
    if (x1 - x0 > c.measureText(label).width + 8) c.fillText(label, Math.max(x0, 0) + 5, hh / 2 + 4);
  }
}

/** True when the loaded video (at its current sync) has a frame for data time t. */
export function videoCovers(t) {
  const v = state.video;
  return !!(v && v.duration && t >= v.clipStart && t <= v.clipStart + v.duration);
}

// Playing the data alone (no video, or the video doesn't cover this time).
let dataPlay = false;

function togglePlay() {
  const v = getVideoElement();
  if (state.playing) {
    if (dataPlay) {
      dataPlay = false;
      state.playing = false;
      playBtn.textContent = "▶";
    } else {
      v.pause();
    }
    return;
  }
  if (state.video && videoCovers(state.time)) {
    seekVideoToTime();
    state.playing = true;
    v.play().catch(() => { state.playing = false; });
    playBtn.textContent = "❚❚";
    return;
  }
  if (state.video) {
    const end = state.video.clipStart + state.video.duration;
    setStatus(`The video doesn't cover this moment at its current sync (clip = ${formatClock(state.video.clipStart, false)}–${formatClock(end, false)} data time), so this plays the data only. If this lap is in the clip, fix the sync in the Video panel.`, "warn");
  }
  dataPlay = true;
  state.playing = true;
  playBtn.textContent = "❚❚";
  lastFrameTs = performance.now();
  requestAnimationFrame(tick);
}

function tick(ts) {
  if (!state.playing || !dataPlay) return;
  const dt = (ts - lastFrameTs) / 1000;
  lastFrameTs = ts;
  const [a, b] = range();
  let t = state.time + dt;
  if (t > b) t = a;
  setTime(t);
  requestAnimationFrame(tick);
}
