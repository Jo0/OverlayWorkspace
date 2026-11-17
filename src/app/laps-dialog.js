// "Start/finish lines": place timing gates on the session's GPS track and find
// laps from them. Click the map to put the start (and, for autocross or a
// stage, the finish); each gate faces the way the car was driving there.
// Wheel zooms, drag pans. The laps found are previewed before applying.

import { DEFAULT_GATE_WIDTH, gateAt, lapsFromGates, sessionTrack } from "../core/laps.js";
import { formatLapTime } from "../core/units.js";
import { $, clear, h } from "./dom.js";
import { saveResults } from "./results-store.js";
import { setSession, setStatus, state } from "./state.js";

export function openLapsDialog() {
  const s = state.session;
  const track = s && sessionTrack(s);
  const dialog = $("#laps-dialog");
  const body = clear($("#laps-body"));
  if (!track) {
    body.append(h("p", {}, "This session has no GPS position, so laps can't be found from lines on the track."),
      h("div", { class: "dialog-actions" }, h("button", { onclick: () => dialog.close() }, "Close")));
    dialog.showModal();
    return;
  }
  const g0 = s.gates || {};
  let gates = { start: g0.start ? { ...g0.start } : null, finish: g0.finish ? { ...g0.finish } : null };
  let circuit = !gates.finish && !!gates.start;
  let placing = gates.start ? (circuit || gates.finish ? null : "finish") : "start";
  let width = (gates.start && gates.start.width) || DEFAULT_GATE_WIDTH;

  // ── Map ──
  const W = 600, H = 380;
  const canvas = h("canvas", { width: W * devicePixelRatio, height: H * devicePixelRatio, class: "laps-map" });
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d");
  const step = Math.max(1, Math.floor(track.times.length / 20000));
  let lat0 = 0, lon0 = 0, n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < track.times.length; i += step) if (Number.isFinite(track.lats[i]) && track.lats[i]) { lat0 += track.lats[i]; lon0 += track.lons[i]; n++; }
  lat0 /= n; lon0 /= n;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 111320;
  const pts = [];
  for (let i = 0; i < track.times.length; i += step) {
    if (!Number.isFinite(track.lats[i]) || !track.lats[i]) { pts.push(null); continue; }
    const x = (track.lons[i] - lon0) * kx, y = (track.lats[i] - lat0) * ky;
    pts.push([x, y]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  let scale = Math.min((W - 40) / (maxX - minX || 1), (H - 40) / (maxY - minY || 1));
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toScreen = (x, y) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale];
  const toWorld = (sx, sy) => [cx + (sx - W / 2) / scale, cy - (sy - H / 2) / scale];
  const css = getComputedStyle(document.documentElement);
  const colors = { track: "rgba(200,210,225,0.55)", start: css.getPropertyValue("--ok").trim() || "#2ed47a", finish: css.getPropertyValue("--err").trim() || "#ff5c5c" };

  const drawGate = (g, color, label) => {
    const x = (g.lon - lon0) * kx, y = (g.lat - lat0) * ky;
    const [sx, sy] = toScreen(x, y);
    const a = (g.heading * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a); // screen y is down
    const half = ((g.width || width) / 2) * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx - dy * half, sy + dx * half);
    ctx.lineTo(sx + dy * half, sy - dx * half);
    ctx.stroke();
    // Arrow: the direction to drive through it.
    const len = Math.max(14, half * 0.8);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + dx * len, sy + dy * len);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx + dx * (len + 6), sy + dy * (len + 6));
    ctx.lineTo(sx + dx * len - dy * 5, sy + dy * len + dx * 5);
    ctx.lineTo(sx + dx * len + dy * 5, sy + dy * len - dx * 5);
    ctx.fill();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(label, sx + 8, sy - 8);
  };
  const draw = () => {
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = colors.track;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      const [sx, sy] = toScreen(p[0], p[1]);
      if (pen) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      pen = true;
    }
    ctx.stroke();
    if (gates.start) drawGate(gates.start, colors.start, circuit ? "Start / finish" : "Start");
    if (gates.finish && !circuit) drawGate(gates.finish, colors.finish, "Finish");
  };

  // Click places a gate; drag pans; wheel zooms.
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.offsetX, y: e.offsetY, cx, cy, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) { cx = drag.cx - dx / scale; cy = drag.cy + dy / scale; draw(); }
  });
  canvas.addEventListener("pointerup", (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || !placing) return;
    const [x, y] = toWorld(e.offsetX, e.offsetY);
    const g = gateAt(track, lat0 + y / ky, lon0 + x / kx, width);
    if (!g) return;
    gates[placing] = { name: placing === "start" ? "Start" : "Finish", ...g };
    placing = placing === "start" && !circuit && !gates.finish ? "finish" : null;
    update();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [wx, wy] = toWorld(e.offsetX, e.offsetY);
    scale *= e.deltaY < 0 ? 1.25 : 0.8;
    cx = wx - (e.offsetX - W / 2) / scale;
    cy = wy + (e.offsetY - H / 2) / scale;
    draw();
  }, { passive: false });

  // ── Controls ──
  const circ = h("input", { type: "checkbox" });
  circ.checked = circuit;
  circ.addEventListener("change", () => { circuit = circ.checked; if (circuit) placing = gates.start ? null : "start"; else if (!gates.finish) placing = "finish"; update(); });
  const widthIn = h("input", { type: "number", min: 2, max: 200, step: 1, value: width, class: "narrow" });
  widthIn.addEventListener("change", () => {
    const v = Number(widthIn.value);
    if (!(v > 0)) return;
    width = v;
    for (const g of [gates.start, gates.finish]) if (g) g.width = v;
    update();
  });
  const placeStart = h("button", { class: "small", onclick: () => { placing = "start"; update(); } }, "Place start");
  const placeFinish = h("button", { class: "small", onclick: () => { placing = "finish"; update(); } }, "Place finish");
  const hint = h("p", { class: "small" });
  const result = h("p", { class: "small" });
  const apply = h("button", { class: "primary" }, "Use these laps");
  let found = [];

  const current = () => ({ start: gates.start, finish: circuit ? null : gates.finish });
  function update() {
    placeFinish.hidden = circuit;
    placeStart.classList.toggle("on", placing === "start");
    placeFinish.classList.toggle("on", placing === "finish");
    hint.textContent = placing === "start" ? (circuit ? "Click the start/finish line on the track." : "Click where the start line is.")
      : placing === "finish" ? "Now click where the finish line is."
      : "Wheel to zoom, drag to pan. Click a Place button to move a line.";
    const g = current();
    found = g.start && (circuit || g.finish) ? lapsFromGates(s, g) : [];
    result.textContent = !g.start || (!circuit && !g.finish) ? ""
      : found.length ? `${found.length} lap${found.length === 1 ? "" : "s"}: ${found.slice(0, 12).map((l) => formatLapTime(l.duration)).join(", ")}${found.length > 12 ? " …" : ""}`
      : "No laps with these lines. Check the arrows point the way you drove, or widen the lines.";
    result.className = found.length ? "small ok-text" : "small warn-text";
    apply.disabled = !found.length;
    draw();
  }

  apply.addEventListener("click", () => {
    const g = current();
    const hadLaps = s.laps.length;
    // Skip ticks and official results go by run number: carry them over.
    const old = new Map(s.laps.map((l) => [l.number, l]));
    for (const l of found) {
      const o = old.get(l.number);
      if (o) { l.excluded = o.excluded; if (o.result) l.result = o.result; }
    }
    s.laps = found;
    s.gates = g;
    s.gatesSet = true;
    saveResults(s);
    setSession(s); // rebuilds timing; Skip ticks and results stay with run numbers
    dialog.close();
    setStatus(`Found ${found.length} laps from the start/finish lines${hadLaps && hadLaps !== found.length ? ` (was ${hadLaps})` : ""}. Saved for this file.`, "ok");
  });

  body.append(
    h("p", { class: "muted small" }, "Laps are timed where the track crosses these lines in the arrow's direction. Autocross and stages: a start and a finish. Circuits: one line. Lines only count within their width, so a course that passes near the start doesn't trigger it."),
    canvas,
    hint,
    h("div", { class: "row-inline" },
      h("label", { class: "field check" }, circ, h("span", {}, "Circuit (start and finish are the same line)")),
      placeStart, placeFinish,
      h("label", { class: "inline-field small" }, h("span", {}, "Line width (m)"), widthIn)),
    result,
    h("div", { class: "dialog-actions" }, h("button", { onclick: () => dialog.close() }, "Cancel"), apply),
  );
  update();
  dialog.showModal();
}
