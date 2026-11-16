// GPS track recorded inside DJI Osmo Action clips (from a paired GPS remote
// such as the StartRC ST012). The camera stores one protobuf entry per video
// frame in a "djmd" metadata track; the fix is at entry.4.2.1.{2,3} (lat/lon
// doubles). Ported from CameraWorkflow/dji_gps.py (itself a port of
// martinmht.github.io/dji2racechrono_web), reading the MP4 directly instead
// of through ffmpeg. Only box headers, the moov box and the metadata samples
// are read, never the video data.
//
// Fix times come from the clip's creation_time, i.e. the CAMERA's clock.

const MP4_EPOCH = 2082844800;

async function bytes(file, start, length) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function u64(b, o) { return u32(b, o) * 2 ** 32 + u32(b, o + 4); }
function type4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

/** Iterates boxes in b[start, end): yields { type, start (payload), end, pos }. */
function* boxes(b, start, end) {
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

function child(b, parent, type) {
  for (const x of boxes(b, parent.start, parent.end)) if (x.type === type) return x;
  return null;
}

async function readMoov(file) {
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

/** Byte offset and size of every sample of a trak, from its stbl. */
function sampleTable(b, stbl) {
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

// ── Schemaless protobuf ──────────────────────────────────────────────────────

function varint(buf, pos) {
  let result = 0, mul = 1, b;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80 && pos < buf.length);
  return [result, pos];
}

/** Decodes one message into Map(field number → [values]). Length-delimited
 *  values stay as byte arrays; fixed64 is read as a double. */
function pbDecode(buf) {
  const fields = new Map();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = varint(buf, pos);
    const wire = tag & 7, num = Math.floor(tag / 8);
    let value;
    if (wire === 0) [value, pos] = varint(buf, pos);
    else if (wire === 1) { if (pos + 8 > buf.length) break; value = dv.getFloat64(pos, true); pos += 8; }
    else if (wire === 2) { let n; [n, pos] = varint(buf, pos); value = buf.subarray(pos, pos + n); pos += n; }
    else if (wire === 5) { if (pos + 4 > buf.length) break; value = dv.getFloat32(pos, true); pos += 4; }
    else break;
    if (!fields.has(num)) fields.set(num, []);
    fields.get(num).push(value);
  }
  return fields;
}

function pbMsg(fields, num) {
  const v = fields && fields.get(num);
  return v && v[0] instanceof Uint8Array ? pbDecode(v[0]) : null;
}

/**
 * Reads the GPS track of a DJI clip. Returns null if the file has no DJI
 * metadata track (e.g. a re-encoded or flipped copy), otherwise
 * { creationTime (unix s, camera clock), duration (s), frames, fixes: [{ t, lat, lon }] }.
 */
export async function readDjiTrack(file) {
  const moov = await readMoov(file);
  if (!moov) return null;
  const { b } = moov;
  const mvhd = child(b, moov.box, "mvhd");
  if (!mvhd) return null;
  const v1 = b[mvhd.start] === 1;
  const created = v1 ? u64(b, mvhd.start + 4) : u32(b, mvhd.start + 4);
  const timescale = u32(b, mvhd.start + (v1 ? 20 : 12));
  const dur = v1 ? u64(b, mvhd.start + 24) : u32(b, mvhd.start + 16);

  let table = null;
  for (const trak of boxes(b, moov.box.start, moov.box.end)) {
    if (trak.type !== "trak") continue;
    const stbl = [["mdia"], ["minf"], ["stbl"]].reduce((box, [t]) => box && child(b, box, t), trak);
    const stsd = stbl && child(b, stbl, "stsd");
    if (stsd && type4(b, stsd.start + 12) === "djmd") { table = sampleTable(b, stbl); break; }
  }
  if (!table || !table.sizes.length) return null;

  // Read the metadata samples in contiguous runs and decode them as one
  // stream, exactly as the Python reads the extracted data stream.
  const parts = [];
  let i = 0;
  while (i < table.offsets.length) {
    let j = i, end = table.offsets[i] + table.sizes[i];
    while (j + 1 < table.offsets.length && table.offsets[j + 1] === end && end - table.offsets[i] < 8 * 1024 * 1024) { j++; end += table.sizes[j]; }
    parts.push(await bytes(file, table.offsets[i], end - table.offsets[i]));
    i = j + 1;
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const raw = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { raw.set(p, o); o += p.length; }
  const entries = pbDecode(raw).get(3) || [];

  const creationMs = (created - MP4_EPOCH) * 1000;
  const durationMs = (dur / timescale) * 1000;
  const frameMs = durationMs / Math.max(1, entries.length);
  const pts = [];
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (!(e instanceof Uint8Array)) continue;
    let lat, lon, gpsClock = NaN;
    try {
      const remote = pbMsg(pbDecode(e), 4);
      const coords = remote && pbMsg(remote, 2);
      const info = coords && pbMsg(coords, 1);
      if (!info) continue;
      lat = (info.get(2) || [0])[0];
      lon = (info.get(3) || [0])[0];
      // The remote's own clock, "YYYY-MM-DD hh:mm:ss" at entry.4.2.6.1. Its
      // time zone is unreliable (seen 6 h off) but minutes and seconds are
      // right, which gps-sync uses to tell repeated runs apart.
      const ts = pbMsg(coords, 6);
      const s = ts && ts.get(1) && ts.get(1)[0];
      if (s instanceof Uint8Array) gpsClock = parseClock(new TextDecoder().decode(s));
    } catch {
      continue;
    }
    if (!lat && !lon) continue;
    const last = pts[pts.length - 1];
    if (last && last.lat === lat && last.lon === lon) continue; // ~10 Hz GPS repeated per frame
    pts.push({ time: Math.floor(creationMs + k * frameMs), lat, lon, gpsClock, frameTime: (creationMs + k * frameMs) / 1000 });
  }
  spreadWithinSeconds(pts);
  return {
    creationTime: created - MP4_EPOCH,
    duration: dur / timescale,
    frames: entries.length,
    fixes: pts.map((p) => ({ t: p.time / 1000, lat: p.lat, lon: p.lon, gpsClock: p.gpsClock, frameTime: p.frameTime })),
  };
}

function parseClock(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : NaN;
}

/** Same as dji_gps.py _assign_timestamps: fixes within one wall-clock second are spread evenly across it. */
function spreadWithinSeconds(pts) {
  let g = 0;
  while (g < pts.length) {
    const sec = Math.floor(pts[g].time / 1000);
    let e = g;
    while (e + 1 < pts.length && Math.floor(pts[e + 1].time / 1000) === sec) e++;
    const n = e - g + 1;
    for (let j = 0; j < n; j++) pts[g + j].time = Math.floor(sec * 1000 + (j / n) * 1000);
    g = e + 1;
  }
}
