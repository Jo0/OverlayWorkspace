// Where exported bytes go. A sink has write(data) (append), writeAt(pos, data)
// (patch already-written bytes) and close().

/** Streams to a file picked with the File System Access API (Chrome, Edge). */
export class FileSink {
  static async create(fileHandle) {
    const s = new FileSink();
    s.writable = await fileHandle.createWritable();
    s.pos = 0;
    return s;
  }
  async write(data) {
    await this.writable.write({ type: "write", position: this.pos, data });
    this.pos += data.length;
  }
  async writeAt(position, data) {
    await this.writable.write({ type: "write", position, data });
  }
  async close() {
    await this.writable.close();
  }
  async abort() {
    try { await this.writable.abort(); } catch { /* already closed */ }
  }
}

/** Keeps everything in memory and hands back a Blob (browsers without the File System Access API). */
export class MemorySink {
  constructor() {
    this.parts = [];
    this.pos = 0;
  }
  write(data) {
    this.parts.push({ pos: this.pos, data });
    this.pos += data.length;
  }
  writeAt(position, data) {
    const part = this.parts.find((p) => position >= p.pos && position + data.length <= p.pos + p.data.length);
    if (!part) throw new Error("MemorySink: patch spans parts");
    part.data.set(data, position - part.pos);
  }
  close() {
    this.blob = new Blob(this.parts.map((p) => p.data), { type: "video/mp4" });
    this.parts = [];
  }
  abort() {
    this.parts = [];
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
