/* ============================================================
   Dropbox同期(storage-bridge 経由・無改造で利用)
   - ローカル(IndexedDB)が常に一次ストレージ。Dropboxはバックアップ兼ほかの端末との受け渡し
   - Dropbox上の配置(basePath = /NameBuilder):
       {docId}/doc.json          作品の情報(タイトル・ページの並び)
       {docId}/pages/{pageId}.nbp ページの線データ(独自バイナリ・gzip)
       _deleted/{docId}          削除した作品の目印(ほかの端末に削除を伝える)
     フォルダ名は作品IDなので、名前を変えても移動は要らない
   - 描いたページだけを上げる(ページ単位)。作品ごとに
       doc.sync = { docRev, pageRev:{pageId:rev}, dirtyPages:{pageId:seq}, docDirty:seq, seq }
     を持ち、どこまで上がっているかを覚える。seq は「上げている最中に描き足された」を見分ける番号
   - 競合(同じ作品を両方の端末で変えた): どちらも捨てない。
     Dropbox側の版を「（別端末の版）」として別作品に取り込み、こちらの版で上書きする
   ============================================================ */
import * as db from './db.js?v=13';

const BASE = '/NameBuilder';
const PREFIX = 'namebuilder';
const TOMB_KEY = 'nb_tombstones';   // 削除したがDropboxからまだ消せていない作品ID

let storage = null;
let hooks = null;
let running = null, again = false, timer = 0;
let state = 'off';      // off | idle | syncing | error | offline
let lastError = '';
let phase = '';         // syncing 中の段階: pull(取り込み) | push(アップロード) | delete(削除の反映)
let lastSyncAt = 0;     // 最後に同期が最後まで成功した時刻
const listeners = new Set();

/* ---------------- 公開API ---------------- */

/** hooks: {
 *   openDoc(): 編集中の作品(無ければnull)。編集中の作品は同じオブジェクトを直接書き換える
 *   openStrokes(pageId): 編集中の作品でメモリにある線(無ければnull)
 *   canReplaceOpen(): 編集中の作品をDropboxの版で差し替えてよいか(未保存の変更が無いか)
 *   replacedOpen(docId): 編集中の作品が差し替わった → 開き直す
 *   makeThumb(strokes): サムネイルBlob
 *   changed(): 作品一覧が変わった(一覧を描き直す)
 * } */
export function initCloud(h) {
  hooks = h;
  if (window.__NB_TEST_BRIDGE) {
    storage = window.__NB_TEST_BRIDGE;
  } else if (typeof window.StorageBridge === 'function') {
    storage = new window.StorageBridge({ basePath: BASE, storagePrefix: PREFIX, ui: true, uiTarget: '#dbxMount' });
  } else {
    setState('off');
    return;
  }
  storage.on('connected', () => { setState('idle'); syncNow(); });
  storage.on('disconnected', () => setState('off'));
  storage.on('error', (e) => { console.warn('[sync]', e); });
  setState(storage.isConnected ? 'idle' : 'off');
  if (storage.isConnected) queueMicrotask(() => syncNow());
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setState('offline'));
}

export const available = () => !!storage;
export const connected = () => !!storage?.isConnected;
export function onStatus(fn) { listeners.add(fn); fn(status()); }

/** 一覧などに出す状態 */
export function status() {
  return {
    state, phase, error: lastError, lastSyncAt,
    connected: connected(), available: available(),
  };
}

/** ローカルで作品が変わった。pageIds = 中身が変わったページ、docChanged = タイトルや並びが変わった */
export function noteLocalChange(doc, pageIds = [], docChanged = true) {
  const s = ensureSync(doc);
  s.seq++;
  for (const id of pageIds) s.dirtyPages[id] = s.seq;
  if (docChanged || pageIds.length) s.docDirty = s.seq;
}

/** 複製などで新しく作った作品の同期情報を白紙にする(全ページ未アップロード扱い) */
export function resetSync(doc) {
  delete doc.sync;
  noteLocalChange(doc, doc.pages, true);
}

export function isDirty(doc) {
  const s = doc.sync;
  if (!s || !s.docRev) return true;
  return s.docDirty > 0 || Object.keys(s.dirtyPages).length > 0;
}

/** 作品を削除した。Dropboxに上がっていれば消す(オフラインなら覚えておいて後で消す) */
export function forgetDoc(doc) {
  if (!doc.sync?.docRev) return;
  const t = tombstones();
  if (!t.includes(doc.id)) { t.push(doc.id); saveTombstones(t); }
  syncSoon(500);
}

export function syncSoon(ms = 20000) {
  if (!connected()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), ms);
}

/** 今すぐ同期(取り込み → 上げる)。実行中なら終わった後にもう一度 */
export function syncNow() {
  clearTimeout(timer);
  if (!connected()) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      if (!navigator.onLine) { setState('offline'); break; }
      try {
        setPhase('delete');
        await processTombstones();
        setPhase('pull');
        await pullAll();
        setPhase('push');
        await pushAll();
        lastError = '';
        lastSyncAt = Date.now();
        phase = '';
        setState('idle');
      } catch (e) {
        console.warn('[sync] 失敗', e);
        lastError = String(e?.message || e).slice(0, 300);
        phase = '';
        setState('error');
        break;
      }
    } while (again);
  })().finally(() => { running = null; hooks?.changed?.(); });
  return running;
}

export function connect() { storage?._ui?._onBtnClick ? storage._ui._onBtnClick() : storage?.connect(); }
export function disconnect() { storage?.disconnect(); }

/* ---------------- 内部 ---------------- */
/** 進み具合だけ変える(ランプの「取り込み中/アップロード中」用) */
function setPhase(p) {
  phase = p;
  setState('syncing');
}
/** ローカルで変わった(未同期が増えた)ことをランプに伝える */
export function touch() { setState(state); }
function setState(s) {
  state = s;
  const st = status();
  for (const fn of listeners) { try { fn(st); } catch (_) {} }
}
function ensureSync(doc) {
  if (!doc.sync) doc.sync = { docRev: null, pageRev: {}, dirtyPages: {}, docDirty: 0, seq: 0 };
  return doc.sync;
}
function tombstones() {
  try { return JSON.parse(localStorage.getItem(TOMB_KEY)) || []; } catch (_) { return []; }
}
function saveTombstones(t) { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); }

const isNotFound = (e) => /not_found/.test(String(e?.message || e));

async function getLocalDoc(id) {
  const open = hooks.openDoc();
  if (open && open.id === id) return open;
  return db.getDoc(id);
}

/** Dropbox上の全ファイル: Map(docId → { docRev, pages: Map(pageId → rev) })。
 *  削除の目印(_deleted/{docId})は deleted に集める */
async function listRemote() {
  const base = storage._basePath ?? BASE;
  let entries = [];
  try {
    let d = await storage._apiFetch('files/list_folder', { path: base, recursive: true });
    entries = d.entries;
    while (d.has_more) {
      d = await storage._apiFetch('files/list_folder/continue', { cursor: d.cursor });
      entries = entries.concat(d.entries);
    }
  } catch (e) {
    if (isNotFound(e)) { const m = new Map(); m.deleted = new Set(); return m; }
    throw e;
  }
  const out = new Map();
  out.deleted = new Set();
  for (const en of entries) {
    if (en['.tag'] !== 'file') continue;
    const rel = en.path_display.slice(base.length + 1).split('/');
    if (rel[0] === '_deleted') { if (rel[1]) out.deleted.add(rel[1]); continue; }
    const docId = rel[0];
    if (!out.has(docId)) out.set(docId, { docRev: null, pages: new Map() });
    const r = out.get(docId);
    if (rel.length === 2 && rel[1] === 'doc.json') r.docRev = en.rev;
    else if (rel.length === 3 && rel[1] === 'pages' && rel[2].endsWith('.nbp')) r.pages.set(rel[2].slice(0, -4), en.rev);
  }
  for (const [id, r] of out) if (!r.docRev) out.delete(id); // doc.json が無いものは作品とみなさない
  return out;
}

async function getMetaRev(path) {
  try {
    const m = await storage._apiFetch('files/get_metadata', { path: storage._resolve(path) });
    return m.rev;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function processTombstones() {
  const t = tombstones();
  if (!t.length) return;
  const rest = [];
  for (const id of t) {
    try {
      try { await storage.delete(id); } catch (e) { if (!isNotFound(e)) throw e; }
      await storage.save(`_deleted/${id}`, '');
    } catch (_) { rest.push(id); }
  }
  saveTombstones(rest);
}

/* ---- 取り込み ---- */
async function pullAll() {
  const remote = await listRemote();
  const tomb = new Set(tombstones());
  let changed = false;
  for (const [docId, info] of remote) {
    if (tomb.has(docId)) continue;
    changed = (await pullDoc(docId, info)) || changed;
  }
  // 以前は上がっていたのにDropboxから消えた作品。
  // 削除の目印があれば「ほかの端末で削除された」としてこちらも消す。
  // 目印が無い(フォルダごと消えた・名前が変わった等)ときは、消さずに上げ直す(安全側)
  for (const doc of await db.listDocs()) {
    if (!doc.sync?.docRev || remote.has(doc.id)) continue;
    const open = hooks.openDoc();
    if (remote.deleted.has(doc.id) && !isDirty(doc) && !(open && open.id === doc.id)) {
      await db.deleteDoc(doc.id);
    } else {
      // こちらで変更がある/開いている → 消さずに上げ直す
      const d = await getLocalDoc(doc.id);
      d.sync.docRev = null;
      d.sync.pageRev = {};
      noteLocalChange(d, d.pages, true);
      await db.putDoc(d);
    }
    changed = true;
  }
  if (changed) hooks.changed?.();
}

/** @returns 変化があったか */
async function pullDoc(docId, info) {
  const local = await getLocalDoc(docId);
  if (!local) { await importRemote(docId, info, docId, ''); return true; }
  if (local.sync?.docRev === info.docRev) return false;
  if (!isDirty(local)) return applyRemote(local, info);
  // 競合: Dropbox側の版を別作品として取り込み、こちらの版で上書きする
  const stamp = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await importRemote(docId, info, uid('doc'), `（別端末の版 ${stamp}）`);
  const s = ensureSync(local);
  s.docRev = info.docRev;
  noteLocalChange(local, local.pages, true);
  await db.putDoc(local);
  return true;
}

async function importRemote(srcId, info, newId, suffix) {
  const json = JSON.parse(await storage.load(`${srcId}/doc.json`));
  const same = newId === srcId;
  const doc = {
    id: newId,
    title: (json.title || '無題') + suffix,
    createdAt: json.createdAt || new Date().toISOString(),
    updatedAt: json.updatedAt || new Date().toISOString(),
    w: json.w, h: json.h,
    pages: Array.isArray(json.pages) ? json.pages.slice() : [],
    lastPage: 0,
    sync: { docRev: same ? info.docRev : null, pageRev: {}, dirtyPages: {}, docDirty: 0, seq: 0 },
  };
  if (!doc.pages.length) doc.pages.push(uid('pg'));
  await db.putDoc(doc);
  for (const pid of doc.pages) {
    const rev = info.pages.get(pid);
    const strokes = rev ? await downloadPage(srcId, pid) : [];
    await db.savePages(doc, [[pid, { strokes }]], [[pid, await hooks.makeThumb(strokes)]]);
    if (same && rev) doc.sync.pageRev[pid] = rev;
  }
  if (!same) noteLocalChange(doc, doc.pages, true); // 別作品として上げ直す
  await db.putDoc(doc);
}

async function applyRemote(local, info) {
  const json = JSON.parse(await storage.load(`${local.id}/doc.json`));
  const pages = Array.isArray(json.pages) && json.pages.length ? json.pages : local.pages;
  const fetched = [];
  for (const pid of pages) {
    const rev = info.pages.get(pid);
    if (!rev || rev === local.sync.pageRev[pid]) continue;
    fetched.push([pid, rev, await downloadPage(local.id, pid)]);
  }
  // ダウンロード中に描き始めていたら差し替えない(次の同期で競合として扱う)
  const open = hooks.openDoc();
  const isOpen = open && open.id === local.id;
  if (isOpen && (!hooks.canReplaceOpen() || isDirty(local))) return false;
  for (const [pid, rev, strokes] of fetched) {
    await db.savePages(local, [[pid, { strokes }]], [[pid, await hooks.makeThumb(strokes)]]);
    local.sync.pageRev[pid] = rev;
  }
  for (const pid of local.pages) {
    if (!pages.includes(pid)) { await db.deletePageData(local.id, pid); delete local.sync.pageRev[pid]; }
  }
  for (const pid of pages) {
    if (!info.pages.has(pid) && !local.pages.includes(pid)) {
      await db.savePages(local, [[pid, { strokes: [] }]], [[pid, await hooks.makeThumb([])]]);
    }
  }
  local.title = json.title || local.title;
  local.updatedAt = json.updatedAt || local.updatedAt;
  local.pages = pages.slice();
  local.sync.docRev = info.docRev;
  await db.putDoc(local);
  if (isOpen) hooks.replacedOpen(local.id);
  return true;
}

/* ---- 上げる ---- */
async function pushAll() {
  for (const doc of await db.listDocs()) {
    const d = await getLocalDoc(doc.id);
    if (d && isDirty(d)) await pushDoc(d);
  }
}

async function pushDoc(doc) {
  const s = ensureSync(doc);
  if (s.docRev) {
    const rev = await getMetaRev(`${doc.id}/doc.json`);
    if (rev && rev !== s.docRev) {
      // 最後に取り込んだ後でほかの端末が上げていた → 取り込み(競合処理)を先に
      const remote = await listRemote();
      if (remote.has(doc.id)) await pullDoc(doc.id, remote.get(doc.id));
    } else if (!rev) {
      s.docRev = null;
    }
  }
  if (!s.docRev) {
    // まだ一度も上がっていない(または消えていた) → 全ページ上げる
    s.pageRev = {};
    noteLocalChange(doc, doc.pages, true);
  }
  const snapPages = { ...s.dirtyPages };
  const snapDoc = s.docDirty;
  for (const pid of Object.keys(snapPages)) {
    if (doc.pages.includes(pid)) {
      const strokes = hooks.openStrokes(doc, pid) || (await db.getPage(doc.id, pid))?.strokes || [];
      const res = await storage.save(`${doc.id}/pages/${pid}.nbp`, await encodePage(strokes));
      s.pageRev[pid] = res.rev;
    }
    if (s.dirtyPages[pid] === snapPages[pid]) delete s.dirtyPages[pid];
  }
  const res = await storage.save(`${doc.id}/doc.json`, JSON.stringify(remoteJson(doc)));
  s.docRev = res.rev;
  if (s.docDirty === snapDoc) s.docDirty = 0;
  // 消したページのファイルをDropboxからも消す
  for (const pid of Object.keys(s.pageRev)) {
    if (doc.pages.includes(pid)) continue;
    try { await storage.delete(`${doc.id}/pages/${pid}.nbp`); } catch (e) { if (!isNotFound(e)) continue; }
    delete s.pageRev[pid];
  }
  await db.putDoc(doc);
}

function remoteJson(doc) {
  return {
    format: 'namebuilder', version: 1,
    id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    w: doc.w, h: doc.h, pages: doc.pages,
  };
}

async function downloadPage(docId, pid) {
  try {
    return await decodePage(await storage.loadBinary(`${docId}/pages/${pid}.nbp`));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

function uid(p) {
  return `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* ============================================================
   ページの線データの符号化(Dropbox用)
   'NBP1' | u32 メタJSON長 | メタJSON([[色,太さ,筆圧の効き,濃さ|null,点数], …]) | 0埋め(偶数へ)
   | Int16 x,y(1/8 px 単位) × 点数 | Uint8 筆圧(0..255) × 点数
   これ全体を gzip して 'NBZ1' を前に付ける(CompressionStream が無い環境では生のまま)
   ============================================================ */
const Q = 8;
const MAGIC_RAW = 0x3150424e; // 'NBP1' (little endian)
const MAGIC_GZ = 0x315a424e;  // 'NBZ1'

export async function encodePage(strokes) {
  // 6・7番目(真っ黒になる筆圧・濃さのカーブ)は後から足した。古い版は読み飛ばすだけなので互換
  const meta = strokes.map((s) => {
    const m = [s.c, s.w, s.t, s.o ?? null, s.p.length / 3];
    if (s.of !== undefined || s.og !== undefined) m.push(s.of ?? null, s.og ?? null);
    return m;
  });
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const n = strokes.reduce((a, s) => a + s.p.length / 3, 0);
  const head = 8 + metaBytes.length;
  const pad = head % 2;
  const buf = new ArrayBuffer(head + pad + n * 4 + n);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC_RAW, true);
  dv.setUint32(4, metaBytes.length, true);
  new Uint8Array(buf, 8, metaBytes.length).set(metaBytes);
  const xy = new Int16Array(buf, head + pad, n * 2);
  const pr = new Uint8Array(buf, head + pad + n * 4, n);
  let k = 0;
  for (const s of strokes) {
    const p = s.p;
    for (let i = 0; i < p.length; i += 3, k++) {
      xy[k * 2] = Math.max(-32768, Math.min(32767, Math.round(p[i] * Q)));
      xy[k * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(p[i + 1] * Q)));
      pr[k] = Math.max(0, Math.min(255, Math.round(p[i + 2] * 255)));
    }
  }
  if (typeof CompressionStream === 'function') {
    const gz = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const out = new Uint8Array(4 + gz.byteLength);
    new DataView(out.buffer).setUint32(0, MAGIC_GZ, true);
    out.set(new Uint8Array(gz), 4);
    return new Blob([out], { type: 'application/octet-stream' });
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

export async function decodePage(ab) {
  let buf = ab;
  if (new DataView(buf).getUint32(0, true) === MAGIC_GZ) {
    buf = await new Response(new Blob([buf.slice(4)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC_RAW) throw new Error('ページデータの形式が違う');
  const mlen = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, mlen)));
  const head = 8 + mlen, pad = head % 2;
  const n = meta.reduce((a, m) => a + m[4], 0);
  const xy = new Int16Array(buf, head + pad, n * 2);
  const pr = new Uint8Array(buf, head + pad + n * 4, n);
  const strokes = [];
  let k = 0;
  for (const [c, w, t, o, cnt, of, og] of meta) {
    const p = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++, k++) {
      p[i * 3] = xy[k * 2] / Q;
      p[i * 3 + 1] = xy[k * 2 + 1] / Q;
      p[i * 3 + 2] = pr[k] / 255;
    }
    const st = { c, w, t, p };
    if (o !== null && o !== undefined) st.o = o;
    if (of !== null && of !== undefined) st.of = of;
    if (og !== null && og !== undefined) st.og = og;
    strokes.push(st);
  }
  return strokes;
}
