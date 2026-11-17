// "Which column is what?" for the generic CSV importer. Shows the first rows,
// preselects the importer's guess, and remembers the choice for files with
// the same columns (in this browser), so the next file of that kind loads
// without asking.

import { TIME_KINDS, buildSession, layoutKey } from "../importers/generic-csv.js";
import { $, clear, h } from "./dom.js";

const LS_PREFIX = "overlayworkspace.csvmap:";
const SPEED_UNITS = ["km/h", "mph", "m/s", "kn"];
const DIST_UNITS = ["m", "km", "mi", "ft"];

function remembered(table) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + layoutKey(table)) || "null"); } catch { return null; }
}
function remember(table, map) {
  const { startTime, beacons, ...keep } = map; // per file, not per layout
  try { localStorage.setItem(LS_PREFIX + layoutKey(table), JSON.stringify(keep)); } catch { /* storage unavailable */ }
}

function toLocalInput(unix) {
  if (!Number.isFinite(unix)) return "";
  const d = new Date(unix * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

/**
 * Resolves to a mapping, or null if cancelled. With a remembered mapping for
 * this layout it resolves straight away, unless `force` (Columns… button).
 */
export function askCsvMapping(table, guess, file, { force = false } = {}) {
  const saved = remembered(table);
  if (saved && !force) return Promise.resolve({ ...guess, ...saved, startTime: guess.startTime, beacons: guess.beacons });
  const map = { ...guess, ...(saved || {}) };
  const dialog = $("#csv-dialog");
  const body = clear($("#csv-body"));
  $("#csv-title").textContent = `Columns in ${file ? file.name : "the file"}`;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dialog.close(); resolve(v); };
    dialog.addEventListener("close", () => finish(null), { once: true });

    const cols = [{ value: -1, label: "(none)" }, ...table.headers.map((name, i) => ({ value: i, label: `${name}${table.units && table.units[i] ? ` [${table.units[i]}]` : ""}` }))];
    const colSel = (key) => {
      const s = h("select", {}, cols.map((o) => h("option", { value: o.value }, o.label)));
      s.value = String(map[key]);
      s.addEventListener("change", () => { map[key] = Number(s.value); check(); });
      return s;
    };
    const opt = (key, options) => {
      const s = h("select", {}, options.map((o) => (typeof o === "object" ? h("option", { value: o.value }, o.label) : h("option", { value: o }, o))));
      if (map[key] && !options.some((o) => (typeof o === "object" ? o.value : o) === map[key])) s.append(h("option", { value: map[key] }, map[key]));
      s.value = map[key] || (typeof options[0] === "object" ? options[0].value : options[0]);
      map[key] = s.value;
      s.addEventListener("change", () => { map[key] = s.value; check(); });
      return s;
    };
    const kind = opt("timeKind", Object.entries(TIME_KINDS).map(([value, k]) => ({ value, label: k.label })));
    const start = h("input", { type: "datetime-local", step: 1, value: toLocalInput(map.startTime) });
    start.addEventListener("change", () => { const t = new Date(start.value).getTime() / 1000; if (Number.isFinite(t)) { map.startTime = t; check(); } });
    const startRow = h("label", { class: "field" }, h("span", { class: "field-label" }, "Start of the log (your local time)"), start,
      h("small", { class: "hint" }, "These times don't say when the log started. A guess from the file's date is filled in; set it right if you'll auto-sync video from GPS."));
    const keep = h("input", { type: "checkbox", checked: true });
    const status = h("p", { class: "small" });
    const ok = h("button", { class: "primary" }, "Import");

    const check = () => {
      startRow.hidden = !!(TIME_KINDS[map.timeKind] && TIME_KINDS[map.timeKind].abs);
      try {
        const s = buildSession({ ...table, rows: table.rows }, map, "", map.startTime);
        const dur = s.end - s.start;
        const gps = s.channel("@latitude") && s.channel("@longitude");
        status.className = "small";
        status.textContent = `${table.rows.length.toLocaleString()} rows · ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, "0")} long · starts ${new Date(s.start * 1000).toLocaleString()} · ${s.laps.length} lap${s.laps.length === 1 ? "" : "s"}${gps ? "" : " · no GPS position (map, auto-sync and start/finish lines need it)"}.`;
        ok.disabled = false;
      } catch (e) {
        status.className = "small warn-text";
        status.textContent = e.message;
        ok.disabled = true;
      }
    };

    const preview = h("div", { class: "csv-preview" }, h("table", { class: "laps" },
      h("thead", {}, h("tr", {}, table.headers.map((x) => h("th", {}, x)))),
      h("tbody", {}, table.rows.slice(0, 5).map((r) => h("tr", {}, table.headers.map((_, i) => h("td", { class: "mono" }, r[i] ?? "")))))));

    ok.addEventListener("click", () => {
      if (keep.checked) remember(table, map);
      finish({ ...map });
    });

    body.append(
      h("p", { class: "muted small" }, "This file isn't a format the app knows by name, so say which column is what. The guesses are filled in; every other numeric column comes in as a channel too."),
      preview,
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Time"), colSel("time")),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Time is"), kind)),
      startRow,
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Latitude (degrees)"), colSel("lat")),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Longitude (degrees)"), colSel("lon"))),
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Speed"), colSel("speed")),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Speed unit"), opt("speedUnit", SPEED_UNITS))),
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Distance (optional)"), colSel("distance")),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Distance unit"), opt("distanceUnit", DIST_UNITS))),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Lap number (optional)"), colSel("lap"),
        h("small", { class: "hint" }, map.beacons && map.beacons.length > 1 ? `No lap column needed: the file lists ${map.beacons.length - 1} laps (beacon markers).` : "Without one, set start/finish lines after importing (Data panel).")),
      h("label", { class: "field check" }, keep, h("span", {}, "Remember these columns for files laid out like this")),
      status,
      h("div", { class: "dialog-actions" }, h("button", { onclick: () => finish(null) }, "Cancel"), ok),
    );
    check();
    dialog.showModal();
  });
}
