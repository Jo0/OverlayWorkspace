// Minimal MP4 (ISO BMFF) writer for one H.264 video track, fed with the
// EncodedVideoChunks that WebCodecs' VideoEncoder produces (avc format).
//
// Layout: ftyp, mdat (64-bit size, patched at the end), moov. One sample per
// chunk, constant frame duration. Encoders that use B-frames (Firefox's does)
// hand chunks over in decode order, not display order; that is recorded with
// composition offsets (ctts) plus an edit list, so the first frame shown is
// still at time 0. Writes go to a "sink" (see sinks.js), so
// large files can stream straight to disk.

const enc = new TextEncoder();

function u8(n) { return [n & 0xff]; }
function u16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u64(n) {
  const hi = Math.floor(n / 2 ** 32), lo = n >>> 0;
  return [...u32(hi), ...u32(lo)];
}
function fourcc(s) { return [...enc.encode(s)]; }

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...payload) {
  const body = concat(payload.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));
  return concat([Uint8Array.from([...u32(8 + body.length), ...fourcc(type)]), body]);
}

function fullBox(type, version, flags, ...payload) {
  return box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...payload);
}

// --- avcC (the decoder configuration in the sample description) ---
//
// Browsers hand over an avcC as decoderConfig.description, but Firefox's
// (seen in 160) is malformed: every SPS and PPS in it has its NAL header byte
// written twice, so a strict decoder reads garbage. Firefox also repeats the
// parameter sets inside each keyframe, so the avcC is rebuilt from those when
// they're there, and repaired otherwise. A valid description passes through.

function parseAvcC(b) {
  const lengthSize = (b[4] & 3) + 1;
  const sps = [], pps = [];
  let p = 5;
  const take = (list, count) => {
    for (let i = 0; i < count && p + 2 <= b.length; i++) {
      const len = (b[p] << 8) | b[p + 1];
      p += 2;
      list.push(b.subarray(p, p + len));
      p += len;
    }
  };
  take(sps, b[p++] & 0x1f);
  take(pps, b[p++]);
  return { lengthSize, sps, pps };
}

/** SPS (type 7) and PPS (type 8) NAL units inside a length-prefixed sample. */
function inBandParams(data, lengthSize) {
  const sps = [], pps = [];
  let p = 0;
  while (p + lengthSize <= data.length) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + data[p + k];
    p += lengthSize;
    if (len <= 0 || p + len > data.length) break;
    const type = data[p] & 0x1f;
    if (type === 7) sps.push(data.slice(p, p + len));
    else if (type === 8) pps.push(data.slice(p, p + len));
    p += len;
  }
  return { sps, pps };
}

/** chroma_format_idc and bit depths from an SPS (needed in avcC for High profiles). */
function spsFormat(nal) {
  const rbsp = [];
  for (let i = 1; i < nal.length; i++) {
    if (nal[i] === 3 && rbsp.length >= 2 && rbsp[rbsp.length - 1] === 0 && rbsp[rbsp.length - 2] === 0) continue;
    rbsp.push(nal[i]);
  }
  let bit = 24; // after profile_idc, constraint flags, level_idc
  const read = () => (rbsp[bit >> 3] >> (7 - (bit++ & 7))) & 1;
  const ue = () => {
    let zeros = 0;
    while (read() === 0 && zeros < 32) zeros++;
    let v = 0;
    for (let i = 0; i < zeros; i++) v = v * 2 + read();
    return 2 ** zeros - 1 + v;
  };
  ue(); // seq_parameter_set_id
  const chroma = ue();
  if (chroma === 3) read(); // separate_colour_plane_flag
  return { chroma, depthLuma: ue(), depthChroma: ue() };
}

function buildAvcC(sps, pps, lengthSize) {
  const s = sps[0];
  const out = [1, s[1], s[2], s[3], 0xfc | (lengthSize - 1), 0xe0 | sps.length];
  for (const n of sps) out.push(...u16(n.length), ...n);
  out.push(pps.length);
  for (const n of pps) out.push(...u16(n.length), ...n);
  if ([100, 110, 122, 144].includes(s[1])) {
    const f = spsFormat(s);
    out.push(0xfc | f.chroma, 0xf8 | f.depthLuma, 0xf8 | f.depthChroma, 0);
  }
  return Uint8Array.from(out);
}

export function makeAvcC(description, keySample) {
  const d = parseAvcC(description);
  const inBand = inBandParams(keySample, d.lengthSize);
  if (inBand.sps.length && inBand.pps.length) return buildAvcC(inBand.sps, inBand.pps, d.lengthSize);
  // A real SPS can't start with its header byte twice: that would be profile_idc 0x67.
  const doubled = d.sps.length && d.sps[0].length > 1 && d.sps[0][0] === d.sps[0][1];
  if (doubled && d.pps.length) return buildAvcC(d.sps.map((n) => n.subarray(1)), d.pps.map((n) => n.subarray(1)), d.lengthSize);
  return description;
}

const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
const MP4_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01

export class Mp4Writer {
  /**
   * @param sink  { write(Uint8Array), writeAt(pos, Uint8Array), close() } (all may be async)
   * @param o     { width, height, fps: {num, den}, creationTime (unix seconds, optional) }
   */
  constructor(sink, { width, height, fps, creationTime }) {
    this.sink = sink;
    this.width = width;
    this.height = height;
    // Media timescale/delta so that delta/timescale = den/num exactly.
    const k = Math.max(1, Math.ceil(10000 / fps.num));
    this.timescale = fps.num * k;
    this.delta = fps.den * k;
    this.created = Math.max(0, Math.round((creationTime || Date.now() / 1000) + MP4_EPOCH));
    this.pos = 0;
    this.sizes = [];
    this.offsets = [];
    this.sync = [];
    this.frameIndex = []; // display position (in frames) of each sample, in decode order
    this.frameUs = (fps.den / fps.num) * 1e6;
    this.avcC = null;
  }

  async start() {
    const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"));
    await this._write(ftyp);
    this.mdatPos = this.pos;
    // size = 1 means "64-bit size follows"; filled in by finish().
    await this._write(Uint8Array.from([...u32(1), ...fourcc("mdat"), ...u64(0)]));
  }

  /** Call from the VideoEncoder output callback (in order). */
  async addChunk(chunk, meta) {
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.description) {
      const d = meta.decoderConfig.description;
      this.description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      this.codec = meta.decoderConfig.codec;
    }
    // Timestamps are whole frames (the exporter makes them so); rounding
    // undoes the microsecond rounding of fractional rates like 59.94.
    this.frameIndex.push(Math.round(chunk.timestamp / this.frameUs));
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (!this.avcC && this.description && chunk.type === "key") this.avcC = makeAvcC(this.description, data);
    this.offsets.push(this.pos);
    this.sizes.push(data.length);
    if (chunk.type === "key") this.sync.push(this.sizes.length);
    await this._write(data);
  }

  async finish() {
    if (!this.avcC) throw new Error("No decoder configuration received from the encoder");
    const mdatSize = this.pos - this.mdatPos;
    await this.sink.writeAt(this.mdatPos + 8, Uint8Array.from(u64(mdatSize)));
    await this._write(this._moov());
    await this.sink.close();
  }

  async _write(data) {
    await this.sink.write(data);
    this.pos += data.length;
  }

  _moov() {
    const n = this.sizes.length;
    const mediaDuration = n * this.delta;
    const movieDuration = Math.round((mediaDuration / this.timescale) * 1000);
    const c = this.created;

    const mvhd = fullBox("mvhd", 0, 0, u32(c), u32(c), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
    const tkhd = fullBox("tkhd", 0, 3, u32(c), u32(c), u32(1), u32(0), u32(movieDuration), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(this.width << 16), u32(this.height << 16));
    const mdhd = fullBox("mdhd", 0, 0, u32(c), u32(c), u32(this.timescale), u32(mediaDuration), u16(0x55c4), u16(0));
    const hdlr = fullBox("hdlr", 0, 0, u32(0), fourcc("vide"), new Uint8Array(12), enc.encode("VideoHandler\0"));
    const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));

    const compressor = new Uint8Array(32);
    const avc1 = box(
      "avc1",
      new Uint8Array(6), u16(1), // reserved, data_reference_index
      u16(0), u16(0), new Uint8Array(12), // pre_defined, reserved, pre_defined
      u16(this.width), u16(this.height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1), // 72 dpi, reserved, frame_count
      compressor, u16(0x0018), u16(0xffff),
      box("avcC", this.avcC),
      box("pasp", u32(1), u32(1)),
    );
    const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
    const stts = fullBox("stts", 0, 0, u32(1), u32(n), u32(this.delta));
    // Sample k is decoded at k frames and shown at frameIndex[k]. ctts holds
    // the difference; version 0 can't go negative, so everything is shifted
    // later by `shift` frames and the edit list skips that much.
    // (Loops, not Math.min(...): a long session has too many samples to spread.)
    let first = Infinity;
    for (const f of this.frameIndex) if (f < first) first = f;
    const diff = this.frameIndex.map((f, k) => f - first - k);
    let minDiff = 0;
    for (const d of diff) if (d < minDiff) minDiff = d;
    const reordered = diff.some((d) => d !== 0);
    const shift = -minDiff;
    let ctts = null, edts = null;
    if (reordered) {
      const runs = [];
      for (const d of diff) {
        const v = (d + shift) * this.delta;
        if (runs.length && runs[runs.length - 1][1] === v) runs[runs.length - 1][0]++;
        else runs.push([1, v]);
      }
      // A B-frame pattern changes the offset almost every sample, so build
      // the body directly rather than passing one argument per run.
      const body = new Uint8Array(4 + 8 * runs.length);
      const bv = new DataView(body.buffer);
      bv.setUint32(0, runs.length);
      runs.forEach(([count, v], i) => { bv.setUint32(4 + 8 * i, count); bv.setUint32(8 + 8 * i, v); });
      ctts = fullBox("ctts", 0, 0, body);
    }
    if (shift) {
      // One edit: play the whole track, starting `shift` frames into the media.
      edts = box("edts", fullBox("elst", 0, 0, u32(1), u32(movieDuration), u32(shift * this.delta), u16(1), u16(0)));
    }
    const stss = fullBox("stss", 0, 0, u32(this.sync.length), ...this.sync.map((s) => u32(s)));
    const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1));
    const stszBody = new Uint8Array(12 + 4 * n);
    const dv = new DataView(stszBody.buffer);
    dv.setUint32(0, 0); dv.setUint32(4, 0); dv.setUint32(8, n);
    this.sizes.forEach((s, i) => dv.setUint32(12 + 4 * i, s));
    const stsz = box("stsz", stszBody);
    const big = this.offsets.length && this.offsets[this.offsets.length - 1] > 0xffffffff;
    const coBody = new Uint8Array(8 + (big ? 8 : 4) * n);
    const cv = new DataView(coBody.buffer);
    cv.setUint32(0, 0); cv.setUint32(4, n);
    this.offsets.forEach((o, i) => {
      if (big) { cv.setUint32(8 + 8 * i, Math.floor(o / 2 ** 32)); cv.setUint32(12 + 8 * i, o >>> 0); }
      else cv.setUint32(8 + 4 * i, o);
    });
    const stco = box(big ? "co64" : "stco", coBody);

    const stbl = box("stbl", ...[stsd, stts, ctts, stss, stsc, stsz, stco].filter(Boolean));
    const minf = box("minf", vmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const trak = box("trak", ...[tkhd, edts, mdia].filter(Boolean));
    return box("moov", mvhd, trak);
  }
}
