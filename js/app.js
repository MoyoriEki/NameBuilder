/* ============================================================
   ネームビルダー 本体
   - ページは 2508×3541(B5・350dpi相当)固定。縦に並べてスクロールする
   - 線はベクター(点列)で持ち、表示用には「ページごとの画像キャッシュ」を
     その時の倍率で焼いて使う(全ページをフル解像度で持つとメモリが持たない)
   - 描画中の線だけは重ねキャンバス(#live)に描き、
     ペンを離したらページのキャッシュへ焼き込む
   ============================================================ */
import * as db from './db.js?v=18';
import { drawStroke, drawLiveStroke, isOpacityStroke, opacityAt, bbox, bboxHit, hitStroke, eraseSplit, sweep } from './ink.js?v=18';
import { pngWithDpi, makeZip } from './zip.js?v=18';
import * as cloud from './cloud.js?v=18';

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
  viewMode: 'page',   // page=ページ送り / scroll=縦スクロール
  readDir: 'rtl',     // rtl=右開き(漫画・次のページは左) / ltr=左開き
  barMode: 'auto',    // auto=横長画面なら縦バー / top / side
  pmax: 0.7,          // この筆圧で最大の太さになる
  lowLatency: false,  // 低遅延描画(実験的)
  fullscreen: true,   // 作品を開いている間は全画面(Androidの上のステータスバーと下のナビゲーションバーを隠す)
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
// 透明な重ねキャンバスに desynchronized を付けると、Android Chromeでは透明部分が
// 真っ黒に表示される。重ねキャンバスは普通のキャンバスにし、低遅延は下の inkCv(不透明)で別に扱う
const liveCtx = liveCv.getContext('2d');

/* 低遅延描画(実験的・設定でオン): 不透明な desynchronized キャンバスを描画中だけ表示し、
   毎フレーム「表示中の画面(view)を写す → 描きかけの線を重ねる」。不透明なので黒くならない */
let inkCv = null, inkCtx = null;
function ensureInk() {
  if (inkCv) return;
  inkCv = document.createElement('canvas');
  inkCv.id = 'ink';
  inkCv.style.visibility = 'hidden';
  inkCv.style.pointerEvents = 'none';
  stage.insertBefore(inkCv, liveCv);
  inkCtx = inkCv.getContext('2d', { desynchronized: true, alpha: false });
  sizeCanvas(inkCv);
}
function hideInk() {
  if (inkCv && inkCv.style.visibility !== 'hidden') inkCv.style.visibility = 'hidden';
}
function sizeCanvas(c) {
  c.width = Math.round(viewW * dpr);
  c.height = Math.round(viewH * dpr);
  c.style.width = viewW + 'px';
  c.style.height = viewH + 'px';
}

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
   カメラ(表示位置・倍率)とレイアウト
   world座標: ページ i は x=0..PAGE_W, y=i*PITCH..i*PITCH+PAGE_H
   画面(css-px) = (world - cam) * cam.z
   表示モード:
     page   … ページ送り。今のページだけを表示し、指で横にスワイプしてめくる
     scroll … 縦スクロール。全ページを縦に並べる
   ============================================================ */
const cam = { x: 0, y: 0, z: 0.2 };
let viewW = 1, viewH = 1, dpr = 1;
let interacting = false, settleTimer = 0;
let barVertical = false;           // メニューバーを縦(画面の横端)に置いているか
const SIDEBAR_W = 68;              // 縦バーの幅(css-px)
const FLIP_GAP = 48;               // めくり中に隣のページとの間に空ける隙間(css-px)
const flip = { dx: 0, anim: 0 };   // めくり中の横ずれ(css-px)とアニメーションのID

const pageCount = () => E.doc.pages.length;
const totalH = () => pageCount() * PITCH - GAP;
const pageMode = () => settings.viewMode !== 'scroll';

/** 今のページ(送りモード)。ページの並べ替え・削除があってもIDで追いかける */
function curIndex() {
  const pages = E.doc.pages;
  let i = pages.indexOf(E.curId);
  if (i < 0) {
    i = clamp(E.curIdx || 0, 0, pages.length - 1);
    E.curId = pages[i];
  }
  E.curIdx = i;
  return i;
}
function setCur(i) {
  E.curIdx = clamp(i, 0, pageCount() - 1);
  E.curId = E.doc.pages[E.curIdx];
}

/** ページを置ける画面内の領域(css-px)。バーやドックの分を除く */
function area() {
  const m = 12;
  if (barVertical) {
    const left = settings.dockSide !== 'right';
    return {
      x0: (left ? SIDEBAR_W : 0) + m,
      x1: viewW - (left ? 0 : SIDEBAR_W) - m,
      y0: m,
      y1: viewH - m,
    };
  }
  return { x0: 84, x1: viewW - 84, y0: TOPBAR + 14, y1: viewH - 14 };
}
function fitPageZoom() {
  const a = area();
  return Math.max(0.01, Math.min((a.x1 - a.x0) / PAGE_W, (a.y1 - a.y0) / PAGE_H));
}
const zMin = () => fitPageZoom() * (pageMode() ? 0.5 : 0.25);
const zMax = () => 2.5;

/** 1軸ぶんの制限: 収まるなら領域の中央、はみ出すなら端から少し先まで動かせる */
function clampAxis(v, lo, len, a0, a1, z) {
  const m = 40 / z;
  if (len <= (a1 - a0) / z) return lo + len / 2 - (a0 + a1) / 2 / z;
  return clamp(v, lo - a0 / z - m, lo + len + m - a1 / z);
}
function clampCam() {
  const a = area(), z = cam.z;
  cam.x = clampAxis(cam.x, 0, PAGE_W, a.x0, a.x1, z);
  if (pageMode()) cam.y = clampAxis(cam.y, curIndex() * PITCH, PAGE_H, a.y0, a.y1, z);
  else cam.y = clampAxis(cam.y, 0, totalH(), a.y0, a.y1, z);
}
function zoomAt(sx, sy, factor) {
  const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
  cam.z = clamp(cam.z * factor, zMin(), zMax());
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
}
function showPage(i, z = fitPageZoom()) {
  i = clamp(i, 0, pageCount() - 1);
  if (pageMode()) setCur(i);
  const a = area();
  cam.z = clamp(z, zMin(), zMax());
  cam.x = PAGE_W / 2 - (a.x0 + a.x1) / 2 / cam.z;
  cam.y = i * PITCH + PAGE_H / 2 - (a.y0 + a.y1) / 2 / cam.z;
  clampCam();
  requestRender();
}
function currentPage() {
  if (pageMode()) return curIndex();
  const a = area();
  const cy = cam.y + (a.y0 + a.y1) / 2 / cam.z;
  return clamp(Math.floor((cy + GAP / 2) / PITCH), 0, pageCount() - 1);
}
function pageAt(wx, wy) {
  const i = Math.floor(wy / PITCH);
  if (i < 0 || i >= pageCount()) return null;
  if (pageMode() && i !== curIndex()) return null;
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

/* ---- ページ送り ---- */
const isRtl = () => settings.readDir !== 'ltr';
/** 画面の左/右にあるページ。右開き(漫画)では次のページが左に来る */
const leftIndex = () => curIndex() + (isRtl() ? 1 : -1);
const rightIndex = () => curIndex() + (isRtl() ? -1 : 1);
const validIndex = (i) => i >= 0 && i < pageCount();
/** side(-1=左/+1=右)へめくれるか。最後のページの「次」側は、新しいページを足してめくれる */
const sideIndex = (side) => (side < 0 ? leftIndex() : rightIndex());
const isNewPageSide = (side) => sideIndex(side) === pageCount();
const canFlipSide = (side) => validIndex(sideIndex(side)) || isNewPageSide(side);
/** めくり確定。最後のページの先なら白紙のページを足してからめくる */
function flipCommit(side) {
  if (isNewPageSide(side)) {
    insertPage(pageCount());
    toast(`${pageCount()}ページ目を追加した`);
  }
  flipTo(side);
}

/** めくりアニメーション: flip.dx を to まで動かし、終わったら done() */
function animateFlip(to, done) {
  cancelAnimationFrame(flip.anim);
  const from = flip.dx, t0 = now();
  const dur = 160 + Math.min(120, Math.abs(to - from) * 0.15);
  beginInteraction();
  const step = () => {
    const t = Math.min(1, (now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    flip.dx = from + (to - from) * e;
    requestRender();
    if (t < 1) { flip.anim = requestAnimationFrame(step); return; }
    flip.anim = 0;
    done?.();
    endInteractionSoon();
  };
  flip.anim = requestAnimationFrame(step);
}
/** side: -1 = 左のページへ / +1 = 右のページへ */
function flipTo(side) {
  if (!pageMode()) {
    // 縦スクロール時は「左右」を次/前に読み替えて移動するだけ
    const i = currentPage() + (side < 0 ? (isRtl() ? 1 : -1) : (isRtl() ? -1 : 1));
    if (validIndex(i)) showPage(i, cam.z);
    return;
  }
  const target = side < 0 ? leftIndex() : rightIndex();
  if (!validIndex(target)) { if (flip.dx) animateFlip(0); return; }
  const dist = PAGE_W * cam.z + FLIP_GAP;
  animateFlip(side < 0 ? dist : -dist, () => {
    flip.dx = 0;
    showPage(target);
    updateNavUI();
  });
}
function goNext() { flipTo(isRtl() ? -1 : 1); }
function goPrev() { flipTo(isRtl() ? 1 : -1); }
const flipping = () => flip.dx !== 0 || flip.anim !== 0;

/* ---- メニューバーの向き ---- */
function applyLayout() {
  const mode = settings.barMode || 'auto';
  const vertical = mode === 'side' || (mode === 'auto' && window.innerWidth > window.innerHeight * 1.1);
  const ed = $('editor');
  barVertical = vertical;
  ed.classList.toggle('vbar', vertical);
  ed.classList.toggle('side-right', settings.dockSide === 'right');
  const dock = $('dock');
  if (vertical) { if (dock.parentElement !== $('topbar')) $('topbar').appendChild(dock); }
  else if (dock.parentElement !== ed) ed.insertBefore(dock, $('zoomPill'));
}

function resize() {
  const wasFit = E ? Math.abs(cam.z / fitPageZoom() - 1) < 0.02 : false;
  const prevCenter = E ? { x: cam.x + viewW / 2 / cam.z, y: cam.y + viewH / 2 / cam.z } : null;
  applyLayout();
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  viewW = stage.clientWidth || 1;
  viewH = stage.clientHeight || 1;
  for (const c of [viewCv, liveCv, inkCv]) if (c) sizeCanvas(c);
  if (E && prevCenter) {
    if (wasFit) { showPage(currentPage()); return; }
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
  if (pageMode()) { const c = curIndex(); return [c, c]; }
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

/** ページ i を world座標 (ox, oy) を左上にして描く */
function drawPage(ctx, i, ox, oy, k) {
  const id = E.doc.pages[i];
  const z = cam.z;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 10 * dpr;
  ctx.shadowOffsetY = 2 * dpr;
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, PAGE_W, PAGE_H);
  ctx.restore();

  const ps = pageState(id);
  if (!ps.strokes) { ensureLoaded(id); return; }

  const want = cacheScaleFor(k);
  let c = caches.get(id);
  const valid = c && c.rev === ps.rev;
  const fits = valid && c.scale >= want - 1e-6 && c.scale <= want * 2 + 1e-6;
  if (!fits && (!interacting || !valid)) c = buildCache(id, ps, want);
  c.used = now();

  if (!interacting && k > c.scale * 1.05) {
    // 等倍を超えて拡大しているときは、見えている範囲の線をベクターのまま直接描く(滲まない)
    const vx0 = cam.x - ox, vy0 = cam.y - oy;
    const vx1 = vx0 + viewW / z, vy1 = vy0 + viewH / z;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.rect(0, 0, PAGE_W, PAGE_H);
    ctx.clip();
    for (const st of ps.strokes) if (bboxHit(bbox(st), vx0, vy0, vx1, vy1)) drawStroke(ctx, st);
    ctx.restore();
  } else {
    ctx.drawImage(c.canvas, ox, oy, PAGE_W, PAGE_H);
  }
}

/** 最後のページの先に見せる「＋ 新しいページ」(まだ存在しない) */
function drawNewPageGhost(ctx, ox, oy) {
  const z = cam.z;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(ox, oy, PAGE_W, PAGE_H);
  ctx.setLineDash([12 / z, 8 / z]);
  ctx.lineWidth = 2 / z;
  ctx.strokeStyle = '#8a9096';
  ctx.strokeRect(ox, oy, PAGE_W, PAGE_H);
  ctx.setLineDash([]);
  ctx.fillStyle = '#6b7278';
  ctx.font = `${22 / z}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('＋ 新しいページ', ox + PAGE_W / 2, oy + PAGE_H / 2);
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
  if (pageMode()) {
    const cur = curIndex(), top = cur * PITCH;
    const ox = flip.dx / z;
    drawPage(ctx, cur, ox, top, k);
    const step = PAGE_W + FLIP_GAP / z;
    if (flip.dx > 0) {
      if (validIndex(leftIndex())) drawPage(ctx, leftIndex(), ox - step, top, k);
      else if (isNewPageSide(-1)) drawNewPageGhost(ctx, ox - step, top);
    }
    if (flip.dx < 0) {
      if (validIndex(rightIndex())) drawPage(ctx, rightIndex(), ox + step, top, k);
      else if (isNewPageSide(1)) drawNewPageGhost(ctx, ox + step, top);
    }
    // めくりに備えて両隣を先読み
    for (const j of [cur - 1, cur + 1]) if (validIndex(j)) ensureLoaded(E.doc.pages[j]);
  } else {
    for (let i = i0; i <= i1; i++) drawPage(ctx, i, 0, i * PITCH, k);
  }
  updateNavUI();
  updateZoomPill();
  housekeep(i0, i1);
  if (!drawing) hideInk();
  else if (isOpacityStroke(drawing.st)) drawOpacityIncremental(true);
}

/** 見えていないページのキャッシュとストロークを手放す */
function housekeep(i0, i1) {
  const visible = new Set(E.doc.pages.slice(Math.max(0, i0 - 1), i1 + 2));
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

let shownNav = '';
function updateNavUI() {
  const cur = currentPage(), n = pageCount();
  const leftI = cur + (isRtl() ? 1 : -1), rightI = cur + (isRtl() ? -1 : 1);
  const s = `${cur}/${n}/${isRtl()}`;
  if (s === shownNav) return;
  shownNav = s;
  $('pageNo').textContent = `${cur + 1} / ${n}`;
  $('prevBtn').disabled = !validIndex(leftI);
  $('nextBtn').disabled = !validIndex(rightI);
  $('prevBtn').title = isRtl() ? '次のページ（←）' : '前のページ（←）';
  $('nextBtn').title = isRtl() ? '前のページ（→）' : '次のページ（→）';
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
  if (drawing && drawing.pts.length && isOpacityStroke(drawing.st)) {
    drawOpacityIncremental(false);
  } else if (drawing && drawing.pts.length) {
    let tctx = ctx;
    if (settings.lowLatency) {
      ensureInk();
      tctx = inkCtx;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.drawImage(viewCv, 0, 0);
    }
    tctx.setTransform(k, 0, 0, k, -cam.x * k, (drawing.top - cam.y) * k);
    tctx.save();
    tctx.beginPath();
    tctx.rect(0, 0, PAGE_W, PAGE_H);
    tctx.clip();
    const pts = drawing.pred.length ? drawing.pts.concat(drawing.pred) : drawing.pts;
    drawLiveStroke(tctx, drawing.st, pts, false);
    tctx.restore();
    if (settings.lowLatency) inkCv.style.visibility = 'visible';
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

/** 濃さが変わる線(描画中)は、重ねキャンバスを使わず画面(view)に直接、増えた区間だけ描き足す。
 *  darken(濃い方を残す)は同じ所を何度塗っても結果が変わらないので消して描き直す必要が無く、
 *  毎フレーム全体を描き直すと出ていたチラつきが起きない。予測点は後で消せないので使わない。
 *  full=true は render() で画面を描き直した直後に、描きかけ全体を載せ直すとき */
function drawOpacityIncremental(full) {
  const d = drawing;
  const n = d.pts.length;
  if (!n) return;
  const from = full ? 0 : Math.max(0, (d.drawn || 0) - 1);
  if (!full && d.drawn && from >= n - 1) return;
  const ctx = viewCtx;
  const k = cam.z * dpr;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, -cam.x * k, (d.top - cam.y) * k);
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  drawLiveStroke(ctx, d.st, d.pts.slice(from), false);
  ctx.restore();
  d.drawn = n;
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
  if (i >= 0 && (i < i0 || i > i1)) { showPage(i, pageMode() ? undefined : cam.z); return true; }
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
  E.syncDocDirty = true; // ページの並びなど、Dropboxにも伝える変更
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
  const contentChanged = ids.length > 0 || st.syncDocDirty;
  st.dirty.clear();
  st.docDirty = false;
  // 表示位置(lastPage)だけの保存では更新日時もDropboxも触らない
  if (contentChanged) {
    st.doc.updatedAt = new Date().toISOString();
    cloud.noteLocalChange(st.doc, ids, !!st.syncDocDirty);
    st.syncDocDirty = false;
  }
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
  if (contentChanged) { cloud.touch(); cloud.syncSoon(); }
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
  for (const st of ps.strokes) drawStroke(ctx, st, 0.7 / s);
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
let recentMaxPressure = 0; // 設定画面に「直近の最大筆圧」として出す
function pressureOf(e) {
  if (e.pointerType !== 'pen') return 0.5;
  const raw = e.pressure > 0 ? e.pressure : 0.02;
  if (e.buttons && raw > recentMaxPressure) recentMaxPressure = raw;
  // 端末によって最大まで押しても1.0に届かない(MovinkPad+Firefoxで0.55程度)ので、上限で正規化する
  return Math.pow(clamp(raw / settings.pmax, 0, 1), settings.gamma);
}
function wantsEraser(e) {
  if (e.pointerType === 'pen') {
    if (e.button === 5 || (e.buttons & 32)) return true; // 消しゴム側(テールスイッチ)
    if (settings.sideEraser && (e.button === 2 || (e.buttons & 2))) return true; // サイドボタン
  }
  return isEraserTool();
}

/* ---- 線 ---- */
const isWhite = (c) => /^#f{6}$/i.test(c);
/** ペン設定 → ストロークの描き方。白(修正用)は darken だと見えないので濃さ変化は付けない */
// 濃淡の標準値。筆圧が弱めでもしっかり黒が出るように、筆圧の55%で真っ黒、
// カーブは0.7(軽い力のうちから早めに濃くなる)にしている
const OPACITY_DEFAULTS = { omin: 0.15, ofull: 0.55, ogamma: 0.7 };
function penStroke(pen) {
  const st = { c: pen.c, w: pen.w, t: pen.pr ? PEN_THINNING : 0 };
  if (pen.op && !isWhite(pen.c)) {
    st.o = pen.omin ?? OPACITY_DEFAULTS.omin;
    st.of = pen.ofull ?? OPACITY_DEFAULTS.ofull;
    st.og = pen.ogamma ?? OPACITY_DEFAULTS.ogamma;
  }
  return st;
}
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
    st: penStroke(pen),
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
  hideInk();
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
    const dx = cur.cx - ref.cx, dy = cur.cy - ref.cy;
    if (pageMode() && cur.n === 1) {
      // 送りモードの指1本は「めくる」だけ。横の動きだけを拾い、縦には動かさない。
      // 触っただけでぶれないよう、横に一定以上・縦より大きく動いてから追従を始める。
      // 指2本でつまんだ後に残った1本は何もしない
      if (gest.max === 1 && !flip.anim) {
        const s0 = gest.start.get(e.pointerId);
        if (!gest.flipping && s0) {
          const tx = Math.abs(t.x - s0.x), ty = Math.abs(t.y - s0.y);
          if (tx > 14 && tx > ty) gest.flipping = true;
        }
        if (gest.flipping) {
          // 隣が無い方向(1ページ目の前)はゴムのように少しだけ動く
          const nd = flip.dx + dx;
          flip.dx = canFlipSide(nd > 0 ? -1 : 1) ? nd : flip.dx + dx * 0.3;
        }
      }
    } else {
      // 指2本(送りモード)/縦スクロールモード: 移動と拡大
      if (cur.n >= 2 && ref.d > 0 && cur.d > 0) zoomAt(cur.cx, cur.cy, cur.d / ref.d);
      if (flip.dx && !flip.anim) animateFlip(0);
      cam.x -= dx / cam.z;
      cam.y -= dy / cam.z;
    }
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
  let vx = 0;
  if (g.vel.length >= 2) {
    const a = g.vel[0], b = g.vel[g.vel.length - 1];
    if (b.t > a.t && now() - b.t < 80) vx = (b.x - a.x) / (b.t - a.t);
  }
  if (!g.moved && quick && settings.tapUndo && e.type === 'pointerup') {
    if (flip.dx && !flip.anim) animateFlip(0);
    if (g.max === 2) undo();
    else if (g.max >= 3) redo();
  } else if (flip.dx !== 0 && !flip.anim) {
    // 指を離した: 一定以上ずらしたか、はじいたらめくる。足りなければ戻す
    const th = Math.min(viewW * 0.18, 160);
    if (flip.dx > 0 && (flip.dx > th || vx > 0.45) && canFlipSide(-1)) flipCommit(-1);
    else if (flip.dx < 0 && (flip.dx < -th || vx < -0.45) && canFlipSide(1)) flipCommit(1);
    else animateFlip(0);
    return;
  } else if (g.max === 1 && g.vel.length >= 2 && !pageMode()) {
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
  if (drawing || erasing || flipping()) return;
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

let wheelAcc = 0, wheelFlipAt = 0;
stage.addEventListener('wheel', (e) => {
  if (!E) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1;
  beginInteraction();
  const a = area();
  const fits = PAGE_W * cam.z <= a.x1 - a.x0 + 1 && PAGE_H * cam.z <= a.y1 - a.y0 + 1;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0015));
  } else if (pageMode() && fits) {
    // ページ全体が見えているときのホイールはページ送り
    wheelAcc += e.deltaY * unit;
    if (Math.abs(wheelAcc) > 80 && now() - wheelFlipAt > 350 && !flip.anim) {
      wheelAcc > 0 ? goNext() : goPrev();
      wheelFlipAt = now();
      wheelAcc = 0;
    }
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
  else if (e.key === 'PageDown') goNext();
  else if (e.key === 'PageUp') goPrev();
  else if (e.key === 'ArrowLeft') flipTo(-1);
  else if (e.key === 'ArrowRight') flipTo(1);
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
  if (pageMode()) goNext(); else showPage(i + 1, cam.z);
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
  $('penOpacity').checked = !!p.op;
  syncOpacityInputs();
  syncOpacityRow();
  if (!$('penDlg').open) { testStrokes = []; $('penTestInfo').textContent = '↑ ペンで試し描きできる（スライダーを動かすと描いた線にも反映）'; $('penDlg').showModal(); }
  sizePenPreview();
  drawPenPreview();
}
function syncOpacityInputs() {
  const p = settings.pens[editingPen];
  const v = { ...OPACITY_DEFAULTS, ...Object.fromEntries(Object.entries({ omin: p.omin, ofull: p.ofull, ogamma: p.ogamma }).filter(([, x]) => x !== undefined)) };
  $('penOmin').value = v.omin;
  $('penOminOut').textContent = Math.round(v.omin * 100);
  $('penOfull').value = v.ofull;
  $('penOfullOut').textContent = Math.round(v.ofull * 100);
  $('penOgamma').value = v.ogamma;
  $('penOgammaOut').textContent = v.ogamma.toFixed(2);
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
$('penOpacity').addEventListener('change', (e) => { updatePen({ op: e.target.checked }); syncOpacityRow(); });
$('penOmin').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penOminOut').textContent = Math.round(v * 100);
  updatePen({ omin: v });
});
$('penOfull').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penOfullOut').textContent = Math.round(v * 100);
  updatePen({ ofull: v });
});
$('penOgamma').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penOgammaOut').textContent = v.toFixed(2);
  updatePen({ ogamma: v });
});
$('penOpacityReset').addEventListener('click', () => {
  updatePen({ ...OPACITY_DEFAULTS });
  syncOpacityInputs();
});
function syncOpacityRow() {
  const p = settings.pens[editingPen];
  $('penOpacityBox').hidden = !p.op;
  $('penOpacityNote').hidden = !(p.op && isWhite(p.c));
}
/* ---- ペン設定の試し描き ----
   プレビュー欄にペンで描ける。点(位置と補正済みの筆圧)だけを覚えておき、描き直すたびに
   今のペン設定で描くので、スライダーを動かすと描いた線の見え方もその場で変わる */
let testStrokes = [];   // [[x,y,pr], …] の配列
let testDraw = null;
// 画面上の見た目に近づけるため、ページを「全体表示」したときの倍率で描く
const previewScale = () => clamp(fitPageZoom() * (window.devicePixelRatio || 1), 0.15, 2);
function sizePenPreview() {
  const cv = $('penPreview');
  const d = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d);
  if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
}
function drawPenPreview() {
  const cv = $('penPreview');
  const ctx = cv.getContext('2d');
  const p = settings.pens[editingPen];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p.c.toLowerCase() === '#ffffff' ? '#cfd4d9' : '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const s = previewScale();
  const st = penStroke(p);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  if (!testStrokes.length && !testDraw) {
    // 見本: 筆圧が 弱→強→弱 と変わる線
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const x = (40 + t * (cv.width - 80)) / s;
      const y = (cv.height / 2 + Math.sin(t * Math.PI * 2) * cv.height * 0.22) / s;
      pts.push([x, y, Math.pow(Math.sin(t * Math.PI), 1.2) * 0.95 + 0.05]);
    }
    drawLiveStroke(ctx, st, pts, true);
  }
  for (const pts of testStrokes) drawLiveStroke(ctx, st, pts, true);
  if (testDraw?.length) drawLiveStroke(ctx, st, testDraw, false);
}
function testPoint(e) {
  const cv = $('penPreview');
  const r = cv.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  const s = previewScale();
  const pr = pressureOf(e);
  testDraw.push([((e.clientX - r.left) * d) / s, ((e.clientY - r.top) * d) / s, pr]);
  const st = penStroke(settings.pens[editingPen]);
  // 表示する筆圧は「筆圧の上限・カーブ」(設定)で補正した後の値。スライダーの「筆圧 ○%」と同じ物差し
  const raw = e.pointerType === 'pen' ? `筆圧 ${Math.round(pr * 100)}%` : '（マウス/指は筆圧なし）';
  $('penTestInfo').textContent = isOpacityStroke(st)
    ? `${raw} → 濃さ ${Math.round(opacityAt(st, pr) * 100)}%`
    : raw;
}
$('penPreview').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { $('penPreview').setPointerCapture(e.pointerId); } catch (_) {}
  testDraw = [];
  testPoint(e);
  drawPenPreview();
});
$('penPreview').addEventListener('pointermove', (e) => {
  if (!testDraw) return;
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) testPoint(ev);
  drawPenPreview();
});
const endTest = () => {
  if (!testDraw) return;
  if (testDraw.length) testStrokes.push(testDraw);
  testDraw = null;
  drawPenPreview();
};
$('penPreview').addEventListener('pointerup', endTest);
$('penPreview').addEventListener('pointercancel', endTest);
$('penTestClear').addEventListener('click', () => { testStrokes = []; drawPenPreview(); });

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
const thumbUrls = [];
function revokeThumbs() { while (thumbUrls.length) URL.revokeObjectURL(thumbUrls.pop()); }

/* ---- ページ一覧 ----
   タップでそのページへ移動。各ページの「⋯」から追加・複製・移動・削除。
   「選択」にすると複数ページを選んでまとめて削除できる */
let pgSelectMode = false;
const pgSelected = new Set(); // ページID

async function openPagesDialog() {
  await flushSave();
  pgSelectMode = false;
  pgSelected.clear();
  await renderPageGrid();
  $('pagesDlg').showModal();
  $('pageGrid').children[currentPage()]?.scrollIntoView({ block: 'center' });
}
async function renderPageGrid() {
  revokeThumbs();
  const grid = $('pageGrid');
  grid.innerHTML = '';
  grid.classList.toggle('selecting', pgSelectMode);
  const doc = E.doc;
  const cur = currentPage();
  doc.pages.forEach((id, i) => {
    const el = document.createElement('div');
    el.className = 'pg' + (i === cur ? ' cur' : '') + (pgSelected.has(id) ? ' checked' : '');
    const th = document.createElement('div');
    th.className = 'pg-thumb';
    const img = document.createElement('img');
    img.alt = '';
    th.appendChild(img);
    const check = document.createElement('span');
    check.className = 'pg-check';
    th.appendChild(check);
    db.getThumb(doc.id, id).then((b) => {
      if (!b) return;
      const u = URL.createObjectURL(b);
      thumbUrls.push(u);
      img.src = u;
    });
    const row = document.createElement('div');
    row.className = 'pg-row';
    const num = document.createElement('span');
    num.className = 'pg-num';
    num.textContent = i === cur ? `${i + 1}（表示中）` : String(i + 1);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pg-more';
    more.textContent = '⋯';
    more.title = 'このページの操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      showPageMenu(i, r.right, r.bottom);
    });
    row.append(num, more);
    el.append(th, row);
    el.addEventListener('click', () => {
      if (pgSelectMode) {
        if (pgSelected.has(id)) pgSelected.delete(id); else pgSelected.add(id);
        el.classList.toggle('checked', pgSelected.has(id));
        updatePgFoot();
        return;
      }
      $('pagesDlg').close();
      showPage(i);
    });
    grid.appendChild(el);
  });
  updatePgFoot();
}
function updatePgFoot() {
  const n = pageCount();
  $('pgSelectBtn').textContent = pgSelectMode ? '選択をやめる' : '選択';
  $('pgSelAll').hidden = !pgSelectMode;
  $('pgDelSel').hidden = !pgSelectMode;
  $('pgAddEnd').hidden = pgSelectMode;
  $('pgDelSel').disabled = pgSelected.size === 0;
  $('pgDelSel').textContent = pgSelected.size ? `削除（${pgSelected.size}ページ）` : '削除';
  $('pageSelInfo').textContent = pgSelectMode
    ? `${pgSelected.size}ページ選択中`
    : `全${n}ページ・タップで移動／⋯で操作`;
}
function showPageMenu(i, x, y) {
  const n = pageCount();
  const items = [
    { label: 'このページを開く', fn: () => { $('pagesDlg').close(); showPage(i); } },
    { label: '前に白紙ページを追加', fn: () => { insertPage(i); afterPageOp(); } },
    { label: '後ろに白紙ページを追加', fn: () => { insertPage(i + 1); afterPageOp(); } },
    { label: '複製（すぐ後ろに）', fn: () => duplicatePage(i) },
  ];
  if (i > 0) items.push({ label: '前へ移動', fn: () => movePage(i, -1) });
  if (i < n - 1) items.push({ label: '後ろへ移動', fn: () => movePage(i, 1) });
  items.push({ label: '削除', danger: true, fn: () => deletePagesAsk([E.doc.pages[i]]) });
  showMenu(x, y, items);
}
async function afterPageOp() {
  markDocDirty();
  await flushSave();
  if ($('pagesDlg').open) await renderPageGrid();
  clampCam();
  shownNav = '';
  requestRender();
}
function movePage(i, delta) {
  const p = E.doc.pages, j = i + delta;
  if (j < 0 || j >= p.length) return;
  [p[i], p[j]] = [p[j], p[i]];
  afterPageOp();
}
async function duplicatePage(i) {
  const src = E.doc.pages[i];
  const ps = pageState(src);
  let strokes = ps.strokes;
  if (!strokes) strokes = (await db.getPage(E.doc.id, src))?.strokes || [];
  insertPage(i + 1, strokes.slice());
  afterPageOp();
}
/** ページを削除(確認つき)。全部は消せない(1ページは残す) */
async function deletePagesAsk(ids) {
  if (!ids.length) return false;
  if (ids.length >= pageCount()) {
    await askConfirm('すべてのページは削除できない（作品には1ページ以上必要）。', 'OK', false, true);
    return false;
  }
  const nums = ids.map((id) => E.doc.pages.indexOf(id) + 1).sort((a, b) => a - b);
  const what = ids.length === 1 ? `${nums[0]}ページ目` : `${ids.length}ページ（${nums.join('・')}）`;
  if (!(await askConfirm(`${what}を削除する？\n元に戻せない。`, '削除', true))) return false;
  for (const id of ids) {
    const k = E.doc.pages.indexOf(id);
    if (k < 0) continue;
    E.doc.pages.splice(k, 1);
    E.pages.delete(id);
    E.dirty.delete(id);
    pgSelected.delete(id);
    const c = caches.get(id);
    if (c) { c.canvas.width = c.canvas.height = 0; caches.delete(id); }
    await db.deletePageData(E.doc.id, id);
  }
  // 消したページに関する履歴は捨てる
  const gone = new Set(ids);
  const strip = (list) => list.map((ent) => ent.filter((e) => !gone.has(e.pageId))).filter((ent) => ent.length);
  E.undo = strip(E.undo);
  E.redo = strip(E.redo);
  updateUndoUI();
  if (pgSelectMode && !pgSelected.size) pgSelectMode = false;
  await afterPageOp();
  showPage(currentPage(), cam.z);
  toast(ids.length === 1 ? 'ページを削除した' : `${ids.length}ページを削除した`);
  return true;
}
$('pgSelectBtn').addEventListener('click', () => {
  pgSelectMode = !pgSelectMode;
  pgSelected.clear();
  renderPageGrid();
});
$('pgSelAll').addEventListener('click', () => {
  const all = pgSelected.size === pageCount();
  pgSelected.clear();
  if (!all) for (const id of E.doc.pages) pgSelected.add(id);
  renderPageGrid();
});
$('pgDelSel').addEventListener('click', () => deletePagesAsk([...pgSelected]));
$('pgAddEnd').addEventListener('click', () => {
  insertPage(pageCount());
  afterPageOp().then(() => $('pageGrid').lastElementChild?.scrollIntoView({ block: 'nearest' }));
});
$('delPageBtn').addEventListener('click', () => deletePagesAsk([E.doc.pages[currentPage()]]));
$('pagesBtn').addEventListener('click', openPagesDialog);

$('undoBtn').addEventListener('click', () => undo());
$('redoBtn').addEventListener('click', () => redo());
$('pageBtn').addEventListener('click', openPagesDialog);
$('prevBtn').addEventListener('click', () => flipTo(-1));
$('nextBtn').addEventListener('click', () => flipTo(1));
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
  // いったん白い紙の上に描いてから、透明指定なら「白→透明」に変換する。
  // 濃さが変わる線(白と混ぜた色で描いている)や白ペンも、透明背景で正しく抜ける
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  for (const st of strokes) drawStroke(ctx, st);
  if (!white) whiteToAlpha(ctx);
  const blob = await new Promise((res) => exportCanvas.toBlob(res, 'image/png'));
  return pngWithDpi(blob, DPI);
}
/** 白を透明に: 白の上に (色c, 不透明度a) を重ねた結果 P から a と c を逆算する。
 *  a = 1 - min(R,G,B)/255、c = (P - 255(1-a)) / a。白の上に戻すと元と同じ見た目になる */
function whiteToAlpha(ctx) {
  const STRIP = 512; // メモリを食わないよう帯に分けて処理
  for (let y = 0; y < PAGE_H; y += STRIP) {
    const h = Math.min(STRIP, PAGE_H - y);
    const img = ctx.getImageData(0, y, PAGE_W, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const m = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (m === 255) { d[i + 3] = 0; continue; }
      const a = (255 - m) / 255;
      const k = 255 * (1 - a);
      d[i] = Math.round((r - k) / a);
      d[i + 1] = Math.round((g - k) / a);
      d[i + 2] = Math.round((b - k) / a);
      d[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, y);
  }
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
  $('lowLatency').checked = settings.lowLatency;
  $('fullscreen').checked = settings.fullscreen;
  for (const r of document.querySelectorAll('input[name=dockSide]')) r.checked = r.value === settings.dockSide;
  for (const n of ['viewMode', 'readDir', 'barMode']) {
    for (const r of document.querySelectorAll(`input[name=${n}]`)) r.checked = r.value === settings[n];
  }
  $('pmax').value = settings.pmax;
  $('pmaxOut').textContent = settings.pmax.toFixed(2);
  $('pmaxSeen').textContent = recentMaxPressure ? `直近の最大筆圧: ${recentMaxPressure.toFixed(2)}` : '（ペンで描くと直近の最大筆圧が出る）';
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
$('lowLatency').addEventListener('change', (e) => { settings.lowLatency = e.target.checked; saveSettings(); hideInk(); });
$('fullscreen').addEventListener('change', (e) => {
  settings.fullscreen = e.target.checked;
  saveSettings();
  if (settings.fullscreen) enterFullscreen();
  else exitFullscreen();
});

/* ---- 全画面(作品を開いている間だけ) ----
   Webアプリからは上下のバーを「両方隠す/両方出す」しか選べないので、描くときだけ全画面にし、
   作品一覧では時計などのバーを出す。全画面への切り替えはタップなどの操作をきっかけにしかできない
   (ブラウザの決まり)ので、作品を開くタップのときに切り替え、解除されていたら(Androidの戻る操作等)
   次に指やペンを離したタイミングで戻す(押した瞬間だと描いている途中に画面の大きさが変わる) */
const fullscreenCapable = () => !!document.documentElement.requestFullscreen;
const inFullscreen = () => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
let fsPending = false;
function enterFullscreen() {
  if (!E || !settings.fullscreen || !fullscreenCapable() || inFullscreen() || fsPending) return;
  fsPending = true;
  const done = () => { fsPending = false; };
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(done, done);
  setTimeout(done, 2000); // 返事が来ないまま固まった場合の保険
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
// 描画の後始末(stage の pointerup)が済んだ後に動くよう、バブリング段階で受ける
document.addEventListener('pointerup', () => {
  if (drawing || erasing || touches.size) return;
  enterFullscreen();
});
for (const r of document.querySelectorAll('input[name=dockSide]')) {
  r.addEventListener('change', () => { settings.dockSide = r.value; saveSettings(); renderDock(); relayout(); });
}
/** レイアウトに関わる設定を変えたら、今のページを全体表示し直す */
function relayout() {
  const i = E ? currentPage() : 0;
  resize();
  if (E) { flip.dx = 0; shownNav = ''; showPage(i); }
}
for (const n of ['viewMode', 'readDir', 'barMode']) {
  for (const r of document.querySelectorAll(`input[name=${n}]`)) {
    r.addEventListener('change', () => {
      const i = E ? currentPage() : 0;
      settings[n] = r.value;
      saveSettings();
      if (E && n === 'viewMode') setCur(i);
      relayout();
    });
  }
}
$('pmax').addEventListener('input', (e) => {
  settings.pmax = Number(e.target.value);
  $('pmaxOut').textContent = settings.pmax.toFixed(2);
  saveSettings();
});
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
/** 確認ダイアログ(ブラウザ標準の confirm は全画面を解除してしまうので自前)。OKなら true */
function askConfirm(message, okLabel = 'OK', danger = false, alertOnly = false) {
  const dlg = $('confirmDlg');
  $('confirmMsg').textContent = message;
  $('confirmOk').textContent = okLabel;
  $('confirmOk').className = 'btn ' + (danger ? 'danger-fill' : 'primary');
  $('confirmCancel').hidden = alertOnly;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}
$('confirmOk').addEventListener('click', () => $('confirmDlg').close('ok'));

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
  // モーダル表示中はその中に置かないと、ダイアログの下に隠れて触れない
  const dlgs = [...document.querySelectorAll('dialog[open]')];
  (dlgs[dlgs.length - 1] || document.body).appendChild(m);
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
/** 作品名の入力(ブラウザ標準の prompt は全画面を解除してしまうので自前のダイアログ)。キャンセルなら null */
function askName(heading, value, okLabel) {
  const dlg = $('nameDlg'), input = $('nameInput');
  $('nameHeading').textContent = heading;
  $('nameOk').textContent = okLabel;
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value : null), { once: true });
  });
}
$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('nameDlg').close('ok');
});

function defaultTitle() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `ネーム ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
$('newDocBtn').addEventListener('click', async () => {
  const title = await askName('新しいネーム', defaultTitle(), '作る');
  if (title === null) return;
  const t = new Date().toISOString();
  const doc = { id: uid('doc'), title: title.trim() || defaultTitle(), createdAt: t, updatedAt: t, w: PAGE_W, h: PAGE_H, pages: [uid('pg')] };
  cloud.noteLocalChange(doc, doc.pages, true);
  await db.putDoc(doc);
  db.requestPersist();
  openDoc(doc.id);
});
async function renameDoc(doc) {
  const t = await askName('名前を変更', doc.title, '変更');
  if (t === null || !t.trim()) return;
  doc.title = t.trim();
  doc.updatedAt = new Date().toISOString();
  cloud.noteLocalChange(doc, [], true);
  await db.putDoc(doc);
  renderList();
  cloud.syncSoon(1000);
}
async function dupDoc(doc) {
  const t = new Date().toISOString();
  const nd = { ...doc, id: uid('doc'), title: doc.title + ' のコピー', createdAt: t, updatedAt: t, pages: doc.pages.slice() };
  cloud.resetSync(nd);
  await db.duplicateDoc(doc, nd);
  renderList();
  cloud.syncSoon(1000);
}
async function removeDoc(doc) {
  if (!(await askConfirm(`「${doc.title}」を削除する？\n元に戻せない。`, '削除', true))) return;
  await db.deleteDoc(doc.id);
  cloud.forgetDoc(doc);
  renderList();
}

/* ============================================================
   画面遷移
   ============================================================ */
async function openDoc(id) {
  const doc = await db.getDoc(id);
  if (!doc) { toast('作品が見つからない'); return; }
  E = newEditorState(doc);
  enterFullscreen(); // 作品を開いたタップをきっかけに全画面へ
  caches.clear();
  $('listScreen').hidden = true;
  $('editor').hidden = false;
  $('docTitle').textContent = doc.title;
  shownNav = '';
  E.curIdx = clamp(doc.lastPage || 0, 0, doc.pages.length - 1);
  E.curId = doc.pages[E.curIdx];
  flip.dx = 0;
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
  discardEditor();
  cloud.syncNow();
}
/** 編集画面を保存せずに閉じる(Dropboxの版に差し替わったとき用。closeDoc からも使う)。
 *  reopening = すぐ開き直すので全画面は解除しない */
function discardEditor(reopening = false) {
  if (!reopening) exitFullscreen();
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
  if (document.visibilityState === 'hidden') {
    // 裏に回る(アプリ切り替え・画面オフ)ときは保存してすぐDropboxへ
    if (E) {
      E.doc.lastPage = currentPage();
      E.docDirty = true;
      flushSave().then(() => cloud.syncNow());
    } else cloud.syncNow();
  } else {
    cloud.syncNow(); // 戻ってきたら、ほかの端末の変更を取り込む
  }
});
window.addEventListener('pagehide', () => { if (E) flushSave(); });
new ResizeObserver(() => resize()).observe(stage);
window.addEventListener('resize', () => resize());

/* ============================================================
   Dropbox同期の表示
   ============================================================ */
const PHASE_TEXT = { pull: '取り込み中…', push: 'アップロード中…', delete: '削除を反映中…' };
let syncUiSeq = 0;
cloud.initCloud({
  openDoc: () => E?.doc || null,
  openStrokes: (doc, pid) => (E && E.doc === doc ? E.pages.get(pid)?.strokes || null : null),
  canReplaceOpen: () => !!E && !E.dirty.size && !E.docDirty && !E.saving && !drawing && !erasing,
  replacedOpen: (docId) => {
    if (!E || E.doc.id !== docId) return;
    const page = currentPage();
    discardEditor(true);
    openDoc(docId).then(() => { if (E) { showPage(page); toast('ほかの端末の変更を取り込んだ'); } });
  },
  makeThumb: (strokes) => makeThumb(null, { strokes }),
  changed: () => { if (!E) renderList(); updateSyncUI(); },
});
let lastCloud = cloud.status();
cloud.onStatus((st) => { lastCloud = st; updateSyncUI(); });
/** ランプ: 緑=同期済み / 黄=未同期(少し待つと自動で上がる) / 青点滅=アップロード中 /
 *  水色点滅=取り込み中 / 赤=エラー / 灰=オフライン / 白抜き=未接続 */
async function updateSyncUI() {
  const seq = ++syncUiSeq;
  const st = lastCloud;
  let cls, text;
  let pending = 0;
  if (st.connected) pending = (await db.listDocs()).filter((d) => cloud.isDirty(d)).length;
  if (seq !== syncUiSeq) return; // 新しい呼び出しが来ていたら古い結果は捨てる
  if (!st.available) { cls = 'off'; text = 'Dropbox連携を読み込めなかった'; }
  else if (!st.connected) { cls = 'off'; text = '未接続'; }
  else if (st.state === 'syncing') { cls = st.phase === 'push' ? 'push' : 'pull'; text = PHASE_TEXT[st.phase] || '同期中…'; }
  else if (st.state === 'offline') { cls = 'offline'; text = pending ? `オフライン（未同期 ${pending}件）` : 'オフライン'; }
  else if (st.state === 'error') { cls = 'error'; text = '同期エラー'; }
  else if (pending) { cls = 'pending'; text = `未同期 ${pending}件`; }
  else { cls = 'ok'; text = '同期済み'; }
  for (const el of [$('syncLamp'), $('syncLampE')]) {
    el.querySelector('.lamp').className = 'lamp ' + cls;
    el.title = 'Dropbox: ' + text;
  }
  $('syncLamp').querySelector('.lamp-text').textContent = text;
  // ダイアログ
  $('syncDlgLamp').className = 'lamp ' + cls;
  $('syncState').textContent = text;
  const lines = [];
  if (st.connected && st.lastSyncAt) lines.push('最後に同期: ' + new Date(st.lastSyncAt).toLocaleTimeString('ja-JP'));
  if (st.connected && cls === 'pending') lines.push('描いてから20秒ほどで自動で上がる。すぐ上げたいときは「今すぐ同期」');
  if (st.state === 'error' && st.error) lines.push('内容: ' + st.error);
  if (!st.available) lines.push('通信できないか、storage-bridge が読み込めなかった。つながる所で開き直すと使える');
  $('syncDetail').textContent = lines.join('\n');
  $('syncHint').hidden = st.connected || !st.available;
  $('syncConnect').hidden = st.connected || !st.available;
  $('syncDisconnect').hidden = !st.connected;
  $('syncNowBtn').hidden = !st.connected;
}
function openSyncDialog() { updateSyncUI(); $('syncDlg').showModal(); }
$('syncLamp').addEventListener('click', openSyncDialog);
$('syncLampE').addEventListener('click', openSyncDialog);
$('syncNowBtn').addEventListener('click', () => cloud.syncNow());
$('syncConnect').addEventListener('click', () => { $('syncDlg').close(); cloud.connect(); });
$('syncDisconnect').addEventListener('click', async () => {
  if (!(await askConfirm('Dropboxとの接続を切る？\n作品はこの端末に残る。', '切断', true))) return;
  cloud.disconnect();
});

/* ---- 起動 ---- */
renderDock();
resize();
renderList();
if (history.state?.doc) history.replaceState(null, '');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.__nbReady = true; // 起動完了(index.html の起動失敗チェック用)

// テスト用フック
window.__nb = { get E() { return E; }, cam, settings, flushSave, caches };
