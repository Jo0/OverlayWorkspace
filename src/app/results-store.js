// Keeps a session's per-run notes in this browser: Skip ticks, official
// results (time, cones, status), the cone penalty, and start/finish gates
// you set (laps are found again from them on load). Keyed by the data
// file's name and start time, so loading the same file again brings them back.

import { lapsFromGates } from "../core/laps.js";
import { cleanResult, DEFAULT_CONE_PENALTY } from "../core/results.js";

const PREFIX = "overlayworkspace.results:";

function key(session) {
  return `${PREFIX}${session.meta.fileName || session.meta.title || "session"}|${Math.round(session.start)}`;
}

/** Applies saved notes to a freshly loaded session (call before timing is built). */
export function restoreResults(session) {
  if (!session) return;
  session.conePenalty = DEFAULT_CONE_PENALTY;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key(session)) || "null"); } catch { saved = null; }
  if (!saved) return;
  if (Number.isFinite(saved.conePenalty) && saved.conePenalty >= 0) session.conePenalty = saved.conePenalty;
  if (saved.gates && saved.gates.start) {
    // Gates first: Skip ticks and results below are by lap number.
    const laps = lapsFromGates(session, saved.gates);
    if (laps.length) { session.laps = laps; session.gates = saved.gates; session.gatesSet = true; }
  }
  for (const lap of session.laps) {
    const n = saved.laps && saved.laps[lap.number];
    if (!n) continue;
    if (n.excluded) lap.excluded = true;
    const r = cleanResult(n.result);
    if (r) lap.result = r;
  }
}

/** Saves the session's notes (or clears them when there are none). */
export function saveResults(session) {
  if (!session) return;
  const laps = {};
  for (const lap of session.laps) {
    const r = cleanResult(lap.result);
    if (r || lap.excluded) laps[lap.number] = { ...(lap.excluded ? { excluded: true } : {}), ...(r ? { result: r } : {}) };
  }
  try {
    const gates = session.gatesSet ? session.gates : undefined;
    if (!Object.keys(laps).length && session.conePenalty === DEFAULT_CONE_PENALTY && !gates) localStorage.removeItem(key(session));
    else localStorage.setItem(key(session), JSON.stringify({ conePenalty: session.conePenalty, laps, gates }));
  } catch { /* storage unavailable */ }
}
