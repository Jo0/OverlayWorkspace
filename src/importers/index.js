// Data importers, one per lap timer / logger format. Each registers itself;
// importData() picks the one that recognizes the file. See docs/EXTENDING.md.

import { importers } from "../core/registry.js";
import { mergeSessions } from "../core/session.js";
import "./racechrono-csv-v3.js";
import "./vbo.js";
import "./generic-csv.js"; // low-confidence catch-all: any CSV with a header row

/** The importer most sure about `file`, by sniffing its first 64 KB. */
async function pick(file) {
  const head = await file.slice(0, 65536).text();
  const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  let best = null, score = 0;
  for (const imp of importers.list()) {
    let s = 0;
    try { s = imp.detect(head, file) || 0; } catch { s = 0; }
    if (s > 0 && imp.extensions && imp.extensions.includes(ext)) s += 0.01;
    if (s > score) { best = imp; score = s; }
  }
  if (!best) {
    const known = importers.list().map((i) => i.label).join(", ");
    throw new Error(`Couldn't recognize ${file.name}. Supported formats: ${known}.`);
  }
  return best;
}

/**
 * Parses one file, or several files of one session (e.g. RaceChrono's _start
 * and _resume VBO files), into one Session. `ctx` is passed to the importer
 * (the generic CSV importer uses ctx.askMapping to confirm columns).
 */
export async function importData(fileOrFiles, ctx = {}) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  const imps = await Promise.all(files.map(pick));
  const imp = imps[0];
  if (imps.some((x) => x !== imp)) throw new Error(`Those files are in different formats (${[...new Set(imps.map((x) => x.label))].join(", ")}). Load one session's files together.`);
  let session;
  if (files.length === 1) session = await imp.parse(files[0], ctx);
  else if (imp.parseMany) session = await imp.parseMany(files, ctx);
  else session = mergeSessions(await Promise.all(files.map((f) => imp.parse(f, ctx))));
  session.meta.importer = imp.id;
  return session;
}
