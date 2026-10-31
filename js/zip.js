/* ============================================================
   書き出し用の小道具
   - CRC32
   - PNGへの解像度(pHYs)チャンク埋め込み: クリスタ等で開いたとき
     350dpi(=B5実寸)として扱われるようにする。無いと72dpi扱いになり
     印刷サイズが巨大になる
   - 無圧縮ZIP(STORE): PNGは既に圧縮済みなので再圧縮しない
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** PNGのIHDR直後に pHYs(dpi) を差し込む。既にあれば差し替えずそのまま返す */
export async function pngWithDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const IHDR_END = 8 + 4 + 4 + 13 + 4; // signature + len + type + data + crc
  // 既存チェック(Chromeは通常pHYsを付けない)
  for (let p = 8; p + 8 <= src.length;) {
    const len = (src[p] << 24 | src[p + 1] << 16 | src[p + 2] << 8 | src[p + 3]) >>> 0;
    const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    if (type === 'pHYs') return blob;
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // 単位: メートル
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, IHDR_END), 0);
  out.set(chunk, IHDR_END);
  out.set(src.subarray(IHDR_END), IHDR_END + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

/** files: [{ name, data:Uint8Array }] → ZIP Blob (無圧縮・UTF-8ファイル名) */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8
    lh.setUint16(8, 0, true);      // STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
