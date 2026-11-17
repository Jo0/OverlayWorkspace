// Official results per run (autocross): the timing-light time, cones and
// a status (off course, DNF...), entered by hand or pasted from the results
// page. Pure functions, no DOM.
//
// A lap may carry lap.result = { official, cones, status }:
//   official  timing-light time in s (optional; the GPS lap time otherwise)
//   cones     cones hit (each adds the session's cone penalty)
//   status    "" (counts), "oc" (off course), "dnf", "dsq" or "rerun": no time

export const STATUSES = [
  { value: "", label: "Clean / cones" },
  { value: "oc", label: "Off course (OC)" },
  { value: "dnf", label: "Did not finish (DNF)" },
  { value: "dsq", label: "Disqualified (DSQ)" },
  { value: "rerun", label: "Rerun (doesn't count)" },
];
const CODES = { oc: "OC", dnf: "DNF", dsq: "DSQ", rerun: "RERUN" };
export const DEFAULT_CONE_PENALTY = 1;

/** True when the run has a time that counts (not OC, DNF, DSQ or a rerun). */
export function counts(lap) {
  return !(lap && lap.result && lap.result.status);
}

/** The run's raw time: the official timing-light time if entered, else the GPS lap time. */
export function rawTime(lap) {
  if (!lap) return NaN;
  const o = lap.result && lap.result.official;
  return Number.isFinite(o) && o > 0 ? o : lap.duration;
}

/** Raw time plus cone penalties, or NaN if the run doesn't count. */
export function countedTime(lap, penalty = DEFAULT_CONE_PENALTY) {
  if (!lap || !counts(lap)) return NaN;
  const cones = (lap.result && lap.result.cones) || 0;
  return rawTime(lap) + cones * penalty;
}

/** What goes beside the raw time, results-sheet style: "+2", "OC", "DNF"... or "". */
export function resultMark(lap) {
  const r = lap && lap.result;
  if (!r) return "";
  if (r.status) return CODES[r.status] || r.status.toUpperCase();
  return r.cones > 0 ? `+${r.cones}` : "";
}

/** "1:08.849" or "68.849" -> seconds; NaN if it isn't a time. */
export function parseTime(s) {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,4}(?:\.\d+)?)\s*$/.exec(String(s || ""));
  if (!m) return NaN;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

const STATUS_WORDS = { OC: "oc", OFF: "oc", DNF: "dnf", DNS: "dnf", DSQ: "dsq", DQ: "dsq", RRN: "rerun", RERUN: "rerun", RR: "rerun" };

/**
 * Reads runs from text pasted off a results page, in order. Generic: each run
 * is a time with a decimal point ("68.849", "1:08.849"), optionally followed
 * by cones or a status ("+2", "(2)", "+OC", "+DNF"), or a bare status word
 * (DNF, OC, DNS, DSQ, RRN). Anything else (names, car numbers, classes) is
 * skipped, so a whole results row can be pasted. Times without a decimal
 * point are ignored: results always show thousandths, car numbers don't.
 * @returns { runs: [{ official, cones, status }], skipped: [token] }
 */
export function parseResults(text) {
  const runs = [], skipped = [];
  // Split into tokens, keeping "+2", "+ 2", "(2)" attached to the time before.
  const tokens = String(text || "")
    .replace(/\s*\+\s*/g, "+")
    .replace(/\s+\(/g, "(")
    .split(/[\s,;|\t]+/)
    .filter(Boolean);
  for (const tok of tokens) {
    const word = tok.replace(/^\[|\]$/g, "").toUpperCase();
    if (STATUS_WORDS[word]) { runs.push({ official: NaN, cones: 0, status: STATUS_WORDS[word] }); continue; }
    const m = /^\[?-?\]?((?:\d{1,2}:)?\d{1,4}\.\d+)(?:\+(\d+|[A-Za-z]+)|\((\d+)\))?$/.exec(tok);
    if (m) {
      const official = parseTime(m[1]);
      const extra = m[2] || m[3] || "";
      let cones = 0, status = "";
      if (/^\d+$/.test(extra)) cones = Number(extra);
      else if (extra) {
        status = STATUS_WORDS[extra.toUpperCase()];
        if (!status) { skipped.push(tok); continue; }
      }
      runs.push({ official, cones, status });
      continue;
    }
    // A lone "+2" (separated from its time) belongs to the run before.
    const add = /^\+(\d+|[A-Za-z]+)$/.exec(tok);
    if (add && runs.length) {
      const last = runs[runs.length - 1];
      if (/^\d+$/.test(add[1])) last.cones += Number(add[1]);
      else if (STATUS_WORDS[add[1].toUpperCase()]) last.status = STATUS_WORDS[add[1].toUpperCase()];
      continue;
    }
    skipped.push(tok);
  }
  return { runs, skipped };
}

/** A result worth keeping (anything entered), or null. */
export function cleanResult(r) {
  if (!r) return null;
  const out = {};
  if (Number.isFinite(r.official) && r.official > 0) out.official = Math.round(r.official * 1000) / 1000;
  if (r.cones > 0) out.cones = Math.round(r.cones);
  if (r.status) out.status = r.status;
  return Object.keys(out).length ? out : null;
}
