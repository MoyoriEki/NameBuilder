/* ============================================================
   ネームビルダー 本体
   - ページは 2508×3541(B5・350dpi相当)固定。縦に並べてスクロールする
   - 線はベクター(点列)で持ち、表示用には「ページごとの画像キャッシュ」を
     その時の倍率で焼いて使う(全ページをフル解像度で持つとメモリが持たない)
   - 描画中の線だけは低遅延の重ねキャンバス(#live, desynchronized)に描き、
     ペンを離したらページのキャッシュへ焼き込む
   ============================================================ */
import * as db from './db.js';
import { strokePath, livePath, drawStroke, bbox, bboxHit, hitStroke, eraseSplit, sweep } from './ink.js';
import { pngWithDpi, makeZip } from './zip.js';

const PAGE_W = 2508, PAGE_H = 3541, DPI = 350;
const GAP = 140;                 // ページ間の隙間(page-px)
const PITCH = PAGE_H + GAP;
const TOPBAR = 52;               // 上部バーの高さ(css-px)
const HISTORY_MAX = 200;
const CACHE_BUDGET = 40e6;       // ページキャッシュの総画素数上限
const KEEP_LOADED = 14;          // メモリに保持するページ数の目安
const DESK = '#d9d8d3';
const PEN_THINNING = 0.7;        // 筆圧オン時の効き具合

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => performance.now();
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ---------------- 設定(端末ローカル) ---------------- */
const SETTINGS_KEY = 'nb_settings';
const DEFAULTS = {
  pens: [
    { c: '#1f2328', w: 7, pr: true },
    { c: '#1f2328', w: 16, pr: true },
    { c: '#3b78d8', w: 10, pr: true },
  ],
  tool: 'pen0',
  eraserMode: 'part',
  eraserSize: 40,
  stab: 0.3,
  gamma: 1.0,
  sideEraser: true,
  fingerDraw: false,
  tapUndo: true,
  dockSide: 'left',
};
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) {}
  s = { ...DEFAULTS, ...s };
  if (!Array.isArray(s.pens) || s.pens.length !== 3) s.pens = structuredClone(DEFAULTS.pens);
  return s;
})();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const COLORS = ['#1f2328', '#5b6168', '#9aa0a6', '#3b78d8', '#6fb3ec', '#d64545', '#2f9e5b', '#e08a1e', '#9b59b6', '#ffffff'];

/* ---------------- 要素 ---------------- */
const stage = $('stage');
const viewCv = $('view'), liveCv = $('live');
const viewCtx = viewCv.getContext('2d', { alpha: false });
const liveCtx = liveCv.getContext('2d', { desynchronized: true });

/* ---------------- 編集中の状態 ---------------- */
let E = null; // { doc, pages:Map, undo:[], redo:[], dirty:Set, docDirty, saveTimer, saving }
const caches = new Map(); // pageId -> { canvas, ctx, scale, rev, used }

function newEditorState(doc) {
  return { doc, pages: new Map(), undo: [], redo: [], dirty: new Set(), docDirty: false, saveTimer: 0, saving: null };
}
function pageState(id) {
  let ps = E.pages.get(id);
  if (!ps) { ps = { strokes: null, loading: null, rev: 0 }; E.pages.set(id, ps); }
  return ps;
}
function ensureLoaded(id) {
  const ps = pageState(id);
  if (ps.strokes || ps.loading) return;
  const doc = E.doc;
  ps.loading = db.getPage(doc.id, id).then((rec) => {
    ps.loading = null;
    if (E?.doc !== doc) return;
    if (!ps.strokes) { ps.strokes = rec?.strokes || []; ps.rev++; }
    requestRender();
  }).catch((err) => { ps.loading = null; console.error(err); toast('ページの読み込みに失敗した'); });
}

/* ============================================================
   カメラ(表示位置・倍率)
   world座標: ページ i は x=0..PAGE_W, y=i*PITCH..i*PITCH+PAGE_H
   画面(css-px) = (world - cam) * cam.z
   ============================================================ */
const cam = { x: 0, y: 0, z: 0.2 };
let viewW = 1, viewH = 1, dpr = 1;
let interacting = false, settleTimer = 0;

const pageCount = () => E.doc.pages.length;
const totalH = () => pageCount() * PITCH - GAP;
function fitPageZoom() {
  return Math.min((viewW - 2 * 84) / PAGE_W, (viewH - TOPBAR - 28) / PAGE_H);
}
const zMin = () => fitPageZoom() * 0.25;
const zMax = () => 2.5;

function clampCam() {
  const z = cam.z;
  const vw = viewW / z, vh = viewH / z;
  const mx = 100 / z;
  if (PAGE_W + 2 * mx <= vw) cam.x = (PAGE_W - vw) / 2;
  else cam.x = clamp(cam.x, -mx, PAGE_W + mx - vw);
  const lo = -(TOPBAR + 160) / z, hi = totalH() + 160 / z - vh;
  cam.y = lo > hi ? (lo + hi) / 2 : clamp(cam.y, lo, hi);
}
function zoomAt(sx, sy, factor) {
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z = clamp(cam.z * factor, zMin(), zMax());
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
}
function showPage(i, z = fitPageZoom()) {
  cam.z = z;
  cam.x = PAGE_W / 2 - viewW / 2 / z;
  cam.y = i * PITCH + PAGE_H / 2 - (TOPBAR + (viewH - TOPBAR) / 2) / z;
  clampCam();
  requestRender();
}
function currentPage() {
  const cy = cam.y + (TOPBAR + (viewH - TOPBAR) / 2) / cam.z;
  return clamp(Math.floor((cy + GAP / 2) / PITCH), 0, pageCount() - 1);
}
function pageAt(wx, wy) {
  const i = Math.floor(wy / PITCH);
  if (i < 0 || i >= pageCount()) return null;
  const y = wy - i * PITCH;
  return { i, id: E.doc.pages[i], x: wx, y, top: i * PITCH, inside: wx >= 0 && wx <= PAGE_W && y >= 0 && y <= PAGE_H };
}
function beginInteraction() {
  interacting = true;
  clearTimeout(settleTimer);
}
function endInteractionSoon() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { interacting = false; requestRender(); }, 140);
}

function resize() {
  const prevCenter = E ? { x: cam.x + viewW / 2 / cam.z, y: cam.y + viewH / 2 / cam.z } : null;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  viewW = stage.clientWidth || 1;
  viewH = stage.clientHeight || 1;
  for (const c of [viewCv, liveCv]) {
    c.width = Math.round(viewW * dpr);
    c.height = Math.round(viewH * dpr);
    c.style.width = viewW + 'px';
    c.style.height = viewH + 'px';
  }
  if (E && prevCenter) {
    cam.x = prevCenter.x - viewW / 2 / cam.z;
    cam.y = prevCenter.y - viewH / 2 / cam.z;
    cam.z = clamp(cam.z, zMin(), zMax());
    clampCam();
    requestRender();
  }
}

/* ============================================================
   描画
   ============================================================ */
let renderQueued = false;
function requestRender() {
  if (renderQueued || !E) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function visibleRange() {
  const y0 = cam.y, y1 = cam.y + viewH / cam.z;
  const i0 = Math.max(0, Math.floor(y0 / PITCH));
  const i1 = Math.min(pageCount() - 1, Math.floor(y1 / PITCH));
  return [i0, i1];
}

/** 表示倍率k(device-px / page-px)に対するキャッシュ解像度。1/8刻みで切り上げ、最大は等倍 */
const cacheScaleFor = (k) => clamp(Math.ceil(k * 8) / 8, 1 / 16, 1);

function buildCache(id, ps, scale) {
  let c = caches.get(id);
  const w = Math.ceil(PAGE_W * scale), h = Math.ceil(PAGE_H * scale);
  if (!c || c.canvas.width !== w || c.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    c = { canvas, ctx: canvas.getContext('2d'), scale, rev: -1, used: 0 };
    caches.set(id, c);
  }
  c.scale = scale;
  const ctx = c.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const st of ps.strokes) drawStroke(ctx, st);
  c.rev = ps.rev;
  return c;
}

/** キャッシュの一部(b: page座標の矩形)だけ描き直す。消しゴム用 */
function redrawRegion(c, strokes, b) {
  const ctx = c.ctx;
  const x0 = b[0] - 2, y0 = b[1] - 2, x1 = b[2] + 2, y1 = b[3] + 2;
  ctx.save();
  ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  for (const st of strokes) if (bboxHit(bbox(st), x0, y0, x1, y1)) drawStroke(ctx, st);
  ctx.restore();
}

function render() {
  renderQueued = false;
  if (!E) return;
  const ctx = viewCtx;
  const z = cam.z, k = z * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = DESK;
  ctx.fillRect(0, 0, viewCv.width, viewCv.height);
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const [i0, i1] = visibleRange();
  const want = cacheScaleFor(k);
  const vx0 = cam.x, vx1 = cam.x + viewW / z;
  for (let i = i0; i <= i1; i++) {
    const id = E.doc.pages[i];
    const top = i * PITCH;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 10 * dpr;
    ctx.shadowOffsetY = 2 * dpr;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, top, PAGE_W, PAGE_H);
    ctx.restore();

    // ページ番号(下の余白)
    ctx.fillStyle = '#80868c';
    ctx.font = `${13 / z}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), PAGE_W / 2, top + PAGE_H + GAP / 2);

    const ps = pageState(id);
    if (!ps.strokes) { ensureLoaded(id); continue; }

    let c = caches.get(id);
    const valid = c && c.rev === ps.rev;
    const fits = valid && c.scale >= want - 1e-6 && c.scale <= want * 2 + 1e-6;
    if (!fits && (!interacting || !valid)) c = buildCache(id, ps, want);
    c.used = now();

    if (!interacting && k > c.scale * 1.05) {
      // 等倍を超えて拡大しているときは、見えている範囲の線をベクターのまま直接描く(滲まない)
      const vy0 = cam.y - top, vy1 = vy0 + viewH / z;
      ctx.save();
      ctx.translate(0, top);
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      for (const st of ps.strokes) if (bboxHit(bbox(st), vx0, vy0, vx1, vy1)) drawStroke(ctx, st);
      ctx.restore();
    } else {
      ctx.drawImage(c.canvas, 0, top, PAGE_W, PAGE_H);
    }
  }
  updatePageNo();
  updateZoomPill();
  housekeep(i0, i1);
}

/** 見えていないページのキャッシュとストロークを手放す */
function housekeep(i0, i1) {
  const visible = new Set(E.doc.pages.slice(i0, i1 + 1));
  let total = 0;
  for (const c of caches.values()) total += c.canvas.width * c.canvas.height;
  if (total > CACHE_BUDGET) {
    const order = [...caches.entries()].filter(([id]) => !visible.has(id)).sort((a, b) => a[1].used - b[1].used);
    for (const [id, c] of order) {
      if (total <= CACHE_BUDGET) break;
      total -= c.canvas.width * c.canvas.height;
      c.canvas.width = c.canvas.height = 0;
      caches.delete(id);
    }
  }
  const loaded = [...E.pages.entries()].filter(([, ps]) => ps.strokes);
  if (loaded.length > KEEP_LOADED) {
    const near = (id) => {
      const i = E.doc.pages.indexOf(id);
      return i >= i0 - 3 && i <= i1 + 3;
    };
    for (const [id, ps] of loaded) {
      if (near(id) || E.dirty.has(id) || drawing?.pageId === id) continue;
      ps.strokes = null;
      ps.rev++;
      const c = caches.get(id);
      if (c) { c.canvas.width = c.canvas.height = 0; caches.delete(id); }
    }
  }
}

let shownPageNo = '';
function updatePageNo() {
  const s = `${currentPage() + 1} / ${pageCount()}`;
  if (s !== shownPageNo) { $('pageNo').textContent = s; shownPageNo = s; }
}
let shownZoom = '';
function updateZoomPill() {
  const s = Math.round((cam.z / fitPageZoom()) * 100) + '%';
  if (s !== shownZoom) { $('zoomPill').textContent = s; shownZoom = s; }
}

/* ---------------- 重ねキャンバス(描画中の線・消しゴムの円) ---------------- */
let liveQueued = false;
let cursor = null; // { x, y } 画面座標(消しゴムの円の表示用)
function requestLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(drawLive);
}
function drawLive() {
  liveQueued = false;
  const ctx = liveCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, liveCv.width, liveCv.height);
  const k = cam.z * dpr;
  if (drawing && drawing.pts.length) {
    ctx.setTransform(k, 0, 0, k, -cam.x * k, (drawing.top - cam.y) * k);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PAGE_W, PAGE_H);
    ctx.clip();
    const pts = drawing.pred.length ? drawing.pts.concat(drawing.pred) : drawing.pts;
    ctx.fillStyle = drawing.st.c;
    ctx.fill(livePath(drawing.st, pts, false));
    ctx.restore();
  }
  if (cursor && (erasing || isEraserTool())) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = (settings.eraserSize / 2) * cam.z;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, Math.max(2, r), 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(40,50,60,0.8)';
    ctx.stroke();
  }
}

/* ============================================================
   履歴(undo/redo)
   1操作 = [{ pageId, before:[stroke], after:[stroke] }]
   ストロークは不変オブジェクトとして扱い、配列だけを差し替える
   ============================================================ */
function pushHistory(entries) {
  if (!entries.length) return;
  E.undo.push(entries);
  if (E.undo.length > HISTORY_MAX) E.undo.shift();
  E.redo.length = 0;
  updateUndoUI();
}
function setPageStrokes(pageId, arr) {
  if (!E.doc.pages.includes(pageId)) return false;
  const ps = pageState(pageId);
  ps.strokes = arr;
  ps.rev++;
  markDirty(pageId);
  return true;
}
function undo() {
  if (!E || drawing || erasing) return;
  const ent = E.undo.pop();
  if (!ent) return;
  let jumped = false;
  for (const e of ent) if (setPageStrokes(e.pageId, e.before)) jumped ||= revealPage(e.pageId);
  E.redo.push(ent);
  updateUndoUI();
  requestRender();
  toast('元に戻した');
}
function redo() {
  if (!E || drawing || erasing) return;
  const ent = E.redo.pop();
  if (!ent) return;
  for (const e of ent) if (setPageStrokes(e.pageId, e.after)) revealPage(e.pageId);
  E.undo.push(ent);
  updateUndoUI();
  requestRender();
  toast('やり直した');
}
/** 変更が画面外のページなら、そのページを見せる */
function revealPage(pageId) {
  const i = E.doc.pages.indexOf(pageId);
  const [i0, i1] = visibleRange();
  if (i >= 0 && (i < i0 || i > i1)) { showPage(i, cam.z); return true; }
  return false;
}
function updateUndoUI() {
  $('undoBtn').disabled = !E?.undo.length;
  $('redoBtn').disabled = !E?.redo.length;
}

/* ============================================================
   保存
   ============================================================ */
function markDirty(pageId) {
  E.dirty.add(pageId);
  scheduleSave();
}
function markDocDirty() {
  E.docDirty = true;
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(E.saveTimer);
  E.saveTimer = setTimeout(() => flushSave(), 1200);
}
async function flushSave() {
  if (!E) return;
  const st = E;
  clearTimeout(st.saveTimer);
  if (st.saving) await st.saving;
  if (!st.dirty.size && !st.docDirty) return;
  const ids = [...st.dirty].filter((id) => st.doc.pages.includes(id));
  st.dirty.clear();
  st.docDirty = false;
  st.doc.updatedAt = new Date().toISOString();
  const recs = [], thumbs = [];
  for (const id of ids) {
    const ps = st.pages.get(id);
    if (!ps?.strokes) continue;
    recs.push([id, { strokes: ps.strokes }]);
    thumbs.push([id, await makeThumb(id, ps)]);
  }
  st.saving = db.savePages(st.doc, recs, thumbs)
    .catch((err) => {
      console.error(err);
      for (const id of ids) st.dirty.add(id);
      toast('保存に失敗した（容量不足かも）');
    })
    .finally(() => { st.saving = null; });
  await st.saving;
}

const THUMB_W = 200, THUMB_H = Math.round((THUMB_W * PAGE_H) / PAGE_W);
/** サムネイル。縮小すると細い線が消えかかるので、輪郭を少し太らせて描く */
function makeThumb(id, ps) {
  const cv = document.createElement('canvas');
  cv.width = THUMB_W; cv.height = THUMB_H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  const s = THUMB_W / PAGE_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.lineWidth = 0.7 / s;
  ctx.lineJoin = 'round';
  for (const st of ps.strokes) {
    const path = strokePath(st);
    ctx.fillStyle = ctx.strokeStyle = st.c;
    ctx.fill(path);
    ctx.stroke(path);
  }
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/webp', 0.85));
}

/* ============================================================
   入力
   ============================================================ */
let drawing = null;  // { id, pageId, top, st, pts:[[x,y,p]], pred:[], sm, minD }
let erasing = null;  // { id, before:Map(pageId -> strokes), last:[wx,wy] }
let penSeenAt = -1e9;
const touches = new Map(); // pointerId -> { x, y }
let gest = null;           // { t0, max, moved, start:Map, ref, vel:[] }
let mousePan = null;       // { id, x, y }
let inertia = null;

const isEraserTool = () => settings.tool === 'eraser';
const penIndex = () => Number(settings.tool.replace('pen', '')) || 0;

function toWorld(e) {
  return [cam.x + e.clientX / cam.z, cam.y + e.clientY / cam.z];
}
function pressureOf(e) {
  if (e.pointerType !== 'pen') return 0.5;
  const p = e.pressure > 0 ? e.pressure : 0.02;
  return Math.pow(clamp(p, 0, 1), settings.gamma);
}
function wantsEraser(e) {
  if (e.pointerType === 'pen') {
    if (e.button === 5 || (e.buttons & 32)) return true; // 消しゴム側(テールスイッチ)
    if (settings.sideEraser && (e.button === 2 || (e.buttons & 2))) return true; // サイドボタン
  }
  return isEraserTool();
}

/* ---- 線 ---- */
function startStroke(e) {
  const [wx, wy] = toWorld(e);
  const hit = pageAt(wx, wy);
  if (!hit || !hit.inside) return false;
  const ps = pageState(hit.id);
  if (!ps.strokes) { ensureLoaded(hit.id); return false; }
  const pen = settings.pens[penIndex()];
  drawing = {
    id: e.pointerId,
    pageId: hit.id,
    top: hit.top,
    st: { c: pen.c, w: pen.w, t: pen.pr ? PEN_THINNING : 0 },
    pts: [],
    pred: [],
    sm: null,
    minD: 0.6 / cam.z,
    cx: e.clientX,
    cy: e.clientY,
  };
  addPoint(wx, wy - hit.top, pressureOf(e));
  requestLive();
  return true;
}
function smoothStep(sm, x, y, p) {
  const k = settings.stab;
  if (!sm) return [x, y, p];
  return [sm[0] + (x - sm[0]) * (1 - k), sm[1] + (y - sm[1]) * (1 - k), sm[2] + (p - sm[2]) * (1 - k * 0.5)];
}
function addPoint(x, y, p) {
  const d = drawing;
  d.sm = smoothStep(d.sm, x, y, p);
  const last = d.pts[d.pts.length - 1];
  if (!last || Math.hypot(d.sm[0] - last[0], d.sm[1] - last[1]) >= d.minD) d.pts.push(d.sm.slice());
  else if (d.sm[2] > last[2]) last[2] = d.sm[2];
}
function moveStroke(e) {
  drawing.cx = e.clientX; drawing.cy = e.clientY;
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const [wx, wy] = toWorld(ev);
    addPoint(wx, wy - drawing.top, pressureOf(ev));
  }
  // 予測点(表示のみ・保存しない)で体感遅延を詰める
  drawing.pred = [];
  const preds = e.getPredictedEvents?.() || [];
  let sm = drawing.sm;
  for (const ev of preds.slice(0, 3)) {
    const [wx, wy] = toWorld(ev);
    sm = smoothStep(sm, wx, wy - drawing.top, pressureOf(ev));
    drawing.pred.push(sm.slice());
  }
  requestLive();
}
function endStroke(e) {
  const d = drawing;
  drawing = null;
  if (e && e.type === 'pointerup') {
    // 手ブレ補正の遅れ分を詰めるため、最後に実座標を1点足す(筆圧は直前の値)
    const [wx, wy] = toWorld(e);
    const last = d.pts[d.pts.length - 1];
    const x = wx, y = wy - d.top;
    if (last && Math.hypot(x - last[0], y - last[1]) >= d.minD) d.pts.push([x, y, last[2]]);
  }
  requestLive();
  if (!d.pts.length) return;
  const flat = new Float32Array(d.pts.length * 3);
  d.pts.forEach((q, i) => { flat[i * 3] = q[0]; flat[i * 3 + 1] = q[1]; flat[i * 3 + 2] = q[2]; });
  const st = { ...d.st, p: flat };
  const ps = pageState(d.pageId);
  if (!ps.strokes) return; // 念のため(描いている間は手放さない)
  const before = ps.strokes;
  const after = before.concat([st]);
  ps.strokes = after;
  ps.rev++;
  const c = caches.get(d.pageId);
  if (c && c.rev === ps.rev - 1) {
    c.ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
    drawStroke(c.ctx, st);
    c.rev = ps.rev;
  }
  pushHistory([{ pageId: d.pageId, before, after }]);
  markDirty(d.pageId);
  requestRender();
}
function cancelStroke() {
  drawing = null;
  requestLive();
}

/* ---- 消しゴム ---- */
function startErase(e) {
  erasing = { id: e.pointerId, before: new Map(), last: null, cx: e.clientX, cy: e.clientY };
  moveErase(e);
}
function moveErase(e) {
  erasing.cx = e.clientX; erasing.cy = e.clientY;
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const [wx, wy] = toWorld(ev);
    const r = settings.eraserSize / 2;
    const samples = erasing.last ? sweep(erasing.last[0], erasing.last[1], wx, wy, r) : [[wx, wy]];
    for (const [x, y] of samples) eraseAt(x, y, r);
    erasing.last = [wx, wy];
  }
  cursor = { x: e.clientX, y: e.clientY };
  requestLive();
}
function eraseAt(wx, wy, r) {
  const hit = pageAt(wx, wy);
  if (!hit) return;
  const ps = pageState(hit.id);
  if (!ps.strokes) return;
  const x = wx, y = hit.y;
  const part = settings.eraserMode === 'part';
  let changed = false;
  let region = null;
  const out = [];
  for (const st of ps.strokes) {
    if (part) {
      const res = eraseSplit(st, x, y, r);
      if (res === null) { out.push(st); continue; }
      out.push(...res);
    } else {
      if (!hitStroke(st, x, y, r)) { out.push(st); continue; }
    }
    changed = true;
    const b = bbox(st);
    region = region ? [Math.min(region[0], b[0]), Math.min(region[1], b[1]), Math.max(region[2], b[2]), Math.max(region[3], b[3])] : b.slice();
  }
  if (!changed) return;
  if (!erasing.before.has(hit.id)) erasing.before.set(hit.id, ps.strokes);
  ps.strokes = out;
  ps.rev++;
  const c = caches.get(hit.id);
  if (c && c.rev === ps.rev - 1) {
    redrawRegion(c, out, region);
    c.rev = ps.rev;
  }
  markDirty(hit.id);
  requestRender();
}
function endErase() {
  const er = erasing;
  erasing = null;
  const entries = [...er.before].map(([pageId, before]) => ({ pageId, before, after: pageState(pageId).strokes }));
  pushHistory(entries);
  requestLive();
}

/* ---- 指(スクロール・ズーム・タップでundo) ---- */
function touchInfo() {
  let cx = 0, cy = 0;
  const pts = [...touches.values()];
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  if (pts.length >= 2) d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  return { n: pts.length, cx, cy, d };
}
function touchDown(e) {
  stopInertia();
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gest) gest = { t0: now(), max: 0, moved: false, start: new Map(), ref: null, vel: [] };
  gest.start.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gest.max = Math.max(gest.max, touches.size);
  gest.ref = touchInfo();
  beginInteraction();
}
function touchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t || !gest) return;
  t.x = e.clientX; t.y = e.clientY;
  const s = gest.start.get(e.pointerId);
  if (s && Math.hypot(t.x - s.x, t.y - s.y) > 12) gest.moved = true;
  const cur = touchInfo();
  const ref = gest.ref;
  if (ref && ref.n === cur.n) {
    if (cur.n >= 2 && ref.d > 0 && cur.d > 0) zoomAt(cur.cx, cur.cy, cur.d / ref.d);
    cam.x -= (cur.cx - ref.cx) / cam.z;
    cam.y -= (cur.cy - ref.cy) / cam.z;
    clampCam();
    if (cur.n === 1) {
      gest.vel.push({ t: now(), x: cur.cx, y: cur.cy });
      if (gest.vel.length > 8) gest.vel.shift();
    }
    requestRender();
  }
  gest.ref = cur;
}
function touchUp(e) {
  if (!touches.delete(e.pointerId) || !gest) return;
  if (touches.size) { gest.ref = touchInfo(); gest.vel = []; return; }
  const g = gest;
  gest = null;
  const quick = now() - g.t0 < 350;
  if (!g.moved && quick && settings.tapUndo && e.type === 'pointerup') {
    if (g.max === 2) undo();
    else if (g.max >= 3) redo();
  } else if (g.max === 1 && g.vel.length >= 2) {
    const a = g.vel[0], b = g.vel[g.vel.length - 1];
    const dt = b.t - a.t;
    if (dt > 0 && now() - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
  }
  if (!inertia) endInteractionSoon();
}
function startInertia(vx, vy) {
  if (Math.hypot(vx, vy) < 0.3) return;
  let last = now();
  inertia = { vx, vy };
  const step = () => {
    if (!inertia) return;
    const t = now(), dt = Math.min(40, t - last);
    last = t;
    cam.x -= (inertia.vx * dt) / cam.z;
    cam.y -= (inertia.vy * dt) / cam.z;
    clampCam();
    const f = Math.pow(0.95, dt / 16);
    inertia.vx *= f; inertia.vy *= f;
    requestRender();
    if (Math.hypot(inertia.vx, inertia.vy) < 0.03) { inertia = null; endInteractionSoon(); return; }
    requestAnimationFrame(step);
  };
  beginInteraction();
  requestAnimationFrame(step);
}
function stopInertia() {
  if (inertia) { inertia = null; endInteractionSoon(); }
}
function cancelGesture() {
  touches.clear();
  gest = null;
  stopInertia();
  endInteractionSoon();
}

/* ---- ポインタの振り分け ---- */
function capture(id) {
  try { stage.setPointerCapture(id); } catch (_) { /* 合成イベント等で対象ポインタが無い */ }
}
stage.addEventListener('pointerdown', (e) => {
  if (!E) return;
  const pen = e.pointerType === 'pen';
  if (pen) {
    penSeenAt = now();
    if (touches.size) cancelGesture(); // ペンが来たら掌によるスクロールを打ち切る
  }
  if (e.pointerType === 'touch') {
    // 指で描いている途中に2本目の指が来たら、描きかけを捨ててジェスチャへ切り替える
    const fing = drawing?.finger ? drawing : erasing?.finger ? erasing : null;
    if (fing) {
      if (drawing) cancelStroke(); else endErase();
      touchDown({ pointerId: fing.id, clientX: fing.cx, clientY: fing.cy });
      capture(e.pointerId);
      touchDown(e);
      return;
    }
    // ペンを使っている最中・直後の指は掌とみなして無視
    if (drawing || erasing || now() - penSeenAt < 400) return;
    if (settings.fingerDraw && !touches.size && !gest) {
      capture(e.pointerId);
      if (startTool(e)) { if (drawing) drawing.finger = true; if (erasing) erasing.finger = true; return; }
    }
    capture(e.pointerId);
    touchDown(e);
    return;
  }
  if (e.pointerType === 'mouse' && e.button === 1) {
    mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    capture(e.pointerId);
    beginInteraction();
    e.preventDefault();
    return;
  }
  if (drawing || erasing) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  capture(e.pointerId);
  startTool(e);
});
function startTool(e) {
  if (wantsEraser(e)) { startErase(e); return true; }
  return startStroke(e);
}

stage.addEventListener('pointermove', (e) => {
  if (!E) return;
  if (e.pointerType === 'pen') penSeenAt = now();
  if (drawing && e.pointerId === drawing.id) { moveStroke(e); return; }
  if (erasing && e.pointerId === erasing.id) { moveErase(e); return; }
  if (mousePan && e.pointerId === mousePan.id) {
    cam.x -= (e.clientX - mousePan.x) / cam.z;
    cam.y -= (e.clientY - mousePan.y) / cam.z;
    mousePan.x = e.clientX; mousePan.y = e.clientY;
    clampCam();
    requestRender();
    return;
  }
  if (e.pointerType === 'touch') {
    touchMove(e);
    return;
  }
  // ホバー(ペンを浮かせている/マウス): 消しゴムの円を出す
  if (isEraserTool() || (e.pointerType === 'pen' && wantsEraser(e))) {
    cursor = { x: e.clientX, y: e.clientY };
    requestLive();
  } else if (cursor) { cursor = null; requestLive(); }
});

function pointerEnd(e) {
  if (!E) return;
  if (drawing && e.pointerId === drawing.id) {
    // キャンセル(OSに奪われた等)でも描いた分は残す
    endStroke(e);
    return;
  }
  if (erasing && e.pointerId === erasing.id) { endErase(); return; }
  if (mousePan && e.pointerId === mousePan.id) { mousePan = null; endInteractionSoon(); return; }
  if (e.pointerType === 'touch') touchUp(e);
}
stage.addEventListener('pointerup', pointerEnd);
stage.addEventListener('pointercancel', pointerEnd);
stage.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch' && cursor && !erasing) { cursor = null; requestLive(); }
});
stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener('wheel', (e) => {
  if (!E) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1;
  beginInteraction();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0015));
  } else {
    cam.x += (e.deltaX * unit) / cam.z;
    cam.y += (e.deltaY * unit) / cam.z;
  }
  clampCam();
  requestRender();
  endInteractionSoon();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!E || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(viewW / 2, viewH / 2, 1.25); clampCam(); requestRender(); return; }
  if (mod && k === '-') { e.preventDefault(); zoomAt(viewW / 2, viewH / 2, 0.8); clampCam(); requestRender(); return; }
  if (mod && k === '0') { e.preventDefault(); showPage(currentPage()); return; }
  if (mod) return;
  if (k === 'e') selectTool('eraser');
  else if (k === '1' || k === '2' || k === '3') selectTool('pen' + (Number(k) - 1));
  else if (k === 'b' || k === 'p') selectTool('pen' + penIndex());
  else if (e.key === 'PageDown') showPage(Math.min(pageCount() - 1, currentPage() + 1), cam.z);
  else if (e.key === 'PageUp') showPage(Math.max(0, currentPage() - 1), cam.z);
});

/* ============================================================
   道具ドック
   ============================================================ */
let lastPenTool = settings.tool.startsWith('pen') ? settings.tool : 'pen0';
function renderDock() {
  const box = $('penSlots');
  box.innerHTML = '';
  settings.pens.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool' + (settings.tool === 'pen' + i ? ' active' : '');
    b.title = `ペン${i + 1}（${i + 1}）`;
    const dot = document.createElement('span');
    dot.className = 'pen-dot';
    const d = clamp(Math.round(p.w * 0.9), 4, 30);
    dot.style.width = dot.style.height = d + 'px';
    dot.style.background = p.c;
    const w = document.createElement('span');
    w.className = 'pen-w';
    w.textContent = p.w;
    b.append(dot, w);
    b.addEventListener('click', () => {
      if (settings.tool === 'pen' + i) openPenDialog(i);
      else selectTool('pen' + i);
    });
    box.appendChild(b);
  });
  const eb = $('eraserBtn');
  eb.classList.toggle('active', isEraserTool());
  let badge = eb.querySelector('.mode-badge');
  if (!badge) { badge = document.createElement('span'); badge.className = 'mode-badge'; eb.appendChild(badge); }
  badge.textContent = settings.eraserMode === 'part' ? '部分' : '線';
  $('dock').classList.toggle('right', settings.dockSide === 'right');
}
function selectTool(t) {
  settings.tool = t;
  if (t.startsWith('pen')) lastPenTool = t;
  saveSettings();
  renderDock();
  if (!isEraserTool() && cursor) { cursor = null; requestLive(); }
}
$('eraserBtn').addEventListener('click', () => {
  if (isEraserTool()) openEraserDialog();
  else selectTool('eraser');
});
$('addPageBtn').addEventListener('click', () => {
  const i = currentPage();
  insertPage(i + 1);
  showPage(i + 1, cam.z);
  toast(`${i + 2}ページ目を追加した`);
});

/* ---- ペン設定 ---- */
let editingPen = 0;
function openPenDialog(i) {
  editingPen = i;
  const p = settings.pens[i];
  const sw = $('penColors');
  sw.innerHTML = '';
  for (const col of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (col.toLowerCase() === p.c.toLowerCase() ? ' active' : '');
    b.style.background = col;
    b.title = col;
    b.addEventListener('click', () => { updatePen({ c: col }); openPenDialog(editingPen); });
    sw.appendChild(b);
  }
  $('penColorInput').value = p.c;
  $('penWidth').value = p.w;
  $('penWidthOut').textContent = p.w;
  $('penPressure').checked = p.pr;
  drawPenPreview();
  if (!$('penDlg').open) $('penDlg').showModal();
}
function updatePen(patch) {
  Object.assign(settings.pens[editingPen], patch);
  saveSettings();
  renderDock();
  drawPenPreview();
}
$('penColorInput').addEventListener('input', (e) => { updatePen({ c: e.target.value }); });
$('penColorInput').addEventListener('change', () => openPenDialog(editingPen));
$('penWidth').addEventListener('input', (e) => {
  const w = Number(e.target.value);
  $('penWidthOut').textContent = w;
  updatePen({ w });
});
$('penPressure').addEventListener('change', (e) => updatePen({ pr: e.target.checked }));
function drawPenPreview() {
  const cv = $('penPreview');
  const ctx = cv.getContext('2d');
  const p = settings.pens[editingPen];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p.c.toLowerCase() === '#ffffff' ? '#cfd4d9' : '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // 画面上の見た目に近づけるため、ページを「全体表示」したときの倍率で描く
  const s = clamp(fitPageZoom() * (window.devicePixelRatio || 1), 0.15, 2);
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const x = (40 + t * (cv.width - 80)) / s;
    const y = (cv.height / 2 + Math.sin(t * Math.PI * 2) * 26) / s;
    pts.push([x, y, Math.pow(Math.sin(t * Math.PI), 1.2) * 0.95 + 0.05]);
  }
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fillStyle = p.c;
  ctx.fill(livePath({ c: p.c, w: p.w, t: p.pr ? PEN_THINNING : 0 }, pts, true));
}

/* ---- 消しゴム設定 ---- */
function openEraserDialog() {
  for (const r of document.querySelectorAll('input[name=eraserMode]')) r.checked = r.value === settings.eraserMode;
  $('eraserSize').value = settings.eraserSize;
  $('eraserSizeOut').textContent = settings.eraserSize;
  $('eraserDlg').showModal();
}
for (const r of document.querySelectorAll('input[name=eraserMode]')) {
  r.addEventListener('change', () => { settings.eraserMode = r.value; saveSettings(); renderDock(); });
}
$('eraserSize').addEventListener('input', (e) => {
  settings.eraserSize = Number(e.target.value);
  $('eraserSizeOut').textContent = settings.eraserSize;
  saveSettings();
});

/* ============================================================
   ページ操作
   ============================================================ */
function insertPage(index, strokes = []) {
  const id = uid('pg');
  E.doc.pages.splice(index, 0, id);
  const ps = pageState(id);
  ps.strokes = strokes;
  ps.rev++;
  markDirty(id);
  markDocDirty();
  clampCam();
  requestRender();
  return id;
}
let pgSel = 0;
const thumbUrls = [];
function revokeThumbs() { while (thumbUrls.length) URL.revokeObjectURL(thumbUrls.pop()); }

async function openPagesDialog() {
  await flushSave();
  pgSel = currentPage();
  await renderPageGrid();
  $('pagesDlg').showModal();
  $('pageGrid').children[pgSel]?.scrollIntoView({ block: 'center' });
}
async function renderPageGrid() {
  revokeThumbs();
  const grid = $('pageGrid');
  grid.innerHTML = '';
  const doc = E.doc;
  doc.pages.forEach((id, i) => {
    const el = document.createElement('div');
    el.className = 'pg' + (i === pgSel ? ' sel' : '');
    const th = document.createElement('div');
    th.className = 'pg-thumb';
    const img = document.createElement('img');
    img.alt = '';
    th.appendChild(img);
    db.getThumb(doc.id, id).then((b) => {
      if (!b) return;
      const u = URL.createObjectURL(b);
      thumbUrls.push(u);
      img.src = u;
    });
    el.append(th, document.createTextNode(String(i + 1)));
    el.addEventListener('click', () => {
      if (pgSel === i) { $('pagesDlg').close(); showPage(i); return; }
      pgSel = i;
      for (const [j, c] of [...grid.children].entries()) c.classList.toggle('sel', j === i);
      updatePgInfo();
    });
    grid.appendChild(el);
  });
  updatePgInfo();
}
function updatePgInfo() {
  $('pageSelInfo').textContent = `${pgSel + 1}ページ目を選択中（もう一度タップで移動）`;
  $('pgMoveL').disabled = pgSel === 0;
  $('pgMoveR').disabled = pgSel >= pageCount() - 1;
  $('pgDel').disabled = pageCount() <= 1;
}
async function afterPageOp() {
  markDocDirty();
  await flushSave();
  await renderPageGrid();
  $('pageGrid').children[pgSel]?.scrollIntoView({ block: 'nearest' });
  clampCam();
  requestRender();
}
function movePage(delta) {
  const p = E.doc.pages, j = pgSel + delta;
  if (j < 0 || j >= p.length) return;
  [p[pgSel], p[j]] = [p[j], p[pgSel]];
  pgSel = j;
  afterPageOp();
}
$('pgMoveL').addEventListener('click', () => movePage(-1));
$('pgMoveR').addEventListener('click', () => movePage(1));
$('pgInsBefore').addEventListener('click', () => { insertPage(pgSel); afterPageOp(); });
$('pgInsAfter').addEventListener('click', () => { insertPage(pgSel + 1); pgSel++; afterPageOp(); });
$('pgDup').addEventListener('click', async () => {
  const src = E.doc.pages[pgSel];
  const ps = pageState(src);
  let strokes = ps.strokes;
  if (!strokes) strokes = (await db.getPage(E.doc.id, src))?.strokes || [];
  insertPage(pgSel + 1, strokes.slice());
  pgSel++;
  afterPageOp();
});
$('pgDel').addEventListener('click', async () => {
  if (pageCount() <= 1) return;
  if (!confirm(`${pgSel + 1}ページ目を削除する？（元に戻せない）`)) return;
  const [id] = E.doc.pages.splice(pgSel, 1);
  E.pages.delete(id);
  E.dirty.delete(id);
  const c = caches.get(id);
  if (c) { c.canvas.width = c.canvas.height = 0; caches.delete(id); }
  // このページに関する履歴は捨てる
  const strip = (list) => list.map((ent) => ent.filter((e) => e.pageId !== id)).filter((ent) => ent.length);
  E.undo = strip(E.undo);
  E.redo = strip(E.redo);
  updateUndoUI();
  await db.deletePageData(E.doc.id, id);
  pgSel = Math.min(pgSel, pageCount() - 1);
  afterPageOp();
});
$('pageBtn').addEventListener('click', openPagesDialog);
$('pagesDlg').addEventListener('close', revokeThumbs);

/* ============================================================
   書き出し(PNG・350dpi)
   ============================================================ */
const safeName = (s) => (s || 'name').replace(/[\\/:*?"<>|]/g, '_').trim() || 'name';
const pad3 = (n) => String(n).padStart(3, '0');

function openExportDialog() {
  const n = pageCount();
  $('exFrom').max = $('exTo').max = n;
  $('exFrom').value = currentPage() + 1;
  $('exTo').value = n;
  $('exStatus').textContent = '';
  $('exGo').disabled = false;
  syncExportRange();
  $('exportDlg').showModal();
}
function syncExportRange() {
  $('exRangeRow').hidden = document.querySelector('input[name=exRange]:checked').value !== 'range';
}
for (const r of document.querySelectorAll('input[name=exRange]')) r.addEventListener('change', syncExportRange);
$('exportBtn').addEventListener('click', openExportDialog);

async function strokesOf(id) {
  const ps = E.pages.get(id);
  if (ps?.strokes) return ps.strokes;
  return (await db.getPage(E.doc.id, id))?.strokes || [];
}
let exportCanvas = null;
async function renderPagePng(strokes, white) {
  if (!exportCanvas) {
    exportCanvas = document.createElement('canvas');
    exportCanvas.width = PAGE_W;
    exportCanvas.height = PAGE_H;
  }
  const ctx = exportCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);
  if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PAGE_W, PAGE_H); }
  for (const st of strokes) drawStroke(ctx, st);
  const blob = await new Promise((res) => exportCanvas.toBlob(res, 'image/png'));
  return pngWithDpi(blob, DPI);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  // モーダル表示中は<dialog>の外が inert になり download 属性が効かないので、開いているダイアログ内に置く
  (document.querySelector('dialog[open]') || document.body).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
$('exGo').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=exRange]:checked').value;
  const white = document.querySelector('input[name=exBg]:checked').value === 'white';
  const n = pageCount();
  let from = 0, to = n - 1;
  if (mode === 'current') from = to = currentPage();
  else if (mode === 'range') {
    from = clamp(Math.round(Number($('exFrom').value)) - 1, 0, n - 1);
    to = clamp(Math.round(Number($('exTo').value)) - 1, from, n - 1);
  }
  const title = safeName(E.doc.title);
  const status = $('exStatus');
  $('exGo').disabled = true;
  try {
    await flushSave();
    if (from === to) {
      status.textContent = '書き出し中…';
      const blob = await renderPagePng(await strokesOf(E.doc.pages[from]), white);
      download(blob, `${title}_p${pad3(from + 1)}.png`);
    } else {
      const files = [];
      for (let i = from; i <= to; i++) {
        status.textContent = `書き出し中… ${i - from + 1} / ${to - from + 1}`;
        const blob = await renderPagePng(await strokesOf(E.doc.pages[i]), white);
        files.push({ name: `${title}_p${pad3(i + 1)}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      status.textContent = 'ZIPにまとめ中…';
      download(makeZip(files), `${title}_p${pad3(from + 1)}-${pad3(to + 1)}.zip`);
    }
    status.textContent = '保存した';
    setTimeout(() => $('exportDlg').close(), 600);
  } catch (err) {
    console.error(err);
    status.textContent = '書き出しに失敗した: ' + (err?.message || err);
  } finally {
    $('exGo').disabled = false;
  }
});

/* ============================================================
   設定ダイアログ
   ============================================================ */
async function openSettings() {
  $('stab').value = settings.stab;
  $('stabOut').textContent = settings.stab.toFixed(2);
  $('gamma').value = settings.gamma;
  $('gammaOut').textContent = settings.gamma.toFixed(2);
  $('sideEraser').checked = settings.sideEraser;
  $('fingerDraw').checked = settings.fingerDraw;
  $('tapUndo').checked = settings.tapUndo;
  for (const r of document.querySelectorAll('input[name=dockSide]')) r.checked = r.value === settings.dockSide;
  $('settingsDlg').showModal();
  const info = $('persistInfo');
  info.textContent = '';
  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    const mb = est ? ` ・使用量 約${Math.round((est.usage || 0) / 1048576)}MB` : '';
    info.textContent = (persisted ? 'データ保護: 有効（ブラウザに勝手に消されない）' : 'データ保護: 未許可（容量が逼迫するとブラウザに消される可能性あり。ホーム画面に追加すると許可されやすい）') + mb;
  } catch (_) {}
}
$('stab').addEventListener('input', (e) => { settings.stab = Number(e.target.value); $('stabOut').textContent = settings.stab.toFixed(2); saveSettings(); });
$('gamma').addEventListener('input', (e) => { settings.gamma = Number(e.target.value); $('gammaOut').textContent = settings.gamma.toFixed(2); saveSettings(); });
$('sideEraser').addEventListener('change', (e) => { settings.sideEraser = e.target.checked; saveSettings(); });
$('fingerDraw').addEventListener('change', (e) => { settings.fingerDraw = e.target.checked; saveSettings(); });
$('tapUndo').addEventListener('change', (e) => { settings.tapUndo = e.target.checked; saveSettings(); });
for (const r of document.querySelectorAll('input[name=dockSide]')) {
  r.addEventListener('change', () => { settings.dockSide = r.value; saveSettings(); renderDock(); });
}
$('settingsBtn').addEventListener('click', openSettings);
$('listSettingsBtn').addEventListener('click', openSettings);

/* ---- ダイアログ共通 ---- */
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // 背景タップで閉じる
}
for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => b.closest('dialog').close());
}

/* ---- トースト ---- */
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1400);
}

/* ============================================================
   作品一覧
   ============================================================ */
const listUrls = [];
function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function renderList() {
  while (listUrls.length) URL.revokeObjectURL(listUrls.pop());
  const docs = (await db.listDocs()).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const ul = $('docList');
  ul.innerHTML = '';
  $('emptyMsg').hidden = docs.length > 0;
  for (const doc of docs) {
    const li = document.createElement('li');
    li.className = 'doc-item';
    const th = document.createElement('div');
    th.className = 'doc-thumb';
    const img = document.createElement('img');
    img.alt = '';
    th.appendChild(img);
    if (doc.pages[0]) {
      db.getThumb(doc.id, doc.pages[0]).then((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        listUrls.push(u);
        img.src = u;
      });
    }
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    const txt = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = doc.title;
    const sub = document.createElement('div');
    sub.className = 'doc-sub';
    sub.textContent = `${doc.pages.length}ページ・${fmtDate(doc.updatedAt)}`;
    txt.append(name, sub);
    const mb = document.createElement('button');
    mb.type = 'button';
    mb.className = 'ibtn doc-menu';
    mb.textContent = '⋯';
    mb.title = 'メニュー';
    mb.addEventListener('click', (e) => {
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, [
        { label: '名前を変更', fn: () => renameDoc(doc) },
        { label: '複製', fn: () => dupDoc(doc) },
        { label: '削除', danger: true, fn: () => removeDoc(doc) },
      ]);
    });
    meta.append(txt, mb);
    li.append(th, meta);
    li.addEventListener('click', () => openDoc(doc.id));
    ul.appendChild(li);
  }
}
function showMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.id = 'popMenu';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.addEventListener('click', () => { closeMenu(); it.fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = clamp(x - r.width, 8, window.innerWidth - r.width - 8) + 'px';
  m.style.top = clamp(y, 8, window.innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onMenuOutside, true), 0);
}
function onMenuOutside(e) {
  if (!e.target.closest('#popMenu')) closeMenu();
}
function closeMenu() {
  $('popMenu')?.remove();
  document.removeEventListener('pointerdown', onMenuOutside, true);
}
function defaultTitle() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `ネーム ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
$('newDocBtn').addEventListener('click', async () => {
  const title = prompt('作品名', defaultTitle());
  if (title === null) return;
  const t = new Date().toISOString();
  const doc = { id: uid('doc'), title: title.trim() || defaultTitle(), createdAt: t, updatedAt: t, w: PAGE_W, h: PAGE_H, pages: [uid('pg')] };
  await db.putDoc(doc);
  db.requestPersist();
  openDoc(doc.id);
});
async function renameDoc(doc) {
  const t = prompt('作品名', doc.title);
  if (t === null || !t.trim()) return;
  doc.title = t.trim();
  await db.putDoc(doc);
  renderList();
}
async function dupDoc(doc) {
  const t = new Date().toISOString();
  const nd = { ...doc, id: uid('doc'), title: doc.title + ' のコピー', createdAt: t, updatedAt: t, pages: doc.pages.slice() };
  await db.duplicateDoc(doc, nd);
  renderList();
}
async function removeDoc(doc) {
  if (!confirm(`「${doc.title}」を削除する？（元に戻せない）`)) return;
  await db.deleteDoc(doc.id);
  renderList();
}

/* ============================================================
   画面遷移
   ============================================================ */
async function openDoc(id) {
  const doc = await db.getDoc(id);
  if (!doc) { toast('作品が見つからない'); return; }
  E = newEditorState(doc);
  caches.clear();
  $('listScreen').hidden = true;
  $('editor').hidden = false;
  $('docTitle').textContent = doc.title;
  shownPageNo = '';
  shownZoom = '';
  resize();
  renderDock();
  updateUndoUI();
  showPage(clamp(doc.lastPage || 0, 0, doc.pages.length - 1));
  if (history.state?.doc !== id) history.pushState({ doc: id }, '');
}
async function closeDoc() {
  if (!E) return;
  if (drawing) endStroke(null);
  if (erasing) endErase();
  E.doc.lastPage = currentPage();
  E.docDirty = true;
  await flushSave();
  for (const c of caches.values()) c.canvas.width = c.canvas.height = 0;
  caches.clear();
  E = null;
  liveCtx.clearRect(0, 0, liveCv.width, liveCv.height);
  $('editor').hidden = true;
  $('listScreen').hidden = false;
  renderList();
}
$('backBtn').addEventListener('click', () => {
  if (history.state?.doc) history.back();
  else closeDoc();
});
window.addEventListener('popstate', () => {
  // Androidの戻る操作: ダイアログが開いていればそれを閉じるだけにする
  const open = document.querySelector('dialog[open]');
  if (open && E) {
    open.close();
    history.pushState({ doc: E.doc.id }, '');
    return;
  }
  if (E) closeDoc();
});
$('zoomPill').addEventListener('click', () => showPage(currentPage()));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && E) {
    E.doc.lastPage = currentPage();
    E.docDirty = true;
    flushSave();
  }
});
window.addEventListener('pagehide', () => { if (E) flushSave(); });
new ResizeObserver(() => resize()).observe(stage);

/* ---- 起動 ---- */
renderDock();
resize();
renderList();
if (history.state?.doc) history.replaceState(null, '');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用フック
window.__nb = { get E() { return E; }, cam, settings, flushSave, caches };
