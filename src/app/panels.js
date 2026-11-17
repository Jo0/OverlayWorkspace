// Left-hand panels: data (session + laps), video (load, flip, sync), layers.

import { CONFIG } from "../config.js";
import { importers, widgets } from "../core/registry.js";
import { groupMembers, makeGroup, moveLayer, newGroupId, normalizeGroups, ungroup } from "../core/arrange.js";
import { newElementId, normalizeTemplate } from "../core/template.js";
import { rawTime, resultMark } from "../core/results.js";
import { formatClock, formatLapTime } from "../core/units.js";
import { importData } from "../importers/index.js";
import { readMp4Info } from "../video/mp4-info.js";
import { readDjiTrack } from "../video/dji-gps.js";
import { readGoProTrack } from "../video/gopro-gps.js";
import { parseNmea } from "../video/nmea.js";
import { matchClockOffset } from "../core/gps-sync.js";
import { $, clear, h, pickFile, pickFiles } from "./dom.js";
import { askCsvMapping } from "./csv-mapping-dialog.js";
import { openLapsDialog } from "./laps-dialog.js";
import { openResultsDialog } from "./results-dialog.js";
import { saveResults } from "./results-store.js";
import { getVideoElement, seekVideoToTime } from "./stage.js";
import { applyComparison, emit, history, on, select, setSelection, setSession, setStatus, setTime, state } from "./state.js";

export function initPanels() {
  buildDataPanel();
  buildVideoPanel();
  buildLayers();
  on("session", () => { buildDataPanel(); buildVideoPanel(); });
  on("comparison-changed", buildDataPanel);
  on("results-changed", buildDataPanel);
  on("open-results", () => { if (state.session && state.session.laps.length) openResultsDialog(); });
  on("template", () => { if (state.session && !state.session.laps.some((l) => l.result)) buildDataPanel(); });
  on("video", buildVideoPanel);
  on("time", updateSyncScrub);
  on("view-lap", (lap) => { focusLapNumber = lap.number; if (state.video) buildVideoPanel(); });
  on("template", buildLayers);
  on("selection", buildLayers);
  on("layers-changed", buildLayers);
  on("delete-element", deleteElement);
  on("duplicate-element", duplicateElement);
  on("group", groupSelection);
  on("ungroup", ungroupSelection);
}

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * Loads one data file, or several files of one session together (RaceChrono
 * splits VBO exports into _start / _resume files). forceMapping re-asks the
 * columns of a generic CSV even when a mapping is remembered.
 */
export async function loadDataFile(fileOrFiles, { forceMapping = false } = {}) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (!files.length) return;
  const names = files.map((f) => f.name).join(", ");
  setStatus(`Reading ${names}…`);
  try {
    const s = await importData(files, { askMapping: (table, guess, file) => askCsvMapping(table, guess, file, { force: forceMapping }) });
    s.sourceFiles = files; // for "Columns…" (re-import with other columns)
    setSession(s);
    if (state.video) autoAlignVideo();
    const lapsNote = s.laps.length ? `${s.laps.length} laps` : "no laps yet (set start/finish lines in the Data panel)";
    setStatus(`Loaded ${names}: ${lapsNote}, ${s.channels.length} channels.`, s.laps.length ? "ok" : "warn");
  } catch (e) {
    if (e.cancelled) { setStatus("Import cancelled."); return; }
    console.error(e);
    setStatus(e.message, "error");
  }
}

function buildDataPanel() {
  const root = clear($("#panel-data"));
  const accept = [...new Set(importers.list().flatMap((i) => i.extensions || []))].join(",");
  root.append(h("div", { class: "panel-head" },
    h("h2", {}, "Data"),
    h("button", { class: "primary", title: "Select several files to load a session that was split across files", onclick: async () => { const fs = await pickFiles(accept); if (fs.length) loadDataFile(fs); } }, "Load data…")));
  const s = state.session;
  if (!s) {
    // What each format is, how to get it, and how well it's been tested.
    root.append(h("ul", { class: "formats" }, importers.list().map((i) => h("li", {},
      h("strong", { class: "small" }, i.label),
      i.help ? h("div", { class: "muted small" }, i.help) : null,
      i.tested ? h("div", { class: `small tested ${i.tested.level}` }, i.tested.text) : null))));
    const issues = CONFIG.sourceUrl ? `${CONFIG.sourceUrl}/issues` : null;
    root.append(h("p", { class: "muted small" }, "A file that doesn't load right, or a format that's missing? ",
      issues ? h("a", { href: issues, target: "_blank", rel: "noopener" }, "Open an issue") : "Report it",
      " with a sample file. It holds your GPS track, so share a short one, or one from somewhere you don't mind showing."));
    return;
  }
  const dur = s.end - s.start;
  root.append(h("div", { class: "summary" },
    h("div", {}, h("strong", {}, s.meta.title || s.meta.fileName || "Session")),
    s.meta.track && s.meta.track !== s.meta.title ? h("div", { class: "muted small" }, s.meta.track) : null,
    h("div", { class: "muted small" }, `${formatClock(s.start, false)} – ${formatClock(s.end, false)} · ${(dur / 60).toFixed(0)} min · ${s.channels.length} channels · ${s.fragments.length} fragment${s.fragments.length === 1 ? "" : "s"}`)));

  if (s.meta.importer === "generic-csv" && s.sourceFiles) {
    root.append(h("div", { class: "row-inline small" }, h("span", { class: "muted" }, "Columns picked by hand."),
      h("button", { class: "small", onclick: () => loadDataFile(s.sourceFiles, { forceMapping: true }) }, "Columns…")));
  }
  if (!s.laps.length) {
    const gps = s.channel("@latitude") && s.channel("@longitude");
    root.append(h("div", { class: "results-prompt strong" },
      h("div", { class: "small" }, h("strong", {}, "No laps in this data. "),
        gps ? "Mark the start and finish lines on the track (or one line for a circuit) and the laps are timed from them."
          : "It has no GPS position either, so laps can't be found from lines on the track."),
      gps ? h("button", { class: "primary small", onclick: openLapsDialog }, "Set start/finish lines…") : null));
    return;
  }
  root.append(resultsPrompt(s));
  const cmp = state.timing.comparisonLap();
  const best = state.timing.bestLap();
  const table = h("table", { class: "laps" },
    h("thead", {}, h("tr", {}, h("th", {}, "Lap"), h("th", {}, "Time"), h("th", { class: "col-frag", title: "Fragment (recording segment)" }, "Frag"), h("th", { title: "Not a run, or leave it out of best and comparison. Cones, OC and DNF go in Official results." }, "Skip"), h("th", { title: "Comparison lap for the delta" }, "Cmp"), h("th", { title: "Official result: cones, off course, DNF. Click to enter." }, "Res"), h("th", {}, ""))));
  const tb = h("tbody");
  for (const l of s.laps) {
    const skip = h("input", { type: "checkbox", title: "Leave out of best lap and comparison" });
    skip.checked = !!l.excluded;
    skip.addEventListener("change", () => { l.excluded = skip.checked; state.timing.invalidate(); saveResults(s); emit("element", null); buildDataPanel(); });
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
      h("td", { class: "mono", title: l.result && Number.isFinite(l.result.official) ? `Official time (GPS ${formatLapTime(l.duration)})` : "GPS time" }, formatLapTime(rawTime(l))),
      h("td", { class: "muted col-frag" }, l.fragment),
      h("td", {}, skip),
      h("td", {}, radio),
      h("td", {}, h("button", {
        class: `result-cell${resultMark(l) ? " has" : l.result ? " has-time" : ""}`,
        title: l.result ? "Edit this run's official result" : "Enter this run's official result (time, cones, OC/DNF)",
        onclick: () => openResultsDialog({ focusRun: l.number }),
      }, resultMark(l) || (l.result ? "✓" : "＋"))),
      h("td", {}, h("button", { class: "small", title: "Jump to 2 s before this lap starts", onclick: () => { setTime(l.start - 2); seekVideoToTime(); emit("view-lap", l); } }, "Go"))));
  }
  table.append(tb);
  const compareTo = (v, label) => h("button", { class: "small", onclick: () => { state.template.timing.comparison = v; applyComparison(); emit("element", null); emit("template", state.template); history.push(); buildDataPanel(); } }, label);
  const mode = state.template.timing.comparison;
  const cmpText = !cmp ? "Comparison: -"
    : cmp.theoretical ? `Comparison: theoretical ${formatLapTime(cmp.duration)} (best of ${cmp.sections.length} sections; ${formatLapTime(best ? best.duration - cmp.duration : NaN)} under the best lap)`
    : `Comparison: lap ${cmp.number}${mode === "best" ? " (session best)" : mode === "theoretical" ? " (session best; theoretical needs 2+ laps)" : ""}`;
  root.append(table, h("div", { class: "row-inline small muted" }, h("span", {}, cmpText)),
    h("div", { class: "row-inline" }, compareTo("best", "Compare to session best"), compareTo("theoretical", "Compare to theoretical")),
    s.channel("@latitude") ? h("div", { class: "row-inline" }, h("button", { class: "small", onclick: openLapsDialog, title: "Find laps from start/finish lines on the track" }, "Start/finish lines…"),
      s.gatesSet ? h("span", { class: "muted small" }, "Laps from your lines") : s.gates ? h("span", { class: "muted small" }, "Laps from the file's lines") : null) : null);
}

/**
 * Where official results start: a prompt with what they do while there are
 * none (prominent for autocross, where every run has a timing sheet), then a
 * one-line summary with an Edit button.
 */
function resultsPrompt(s) {
  const n = s.laps.filter((l) => l.result).length;
  if (n) {
    return h("div", { class: "results-summary row-inline" },
      h("span", { class: "small" }, `Official results: ${n} of ${s.laps.length} runs · ${s.conePenalty} s per cone`),
      h("button", { class: "small", onclick: () => openResultsDialog() }, "Edit…"));
  }
  const autocross = state.template && state.template.sessionType === "autocross";
  return h("div", { class: `results-prompt${autocross ? " strong" : ""}` },
    h("div", { class: "small" }, h("strong", {}, "Official results"),
      ": the timing sheet's times, cones and OC/DNF. The timer then shows them at the finish (1:08.849 +2), and best goes by the time as it counts."),
    h("button", { class: autocross ? "primary small" : "small", onclick: () => openResultsDialog() }, "Enter official results…"));
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

  // DOM append() would print a null as the text "null": drop the absent parts.
  root.append(...[
    h("div", { class: "summary" },
      h("div", {}, h("strong", {}, v.name)),
      h("div", { class: "muted small" }, [v.width ? `${v.width}×${v.height}` : null, v.duration ? `${v.duration.toFixed(1)} s` : null, v.cameraStart != null ? `camera clock ${formatClock(v.cameraStart, false)}` : "no recording time in file"].filter(Boolean).join(" · "))),
    h("label", { class: "field check" }, flip, h("span", {}, "Rotate 180° (upside-down mount)")),
    h("h3", {}, "Sync video and data"),
    v.syncNote ? h("p", { class: "small ok-text" }, `✓ ${v.syncNote}`) : null,
    coverage(v),
    state.session ? h("div", { class: "auto-sync" },
      h("button", { class: "primary small", onclick: () => autoSync(v) }, "Auto-sync from GPS"),
      h("small", { class: "hint" }, "Matches the GPS track the camera recorded (DJI with a GPS remote, or a GoPro with GPS) to the session's track. If the loaded video is a flipped or re-encoded copy, you'll be asked for the original camera file or its .nmea.")) : null,
    state.session && state.session.laps.length ? syncSteps(v) : null,
    h("details", { class: "advanced" },
      h("summary", { class: "small" }, "Or set the offset by number"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Camera clock correction (s)"), corr,
        h("small", { class: "hint" }, "Seconds to add to the camera's clock, e.g. −169.40 if it ran 2:49.40 fast (CameraWorkflow's clock_offset.py prints this per clip).")),
      h("div", { class: "row-inline" }, nudge(-1), nudge(-0.1), nudge(-0.01), nudge(0.01), nudge(0.1), nudge(1))),
    h("button", { class: "small", onclick: () => { if (state.video.url) URL.revokeObjectURL(state.video.url); state.video = null; emit("video", null); buildVideoPanel(); } }, "Remove video"),
  ].filter(Boolean));
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

/**
 * Camera-side GPS fixes from a file: a DJI clip's metadata track, a GoPro
 * clip's GPMF telemetry, or an NMEA log. GoPro adds utcOffset (its GPS time
 * against the camera clock) and device; noFix says the camera recorded GPS
 * but never got a fix (or has no receiver).
 */
async function readCameraGps(file) {
  if (/\.(nmea|txt|log)$/i.test(file.name)) {
    return { name: file.name, fixes: parseNmea(await file.text()), creationTime: null };
  }
  const dji = await readDjiTrack(file);
  if (dji) return { name: file.name, fixes: dji.fixes, creationTime: dji.creationTime };
  const gp = await readGoProTrack(file);
  if (gp) return { name: file.name, fixes: gp.fixes, creationTime: gp.creationTime, utcOffset: gp.utcOffset, device: gp.device, noFix: gp.fixes.length < 20 };
  return null;
}

async function autoSync(v) {
  try {
    setStatus("Reading the camera's GPS track…");
    let sources = [];
    const own = await readCameraGps(v.file).catch(() => null);
    if (own && own.fixes.length >= 20) sources = [own];
    else if (own && own.noFix) {
      setStatus(`${v.name} is from a ${own.device || "GoPro"}, but it has no usable GPS: the camera never got a fix during this clip (it needs open sky and can take a minute after power-on), or the model has no GPS (HERO12 Black, HERO11 Mini, Bones). Use the two steps below.`, "warn");
      return;
    } else {
      setStatus(`${v.name} has no camera GPS track (flipped and re-encoded copies lose it). Pick the ORIGINAL camera file (DJI: its GPS remote's clock rules out matching the wrong run; GoPro: its GPS time does), or select ALL the .nmea files from that day (one .nmea alone can match the wrong run on autocross).`, "warn");
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
    // GoPro GPS carries real UTC, which already says how far off the camera
    // clock is (hours, if it stored local time as UTC): search just around it.
    const utc = sources.map((s) => s.utcOffset).filter(Number.isFinite).sort((a, b) => a - b);
    const center = utc.length ? utc[Math.floor(utc.length / 2)] : null;
    const m = matchClockOffset(state.session, sources.map((s) => s.fixes), center != null ? { center, maxOffset: 30 } : {});
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
    const hh = Math.floor(Math.abs(off) / 3600), mm = Math.floor((Math.abs(off) % 3600) / 60), ss = (Math.abs(off) % 60).toFixed(2).padStart(5, "0");
    const clockOff = hh ? `${hh} h ${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
    const laps = state.session.laps.filter((l) => l.start >= v.clipStart && l.start <= v.clipStart + (v.duration || 0));
    const how = center != null ? `, around where the ${sources[0].device || "GoPro"}'s GPS time put it` : m.usedGpsClock ? ", confirmed by the GPS remote's clock" : "";
    v.syncNote = `Auto-synced from GPS: the camera clock was ${clockOff} ${off < 0 ? "fast" : "slow"} (tracks match within ${err.toFixed(1)} m${how}).`
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
//
// Front-most at the top. A group is one row with its members indented under
// it. Click picks one row (a group row picks the whole group); Shift or
// Ctrl/Cmd-click adds or removes.

const collapsed = new Set(); // group ids folded in the list (view only, not saved)

function buildLayers() {
  const root = clear($("#panel-layers"));
  if (!state.template) return;
  const add = h("select", { class: "add-select" },
    h("option", { value: "" }, "+ Add element…"),
    widgets.list().map((w) => h("option", { value: w.id, title: w.description || "" }, w.label)));
  add.addEventListener("change", () => { if (add.value) addElement(add.value); add.value = ""; });
  root.append(h("div", { class: "panel-head" }, h("h2", {}, "Layers"), add));
  const list = h("ul", { class: "layers" });
  const t = state.template;
  const els = t.elements;
  const sel = new Set(state.selection);
  const pick = (e, ids, single) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const cur = new Set(state.selection);
      const allIn = ids.every((i) => cur.has(i));
      for (const i of ids) allIn ? cur.delete(i) : cur.add(i);
      setSelection([...cur]);
    } else if (single) select(ids[0], { single: true });
    else setSelection(ids);
  };
  const seenGroups = new Set();
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.group && !seenGroups.has(el.group)) {
      seenGroups.add(el.group);
      const gid = el.group;
      const members = groupMembers(t, gid);
      const ids = members.map((m) => m.id);
      const allHidden = members.every((m) => m.hidden), allLocked = members.every((m) => m.locked);
      const open = !collapsed.has(gid);
      const fold = h("button", { class: "icon", title: open ? "Fold" : "Unfold", onclick: (e) => { e.stopPropagation(); open ? collapsed.add(gid) : collapsed.delete(gid); buildLayers(); } }, open ? "▾" : "▸");
      const eye = h("button", { class: "icon", title: allHidden ? "Show group" : "Hide group", onclick: (e) => { e.stopPropagation(); for (const m of members) m.hidden = !allHidden; emit("element", null); history.push(); buildLayers(); } }, allHidden ? "◌" : "●");
      const up = h("button", { class: "icon", title: "Bring group forward", onclick: (e) => { e.stopPropagation(); reorder(el.id, 1, false); } }, "▲");
      const down = h("button", { class: "icon", title: "Send group backward", onclick: (e) => { e.stopPropagation(); reorder(el.id, -1, false); } }, "▼");
      const whole = ids.every((x) => sel.has(x));
      list.append(h("li", { class: `group-row${whole ? " sel" : ""}`, onclick: (e) => pick(e, ids, false) },
        fold, eye, h("span", { class: "layer-name" }, (t.groups[gid] && t.groups[gid].name) || "Group", allLocked ? " 🔒" : ""),
        h("span", { class: "muted small" }, `group · ${members.length}`), up, down));
    }
    if (el.group && collapsed.has(el.group)) continue;
    const eye = h("button", { class: "icon", title: el.hidden ? "Show" : "Hide", onclick: (e) => { e.stopPropagation(); el.hidden = !el.hidden; emit("element", el); history.push(); buildLayers(); } }, el.hidden ? "◌" : "●");
    const up = h("button", { class: "icon", title: "Bring forward", onclick: (e) => { e.stopPropagation(); reorder(el.id, 1, true); } }, "▲");
    const down = h("button", { class: "icon", title: "Send backward", onclick: (e) => { e.stopPropagation(); reorder(el.id, -1, true); } }, "▼");
    list.append(h("li", { class: `${el.group ? "in-group " : ""}${sel.has(el.id) ? "sel" : ""}`, onclick: (e) => pick(e, [el.id], true) },
      eye, h("span", { class: "layer-name" }, el.name, el.locked ? " 🔒" : ""), h("span", { class: "muted small" }, el.type), up, down));
  }
  root.append(list);
  if (state.selection.length > 1 || seenGroups.size) {
    root.append(h("p", { class: "muted small layers-hint" }, "Shift-click to select several. Ctrl+G groups them, Ctrl+Shift+G ungroups. On the stage, a click takes a whole group; Ctrl-click or double-click picks one element in it."));
  }
}

/** Moves a layer one step; `single` moves a grouped element within its group instead of the whole group. */
function reorder(id, dir, single) {
  if (moveLayer(state.template, id, dir, single)) {
    emit("template", state.template);
    history.push();
  }
}

function asList(x) {
  return Array.isArray(x) ? x : x ? [x] : [];
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

function deleteElement(x) {
  const gone = new Set(asList(x).map((e) => e.id));
  if (!gone.size) return;
  const t = state.template;
  t.elements = t.elements.filter((e) => !gone.has(e.id));
  normalizeGroups(t);
  setSelection([]);
  emit("template", t);
  history.push();
}

/** Copies elements on top of the layer list, 40 px down-right. A copied group becomes a new group. */
function duplicateElement(x) {
  const t = state.template;
  const src = asList(x);
  if (!src.length) return;
  const newGroup = new Map();
  const copies = src.map((el) => {
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = newElementId(el.type);
    copy.name = src.length === 1 ? `${el.name} copy` : el.name;
    copy.x += 40;
    copy.y += 40;
    if (el.group) {
      // Only a group copied whole stays a group; a lone member's copy is loose.
      const whole = groupMembers(t, el.group).every((m) => src.includes(m));
      if (whole) {
        if (!newGroup.has(el.group)) {
          const gid = newGroupId();
          t.groups[gid] = { name: `${(t.groups[el.group] && t.groups[el.group].name) || "Group"} copy` };
          newGroup.set(el.group, gid);
        }
        copy.group = newGroup.get(el.group);
      } else delete copy.group;
    }
    return copy;
  });
  t.elements.push(...copies);
  normalizeGroups(t);
  emit("template", t);
  setSelection(copies.map((c) => c.id));
  history.push();
}

function groupSelection(x) {
  const t = state.template;
  const ids = asList(x).map((e) => e.id);
  if (ids.length < 2) {
    setStatus("Select two or more elements to group them (Shift-click or drag a box).", "info");
    return;
  }
  makeGroup(t, ids);
  emit("template", t);
  setSelection(ids);
  history.push();
}

function ungroupSelection(x) {
  const t = state.template;
  const ids = asList(x).map((e) => e.id);
  const freed = ungroup(t, ids);
  if (!freed.length) return;
  emit("template", t);
  setSelection(freed);
  history.push();
}
