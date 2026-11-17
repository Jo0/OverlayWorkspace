// "Official results" dialog: per run, the timing-light time, cones and status,
// typed in or pasted from the results page. Changes apply as you go and are
// kept in this browser per session (results-store.js).

import { STATUSES, cleanResult, countedTime, parseResults, parseTime, resultMark } from "../core/results.js";
import { formatLapTime } from "../core/units.js";
import { $, clear, h } from "./dom.js";
import { saveResults } from "./results-store.js";
import { emit, setStatus, state } from "./state.js";

let dialog = null;

function changed() {
  const s = state.session;
  state.timing.invalidate();
  saveResults(s);
  emit("element", null);
  emit("results-changed");
}

/** Opens the dialog; focusRun scrolls to that run and puts the cursor in its official time. */
export function openResultsDialog({ focusRun = null } = {}) {
  const s = state.session;
  if (!s || !s.laps.length) return;
  dialog = dialog || $("#results-dialog");
  const body = clear($("#results-body"));

  const penalty = h("input", { type: "number", step: 0.5, min: 0, value: s.conePenalty, class: "narrow" });
  penalty.addEventListener("change", () => {
    const v = Number(penalty.value);
    if (!Number.isFinite(v) || v < 0) return;
    s.conePenalty = v;
    changed();
    render();
  });

  const table = h("table", { class: "laps results" });
  const render = () => {
    clear(table);
    table.append(h("thead", {}, h("tr", {},
      h("th", {}, "Run"), h("th", { title: "From the GPS data" }, "GPS"), h("th", { title: "Timing-light time from the results (optional)" }, "Official"),
      h("th", {}, "Cones"), h("th", {}, "Status"), h("th", { title: "Official (or GPS) time plus cones, as it counts for best" }, "Counts as"))));
    const tb = h("tbody");
    // Edits go through the lap each time: an untouched run has no result object.
    const edit = (l, fn) => { fn((l.result = l.result || {})); tidy(l); changed(); render(); };
    for (const l of s.laps) {
      const r = l.result || {};
      const official = h("input", { type: "text", class: "mono narrow", placeholder: "—", value: Number.isFinite(r.official) ? formatLapTime(r.official) : "" });
      official.addEventListener("change", () => {
        const v = parseTime(official.value);
        if (official.value.trim() && !Number.isFinite(v)) setStatus(`"${official.value}" isn't a time. Use 1:08.849 or 68.849.`, "warn");
        edit(l, (res) => { res.official = Number.isFinite(v) && v > 0 ? v : undefined; });
      });
      const cones = h("input", { type: "number", min: 0, step: 1, class: "narrow", value: r.cones || 0 });
      cones.addEventListener("change", () => edit(l, (res) => { res.cones = Math.max(0, Math.round(Number(cones.value) || 0)); }));
      const status = h("select", {}, STATUSES.map((x) => h("option", { value: x.value }, x.label)));
      status.value = r.status || "";
      status.addEventListener("change", () => edit(l, (res) => { res.status = status.value || undefined; }));
      const c = countedTime(l, s.conePenalty);
      tb.append(h("tr", { class: `${l.excluded ? "is-skip" : ""}${l.number === focusRun ? " focus" : ""}`, dataset: { run: l.number } },
        h("td", {}, l.number, l.excluded ? h("span", { class: "muted small" }, " skip") : null),
        h("td", { class: "mono muted" }, formatLapTime(l.duration)),
        h("td", {}, official),
        h("td", {}, cones),
        h("td", {}, status),
        h("td", { class: "mono" }, Number.isFinite(c) ? formatLapTime(c) : resultMark(l) || "—")));
    }
    table.append(tb);
  };

  // Paste: fills runs in order, skipping laps marked Skip (not runs).
  const paste = h("textarea", { rows: 3, placeholder: "e.g. 68.849+1  70.123+OC  69.019  DNF", spellcheck: false, class: "mono" });
  const startSel = h("select", {}, s.laps.filter((l) => !l.excluded).map((l) => h("option", { value: l.number }, `Run ${l.number}`)));
  const preview = h("p", { class: "small" });
  const read = () => {
    const { runs, skipped } = parseResults(paste.value);
    const targets = s.laps.filter((l) => !l.excluded && l.number >= Number(startSel.value));
    return { runs, skipped, targets };
  };
  const showPreview = () => {
    const { runs, skipped, targets } = read();
    if (!paste.value.trim()) { preview.textContent = ""; return; }
    const pairs = runs.slice(0, targets.length).map((x, i) => `Run ${targets[i].number}: ${Number.isFinite(x.official) ? formatLapTime(x.official) : ""}${x.cones ? ` +${x.cones}` : ""}${x.status ? ` ${x.status.toUpperCase()}` : ""}`.trim());
    const extra = runs.length > targets.length ? ` ${runs.length - targets.length} left over (no run for them): check the start run, or a "best" column at the end of the row.` : "";
    const short = runs.length < targets.length ? ` ${targets.length - runs.length} run(s) get nothing.` : "";
    preview.textContent = runs.length ? `${pairs.join(" · ")}.${extra}${short}${skipped.length ? ` Ignored: ${skipped.slice(0, 8).join(" ")}${skipped.length > 8 ? " …" : ""}` : ""}` : "No times found. Times need their decimals (68.849).";
  };
  paste.addEventListener("input", showPreview);
  startSel.addEventListener("change", showPreview);
  const fill = h("button", { class: "primary", onclick: () => {
    const { runs, targets } = read();
    if (!runs.length) return;
    runs.slice(0, targets.length).forEach((x, i) => { targets[i].result = cleanResult(x) || {}; });
    changed();
    render();
    setStatus(`Filled ${Math.min(runs.length, targets.length)} run(s) from the pasted results.`, "ok");
  } }, "Fill in");

  const clearAll = h("button", { onclick: () => {
    if (!confirm("Clear the official times, cones and statuses of every run in this session?")) return;
    for (const l of s.laps) delete l.result;
    changed();
    render();
  } }, "Clear all");

  body.append(
    h("p", { class: "muted small" }, "What the timing sheet says about each run. The run timer shows the raw time with the cones or status beside it (1:08.849 +2); best and comparisons go by the time as it counts. Off course, DNF, DSQ and reruns can't be best and stay out of the theoretical best. Kept in this browser for this session."),
    h("label", { class: "field inline-field" }, h("span", { class: "field-label" }, "Seconds per cone"), penalty),
    h("div", { class: "results-wrap" }, table),
    h("h3", {}, "Paste from the results page"),
    h("p", { class: "muted small" }, "Copy your times from the results (AXware and most others write 68.849+1, 70.123+OC, DNF). A whole row works: names and classes are ignored. Runs marked Skip are passed over."),
    paste,
    h("div", { class: "row-inline" }, h("span", { class: "small" }, "First time goes to"), startSel, fill),
    preview,
    h("div", { class: "dialog-actions" }, clearAll, h("button", { onclick: () => dialog.close() }, "Done")),
  );
  render();
  dialog.showModal();
  const row = focusRun != null && table.querySelector(`tr[data-run="${focusRun}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.querySelector("input").focus();
  }
}

/** Drops an empty result object, so untouched runs stay plain. */
function tidy(lap) {
  const c = cleanResult(lap.result);
  if (c) lap.result = c; else delete lap.result;
}
