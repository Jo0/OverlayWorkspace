// Minimal MP4 (ISO BMFF) writer for one H.264 video track, fed with the
// EncodedVideoChunks that WebCodecs' VideoEncoder produces (avc format).
//
// Layout: ftyp, mdat (64-bit size, patched at the end), moov. One sample per
// chunk, constant frame duration. Writes go to a "sink" (see sinks.js), so
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
    this.avcC = null;
    this.lastTimestamp = -Infinity;
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
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcC) {
      const d = meta.decoderConfig.description;
      this.avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      this.codec = meta.decoderConfig.codec;
    }
    if (chunk.timestamp < this.lastTimestamp) {
      throw new Error("Encoder produced out-of-order frames (B-frames); this writer only supports in-order H.264.");
    }
    this.lastTimestamp = chunk.timestamp;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
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

    const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
    const minf = box("minf", vmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, hdlr, minf);
    const trak = box("trak", tkhd, mdia);
    return box("moov", mvhd, trak);
  }
}
