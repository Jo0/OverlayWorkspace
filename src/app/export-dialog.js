// Export dialog: pick a time range, size and frame rate; writes
// <name>.mp4 (overlay), <name>_alpha.mp4 (matte) and <name>.overlay.json.

import { FPS_PRESETS, exportOverlay, sidecar } from "../export/exporter.js";
import { FileSink, MemorySink, downloadBlob } from "../export/sinks.js";
import { formatLapTime } from "../core/units.js";
import { $, clear, h } from "./dom.js";
import { renderer } from "./stage.js";
import { setStatus, state } from "./state.js";

let dialog, abort = null;

export function initExportDialog() {
  dialog = $("#export-dialog");
  $("#btn-export").addEventListener("click", open);
}

function sanitize(s) {
  return (s || "overlay").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
}

function scopes() {
  const out = [];
  const s = state.session, v = state.video;
  if (v) out.push({ value: "video", label: `Whole video clip (${v.name})` });
  if (s) {
    out.push({ value: "each-lap", label: "Every lap, one file pair each" });
    for (const l of s.laps) out.push({ value: `lap:${l.number}`, label: `Lap ${l.number} (${formatLapTime(l.duration)})` });
    for (const f of s.fragments) out.push({ value: `frag:${f.id}`, label: `Fragment ${f.id} (${((f.end - f.start) / 60).toFixed(1)} min)` });
    out.push({ value: "session", label: "Whole session" });
  }
  return out;
}

/** Ranges to export for a scope: [{ t0, t1, name }]. */
function rangesFor(scope, pre, post) {
  const s = state.session, v = state.video;
  const base = sanitize(v ? v.name : (s && (s.meta.fileName || s.meta.title)) || state.template.name);
  if (scope === "video") return [{ t0: v.clipStart, t1: v.clipStart + v.duration, name: `${base}_overlay` }];
  if (scope === "each-lap") return s.laps.map((l) => ({ t0: l.start - pre, t1: l.end + post, name: `${base}_lap${l.number}_overlay`, lap: l }));
  if (scope.startsWith("lap:")) {
    const l = s.laps.find((x) => `lap:${x.number}` === scope);
    return [{ t0: l.start - pre, t1: l.end + post, name: `${base}_lap${l.number}_overlay`, lap: l }];
  }
  if (scope.startsWith("frag:")) {
    const f = s.fragments.find((x) => `frag:${x.id}` === scope);
    return [{ t0: f.start, t1: f.end, name: `${base}_fragment${f.id}_overlay` }];
  }
  return [{ t0: s.start, t1: s.end, name: `${base}_session_overlay` }];
}

function open() {
  if (!state.template) return;
  if (!state.session && !state.video) {
    setStatus("Load a data file (and optionally a video) first.", "error");
    return;
  }
  const body = clear($("#export-body"));
  const c = state.template.canvas;
  const sizes = [{ value: `${c.width}x${c.height}`, label: `Template canvas ${c.width}×${c.height}` }];
  if (state.video && state.video.width && `${state.video.width}x${state.video.height}` !== sizes[0].value) sizes.push({ value: `${state.video.width}x${state.video.height}`, label: `Video ${state.video.width}×${state.video.height}` });
  for (const [w, hh] of [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [1080, 1920]]) {
    const v = `${w}x${hh}`;
    if (!sizes.some((s) => s.value === v)) sizes.push({ value: v, label: `${w}×${hh}${w < hh ? " (vertical)" : ""}` });
  }

  const scopeSel = h("select", {}, scopes().map((o) => h("option", { value: o.value }, o.label)));
  const pre = h("input", { type: "number", value: 0, step: 0.5, min: 0 });
  const post = h("input", { type: "number", value: 2, step: 0.5, min: 0 });
  const sizeSel = h("select", {}, sizes.map((o) => h("option", { value: o.value }, o.label)));
  const fpsSel = h("select", {}, FPS_PRESETS.map((p, i) => h("option", { value: i }, p.label)));
  fpsSel.value = String(FPS_PRESETS.findIndex((p) => p.label === "59.94"));
  const rate = h("input", { type: "number", value: 24, min: 1, max: 200, step: 1 });
  const setRate = () => { const [w, hh] = sizeSel.value.split("x").map(Number); rate.value = String(Math.max(4, Math.round((w * hh) / (1920 * 1080) * 6))); };
  sizeSel.addEventListener("change", setRate);
  setRate();
  const summary = h("p", { class: "muted small" });
  const lapOpts = h("div", { class: "grid-2" },
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Lead-in (s)"), pre),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Run-out (s)"), post));
  const refresh = () => {
    const sc = scopeSel.value;
    lapOpts.style.display = sc === "each-lap" || sc.startsWith("lap:") ? "" : "none";
    const rs = rangesFor(sc, Number(pre.value) || 0, Number(post.value) || 0);
    const secs = rs.reduce((a, r) => a + (r.t1 - r.t0), 0);
    const fps = FPS_PRESETS[fpsSel.value];
    const frames = Math.round((secs * fps.num) / fps.den);
    const mb = ((Number(rate.value) * 1e6 * secs) / 8 / 1e6) * 1.15;
    summary.textContent = `${rs.length} file pair${rs.length > 1 ? "s" : ""} · ${secs.toFixed(1)} s · ${frames} frames · at most ~${Math.round(mb)} MB per file; overlays are mostly empty, so expect a small fraction of that.`;
  };
  for (const el of [scopeSel, pre, post, fpsSel, rate, sizeSel]) el.addEventListener("input", refresh);
  refresh();

  const progress = h("progress", { max: 1, value: 0, class: "export-progress" });
  const ptext = h("p", { class: "small mono" });
  const canPickFolder = typeof window.showDirectoryPicker === "function";
  const go = h("button", { class: "primary" }, canPickFolder ? "Choose folder & export" : "Export (downloads)");
  const dl = canPickFolder ? h("button", { title: "Save through the browser's downloads instead of writing into a folder" }, "Download files instead") : null;
  const cancel = h("button", { onclick: () => { if (abort) abort.abort(); else dialog.close(); } }, "Cancel");

  /** Asks for an output folder with write access. Returns the handle, or null with a message shown. */
  const pickFolder = async () => {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite", id: "overlay-export" });
    } catch (e) {
      // Embedded browsers (and some setups) report AbortError even when a
      // folder was chosen, so don't fail silently: say what happened.
      ptext.textContent = e.name === "AbortError"
        ? "No folder came back from the folder picker. If you did choose one, this browser doesn't let pages write into folders: use \"Download files instead\", or open the app in Chrome or Edge."
        : `The folder picker failed (${e.name}: ${e.message}). Use "Download files instead", or open the app in Chrome or Edge.`;
      setStatus(ptext.textContent, "warn");
      return null;
    }
    try {
      if (dir.requestPermission && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") {
        ptext.textContent = "Write access to that folder wasn't granted. Pick it again and allow editing, or use \"Download files instead\".";
        setStatus(ptext.textContent, "warn");
        return null;
      }
    } catch (e) {
      ptext.textContent = `Couldn't get write access to the folder (${e.name}: ${e.message}). Use "Download files instead".`;
      setStatus(ptext.textContent, "warn");
      return null;
    }
    return dir;
  };

  go.addEventListener("click", async () => {
    if (!canPickFolder) return run(null);
    ptext.textContent = "Waiting for a folder…";
    const dir = await pickFolder();
    if (dir) run(dir);
  });
  if (dl) dl.addEventListener("click", () => run(null));

  const run = async (dir) => {
    const fps = FPS_PRESETS[fpsSel.value];
    const [width, height] = sizeSel.value.split("x").map(Number);
    const rs = rangesFor(scopeSel.value, Number(pre.value) || 0, Number(post.value) || 0);
    go.disabled = true;
    if (dl) dl.disabled = true;
    ptext.textContent = `Starting${dir ? ` (writing into folder "${dir.name}")` : " (files will download when each is done)"}…`;
    abort = new AbortController();
    try {
      for (let k = 0; k < rs.length; k++) {
        const r = rs[k];
        const files = { color: `${r.name}.mp4`, alpha: `${r.name}_alpha.mp4`, json: `${r.name}.overlay.json` };
        const colorSink = dir ? await FileSink.create(await dir.getFileHandle(files.color, { create: true })) : new MemorySink();
        const alphaSink = dir ? await FileSink.create(await dir.getFileHandle(files.alpha, { create: true })) : new MemorySink();
        const res = await exportOverlay({
          template: state.template, theme: state.theme, session: state.session, timing: state.timing, renderer,
          t0: r.t0, t1: r.t1, fps, width, height, bitrate: Number(rate.value) * 1e6,
          colorSink, alphaSink, signal: abort.signal,
          onProgress: (done, total, info) => {
            progress.value = (k + done / total) / rs.length;
            const eta = (total - done) / Math.max(0.01, info.fps);
            ptext.textContent = `${rs.length > 1 ? `[${k + 1}/${rs.length}] ` : ""}${r.name}: frame ${done}/${total} · ${info.fps.toFixed(1)} fps · ${Math.ceil(eta)} s left`;
          },
        });
        // Name the loaded clip only for a range that's actually in it: a lap
        // from another run would otherwise claim this clip in its JSON.
        const v = state.video;
        const inClip = v && Number.isFinite(v.duration) && r.t0 < v.clipStart + v.duration && r.t1 > v.clipStart;
        const meta = sidecar({ template: state.template, session: state.session, t0: r.t0, t1: r.t1, fps, width, height, video: inClip ? v : null, colorFile: files.color, alphaFile: files.alpha });
        meta.encoder = { codec: res.codec, hardwareAcceleration: res.hardwareAcceleration, seconds: Math.round(res.seconds * 10) / 10 };
        const json = JSON.stringify(meta, null, 2);
        if (dir) {
          const w = await (await dir.getFileHandle(files.json, { create: true })).createWritable();
          await w.write(json);
          await w.close();
        } else {
          downloadBlob(colorSink.blob, files.color);
          downloadBlob(alphaSink.blob, files.alpha);
          downloadBlob(new Blob([json], { type: "application/json" }), files.json);
        }
        ptext.textContent = `Done: ${files.color} + ${files.alpha} (${res.frames} frames in ${res.seconds.toFixed(1)} s, ${res.codec}${res.hardwareAcceleration ? ", " + res.hardwareAcceleration : ""}).`;
      }
      progress.value = 1;
      setStatus(`Exported ${rs.length} overlay${rs.length > 1 ? "s" : ""}.`, "ok");
    } catch (e) {
      console.error(e);
      ptext.textContent = e.name === "AbortError" ? "Cancelled." : `Failed: ${e.message}`;
      setStatus(ptext.textContent, e.name === "AbortError" ? "info" : "error");
    } finally {
      abort = null;
      go.disabled = false;
      if (dl) dl.disabled = false;
    }
  };

  body.append(
    h("label", { class: "field" }, h("span", { class: "field-label" }, "What to export"), scopeSel),
    lapOpts,
    h("div", { class: "grid-2" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Size"), sizeSel),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Frame rate"), fpsSel)),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Bitrate per file (Mbit/s)"), rate),
    summary,
    h("p", { class: "muted small" }, "Keep this tab in front while exporting; browsers slow down background tabs. Gauges don't need the camera's 120 fps: 59.94 looks the same and exports twice as fast."),
    progress, ptext,
    h("div", { class: "dialog-actions" }, cancel, dl, go),
  );
  dialog.showModal();
}
