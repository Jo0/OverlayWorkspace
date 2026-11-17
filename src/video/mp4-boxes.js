// Reading MP4/MOV structure without loading the file: box headers, the moov
// box, a track's sample table, and its samples. Shared by the camera GPS
// readers (DJI, GoPro). Only box headers, moov and the requested samples are
// read, never the video data.

export const MP4_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01

export async function bytes(file, start, length) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

export function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
export function u64(b, o) { return u32(b, o) * 2 ** 32 + u32(b, o + 4); }
export function type4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

/** Iterates boxes in b[start, end): yields { type, start (payload), end, pos }. */
export function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p + hdr, end: p + size, pos: p };
    p += size;
  }
}

export function child(b, parent, type) {
  for (const x of boxes(b, parent.start, parent.end)) if (x.type === type) return x;
  return null;
}

/** Finds and reads the moov box: { b, box } or null. */
export async function readMoov(file) {
  let pos = 0;
  for (let guard = 0; pos + 8 <= file.size && guard < 10000; guard++) {
    const h = await bytes(file, pos, 16);
    let size = u32(h, 0);
    const type = type4(h, 4);
    let hdr = 8;
    if (size === 1) { size = u64(h, 8); hdr = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < hdr) break;
    if (type === "moov") {
      const b = await bytes(file, pos, Math.min(size, 256 * 1024 * 1024));
      return { b, box: { type, start: hdr, end: b.length, pos: 0 } };
    }
    pos += size;
  }
  return null;
}

/** { created (unix s), duration (s) } from moov/mvhd. */
export function movieHeader(b, moov) {
  const mvhd = child(b, moov, "mvhd");
  if (!mvhd) return null;
  const v1 = b[mvhd.start] === 1;
  const created = v1 ? u64(b, mvhd.start + 4) : u32(b, mvhd.start + 4);
  const timescale = u32(b, mvhd.start + (v1 ? 20 : 12));
  const dur = v1 ? u64(b, mvhd.start + 24) : u32(b, mvhd.start + 16);
  return { created: created - MP4_EPOCH, duration: dur / timescale };
}

/**
 * The first track whose sample description is `entryType` (e.g. "djmd",
 * "gpmd"): { stbl, timescale } or null.
 */
export function findTrack(b, moov, entryType) {
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(b, trak, "mdia");
    const minf = mdia && child(b, mdia, "minf");
    const stbl = minf && child(b, minf, "stbl");
    const stsd = stbl && child(b, stbl, "stsd");
    if (!stsd || type4(b, stsd.start + 12) !== entryType) continue;
    const mdhd = child(b, mdia, "mdhd");
    const timescale = mdhd ? u32(b, mdhd.start + (b[mdhd.start] === 1 ? 20 : 12)) : 1;
    return { stbl, timescale };
  }
  return null;
}

/** Byte offset and size of every sample of a trak, from its stbl. */
export function sampleTable(b, stbl) {
  const stsz = child(b, stbl, "stsz");
  const stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco") || child(b, stbl, "co64");
  if (!stsz || !stsc || !stco) return null;
  const fixed = u32(b, stsz.start + 4), count = u32(b, stsz.start + 8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || u32(b, stsz.start + 12 + 4 * i);
  const big = stco.type === "co64";
  const nChunks = u32(b, stco.start + 4);
  const chunkOff = (c) => (big ? u64(b, stco.start + 8 + 8 * c) : u32(b, stco.start + 8 + 4 * c));
  const runs = [];
  const nRuns = u32(b, stsc.start + 4);
  for (let r = 0; r < nRuns; r++) runs.push({ first: u32(b, stsc.start + 8 + 12 * r) - 1, per: u32(b, stsc.start + 12 + 12 * r) });
  const offsets = new Array(count);
  let s = 0;
  for (let r = 0; r < runs.length && s < count; r++) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1].first : nChunks;
    for (let c = runs[r].first; c < lastChunk && s < count; c++) {
      let o = chunkOff(c);
      for (let k = 0; k < runs[r].per && s < count; k++) { offsets[s] = o; o += sizes[s]; s++; }
    }
  }
  return { offsets, sizes };
}

/** Start time and duration (s, on the track's timeline) of each sample, from stts. */
export function sampleTimes(b, stbl, timescale) {
  const stts = child(b, stbl, "stts");
  if (!stts) return null;
  const n = u32(b, stts.start + 4);
  const starts = [], durations = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const count = u32(b, stts.start + 8 + 8 * i), delta = u32(b, stts.start + 12 + 8 * i);
    for (let k = 0; k < count; k++) { starts.push(t / timescale); durations.push(delta / timescale); t += delta; }
  }
  return { starts, durations };
}

/** Reads samples, merging neighbours into one read (up to 8 MB). Returns one Uint8Array per sample. */
export async function readSamples(file, table) {
  const out = new Array(table.offsets.length);
  let i = 0;
  while (i < table.offsets.length) {
    let j = i, end = table.offsets[i] + table.sizes[i];
    while (j + 1 < table.offsets.length && table.offsets[j + 1] === end && end - table.offsets[i] < 8 * 1024 * 1024) { j++; end += table.sizes[j]; }
    const chunk = await bytes(file, table.offsets[i], end - table.offsets[i]);
    let o = 0;
    for (let k = i; k <= j; k++) { out[k] = chunk.subarray(o, o + table.sizes[k]); o += table.sizes[k]; }
    i = j + 1;
  }
  return out;
}
