// Left-hand panels: data (session + laps), video (load, flip, sync), layers.

import { importers, widgets } from "../core/registry.js";
import { newElementId, normalizeTemplate } from "../core/template.js";
import { formatClock, formatLapTime } from "../core/units.js";
import { importData } from "../importers/index.js";
import { readMp4Info } from "../video/mp4-info.js";
import { readDjiTrack } from "../video/dji-gps.js";
import { parseNmea } from "../video/nmea.js";
import { matchClockOffset } from "../core/gps-sync.js";
import { $, clear, h, pickFile, pickFiles } from "./dom.js";
import { getVideoElement, seekVideoToTime } from "./stage.js";
import { applyComparison, emit, history, on, select, setSession, setStatus, setTime, state } from "./state.js";

export function initPanels() {
  buildDataPanel();
  buildVideoPanel();
  buildLayers();
  on("session", () => { buildDataPanel(); buildVideoPanel(); });
  on("comparison-changed", buildDataPanel);
  on("video", buildVideoPanel);
  on("time", updateSyncScrub);
  on("view-lap", (lap) => { focusLapNumber = lap.number; if (state.video) buildVideoPanel(); });
  on("template", buildLayers);
  on("selection", buildLayers);
  on("layers-changed", buildLayers);
  on("delete-element", deleteElement);
  on("duplicate-element", duplicateElement);
}

// ── Data ─────────────────────────────────────────────────────────────────────

export async function loadDataFile(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const s = await importData(file);
    setSession(s);
    if (state.video) autoAlignVideo();
    setStatus(`Loaded ${file.name}: ${s.laps.length} laps, ${s.channels.length} channels.`, "ok");
  } catch (e) {
    console.error(e);
    setStatus(e.message, "error");
  }
}

function buildDataPanel() {
  const root = clear($("#panel-data"));
  const accept = [...new Set(importers.list().flatMap((i) => i.extensions || []))].join(",");
  root.append(h("div", { class: "panel-head" },
    h("h2", {}, "Data"),
    h("button", { class: "primary", onclick: async () => { const f = await pickFile(accept); if (f) loadDataFile(f); } }, "Load data…")));
  const s = state.session;
  if (!s) {
    root.append(h("p", { class: "muted small" }, "Supported: ", importers.list().map((i) => i.label).join(", "), "."),
      ...importers.list().map((i) => (i.help ? h("p", { class: "muted small" }, i.help) : null)));
    return;
  }
  const dur = s.end - s.start;
  root.append(h("div", { class: "summary" },
    h("div", {}, h("strong", {}, s.meta.title || s.meta.fileName || "Session")),
    s.meta.track && s.meta.track !== s.meta.title ? h("div", { class: "muted small" }, s.meta.track) : null,
    h("div", { class: "muted small" }, `${formatClock(s.start, false)} – ${formatClock(s.end, false)} · ${(dur / 60).toFixed(0)} min · ${s.channels.length} channels · ${s.fragments.length} fragment${s.fragments.length === 1 ? "" : "s"}`)));

  if (!s.laps.length) {
    root.append(h("p", { class: "muted small" }, "No laps in this session."));
    return;
  }
  const cmp = state.timing.comparisonLap();
  const best = state.timing.bestLap();
  const table = h("table", { class: "laps" },
    h("thead", {}, h("tr", {}, h("th", {}, "Lap"), h("th", {}, "Time"), h("th", { title: "Fragment (recording segment)" }, "Frag"), h("th", { title: "Leave out of best lap and comparison (cones, DNF, off-course)" }, "Skip"), h("th", { title: "Comparison lap for the delta" }, "Cmp"), h("th", {}, ""))));
  const tb = h("tbody");
  for (const l of s.laps) {
    const skip = h("input", { type: "checkbox", title: "Leave out of best lap and comparison" });
    skip.checked = !!l.excluded;
    skip.addEventListener("change", () => { l.excluded = skip.checked; state.timing._profiles.clear(); emit("element", null); buildDataPanel(); });
    const radio = h("input", { type: "radio", name: "cmp-lap", title: "Compare against this lap" });
    radio.checked = state.template.timing.comparison === l.number;
    radio.addEventListener("change", () => {
      state.template.timing.comparison = l.number;
      applyComparison();
      emit("element", null);
      emit("template", state.template);
      history.push();
      buildDataPanel();
    });
    tb.append(h("tr", { class: [l === cmp ? "is-cmp" : "", l === best ? "is-best" : "", l.excluded ? "is-skip" : ""].join(" ") },
      h("td", {}, l.number),
      h("td", { class: "mono" }, formatLapTime(l.duration)),
      h("td", { class: "muted" }, l.fragment),
      h("td", {}, skip),
      h("td", {}, radio),
      h("td", {}, h("button", { class: "small", title: "Jump to 2 s before this lap starts", onclick: () => { setTime(l.start - 2); seekVideoToTime(); emit("view-lap", l); } }, "Go"))));
  }
  table.append(tb);
  const useBest = h("button", { class: "small", onclick: () => { state.template.timing.comparison = "best"; applyComparison(); emit("element", null); emit("template", state.template); history.push(); buildDataPanel(); } }, "Compare to best");
  root.append(table, h("div", { class: "row-inline small muted" },
    h("span", {}, `Comparison: lap ${cmp ? cmp.number : "-"}${state.template.timing.comparison === "best" ? " (best)" : ""}`), useBest));
}

// ── Video ────────────────────────────────────────────────────────────────────

export async function loadVideoFile(file) {
  if (state.video && state.video.url) URL.revokeObjectURL(state.video.url);
  const info = await readMp4Info(file).catch(() => ({ creationTime: null, duration: null }));
  const url = URL.createObjectURL(file);
  state.video = {
    file, url, name: file.name,
    duration: info.duration,
    cameraStart: info.creationTime,
    clipStart: info.creationTime ?? (state.session ? state.session.start : 0),
    flip: false,
  };
  const v = getVideoElement();
  v.addEventListener("loadedmetadata", () => {
    state.video.duration = v.duration;
    state.video.width = v.videoWidth;
    state.video.height = v.videoHeight;
    emit("video", state.video);
  }, { once: true });
  v.addEventListener("error", () => setStatus(`The browser can't play ${file.name} (codec not supported?). Sync and export still work; the preview just has no picture.`, "error"), { once: true });
  autoAlignVideo();
  emit("video", state.video);
  setTime(state.video.clipStart);
  seekVideoToTime();
  setStatus(`Loaded video ${file.name}${info.creationTime ? `, recorded ${formatClock(info.creationTime, false)} by the camera clock` : ""}.`, "ok");
}

/** Without a better clue, start where the camera clock says. */
function autoAlignVideo() {
  const v = state.video;
  if (!v || v.userSynced) return;
  v.clipStart = v.cameraStart ?? (state.session ? state.session.start : 0);
}

function setClipStart(t) {
  const v = state.video;
  v.clipStart = t;
  v.userSynced = true;
  setTime(v.clipStart + getVideoElement().currentTime);
  emit("video", v);
}

function buildVideoPanel() {
  const root = clear($("#panel-video"));
  root.append(h("div", { class: "panel-head" },
    h("h2", {}, "Video"),
    h("button", { onclick: async () => { const f = await pickFile("video/*,.mp4,.mov"); if (f) loadVideoFile(f); } }, "Load video…")));
  const v = state.video;
  if (!v) {
    root.append(h("p", { class: "muted small" }, "Optional: load the clip to design over your own footage and line the data up with it. The file stays on your computer."));
    return;
  }
  const flip = h("input", { type: "checkbox" });
  flip.checked = !!v.flip;
  flip.addEventListener("change", () => { v.flip = flip.checked; emit("video", v); });

  const corr = h("input", { type: "number", step: 0.01, value: v.cameraStart != null ? (v.clipStart - v.cameraStart).toFixed(2) : "" });
  corr.disabled = v.cameraStart == null;
  corr.addEventListener("change", () => { const n = Number(corr.value); if (Number.isFinite(n)) { setClipStart(v.cameraStart + n); v.syncNote = null; } });
  const nudge = (d) => h("button", { class: "small", title: "Move the data against the video", onclick: () => setClipStart(v.clipStart + d) }, (d > 0 ? "+" : "") + d);

  root.append(
    h("div", { class: "summary" },
      h("div", {}, h("strong", {}, v.name)),
      h("div", { class: "muted small" }, [v.width ? `${v.width}×${v.height}` : null, v.duration ? `${v.duration.toFixed(1)} s` : null, v.cameraStart != null ? `camera clock ${formatClock(v.cameraStart, false)}` : "no recording time in file"].filter(Boolean).join(" · "))),
    h("label", { class: "field check" }, flip, h("span", {}, "Rotate 180° (upside-down mount)")),
    h("h3", {}, "Sync video and data"),
    v.syncNote ? h("p", { class: "small ok-text" }, `✓ ${v.syncNote}`) : null,
    coverage(v),
    state.session ? h("div", { class: "auto-sync" },
      h("button", { class: "primary small", onclick: () => autoSync(v) }, "Auto-sync from GPS"),
      h("small", { class: "hint" }, "Matches the GPS track the camera recorded (DJI with a GPS remote) to the session's track. If the loaded video is a flipped or re-encoded copy, you'll be asked for the original camera file or its .nmea.")) : null,
    state.session && state.session.laps.length ? syncSteps(v) : null,
    h("details", { class: "advanced" },
      h("summary", { class: "small" }, "Or set the offset by number"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Camera clock correction (s)"), corr,
        h("small", { class: "hint" }, "Seconds to add to the camera's clock, e.g. −169.40 if it ran 2:49.40 fast (CameraWorkflow's clock_offset.py prints this per clip).")),
      h("div", { class: "row-inline" }, nudge(-1), nudge(-0.1), nudge(-0.01), nudge(0.01), nudge(0.1), nudge(1))),
    h("button", { class: "small", onclick: () => { if (state.video.url) URL.revokeObjectURL(state.video.url); state.video = null; emit("video", null); buildVideoPanel(); } }, "Remove video"),
  );
}

// The two-step sync: move the VIDEO (not the data) to the start or finish
// line, then say which lap that is. Kept in module scope so the scrubber can
// follow the video without rebuilding the panel.
let syncScrub = null, syncTimeLabel = null;
let focusLapNumber = null; // last lap picked with "Go"

function fmtClipTime(s) {
  if (!Number.isFinite(s)) return "--";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

function syncSteps(v) {
  const video = getVideoElement();
  const dur = v.duration || 0;
  syncScrub = h("input", { type: "range", min: 0, max: Math.max(0.01, dur), step: 0.01, value: video.currentTime || 0, class: "video-scrub" });
  syncTimeLabel = h("span", { class: "mono small" }, `${fmtClipTime(video.currentTime)} / ${fmtClipTime(dur)}`);
  const seek = (t) => {
    if (!video.paused) video.pause();
    video.currentTime = Math.min(Math.max(0, t), dur);
  };
  syncScrub.addEventListener("input", () => seek(Number(syncScrub.value)));
  const step = (d, label) => h("button", { class: "small", title: `${d > 0 ? "Forward" : "Back"} ${Math.abs(d)} s`, onclick: () => seek(video.currentTime + d) }, label);

  const laps = state.session.laps;
  const lapSel = h("select", {}, laps.map((l) => h("option", { value: l.number }, `Lap ${l.number}`)));
  lapSel.value = String(focusLapNumber ?? (state.timing.context(state.time).lapNumber || laps[0].number));
  const edgeSel = h("select", {}, h("option", { value: "start" }, "start"), h("option", { value: "end" }, "finish"));

  const apply = () => {
    const lap = laps.find((l) => String(l.number) === lapSel.value);
    if (!lap) return;
    const at = video.currentTime;
    setClipStart((edgeSel.value === "start" ? lap.start : lap.end) - at);
    v.syncNote = `Lap ${lap.number} ${edgeSel.value === "start" ? "starts" : "finishes"} at ${fmtClipTime(at)} in the clip. Press ▶ to preview.`;
    focusLapNumber = lap.number;
    emit("view-video");
    buildVideoPanel();
    setStatus(`Synced. ${v.syncNote}`, "ok");
  };

  return h("div", { class: "sync-steps" },
    h("p", { class: "muted small" }, "The camera and the data logger each keep their own clock. Show the app one moment that's the same in both:"),
    h("ol", { class: "small" },
      h("li", {}, "Move the video to the frame where you cross the start (or finish) line:",
        h("div", { class: "video-scrub-row" }, syncScrub, syncTimeLabel),
        h("div", { class: "row-inline" }, step(-1, "−1 s"), step(-0.1, "−0.1"), step(-1 / 30, "−⅟30"), step(1 / 30, "+⅟30"), step(0.1, "+0.1"), step(1, "+1 s"))),
      h("li", {}, "Say which line that is:",
        h("div", { class: "align-row" }, h("span", {}, "This frame is the"), edgeSel, h("span", {}, "of"), lapSel,
          h("button", { class: "primary small", onclick: apply }, "Sync")))));
}

function updateSyncScrub() {
  if (!syncScrub || !syncScrub.isConnected || !state.video) return;
  const t = getVideoElement().currentTime;
  if (document.activeElement !== syncScrub) syncScrub.value = String(t);
  syncTimeLabel.textContent = `${fmtClipTime(t)} / ${fmtClipTime(state.video.duration)}`;
}

// ── Auto-sync from the camera's GPS ──────────────────────────────────────────

function stem(name) {
  return (name || "").replace(/\.[^.]+$/, "").toLowerCase();
}

/** Camera-side GPS fixes from a file: a DJI clip's metadata track or an NMEA log. */
async function readCameraGps(file) {
  if (/\.(nmea|txt|log)$/i.test(file.name)) {
    return { name: file.name, fixes: parseNmea(await file.text()), creationTime: null };
  }
  const tr = await readDjiTrack(file);
  return tr ? { name: file.name, fixes: tr.fixes, creationTime: tr.creationTime } : null;
}

async function autoSync(v) {
  try {
    setStatus("Reading the camera's GPS track…");
    let sources = [];
    const own = await readCameraGps(v.file).catch(() => null);
    if (own && own.fixes.length >= 20) sources = [own];
    else {
      setStatus(`${v.name} has no camera GPS track (flipped and re-encoded copies lose it). Pick the ORIGINAL camera file (best: its GPS remote's clock rules out matching the wrong run), or select ALL the .nmea files from that day (one .nmea alone can match the wrong run on autocross).`, "warn");
      const files = await pickFiles(".mp4,.MP4,.mov,.nmea,.txt,.log");
      if (!files.length) return;
      for (const f of files) {
        const s = await readCameraGps(f).catch(() => null);
        if (s && s.fixes.length >= 20) sources.push(s);
      }
      if (!sources.length) {
        setStatus("None of those files has a camera GPS track.", "error");
        return;
      }
    }
    setStatus("Matching the tracks…");
    await new Promise((r) => setTimeout(r, 0));
    const m = matchClockOffset(state.session, sources.map((s) => s.fixes));
    // Clips' offsets differ by up to ~1 s (start times are whole seconds): use
    // the loaded clip's own result when it's among the sources.
    const k = sources.findIndex((s) => stem(s.name) === stem(v.name));
    const off = k >= 0 ? m.clips[k].offset : m.offset;
    const err = k >= 0 ? m.clips[k].error : m.error;
    const base = v.cameraStart ?? (k >= 0 ? sources[k].creationTime : null);
    if (base == null) {
      setStatus("The video file has no recording time, so a clock offset can't be applied to it. Use the two steps below.", "error");
      return;
    }
    setClipStart(base + off);
    const mm = Math.floor(Math.abs(off) / 60), ss = (Math.abs(off) - mm * 60).toFixed(2).padStart(5, "0");
    const laps = state.session.laps.filter((l) => l.start >= v.clipStart && l.start <= v.clipStart + (v.duration || 0));
    v.syncNote = `Auto-synced from GPS: the camera clock was ${mm}:${ss} ${off < 0 ? "fast" : "slow"} (tracks match within ${err.toFixed(1)} m${m.usedGpsClock ? ", confirmed by the GPS remote's clock" : ""}).`
      + (laps.length ? ` Lap ${laps[0].number} starts at ${fmtClipTime(laps[0].start - v.clipStart)} in the clip. Press ▶ to preview.` : "");
    if (m.ambiguous && !m.usedGpsClock) {
      v.syncNote += ` Careful: an offset of ${m.ambiguous.offset.toFixed(1)} s fits almost as well (probably another run on the same course). Check the preview; adding more clips from the day settles it.`;
    }
    if (laps.length) setTime(laps[0].start); // land exactly on the start line
    getVideoElement().currentTime = Math.max(0, state.time - v.clipStart);
    emit("view-video");
    buildVideoPanel();
    setStatus(v.syncNote, m.ambiguous && !m.usedGpsClock ? "warn" : "ok");
  } catch (e) {
    console.error(e);
    setStatus(`Auto-sync failed: ${e.message}`, "error");
  }
}

/** Which laps the clip covers at the current sync: a quick sanity check. */
function coverage(v) {
  if (!state.session || !v.duration) return null;
  const a = v.clipStart, b = v.clipStart + v.duration;
  const laps = state.session.laps.filter((l) => l.end > a && l.start < b);
  if (!laps.length) {
    return h("p", { class: "small warn-text" }, "At this sync the clip covers no lap. The camera clock is probably off: sync it with the two steps below.");
  }
  return h("p", { class: "small" }, "At this sync the clip covers: ", laps.map((l) => {
    const full = l.start >= a && l.end <= b;
    return `lap ${l.number}${full ? "" : " (partly)"}`;
  }).join(", "), ".");
}

// ── Layers ───────────────────────────────────────────────────────────────────

function buildLayers() {
  const root = clear($("#panel-layers"));
  if (!state.template) return;
  const add = h("select", { class: "add-select" },
    h("option", { value: "" }, "+ Add element…"),
    widgets.list().map((w) => h("option", { value: w.id, title: w.description || "" }, w.label)));
  add.addEventListener("change", () => { if (add.value) addElement(add.value); add.value = ""; });
  root.append(h("div", { class: "panel-head" }, h("h2", {}, "Layers"), add));
  const list = h("ul", { class: "layers" });
  const els = state.template.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    const eye = h("button", { class: "icon", title: el.hidden ? "Show" : "Hide", onclick: (e) => { e.stopPropagation(); el.hidden = !el.hidden; emit("element", el); history.push(); buildLayers(); } }, el.hidden ? "◌" : "●");
    const up = h("button", { class: "icon", title: "Bring forward", onclick: (e) => { e.stopPropagation(); move(i, 1); } }, "▲");
    const down = h("button", { class: "icon", title: "Send backward", onclick: (e) => { e.stopPropagation(); move(i, -1); } }, "▼");
    list.append(h("li", { class: el.id === state.selectedId ? "sel" : "", onclick: () => select(el.id) },
      eye, h("span", { class: "layer-name" }, el.name, el.locked ? " 🔒" : ""), h("span", { class: "muted small" }, el.type), up, down));
  }
  root.append(list);
}

function move(i, d) {
  const els = state.template.elements;
  const j = i + d;
  if (j < 0 || j >= els.length) return;
  [els[i], els[j]] = [els[j], els[i]];
  emit("template", state.template);
  history.push();
}

function addElement(type) {
  const def = widgets.get(type);
  const c = state.template.canvas;
  const w = def.defaults.w, hh = def.defaults.h;
  const raw = { type, x: Math.round((c.width - w) / 2), y: Math.round((c.height - hh) / 2), w, h: hh, props: { ...def.defaults.props } };
  const el = normalizeTemplate({ canvas: c, elements: [raw] }).elements[0];
  state.template.elements.push(el);
  emit("template", state.template);
  select(el.id);
  history.push();
}

function deleteElement(el) {
  const els = state.template.elements;
  const i = els.indexOf(el);
  if (i < 0) return;
  els.splice(i, 1);
  select(null);
  emit("template", state.template);
  history.push();
}

function duplicateElement(el) {
  const copy = JSON.parse(JSON.stringify(el));
  copy.id = newElementId(el.type);
  copy.name = `${el.name} copy`;
  copy.x += 40;
  copy.y += 40;
  state.template.elements.push(copy);
  emit("template", state.template);
  select(copy.id);
  history.push();
}
