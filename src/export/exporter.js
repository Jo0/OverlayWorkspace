// Renders a time range of the overlay to two H.264 MP4s with WebCodecs: the
// overlay itself (straight, unpremultiplied colors; black where transparent)
// and a grayscale alpha matte (white = opaque). Every video editor and ffmpeg
// can combine the pair (ffmpeg: alphamerge). A JSON sidecar records exactly
// which session time the first frame shows, for automatic placement.

import { makeFrame } from "../core/frame.js";
import { widgets } from "../core/registry.js";
import { Mp4Writer } from "./mp4-writer.js";

export const FPS_PRESETS = [
  { label: "23.976", num: 24000, den: 1001 },
  { label: "24", num: 24, den: 1 },
  { label: "25", num: 25, den: 1 },
  { label: "29.97", num: 30000, den: 1001 },
  { label: "30", num: 30, den: 1 },
  { label: "50", num: 50, den: 1 },
  { label: "59.94", num: 60000, den: 1001 },
  { label: "60", num: 60, den: 1 },
  { label: "119.88", num: 120000, den: 1001 },
  { label: "120", num: 120, den: 1 },
];

// H.264 levels: [level_idc, max macroblocks/second, max frame size in macroblocks]
const LEVELS = [
  [31, 108000, 3600], [32, 216000, 5120], [40, 245760, 8192], [41, 245760, 8192], [42, 522240, 8704],
  [50, 589824, 22080], [51, 983040, 36864], [52, 2073600, 36864], [60, 4177920, 139264], [61, 8355840, 139264], [62, 16711680, 139264],
];

export function h264Codec(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * fps;
  const lv = LEVELS.find(([, rate, size]) => mbps <= rate && mbs <= size) || LEVELS[LEVELS.length - 1];
  return `avc1.6400${lv[0].toString(16).padStart(2, "0").toUpperCase()}`; // High profile
}

export async function pickEncoderConfig({ width, height, fps, bitrate }) {
  const rate = fps.num / fps.den;
  const base = { codec: h264Codec(width, height, rate), width, height, bitrate, framerate: rate, avc: { format: "avc" }, bitrateMode: "variable", latencyMode: "quality" };
  for (const hw of ["prefer-hardware", "no-preference", "prefer-software"]) {
    const cfg = { ...base, hardwareAcceleration: hw };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config;
    } catch { /* try next */ }
  }
  throw new Error(`This browser can't encode H.264 at ${width}×${height} ${rate.toFixed(2)} fps. Try a lower frame rate or size.`);
}

/** Waits until all elements' widgets have loaded what they need (images, fonts). */
async function prepareTemplate(template) {
  await Promise.all(template.elements.map((el) => {
    const w = widgets.get(el.type);
    return w && w.prepare ? w.prepare(el) : null;
  }));
  if (typeof document !== "undefined" && document.fonts) await document.fonts.ready;
}

/**
 * @param {object} o
 *   template, theme, session, timing, renderer
 *   t0, t1            session time range (unix seconds)
 *   fps               { num, den }
 *   width, height     output size
 *   bitrate           bits/second per file
 *   colorSink, alphaSink   see sinks.js
 *   onProgress(done, total, info)
 *   signal            AbortSignal
 */
export async function exportOverlay(o) {
  const { template, theme, session, timing, renderer, t0, t1, fps, width, height, bitrate, colorSink, alphaSink, onProgress, signal } = o;
  await prepareTemplate(template);
  const config = await pickEncoderConfig({ width, height, fps, bitrate });
  const frameDur = fps.den / fps.num;
  const total = Math.max(1, Math.round((t1 - t0) / frameDur));
  const gop = Math.max(1, Math.round((fps.num / fps.den) * 2));

  const color = new OffscreenCanvas(width, height);
  const cctx = color.getContext("2d", { alpha: true });
  const matte = new OffscreenCanvas(width, height);
  const mctx = matte.getContext("2d", { alpha: true });

  const writers = [
    new Mp4Writer(colorSink, { width, height, fps, creationTime: t0 }),
    new Mp4Writer(alphaSink, { width, height, fps, creationTime: t0 }),
  ];
  for (const w of writers) await w.start();

  let failure = null;
  // Chunks are written in order through a promise chain per file.
  const chains = writers.map(() => Promise.resolve());
  const encoders = writers.map((w, k) => new VideoEncoder({
    output: (chunk, meta) => {
      chains[k] = chains[k].then(() => w.addChunk(chunk, meta)).catch((e) => { failure = failure || e; });
    },
    error: (e) => { failure = failure || e; },
  }));
  for (const e of encoders) e.configure(config);

  const waitQueue = async (e) => {
    while (e.encodeQueueSize > 6 && !failure) {
      await new Promise((r) => {
        const done = () => { e.removeEventListener("dequeue", done); clearTimeout(timer); r(); };
        const timer = setTimeout(done, 50);
        e.addEventListener("dequeue", done);
      });
    }
  };

  const started = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (failure) throw failure;
      const t = t0 + i * frameDur;
      const frame = makeFrame(session, timing, t, renderer.cache);
      renderer.render(cctx, { template, theme, frame, width, height });

      // Alpha matte: white where the overlay is opaque, scaled by its alpha, black elsewhere.
      mctx.globalCompositeOperation = "copy";
      mctx.drawImage(color, 0, 0);
      mctx.globalCompositeOperation = "source-in";
      mctx.fillStyle = "#fff";
      mctx.fillRect(0, 0, width, height);
      mctx.globalCompositeOperation = "destination-over";
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, width, height);
      mctx.globalCompositeOperation = "source-over";

      const timestamp = Math.round(i * frameDur * 1e6);
      const duration = Math.round(frameDur * 1e6);
      const keyFrame = i % gop === 0;
      const fc = new VideoFrame(color, { timestamp, duration, alpha: "discard" });
      const fa = new VideoFrame(matte, { timestamp, duration, alpha: "discard" });
      encoders[0].encode(fc, { keyFrame });
      encoders[1].encode(fa, { keyFrame });
      fc.close();
      fa.close();
      await Promise.all(encoders.map(waitQueue));
      if (onProgress && (i % 5 === 0 || i === total - 1)) {
        const elapsed = (performance.now() - started) / 1000;
        onProgress(i + 1, total, { elapsed, fps: (i + 1) / elapsed });
      }
    }
    await Promise.all(encoders.map((e) => e.flush()));
    await Promise.all(chains);
    if (failure) throw failure;
    for (const w of writers) await w.finish();
  } catch (e) {
    for (const enc of encoders) { try { enc.close(); } catch { /* closed */ } }
    for (const s of [colorSink, alphaSink]) if (s.abort) await s.abort();
    throw e;
  }
  for (const enc of encoders) { try { enc.close(); } catch { /* closed */ } }

  return {
    frames: total,
    codec: config.codec,
    hardwareAcceleration: config.hardwareAcceleration,
    seconds: (performance.now() - started) / 1000,
  };
}

/** The sidecar JSON written next to an export, so other tools can place the overlay exactly. */
export function sidecar({ template, session, t0, t1, fps, width, height, video, colorFile, alphaFile }) {
  return {
    schema: "overlay-export/1",
    generator: "OverlayWorkspace",
    template: template.name,
    session: { title: session.meta.title || "", importer: session.meta.importer || "", fileName: session.meta.fileName || "" },
    start: t0,
    end: t1,
    startISO: new Date(t0 * 1000).toISOString(),
    fps: { num: fps.num, den: fps.den },
    width,
    height,
    files: { overlay: colorFile, alpha: alphaFile },
    alpha: "separate grayscale matte, white = opaque; overlay colors are straight (not premultiplied). Both files are limited-range (TV) H.264: expand the matte to full range before using it as alpha (ffmpeg: scale=in_range=tv:out_range=pc,format=gray).",
    ffmpeg: "ffmpeg -i VIDEO -itsoffset START -i OVERLAY -itsoffset START -i ALPHA -filter_complex \"[2]scale=in_range=tv:out_range=pc,format=gray[a];[1][a]alphamerge[ov];[0][ov]overlay=eof_action=pass\" -c:a copy OUT  (START = video.overlayStartsAt, seconds into the video; overlay exported at the video's frame size)",
    // Where the overlay's first frame lands in the video it was lined up against.
    video: video ? { file: video.name, clipStart: video.clipStart, overlayStartsAt: t0 - video.clipStart } : null,
  };
}
