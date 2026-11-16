// Reads a video file's recording start time (MP4/MOV moov/mvhd creation_time)
// without loading the file: only box headers and the moov box are read.
// The camera's clock may be off; the app lets you correct the sync.

const MP4_EPOCH = 2082844800;

async function readBytes(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

function u64(dv, o) {
  return dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
}

/** @returns {Promise<{creationTime: number|null, duration: number|null}>} unix seconds / seconds */
export async function readMp4Info(file) {
  let pos = 0;
  const size = file.size;
  for (let guard = 0; pos + 8 <= size && guard < 10000; guard++) {
    const hdr = await readBytes(file, pos, 16);
    let boxSize = hdr.getUint32(0);
    const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
    let headerLen = 8;
    if (boxSize === 1) { boxSize = u64(hdr, 8); headerLen = 16; }
    else if (boxSize === 0) boxSize = size - pos;
    if (boxSize < headerLen) break;
    if (type === "moov") {
      const moov = await readBytes(file, pos + headerLen, Math.min(boxSize - headerLen, 64 * 1024 * 1024));
      return parseMvhd(moov);
    }
    pos += boxSize;
  }
  return { creationTime: null, duration: null };
}

function parseMvhd(dv) {
  let p = 0;
  while (p + 8 <= dv.byteLength) {
    const s = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    if (type === "mvhd") {
      const v = dv.getUint8(p + 8);
      let created, timescale, duration;
      if (v === 1) {
        created = u64(dv, p + 12);
        timescale = dv.getUint32(p + 28);
        duration = u64(dv, p + 32);
      } else {
        created = dv.getUint32(p + 12);
        timescale = dv.getUint32(p + 20);
        duration = dv.getUint32(p + 24);
      }
      return {
        creationTime: created > 0 ? created - MP4_EPOCH : null,
        duration: timescale ? duration / timescale : null,
      };
    }
    if (s < 8) break;
    p += s;
  }
  return { creationTime: null, duration: null };
}
