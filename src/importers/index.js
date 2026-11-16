// Data importers, one per lap timer / logger format. Each registers itself;
// importData() picks the one that recognizes the file. See docs/EXTENDING.md.

import { importers } from "../core/registry.js";
import "./racechrono-csv-v3.js";

/** Picks an importer by sniffing the file's first 64 KB, then parses it. */
export async function importData(file) {
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
  const session = await best.parse(file);
  session.meta.importer = best.id;
  return session;
}
