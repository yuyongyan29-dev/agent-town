import fs from 'node:fs/promises';

const CHUNK = 8 * 1024 * 1024;

/**
 * 只追加的 jsonl 增量读取：记住每个文件的偏移，只交出完整的新行。
 * filter(line) 返回 false 的行不做 JSON.parse（跳过体积大又用不上的记录）。
 */
export class Tailer {
  constructor() {
    this.files = new Map(); // path -> { offset, size, mtimeMs, rest:Buffer }
  }

  known(file) {
    return this.files.has(file);
  }

  async read(file, onRecord, filter) {
    let st;
    try { st = await fs.stat(file); } catch { return false; }
    let f = this.files.get(file);
    if (!f) { f = { offset: 0, size: 0, mtimeMs: 0, rest: Buffer.alloc(0) }; this.files.set(file, f); }
    if (st.size < f.offset) { f.offset = 0; f.rest = Buffer.alloc(0); } // 文件被截断或重写
    if (st.size === f.offset) { f.mtimeMs = st.mtimeMs; return false; }
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - f.offset));
      while (f.offset < st.size) {
        const len = Math.min(buf.length, st.size - f.offset);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        // 按字节切到最后一个换行，避免把多字节字符劈开
        const chunk = buf.subarray(0, bytesRead);
        const lastNl = chunk.lastIndexOf(10);
        if (lastNl === -1) { f.rest = Buffer.concat([f.rest, chunk]); continue; }
        const text = Buffer.concat([f.rest, chunk.subarray(0, lastNl)]).toString('utf8');
        f.rest = Buffer.from(chunk.subarray(lastNl + 1));
        let start = 0;
        while (start < text.length) {
          let nl = text.indexOf('\n', start);
          if (nl === -1) nl = text.length;
          const line = text.slice(start, nl);
          start = nl + 1;
          if (!line || (filter && !filter(line))) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          onRecord(rec);
        }
      }
    } finally {
      await fh.close();
    }
    f.size = st.size;
    f.mtimeMs = st.mtimeMs;
    return true;
  }
}
