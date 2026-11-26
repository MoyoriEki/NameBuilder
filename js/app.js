/* ============================================================
   ネームビルダー 本体
   - ページは 2508×3541(B5・350dpi相当)固定。縦に並べてスクロールする
   - 線はベクター(点列)で持ち、表示用には「ページごとの画像キャッシュ」を
     その時の倍率で焼いて使う(全ページをフル解像度で持つとメモリが持たない)
   - 描画中の線だけは重ねキャンバス(#live)に描き、
     ペンを離したらページのキャッシュへ焼き込む
   ============================================================ */
import * as db from './db.js?v=31';
import { drawStroke, drawStrokes, addStrokes, drawLiveStroke, isOpacityStroke, opacityAt, bbox, bboxHit, hitStroke, eraseSplit, sweep,
  fractionInPoly, topStrokeAt, unionBox, transformStroke, pointInPoly, strokePath,
  ensureImages, setImageReady, makeImage, sprayer, seededRandom, primeDots,
  makeRaster, rasterSource, startEncode, releaseRaster, adoptRasters, persistStrokes, paintInto } from './ink.js?v=31';
import { layerCanvas, copyLayer, pageCtx, eraseDab, blurDab, extractPoly, clearPoly, pasteFloat } from './raster.js?v=31';
import { bucketFill, polygonFill, subtractCircles } from './fill.js?v=31';
import { pngWithDpi, makeZip } from './zip.js?v=31';
import * as cloud from './cloud.js?v=31';

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
  textPen: { c: '#1f2328', w: 6, pr: true, b: 8 }, // 文字ペン(オートレイヤー)。b = フチの太さ(page-px)
  underPen: { c: '#c4c9ce', w: 40, pr: false },    // 塗りペン(オートレイヤー: いつも一番下)
  shadowPen: { c: '#b4b9be', w: 60, pr: false, bl: 0 }, // 影ペン(オートレイヤー: 線画の上に乗算で重なる)。bl = ぼかし
  // 白ペン(オートレイヤー: 線画・影の上、文字の下)。m = 種類(flat=ベタ / air=エアブラシ / spray=スプレー)、
  // a = 濃さ(エアブラシ・スプレー)、bl = ぼかし(エアブラシ)、ds = 粒の大きさ(半径 px)・dn = 粒の量(スプレー)
  whitePen: { c: '#ffffff', w: 40, pr: true, m: 'air', a: 0.8, bl: 10, ds: 4, dn: 5 },
  // 塗りつぶし。e = はみ出し(線の下へ広げる px)、layer = 塗る先(n=線画 / u=塗り / s=影 / h=白 / x=文字)、
  // ref = 塗り・影・白に塗るときに境目として見るレイヤー(線画・文字は、それぞれ自分のレイヤーだけを見る)。
  // 色は 線画・塗り・文字 は c、影は影ペンの色、白は白
  fill: { c: '#1f2328', e: 2, layer: 'n', ref: { n: true, u: false, s: false, h: false, x: false } },
  eraserMode: 'part',
  eraseTarget: 'all', // 消しゴムが消すレイヤー: all=全部 / n=線画 / u=塗り / s=影 / h=白 / x=文字 / auto=直前に使ったペンのレイヤー
  selTarget: 'all',   // 範囲選択・移動で選ぶレイヤー(同上)
  eraserSize: 40,
  // ぼかし(塗り・影・白の画素をなぞってぼかす)。size = 大きさ(直径 px)、str = 強さ(1回のぼけ方 px)、target = 対象(all / u / s / h)
  blur: { size: 80, str: 10, target: 'all' },
  selMode: 'lasso',   // 選択ツール: lasso=投げ縄 / rect=四角
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
  flipEase: 3,        // めくりの軽さ 1(重い)〜5(軽い)
  flipNear: 0.35,     // 隣のページの近さ(今のページの端から画面の端までのうち、どれだけ離して置くか。0=すぐ横 1=画面の外)
  lowLatency: false,  // 低遅延描画(実験的)
  noMargin: false,    // 閲覧用: ページを全体表示したとき、まわりに余白を空けない(バー・ドックの所は避ける)
  fullscreen: true,   // 作品を開いている間は全画面(Androidの上のステータスバーと下のナビゲーションバーを隠す)
  exportDbx: false,   // PNG書き出しをDropboxのフォルダに保存する(前回の選択を覚える)
  exportFolder: '',   // 書き出し先のDropboxフォルダの既定(空=トップ)
  exportZip: false,   // 複数ページをZIPにまとめる
};
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) {}
  s = { ...DEFAULTS, ...s };
  if (!Array.isArray(s.pens) || s.pens.length !== 3) s.pens = structuredClone(DEFAULTS.pens);
  s.textPen = { ...DEFAULTS.textPen, ...s.textPen };
  s.underPen = { ...DEFAULTS.underPen, ...s.underPen };
  s.shadowPen = { ...DEFAULTS.shadowPen, ...s.shadowPen };
  s.whitePen = { ...DEFAULTS.whitePen, ...s.whitePen, c: '#ffffff' };
  if (!['flat', 'air', 'spray'].includes(s.whitePen.m)) s.whitePen.m = 'air';
  // 直前に使ったペン(消しゴム・選択の対象レイヤーを決める)
  if (!/^pen[0-6]$/.test(s.lastPen || '')) s.lastPen = /^pen[0-6]$/.test(s.tool) ? s.tool : 'pen0';
  s.fill = { ...DEFAULTS.fill, ...s.fill };
  s.fill.ref = { ...DEFAULTS.fill.ref, ...s.fill.ref };
  if (!['n', 'u', 's', 'h', 'x'].includes(s.fill.layer)) s.fill.layer = 'n';
  s.blur = { ...DEFAULTS.blur, ...s.blur };
  if (!['all', 'u', 's', 'h'].includes(s.blur.target)) s.blur.target = 'all';
  return s;
})();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const COLORS = ['#1f2328', '#5b6168', '#9aa0a6', '#3b78d8', '#6fb3ec', '#d64545', '#2f9e5b', '#e08a1e', '#9b59b6', '#ffffff'];
// 影の色(乗算で重ねるので、白に近いほど薄い影になる)
const SHADOW_COLORS = ['#e2e4e7', '#ccd0d4', '#b4b9be', '#9ca2a8', '#848a91', '#6b7178', '#c4c8e4', '#c3d6e8', '#e6d2c6', '#d9c6e0'];

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
/** 画像の読み込み(デコード)が終わったら、画像のあるページを描き直す */
setImageReady(() => {
  if (!E) return;
  for (const ps of E.pages.values()) {
    if (ps.strokes?.some((st) => st.k === 'i' || st.k === 'r')) ps.rev++;
  }
  requestRender();
});
function ensureLoaded(id) {
  const ps = pageState(id);
  if (ps.strokes || ps.loading) return;
  const doc = E.doc;
  ps.loading = db.getPage(doc.id, id).then(async (rec) => {
    const strokes = rec?.strokes || [];
    // 塗り・影・白の画像は展開し終わってから出す(出した後に塗りがぱっと現れないように)
    await ensureImages(strokes, true).catch(() => {});
    ps.loading = null;
    if (E?.doc !== doc) return;
    if (!ps.strokes) { ps.strokes = strokes; ps.rev++; }
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
  const nm = settings.noMargin;
  const m = nm ? 0 : 12;
  if (compactUI) {
    const c = nm ? 0 : 8;
    return { x0: c, x1: viewW - c, y0: TOPBAR + c, y1: viewH - compactDockH - c };
  }
  if (barVertical) {
    const left = settings.dockSide !== 'right';
    return {
      x0: (left ? SIDEBAR_W : 0) + m,
      x1: viewW - (left ? 0 : SIDEBAR_W) - m,
      y0: m,
      y1: viewH - m,
    };
  }
  if (nm) {
    // 浮いている道具ドック(幅74px)の側だけ避ける
    const left = settings.dockSide !== 'right';
    return { x0: left ? 74 : 0, x1: viewW - (left ? 0 : 74), y0: TOPBAR, y1: viewH };
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
  // ページの端から領域の3割ぶん先まで動かせる。全体が収まる倍率でも、中央から同じだけずらせる
  // (描きやすい位置に寄せられるように)
  const slack = ((a1 - a0) * 0.3) / z;
  if (len <= (a1 - a0) / z) {
    const c = lo + len / 2 - (a0 + a1) / 2 / z;
    return clamp(v, c - slack, c + slack);
  }
  return clamp(v, lo - a0 / z - slack, lo + len + slack - a1 / z);
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
  const dist = flipDist(side);
  animateFlip(side < 0 ? dist : -dist, () => {
    flip.dx = 0;
    showPage(target);
    updateNavUI();
  });
}
function goNext() { flipTo(isRtl() ? -1 : 1); }
function goPrev() { flipTo(isRtl() ? 1 : -1); }
const flipping = () => flip.dx !== 0 || flip.anim !== 0;
/** めくりで隣のページが今のページの位置まで来る距離(css-px)。隣のページは画面の外
 *  (今のページの端から画面の端まで+少し)に置いておき、指に合わせて画面の外から滑り込ませる。
 *  すぐ横に置くと、横長の画面では少しずらしただけで机の部分に隣のページがチラつく */
function flipDist(side) {
  const pw = PAGE_W * cam.z;
  const left = -cam.x * cam.z, right = left + pw;
  const edge = side < 0 ? left : viewW - right;
  return Math.max(0, edge) * settings.flipNear + FLIP_GAP + pw;
}
/** めくりの軽さ(1〜5)ごとの判定値。
 *  start: 指が横にこれだけ動いたらページが付いてくる(px) / ratio: 横の動きが縦の何倍以上か
 *  commit: 離したとき、画面幅のこの割合以上ずれていればめくる / speed: これより速く払えばめくる(px/ms) */
const FLIP_EASE = [
  null,
  { start: 34, ratio: 1.6, commit: 0.20, speed: 0.55 },
  { start: 26, ratio: 1.4, commit: 0.15, speed: 0.45 },
  { start: 18, ratio: 1.2, commit: 0.11, speed: 0.35 },
  { start: 12, ratio: 1.0, commit: 0.08, speed: 0.27 },
  { start: 8, ratio: 0.9, commit: 0.05, speed: 0.2 },
];
const flipEase = () => FLIP_EASE[clamp(Math.round(settings.flipEase || 3), 1, 5)];

/* ---- メニューバーの向き ---- */
/* スマホ(縦向きで幅が狭い)用: 道具ドックを画面の下に横一列で置き、上のバーも詰める。
   ページは画面の幅いっぱいまで使う */
let compactUI = false, compactDockH = 0;
const COMPACT_W = 640;
function applyLayout() {
  const mode = settings.barMode || 'auto';
  const vertical = mode === 'side' || (mode === 'auto' && window.innerWidth > window.innerHeight * 1.1);
  const ed = $('editor');
  barVertical = vertical;
  compactUI = !vertical && window.innerWidth < COMPACT_W;
  ed.classList.toggle('compact', compactUI);
  ed.classList.toggle('vbar', vertical);
  ed.classList.toggle('side-right', settings.dockSide === 'right');
  const dock = $('dock');
  if (vertical) { if (dock.parentElement !== $('topbar')) $('topbar').appendChild(dock); }
  else if (dock.parentElement !== ed) ed.insertBefore(dock, $('zoomPill'));
  compactDockH = compactUI ? dock.offsetHeight : 0;
  ed.style.setProperty('--dock-h', compactDockH + 'px');
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
    c = { id, canvas, ctx: canvas.getContext('2d'), scale, rev: -1, used: 0 };
    caches.set(id, c);
  }
  c.scale = scale;
  const ctx = c.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawStrokes(ctx, ps.strokes, 0, ps.hidden, ps.swap ? { swap: ps.swap } : null);
  applyCuts(ctx, id);
  c.rev = ps.rev;
  return c;
}

/** キャッシュの一部(b: page座標の矩形)だけ描き直す。消しゴム用。
 *  切り抜きはキャッシュの画素の境目に揃える。端の画素が半端に残ると、そこに乗算の影が
 *  二重に掛かって濃い筋になる(普通の線でも縁が少し濃くなる) */
function redrawRegion(c, strokes, b) {
  const ctx = c.ctx, k = c.scale;
  const px0 = Math.max(0, Math.floor((b[0] - 2) * k)), py0 = Math.max(0, Math.floor((b[1] - 2) * k));
  const px1 = Math.min(c.canvas.width, Math.ceil((b[2] + 2) * k)), py1 = Math.min(c.canvas.height, Math.ceil((b[3] + 2) * k));
  if (px1 <= px0 || py1 <= py0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(px0, py0, px1 - px0, py1 - py0);
  ctx.clip();
  ctx.clearRect(px0, py0, px1 - px0, py1 - py0);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const x0 = px0 / k, y0 = py0 / k, x1 = px1 / k, y1 = py1 / k;
  drawStrokes(ctx, strokes.filter((st) => bboxHit(bbox(st), x0, y0, x1, y1)));
  applyCuts(ctx, c.id);
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
    const hid = ps.hidden;
    drawStrokes(ctx, ps.strokes.filter((st) => (!hid || !hid.has(st)) && bboxHit(bbox(st), vx0, vy0, vx1, vy1)), 0, null,
      ps.swap ? { swap: ps.swap } : null);
    applyCuts(ctx, id);
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
    if (flip.dx > 0) {
      const step = flipDist(-1) / z;
      if (validIndex(leftIndex())) drawPage(ctx, leftIndex(), ox - step, top, k);
      else if (isNewPageSide(-1)) drawNewPageGhost(ctx, ox - step, top);
    }
    if (flip.dx < 0) {
      const step = flipDist(1) / z;
      if (validIndex(rightIndex())) drawPage(ctx, rightIndex(), ox + step, top, k);
      else if (isNewPageSide(1)) drawNewPageGhost(ctx, ox + step, top);
    }
    // めくりに備えて両隣を先読み
    for (const j of [cur - 1, cur + 1]) if (validIndex(j)) ensureLoaded(E.doc.pages[j]);
  } else {
    for (let i = i0; i <= i1; i++) drawPage(ctx, i, 0, i * PITCH, k);
  }
  checkSel();
  if (sel?.lift) drawLifted(ctx);
  updateNavUI();
  updateZoomPill();
  housekeep(i0, i1);
  if (!drawing) hideInk();
  else if (isOpacityStroke(drawing.st)) drawOpacityIncremental(true);
  // 選択枠は画面座標で描くので、カメラが動いたらすぐ描き直す
  if (sel || selOp || selShown) drawLive();
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
      if (near(id) || E.dirty.has(id) || drawing?.pageId === id || sel?.pageId === id) continue;
      for (const st of ps.strokes) releaseRaster(st); // 塗り・影・白の画素も手放す(PNG は残る)
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
    if (isRasterLayer(layerOf(drawing.st))) drawRasterLive(tctx, drawing, pts);
    else {
      // 文字ペン: 描いている線のフチが、もう書いてある文字を隠さないように中身を描き直す
      const under = drawing.st.x ? () => {
        for (const st of pageState(drawing.pageId).strokes || []) if (st.x) drawStroke(tctx, st);
      } : null;
      drawLiveStroke(tctx, drawing.st, pts, false, under);
    }
    tctx.restore();
    if (settings.lowLatency) inkCv.style.visibility = 'visible';
  }
  drawSelOverlay(ctx);
  if (cursor) {
    // 消しゴム・ぼかしの円。色で対象のレイヤーが分かる。ぼかしは点線
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const blur = erasing ? erasing.mode === 'blur' : isBlurTool();
    const r = brushRadius(blur ? 'blur' : 'erase') * cam.z;
    const L = blur ? LAYERS[settings.blur.target] : LAYERS[eraseLayer() || 'all'];
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, Math.max(2, r), 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = L.ring;
    if (blur) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** 塗り・影・白(描画中): 重ねキャンバスは下と普通に重なるだけなので、そのまま載せると線を隠してしまう。
 *  描いている線の範囲だけ「紙＋全部の段」を描き直して載せる。描いている線はその段の画像とまとめてから
 *  段の重ね方(影は乗算)で重ねるので、離したときとまったく同じ見た目になる。ctx はページ座標 */
function drawRasterLive(ctx, d, pts) {
  const st = liveStroke(d, pts);
  if (!st.p.length) return;
  if (d.spray) primeDots(st, d.spray.path); // 粒の形は出すたびに足してあるので、毎回作り直さない
  const b = bbox(st);
  ctx.save();
  ctx.beginPath();
  ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
  ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
  const near = (pageState(d.pageId).strokes || []).filter((q) => bboxHit(bbox(q), b[0], b[1], b[2], b[3]));
  drawStrokes(ctx, near, 0, null, { live: { st, box: b } });
  ctx.restore();
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
/** 履歴の1手を当てる(undo: before に、redo: after に)。塗り・影・白の画像は、
 *  手放してあれば展開し終わってから差し替える(差し替えた直後に塗りが消えて見えないように) */
let historyBusy = false;
async function applyHistory(ent, back) {
  historyBusy = true;
  try {
    const target = (e) => (back ? e.before : e.after);
    await Promise.all(ent.map((e) => ensureImages(target(e), true))).catch(() => {});
    if (!E) return;
    for (const e of ent) {
      const next = target(e), prev = pageState(e.pageId).strokes || (back ? e.after : e.before);
      adoptRasters(next);
      if (setPageStrokes(e.pageId, next)) {
        retireRasters(prev, next);
        revealPage(e.pageId);
      }
    }
  } finally { historyBusy = false; }
  updateUndoUI();
  requestRender();
}
function undo() {
  if (!E || drawing || erasing || selOp || historyBusy) return;
  clearSel();
  const ent = E.undo.pop();
  if (!ent) return;
  E.redo.push(ent);
  applyHistory(ent, true).then(() => toast('元に戻した'));
}
function redo() {
  if (!E || drawing || erasing || selOp || historyBusy) return;
  clearSel();
  const ent = E.redo.pop();
  if (!ent) return;
  E.undo.push(ent);
  applyHistory(ent, false).then(() => toast('やり直した'));
}
/** ページから外れた塗り・影・白の画像の、表示用の画素を手放す */
function retireRasters(before, after) {
  if (!before) return;
  const keep = new Set(after);
  for (const st of before) if (st.k === 'r' && !keep.has(st)) releaseRaster(st);
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
    recs.push([id, { strokes: await persistStrokes(ps.strokes) }]);
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
async function makeThumb(id, ps) {
  await ensureImages(ps.strokes);
  const cv = document.createElement('canvas');
  cv.width = THUMB_W; cv.height = THUMB_H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  const s = THUMB_W / PAGE_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawStrokes(ctx, ps.strokes, 0.7 / s);
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/webp', 0.85));
}

/* ============================================================
   入力
   ============================================================ */
let drawing = null;  // { id, pageId, top, st, pts:[[x,y,p]], pred:[], sm, minD }
let erasing = null;  // { id, before:Map(pageId -> strokes), last:[wx,wy] }
let penSeenAt = -1e9; // ペンが最後に画面に触れていた時刻(ホバーは含めない)
const touches = new Map(); // pointerId -> { x, y }
let gest = null;           // { t0, max, moved, start:Map, ref, vel:[] }
let mousePan = null;       // { id, x, y }
let inertia = null;

const isEraserTool = () => settings.tool === 'eraser';
const isSelTool = () => settings.tool === 'select' || settings.tool === 'move';

/* ---- レイヤーごとの消しゴム・選択 ----
   線はどのペンで描いたかで5つのレイヤーに分かれる: 塗りペン(u) / 影ペン(s) / ふつう(線・塗り・画像)(n) / 白ペン(h) / 文字ペン(x)。
   消しゴムと範囲選択・移動は、相手にするレイヤーを選べる(全部/線画/塗り/影/白/文字/直前に使ったペンのレイヤー)。
   ボタン左上の印をタップで切り替え、2回タップの設定でも選べる */
const LAYERS = {
  n: { label: '線', name: '線画', ring: 'rgba(40,50,60,0.85)', chip: '#3d444b' },
  x: { label: '文', name: '文字', ring: '#3b78d8', chip: '#3b78d8' },
  u: { label: '塗', name: '塗り', ring: '#c27c0e', chip: '#c27c0e' },
  s: { label: '影', name: '影', ring: '#7a5cc0', chip: '#7a5cc0' },
  h: { label: '白', name: '白', ring: '#1d9bb5', chip: '#1d9bb5' },
  all: { label: '全', name: '全部', ring: 'rgba(40,50,60,0.85)', chip: '#7a8288' },
};
const TARGETS = ['all', 'n', 'u', 's', 'h', 'x']; // 印をタップしたときの切り替え順(直前のペンは設定ダイアログからだけ選べる)
const layerOf = (st) => (st.u ? 'u' : st.s ? 's' : st.h ? 'h' : st.x ? 'x' : 'n');
/* ---- 画像の段(塗り・影・白) ----
   塗り・影・白は、ページごと・段ごとに1枚の画像で持つ(ink.js の k:'r'・raster.js)。
   前の版の線データ(塗りペンの線など)は、その段を初めて編集するときに画像へ焼き込む(rasterBase)。
   編集するたびに段の画像を写した新しいオブジェクトを作り、古い方は取り消し用に PNG だけ残す */
const RASTER_LAYERS = ['u', 's', 'h'];
const isRasterLayer = (L) => RASTER_LAYERS.includes(L);
const rasterIn = (strokes, L) => strokes.find((st) => st.k === 'r' && layerOf(st) === L) || null;
/** 段 L の画像。前の版の線データがあれば、ここで画像に焼き込む(見た目は変わらないので履歴にも残さず、
 *  保存もしない。次にこのページを保存するときに画像の形で保存される)。
 *  戻り値: 画像 / null(まだ何も無い) / undefined(画像を展開中。少し待ってからもう一度) */
function rasterBase(pageId, L) {
  const ps = pageState(pageId);
  if (!ps.strokes) return undefined;
  const cur = rasterIn(ps.strokes, L);
  if (cur && !rasterSource(cur)) { ensureImages([cur], true); return undefined; }
  const legacy = ps.strokes.filter((st) => st.k !== 'r' && layerOf(st) === L);
  if (!legacy.length) return cur;
  const cv = copyLayer(cur, PAGE_W, PAGE_H);
  const g = pageCtx(cv);
  for (const st of legacy) paintInto(g, st);
  const obj = makeRaster(L, cv, PAGE_W, PAGE_H);
  const gone = new Set(legacy);
  if (cur) gone.add(cur);
  ps.strokes = addStrokes(ps.strokes.filter((st) => !gone.has(st)), [obj]);
  ps.rev++;
  if (cur) releaseRaster(cur);
  return obj;
}
/** 段 L の画像を編集し、1手の履歴にする。paint(g, cv): g はページ座標で描ける。box: 変わった範囲(page座標) */
function commitRaster(pageId, L, paint, box = null) {
  const base = rasterBase(pageId, L);
  if (base === undefined) { toast('塗りの画像を読み込み中。もう一度試して'); return null; }
  const cv = copyLayer(base, PAGE_W, PAGE_H);
  paint(pageCtx(cv), cv);
  const obj = makeRaster(L, cv, PAGE_W, PAGE_H);
  const ps = pageState(pageId);
  const before = ps.strokes;
  const after = base ? before.map((st) => (st === base ? obj : st)) : addStrokes(before, [obj]);
  const c = caches.get(pageId), fresh = c && c.rev === ps.rev;
  if (!setPageStrokes(pageId, after)) return null;
  // ページのキャッシュは変わった所だけ描き直す
  if (fresh && box) { redrawRegion(c, after, box); c.rev = ps.rev; }
  startEncode(obj);
  if (base) releaseRaster(base);
  pushHistory([{ pageId, before, after }]);
  requestRender();
  return obj;
}
/** なぞる操作(消しゴム・ぼかし)の間だけ書き換える、段 L の作業用の画像。初めて触ったときに、段の画像を写して差し替える。
 *  sess: { before:Map(pageId → 差し替える前の配列), work:Map('pageId:L' → { obj, base }) } */
function rasterWork(sess, pageId, L) {
  const key = pageId + ':' + L;
  let w = sess.work.get(key);
  if (w) return w.obj;
  const base = rasterBase(pageId, L);
  if (!base) return null; // 何も無い(消す物もぼかす物も無い)か、展開中
  const ps = pageState(pageId);
  if (!sess.before.has(pageId)) sess.before.set(pageId, ps.strokes);
  const obj = makeRaster(L, copyLayer(base, PAGE_W, PAGE_H), PAGE_W, PAGE_H);
  ps.strokes = ps.strokes.map((st) => (st === base ? obj : st));
  w = { obj, base };
  sess.work.set(key, w);
  return obj;
}
/** なぞる操作の終わり: 作業用の画像を PNG にし始め(途中で保存していたら作り直す)、元の画像を手放す */
function finishRasterWork(sess) {
  for (const [key, { obj, base }] of sess.work) {
    startEncode(obj, true);
    releaseRaster(base);
    markDirty(key.slice(0, key.lastIndexOf(':')));
  }
}
/** 直前に使ったペンのレイヤー */
const penLayer = () => {
  const i = Number(String(settings.lastPen).replace('pen', '')) || 0;
  return i === 3 ? 'x' : i === 4 ? 'u' : i === 5 ? 's' : i === 6 ? 'h' : 'n';
};
/** 設定値 → 相手にするレイヤー(null = 全部) */
const resolveTarget = (t) => (t === 'auto' ? penLayer() : LAYERS[t] && t !== 'all' ? t : null);
/** 消しゴムで消すレイヤー(null = 全部) */
const eraseLayer = () => resolveTarget(settings.eraseTarget);
/** 範囲選択・移動で選べる線 */
function selTargets(strokes) {
  const L = resolveTarget(settings.selTarget);
  return L ? strokes.filter((st) => layerOf(st) === L) : strokes;
}
const targetName = (t) => (t === 'auto' ? `直前のペン（今は${LAYERS[penLayer()].name}）` : LAYERS[t]?.name || '全部');
const penIndex = () => Number(settings.tool.replace('pen', '')) || 0;
const TEXT_PEN = 3;   // 文字ペンはペン番号3として扱う(tool = 'pen3')
const UNDER_PEN = 4;  // 塗りペンはペン番号4(tool = 'pen4')
const SHADOW_PEN = 5; // 影ペンはペン番号5(tool = 'pen5')
const WHITE_PEN = 6;  // 白ペンはペン番号6(tool = 'pen6')
const penOf = (i) => (i === TEXT_PEN ? settings.textPen : i === UNDER_PEN ? settings.underPen
  : i === SHADOW_PEN ? settings.shadowPen : i === WHITE_PEN ? settings.whitePen : settings.pens[i]);
const WHITE_MODE = { flat: 'ベタ', air: 'エア', spray: '粒' };

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
  if (pen === settings.textPen) { st.x = 1; st.b = pen.b; return st; }
  if (pen === settings.underPen) { st.u = 1; return st; }
  if (pen === settings.shadowPen) {
    // 影: 乗算で重ねる。筆圧で濃さは付けない(段階ごとの部品の継ぎ目が乗算で濃くなるため)
    st.s = 1;
    if (pen.bl > 0) st.bl = pen.bl;
    return st;
  }
  if (pen === settings.whitePen) {
    st.h = 1;
    st.c = '#ffffff';
    if (pen.m === 'air') {
      if (pen.bl > 0) st.bl = pen.bl;
      if (pen.a < 1) st.a = pen.a;
    } else if (pen.m === 'spray') {
      st.k = 'd'; // 粒の並び(点は描いたときに sprayer で作る)
      st.t = 0;
      if (pen.a < 1) st.a = pen.a;
    }
    return st;
  }
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
  const pen = penOf(penIndex());
  clearSel();
  const st = penStroke(pen);
  // 塗り・影・白: 段の画像を用意する(前の版の線データはここで画像に焼き込む)。展開中なら描かない
  if (isRasterLayer(layerOf(st)) && rasterBase(hit.id, layerOf(st)) === undefined) { requestRender(); return false; }
  drawing = {
    id: e.pointerId,
    pageId: hit.id,
    top: hit.top,
    st,
    pts: [],
    pred: [],
    sm: null,
    minD: 0.6 / cam.z,
    cx: e.clientX,
    cy: e.clientY,
    spray: st.k === 'd' ? sprayer(pen) : null, // スプレー: 粒を出す係(粒は描いたときに決めて保存する)
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
  if (d.spray) d.spray.add(d.sm[0], d.sm[1], d.sm[2]);
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
  if (e && e.type === 'pointerup' && !d.spray) {
    // 手ブレ補正の遅れ分を詰めるため、最後に実座標を1点足す(筆圧は直前の値)
    const [wx, wy] = toWorld(e);
    const last = d.pts[d.pts.length - 1];
    const x = wx, y = wy - d.top;
    if (last && Math.hypot(x - last[0], y - last[1]) >= d.minD) d.pts.push([x, y, last[2]]);
  }
  requestLive();
  if (!d.pts.length) return;
  const st = liveStroke(d, d.pts);
  if (!st.p.length) return;
  const ps = pageState(d.pageId);
  if (!ps.strokes) return; // 念のため(描いている間は手放さない)
  const L = layerOf(st);
  if (isRasterLayer(L)) {
    // 塗り・影・白: 段の画像に焼き込む
    if (commitRaster(d.pageId, L, (g) => paintInto(g, st), bbox(st))) markDirty(d.pageId);
    return;
  }
  const before = ps.strokes;
  const after = addStrokes(before, [st]);
  ps.strokes = after;
  ps.rev++;
  const c = caches.get(d.pageId);
  if (c && c.rev === ps.rev - 1) {
    if (after[after.length - 1] === st && !st.x) {
      // いちばん上に足しただけなら、キャッシュに重ねて描けばよい
      c.ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
      drawStroke(c.ctx, st);
    } else {
      // 文字ペンの線(フチ)や、文字の下に入る線は、その周りを描き直す
      redrawRegion(c, after, bbox(st));
    }
    c.rev = ps.rev;
  }
  pushHistory([{ pageId: d.pageId, before, after }]);
  markDirty(d.pageId);
  requestRender();
}
/** 描いている線をストロークの形にする(描画中の表示と、離したときの保存に使う)。スプレーは粒の並び */
function liveStroke(d, pts) {
  if (d.spray) return { ...d.st, p: new Float32Array(d.spray.dots) };
  const p = new Float32Array(pts.length * 3);
  pts.forEach((q, i) => { p[i * 3] = q[0]; p[i * 3 + 1] = q[1]; p[i * 3 + 2] = q[2]; });
  return { ...d.st, p };
}
function cancelStroke() {
  drawing = null;
  hideInk();
  requestLive();
}

/* ---- 消しゴム・ぼかし ----
   消しゴム: 線は線ごと/部分で消す。塗り・影・白(画像の段)は、円の中の画素を消す(ふちを少しずつ削れる)。
   ぼかし: 塗り・影・白の画素を、なぞった所だけぼかす(線画・文字は線データなのでぼかせない)。
   どちらも、なぞっている間は段の作業用の画像を直接書き換え、離したときに1手の履歴にする */
function startErase(e, mode = 'erase') {
  clearSel();
  // cuts: 部分消しで塗りに当たった所。pageId -> { fills:Set, circles:[[x,y,r]] }。離したときにまとめて削る
  // work: 書き換え中の段の画像(rasterWork)
  erasing = { id: e.pointerId, before: new Map(), work: new Map(), last: null, cx: e.clientX, cy: e.clientY, cuts: new Map(), mode };
  moveErase(e);
}
const isBlurTool = () => settings.tool === 'blur';
const brushRadius = (mode) => (mode === 'blur' ? settings.blur.size : settings.eraserSize) / 2;
function moveErase(e) {
  erasing.cx = e.clientX; erasing.cy = e.clientY;
  const evs = e.getCoalescedEvents?.() || [];
  const blur = erasing.mode === 'blur';
  const r = brushRadius(erasing.mode);
  for (const ev of evs.length ? evs : [e]) {
    const [wx, wy] = toWorld(ev);
    const samples = erasing.last ? sweep(erasing.last[0], erasing.last[1], wx, wy, r) : [[wx, wy]];
    for (const [x, y] of samples) (blur ? blurAt : eraseAt)(x, y, r);
    erasing.last = [wx, wy];
  }
  cursor = { x: e.clientX, y: e.clientY };
  requestLive();
}
/** ぼかし: 対象の段(全部なら塗り・影・白)の、円の中の画素をぼかす */
function blurAt(wx, wy, r) {
  const hit = pageAt(wx, wy);
  if (!hit) return;
  const ps = pageState(hit.id);
  if (!ps.strokes) return;
  const T = settings.blur.target;
  let any = false;
  for (const L of T === 'all' ? RASTER_LAYERS : [T]) {
    const obj = rasterWork(erasing, hit.id, L);
    if (!obj) continue;
    blurDab(obj.cv, wx, hit.y, r, settings.blur.str);
    any = true;
  }
  if (!any) return;
  const oldRev = ps.rev;
  ps.rev++;
  const c = caches.get(hit.id);
  const m = settings.blur.str * 3 + 2;
  if (c && c.rev === oldRev) { redrawRegion(c, ps.strokes, [wx - r - m, hit.y - r - m, wx + r + m, hit.y + r + m]); c.rev = ps.rev; }
  requestRender();
}
function eraseAt(wx, wy, r) {
  const hit = pageAt(wx, wy);
  if (!hit) return;
  const ps = pageState(hit.id);
  if (!ps.strokes) return;
  const x = wx, y = hit.y;
  const part = settings.eraserMode === 'part';
  const only = eraseLayer();
  // 塗り・影・白(画像の段): 円の中の画素を消す。前の版の線データは、ここで画像に焼き込んでから消す
  let rregion = null;
  for (const L of only ? (isRasterLayer(only) ? [only] : []) : RASTER_LAYERS) {
    const obj = rasterWork(erasing, hit.id, L);
    if (!obj) continue;
    eraseDab(obj.cv, x, y, r);
    rregion = [x - r - 2, y - r - 2, x + r + 2, y + r + 2];
  }
  let changed = false;
  let region = rregion;
  const out = [];
  let cut = null;
  for (const st of ps.strokes) {
    if (st.k === 'i' || st.k === 'r') { out.push(st); continue; } // 画像は消しゴムでは消さない(選択して削除)。画像の段は上で
    if (only && layerOf(st) !== only) { out.push(st); continue; } // 対象でないレイヤーは消さない
    if (part && st.k === 'f') {
      // 塗りはここでは配列から外さず、当たった円を覚えておく(見た目は applyCuts で抜く)
      if (hitStroke(st, x, y, r)) {
        if (!cut) {
          cut = erasing.cuts.get(hit.id);
          if (!cut) { cut = { fills: new Set(), circles: [] }; erasing.cuts.set(hit.id, cut); }
          cut.circles.push([x, y, r]);
        }
        cut.fills.add(st);
      }
      out.push(st);
      continue;
    }
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
  if (cut) {
    if (!erasing.before.has(hit.id)) erasing.before.set(hit.id, ps.strokes);
    const c = caches.get(hit.id);
    if (c && c.rev === ps.rev && !changed) {
      c.ctx.save();
      c.ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
      applyCuts(c.ctx, hit.id, [[x, y, r]]);
      c.ctx.restore();
    }
    requestRender();
  }
  if (!changed && !rregion) return;
  if (!erasing.before.has(hit.id)) erasing.before.set(hit.id, ps.strokes);
  if (changed) ps.strokes = out;
  const oldRev = ps.rev;
  ps.rev++;
  const c = caches.get(hit.id);
  if (c && c.rev === oldRev) {
    redrawRegion(c, ps.strokes, region);
    c.rev = ps.rev;
  }
  if (changed) markDirty(hit.id);
  requestRender();
}
function endErase() {
  const er = erasing;
  // 塗りの部分消し: 通った円の分を塗りから削った新しい塗りに差し替える
  for (const [pageId, cut] of er.cuts) {
    const ps = pageState(pageId);
    if (!ps.strokes) continue;
    const next = [];
    for (const st of ps.strokes) {
      if (!cut.fills.has(st)) { next.push(st); continue; }
      const rest = subtractCircles(st, cut.circles.filter(([cx, cy, r]) => hitStroke(st, cx, cy, r)), PAGE_W, PAGE_H);
      if (rest) next.push(rest);
    }
    ps.strokes = next;
    ps.rev++;
    markDirty(pageId);
  }
  finishRasterWork(er);
  erasing = null;
  if (er.cuts.size || er.work.size) requestRender();
  const entries = [...er.before].map(([pageId, before]) => ({ pageId, before, after: pageState(pageId).strokes }));
  pushHistory(entries);
  requestLive();
}

/* ---- 選択・移動 ----
   範囲選択ツール: 投げ縄(設定で四角)で囲んだ線を選ぶ。点の半分以上が囲みの中にある線が選ばれる。
     囲まずにタップすると、その位置の線を1本選ぶ
   移動ツール: 線に触れてそのままドラッグすると、その線を動かす
   どちらも、選択中は枠の中をドラッグで移動・右下の丸をドラッグで拡大縮小・枠の外をタップで解除。
   動かしている間は、選んだ線をページのキャッシュから外して(ps.hidden)、ずらした位置に直接描く。
   離したら変形した新しい線に差し替える(1回の移動・拡大縮小 = 1手のundo)。
   投げ縄・四角で選んだときは囲んだ形(poly)も覚えておき、塗りつぶしに使う(線が無くても選択として残る)。
   塗り・影・白(画像の段)は、投げ縄・四角で囲んだときだけ、囲んだ中の画素が選択に入る(rasters: 段の文字の並び)。
   動かしている間は、段を「囲んだ所を抜いた画像」(ps.swap)に差し替え、抜いた画素(floats)をずらした位置に描く */
let sel = null;       // { pageId, top, strokes:[stroke], poly?:[[x,y]], rasters?:['u'|'s'|'h'], box:[x0,y0,x1,y1](page座標), rev, lift?:{ax,ay,s,dx,dy}, floats? }
let selOp = null;     // { id, kind:'lasso'|'rect'|'move'|'scale'|'none', sx, sy, cx, cy, moved, … }
let selShown = false; // 選択の枠・ボタンを表示しているか
const HANDLE_R = 9;   // 拡大縮小ハンドルの見た目の半径(css-px)。当たりはこれより広く取る
const SEL_PICK = 12;  // タップで線を拾うときの許容距離(css-px)

const pageToScreen = (top, x, y) => [(x - cam.x) * cam.z + flip.dx, (y + top - cam.y) * cam.z];
const polyBox = (poly) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
};
const rectPoly = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];

/** 今の(動かしている途中も含む)選択枠。page座標 */
function selBoxNow() {
  const b = sel.box, t = sel.lift;
  if (!t) return b;
  const fx = (x) => t.ax + (x - t.ax) * t.s + t.dx, fy = (y) => t.ay + (y - t.ay) * t.s + t.dy;
  return [fx(b[0]), fy(b[1]), fx(b[2]), fy(b[3])];
}
function selScreenBox() {
  const b = selBoxNow();
  const [x0, y0] = pageToScreen(sel.top, b[0], b[1]);
  const [x1, y1] = pageToScreen(sel.top, b[2], b[3]);
  return [x0, y0, x1, y1];
}
function setSel(pageId, top, strokes, poly = null, rasters = null) {
  if (!strokes.length && !poly) { clearSel(); return; }
  sel = { pageId, top, strokes, poly, rasters: poly && rasters?.length ? rasters : null, box: null, rev: pageState(pageId).rev, lift: null };
  sel.box = selBoxOf(sel);
  requestLive();
}
/** 選択の外接矩形: 線の外接矩形。囲んだ中の画素も選んでいれば、囲んだ形の外接矩形も合わせる */
const selBoxOf = (sl) => {
  const a = sl.strokes.length ? unionBox(sl.strokes) : null;
  const b = sl.poly && (!a || sl.rasters) ? polyBox(sl.poly) : null;
  return a && b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : a || b;
};
/** 範囲選択で囲んだときに、画素も選ぶ段(選ぶレイヤーが 全部 なら 塗り・影・白) */
function selRasterLayers() {
  const L = resolveTarget(settings.selTarget);
  return L ? (isRasterLayer(L) ? [L] : []) : RASTER_LAYERS;
}
const selHasPixels = () => !!sel?.rasters?.length;
function clearSel() {
  if (!sel) return;
  if (sel.lift) unlift();
  sel = null;
  requestLive();
}
/** 選択がまだ有効か確かめる(ページの削除・並べ替え・undo・同期での差し替えなど) */
function checkSel() {
  if (!sel) return;
  const i = E.doc.pages.indexOf(sel.pageId);
  if (i < 0 || (pageMode() && i !== curIndex())) { if (!selOp) { sel = null; } return; }
  sel.top = i * PITCH;
  if (selOp) return;
  const ps = pageState(sel.pageId);
  if (ps.rev === sel.rev) return;
  const have = new Set(ps.strokes || []);
  const keep = sel.strokes.filter((st) => have.has(st));
  if (!keep.length && !sel.poly) { sel = null; return; }
  if (keep.length !== sel.strokes.length) { sel.strokes = keep; sel.box = selBoxOf(sel); }
  sel.rev = ps.rev;
}
/** 選んだ線をページのキャッシュから外し、動かせる状態にする。
 *  画素も選んでいれば、段ごとに囲んだ中の画素を切り出し(floats)、段は抜いた画像に差し替えて表示する */
function lift() {
  const ps = pageState(sel.pageId);
  ps.hidden = new Set(sel.strokes);
  sel.floats = [];
  for (const L of sel.rasters || []) {
    const layer = rasterBase(sel.pageId, L);
    const src = layer && rasterSource(layer);
    if (!src) continue;
    const f = extractPoly(src, sel.poly);
    if (!f) continue;
    const hole = copyLayer(layer, PAGE_W, PAGE_H);
    clearPoly(hole, sel.poly);
    sel.floats.push({ L, layer, f, hole });
  }
  ps.swap = sel.floats.length ? new Map(sel.floats.map((x) => [x.layer, { ...x.layer, cv: x.hole }])) : null;
  ps.rev++;
  sel.rev = ps.rev;
  sel.lift = { ax: sel.box[0], ay: sel.box[1], s: 1, dx: 0, dy: 0 };
  beginInteraction();
}
function unlift() {
  const ps = pageState(sel.pageId);
  ps.hidden = null;
  ps.swap = null;
  sel.floats = null;
  ps.rev++;
  sel.rev = ps.rev;
  sel.lift = null;
  endInteractionSoon();
  requestRender();
}
/** 動かしている線を、ずらした位置に描く(render から。ctx は world座標) */
function drawLifted(ctx) {
  const t = sel.lift;
  ctx.save();
  ctx.translate(flip.dx / cam.z, sel.top);
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  ctx.translate(t.ax + t.dx, t.ay + t.dy);
  ctx.scale(t.s, t.s);
  ctx.translate(-t.ax, -t.ay);
  // 段の順に: 塗り → 線画 → 影(乗算) → 白 → 文字
  const drawFloat = (L) => {
    for (const x of sel.floats || []) {
      if (x.L !== L) continue;
      const [x0, y0, x1, y1] = x.f.box;
      ctx.save();
      if (L === 's') ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(x.f.img, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
  };
  drawFloat('u');
  drawStrokes(ctx, sel.strokes.filter((st) => !st.x));
  drawFloat('s');
  drawFloat('h');
  drawStrokes(ctx, sel.strokes.filter((st) => st.x));
  ctx.restore();
}

function startSelTool(e) {
  const [wx, wy] = toWorld(e);
  const base = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, moved: false };
  if (sel && !flip.dx) {
    const [x0, y0, x1, y1] = selScreenBox();
    if (Math.hypot(e.clientX - x1, e.clientY - y1) <= HANDLE_R + 14) {
      selOp = { ...base, kind: 'scale' };
      return true;
    }
    const pad = 10;
    if (e.clientX >= x0 - pad && e.clientX <= x1 + pad && e.clientY >= y0 - pad && e.clientY <= y1 + pad) {
      selOp = { ...base, kind: 'move', w0: [wx, wy] };
      return true;
    }
  }
  const hit = pageAt(wx, wy);
  if (!hit) { clearSel(); selOp = { ...base, kind: 'none' }; return true; }
  const ps = pageState(hit.id);
  if (!ps.strokes) { ensureLoaded(hit.id); return false; }
  clearSel();
  if (settings.tool === 'move') {
    const st = topStrokeAt(selTargets(ps.strokes), hit.x, hit.y, SEL_PICK / cam.z);
    if (st) { setSel(hit.id, hit.top, [st]); selOp = { ...base, kind: 'move', w0: [wx, wy] }; }
    else {
      selOp = { ...base, kind: 'none' };
      const L = resolveTarget(settings.selTarget);
      if (L && isRasterLayer(L)) toast(`${LAYERS[L].name}は範囲選択（投げ縄・四角）で囲んで動かす`);
    }
    return true;
  }
  selOp = { ...base, kind: settings.selMode === 'rect' ? 'rect' : 'lasso', pageId: hit.id, top: hit.top, pts: [[hit.x, hit.y]] };
  requestLive();
  return true;
}
function moveSelOp(e) {
  const o = selOp;
  o.cx = e.clientX; o.cy = e.clientY;
  if (!o.moved && Math.hypot(e.clientX - o.sx, e.clientY - o.sy) > 4) o.moved = true;
  if (o.kind === 'lasso' || o.kind === 'rect') {
    const evs = e.getCoalescedEvents?.() || [];
    for (const ev of evs.length ? evs : [e]) {
      const [wx, wy] = toWorld(ev);
      const x = wx, y = wy - o.top;
      if (o.kind === 'rect') o.pts[1] = [x, y];
      else {
        const l = o.pts[o.pts.length - 1];
        if (Math.hypot(x - l[0], y - l[1]) * cam.z >= 2) o.pts.push([x, y]);
      }
    }
    requestLive();
    return;
  }
  if (!o.moved || !sel || (o.kind !== 'move' && o.kind !== 'scale')) return;
  if (!sel.strokes.length && !sel.poly) return;
  if (!sel.lift) lift();
  const [wx, wy] = toWorld(e);
  const b = sel.box, t = sel.lift;
  if (o.kind === 'move') {
    // 選択の中心がページの外に出ないようにする(見えなくなって戻せなくなるのを防ぐ)
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    t.dx = clamp(cx + wx - o.w0[0], 0, PAGE_W) - cx;
    t.dy = clamp(cy + wy - o.w0[1], 0, PAGE_H) - cy;
  } else {
    // 左上を固定して、対角線の向きに引いた分だけ縦横同じ比率で拡大縮小
    const w = b[2] - b[0], h = b[3] - b[1];
    const px = wx - flip.dx / cam.z - b[0], py = wy - sel.top - b[1];
    const s = (px * w + py * h) / (w * w + h * h);
    t.s = clamp(s, Math.max(0.05, 6 / Math.max(w, h)), 10);
  }
  requestRender();
}
function endSelOp() {
  const o = selOp;
  selOp = null;
  if (o.kind === 'lasso' || o.kind === 'rect') { finishLasso(o); return; }
  if (o.kind === 'fill') { if (!o.moved) doFill(o.w0[0], o.w0[1]); return; }
  if (sel?.lift) commitLift();
  requestLive();
}
function cancelSelOp() {
  if (!selOp) return;
  selOp = null;
  if (sel?.lift) unlift();
  requestLive();
}
function finishLasso(o) {
  const ps = pageState(o.pageId);
  requestLive();
  if (!ps.strokes || !E.doc.pages.includes(o.pageId)) return;
  if (!o.moved) {
    // 囲まずにタップ → その位置の線を1本選ぶ
    const [x, y] = o.pts[0];
    const st = topStrokeAt(selTargets(ps.strokes), x, y, SEL_PICK / cam.z);
    if (st) setSel(o.pageId, o.top, [st]);
    return;
  }
  const poly = o.kind === 'rect' ? rectPoly(o.pts[0], o.pts[1] || o.pts[0]) : o.pts;
  if (poly.length < 3) return;
  const pb = polyBox(poly);
  // 塗り・影・白: 囲んだ中の画素も選ぶ(前の版の線データは、ここで画像に焼き込む。線として拾わないように先に)
  const rasters = selRasterLayers().filter((L) => rasterBase(o.pageId, L));
  const picked = selTargets(ps.strokes).filter((st) => fractionInPoly(st, poly, pb) >= 0.5);
  // 線が無くても、囲んだ範囲は選択として残す(塗りつぶしに使える)
  setSel(o.pageId, o.top, picked, poly.map((q) => q.slice()), rasters);
}
/** 動かし終わった: 変形した新しい線に差し替えて1手の履歴にする。
 *  画素は、抜いた画像に、切り出した画素を変形して貼った新しい段にする */
function commitLift() {
  const t = sel.lift;
  const ps = pageState(sel.pageId);
  const floats = sel.floats || [];
  ps.hidden = null;
  ps.swap = null;
  sel.floats = null;
  sel.lift = null;
  endInteractionSoon();
  if (t.s === 1 && !t.dx && !t.dy) { ps.rev++; sel.rev = ps.rev; requestRender(); return; }
  if (sel.poly) sel.poly = sel.poly.map(([x, y]) => [t.ax + (x - t.ax) * t.s + t.dx, t.ay + (y - t.ay) * t.s + t.dy]);
  if (!sel.strokes.length && !floats.length) { ps.rev++; sel.rev = ps.rev; sel.box = selBoxOf(sel); requestRender(); return; }
  const map = new Map(sel.strokes.map((st) => [st, transformStroke(st, t.ax, t.ay, t.s, t.dx, t.dy)]));
  const made = [];
  for (const x of floats) {
    pasteFloat(x.hole, x.f, t);
    const obj = makeRaster(x.L, x.hole, PAGE_W, PAGE_H);
    map.set(x.layer, obj);
    made.push([obj, x.layer]);
  }
  const before = ps.strokes;
  const after = before.map((st) => map.get(st) || st);
  setPageStrokes(sel.pageId, after);
  for (const [obj, old] of made) { startEncode(obj); releaseRaster(old); }
  pushHistory([{ pageId: sel.pageId, before, after }]);
  sel.strokes = sel.strokes.map((st) => map.get(st));
  sel.box = selBoxOf(sel);
  sel.rev = ps.rev;
  requestRender();
}
/** 選んだ画素について、段ごとに新しい画像を作る。edit(cv, layer, src) で書き換える。戻り値 Map(古い段 → 新しい段) */
function editSelPixels(edit) {
  const map = new Map();
  for (const L of sel.rasters || []) {
    const layer = rasterBase(sel.pageId, L);
    const src = layer && rasterSource(layer);
    if (!src) continue;
    const cv = copyLayer(layer, PAGE_W, PAGE_H);
    edit(cv, layer, src);
    map.set(layer, makeRaster(L, cv, PAGE_W, PAGE_H));
  }
  return map;
}
function settlePixels(map) {
  for (const [old, obj] of map) { startEncode(obj); releaseRaster(old); }
}
function deleteSel() {
  if (!sel || selOp || (!sel.strokes.length && !selHasPixels())) return;
  const { pageId } = sel;
  const gone = new Set(sel.strokes);
  // 画素: 囲んだ中を消した新しい段にする
  const pix = editSelPixels((cv) => clearPoly(cv, sel.poly));
  const before = pageState(pageId).strokes;
  const after = before.filter((st) => !gone.has(st)).map((st) => pix.get(st) || st);
  const n = before.length - after.length;
  sel = null;
  if ((n || pix.size) && setPageStrokes(pageId, after)) {
    settlePixels(pix);
    pushHistory([{ pageId, before, after }]);
    toast(n ? `${n}本の線${pix.size ? 'と、囲んだ中の塗り' : ''}を削除した` : '囲んだ中の塗りを削除した');
  }
  requestRender();
  requestLive();
}
/** 複製: 少しずらした位置に写しを作り、写しの方を選ぶ */
function duplicateSel() {
  if (!sel || selOp || (!sel.strokes.length && !selHasPixels())) return;
  const { pageId, top } = sel;
  const off = 40;
  const copies = sel.strokes.map((st) => transformStroke(st, 0, 0, 1, off, off));
  // 画素: 囲んだ中を切り出して、ずらした所に貼る
  const pix = editSelPixels((cv, layer, src) => {
    const f = extractPoly(src, sel.poly);
    if (f) pasteFloat(cv, f, { ax: 0, ay: 0, s: 1, dx: off, dy: off });
  });
  const before = pageState(pageId).strokes, after = addStrokes(before.map((st) => pix.get(st) || st), copies);
  if (!setPageStrokes(pageId, after)) return;
  settlePixels(pix);
  pushHistory([{ pageId, before, after }]);
  setSel(pageId, top, copies, sel.poly && sel.poly.map(([x, y]) => [x + off, y + off]), sel.rasters);
  requestRender();
}

/* ---- 塗りつぶし ----
   タップした所を、線で囲まれた範囲ごと塗る(文字ペンの線は見ない。塗りは文字の下に入る)。
   投げ縄・四角の選択があり、その中をタップしたときは、線に関係なく選択範囲を塗る */
function addToPage(pageId, news, bottom = false) {
  const before = pageState(pageId).strokes;
  const after = addStrokes(before, news, bottom);
  if (!setPageStrokes(pageId, after)) return false;
  pushHistory([{ pageId, before, after }]);
  requestRender();
  return true;
}
/** 選択範囲を塗る。塗りは選択に加えるので、そのまま動かせる */
function fillSel() {
  if (!sel?.poly || selOp) return;
  const f = polygonFill(sel.poly, fillColor());
  if (!f) return;
  const L = settings.fill.layer;
  if (isRasterLayer(L)) {
    // 塗り・影・白: 段の画像に塗り込み、その段の画素を選択に加える(そのまま動かせる)
    if (!commitRaster(sel.pageId, L, (g) => paintInto(g, f), polyBox(sel.poly))) return;
    sel.rasters = [...new Set([...(sel.rasters || []), L])];
  } else {
    if (!addToPage(sel.pageId, [toFillLayer(f)])) return;
    sel.strokes = sel.strokes.concat([f]);
  }
  sel.box = selBoxOf(sel);
  sel.rev = pageState(sel.pageId).rev;
  requestLive();
}
function startFillTool(e) {
  const [wx, wy] = toWorld(e);
  selOp = { id: e.pointerId, kind: 'fill', sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, moved: false, w0: [wx, wy] };
  return true;
}
async function doFill(wx, wy) {
  const hit = pageAt(wx, wy);
  if (sel?.poly && !sel.lift && hit?.id === sel.pageId && pointInPoly(hit.x, hit.y, sel.poly)) { fillSel(); return; }
  clearSel();
  if (!hit || !hit.inside) return;
  const ps = pageState(hit.id);
  if (!ps.strokes) { ensureLoaded(hit.id); return; }
  const strokes = ps.strokes;
  await ensureImages(strokes); // 画像の線も境目として使う
  if (ps.strokes !== strokes) return; // 待っている間に変わった
  const f = bucketFill(fillRefs(strokes), PAGE_W, PAGE_H, hit.x, hit.y, fillColor(), settings.fill.e);
  if (!f) return;
  const L = settings.fill.layer;
  if (isRasterLayer(L)) commitRaster(hit.id, L, (g) => paintInto(g, f), bbox(f)); // 塗り・影・白: 段の画像に塗り込む
  else addToPage(hit.id, [toFillLayer(f)]);
}
/* 塗りつぶしのレイヤー:
   線画 … 線画レイヤーを見て、線画レイヤーに塗る(今までどおり)
   塗り … 設定で選んだレイヤー(標準は線画)を見て、塗りレイヤー(いちばん下)に塗る。線の下に色を置く用
   影   … 設定で選んだレイヤーを見て、影レイヤーに塗る(乗算で重なる)。色は影ペンの色
   白   … 設定で選んだレイヤーを見て、白レイヤーに塗る(線・影の上、文字の下)。白抜き・モザイク用。色は白
   文字 … 文字レイヤーを見て、文字レイヤーに塗る。文字ペンで描いたフキダシ・描き文字の中を塗る用。
          文字レイヤーの塗りは文字の線より下に描くので、中の文字は隠れない */
const FILL_LAYERS = ['n', 'u', 's', 'h', 'x'];
const fillUsesRef = (L) => L === 'u' || L === 's' || L === 'h';
function fillRefs(strokes) {
  const L = settings.fill.layer;
  if (!fillUsesRef(L)) return strokes.filter((st) => layerOf(st) === L);
  const ref = settings.fill.ref;
  return strokes.filter((st) => ref[layerOf(st)]);
}
function toFillLayer(f) {
  const L = settings.fill.layer;
  if (L === 'u') f.u = 1;
  if (L === 's') f.s = 1;
  if (L === 'h') f.h = 1;
  if (L === 'x') { f.x = 1; f.b = 0; }
  return f;
}
/** 塗りつぶしの色: 影に塗るときは影ペンの色、白に塗るときは白(塗る先を変えるたびに色を選び直さなくていいように) */
const fillColor = () => (settings.fill.layer === 's' ? settings.shadowPen.c : settings.fill.layer === 'h' ? '#ffffff' : settings.fill.c);
/** 投げ縄の線・選択枠・拡大縮小ハンドル・操作ボタン(drawLive から。ctx は重ねキャンバス) */
function drawSelOverlay(ctx) {
  const o = selOp;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dashed = () => {
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#3b78d8';
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (o && o.moved && (o.kind === 'lasso' || o.kind === 'rect')) {
    const pts = o.kind === 'rect' ? rectPoly(o.pts[0], o.pts[1] || o.pts[0]) : o.pts;
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [sx, sy] = pageToScreen(o.top, x, y);
      if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(59,120,216,0.08)';
    ctx.fill();
    dashed();
  }
  let show = false;
  if (sel && !flip.dx) {
    const [x0, y0, x1, y1] = selScreenBox();
    if (sel.poly) {
      // 囲んだ形(塗りつぶしの範囲)を点線で、外接の枠は細い線で
      const t = sel.lift || { ax: 0, ay: 0, s: 1, dx: 0, dy: 0 };
      ctx.beginPath();
      sel.poly.forEach(([x, y], i) => {
        const [sx, sy] = pageToScreen(sel.top, t.ax + (x - t.ax) * t.s + t.dx, t.ay + (y - t.ay) * t.s + t.dy);
        if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,120,216,0.08)';
      ctx.fill();
      dashed();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(59,120,216,0.45)';
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = 'rgba(59,120,216,0.06)';
      ctx.fill();
      dashed();
    }
    ctx.beginPath();
    ctx.arc(x1, y1, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#3b78d8';
    ctx.stroke();
    if (!selOp) {
      show = true;
      const has = sel.strokes.length > 0;
      $('selFill').hidden = !sel.poly;
      $('selDup').disabled = $('selDel').disabled = !has && !selHasPixels();
      $('selFront').disabled = $('selBack').disabled = !has;
      placeSelBar(x0, y0, x1, y1);
    }
  }
  if (show !== selShown) { selShown = show; $('selBar').hidden = !show; }
}
function placeSelBar(x0, y0, x1, y1) {
  const bar = $('selBar');
  bar.hidden = false;
  const a = area();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = y0 - bh - 12;
  if (top < a.y0) top = y1 + HANDLE_R + 12;
  if (top + bh > viewH - 8) top = clamp(y0 + 12, a.y0, viewH - bh - 8);
  const left = clamp((x0 + x1) / 2 - bw / 2, a.x0, Math.max(a.x0, a.x1 - bw));
  bar.style.left = Math.round(left) + 'px';
  bar.style.top = Math.round(top) + 'px';
}
$('selDel').addEventListener('click', deleteSel);
$('selDup').addEventListener('click', duplicateSel);
$('selFill').addEventListener('click', fillSel);
$('selFront').addEventListener('click', () => reorderSel(false));
$('selBack').addEventListener('click', () => reorderSel(true));

/** 選んだ線・画像を、ふつうの線の段のいちばん上(前面)/いちばん下(背面)へ。
 *  塗りペン・文字ペンの線はそれぞれの段の中で動く */
function reorderSel(back) {
  if (!sel || selOp || !sel.strokes.length) return;
  const { pageId } = sel;
  const picked = new Set(sel.strokes);
  const before = pageState(pageId).strokes;
  const inOrder = before.filter((st) => picked.has(st));
  const after = addStrokes(before.filter((st) => !picked.has(st)), inOrder, back);
  if (after.every((st, i) => st === before[i])) return;
  if (!setPageStrokes(pageId, after)) return;
  pushHistory([{ pageId, before, after }]);
  toast(back ? '背面へ移した' : '前面へ移した');
  requestRender();
}

/* ---- 画像の取り込み ----
   画像は作品のデータの中に持つ(元のファイルとは紐づけない。元を消しても・動かしても崩れない)。
   大きすぎる画像はページの解像度(350dpi)より細かくても意味が無いので、長い辺 3541px までに縮める。
   取り込んだらページに置いて選択状態にし、移動ツールでそのまま位置・大きさを決められる。
   後からでも、選択すれば動かす・拡大縮小・前面/背面・削除ができる */
const IMG_MAX = Math.max(PAGE_W, PAGE_H);
async function importImage(file) {
  if (!E || !file) return;
  let bm;
  try { bm = await createImageBitmap(file); } catch (_) { toast('この画像は読み込めない'); return; }
  let w = bm.width, h = bm.height;
  let blob = file;
  const k = Math.min(1, IMG_MAX / Math.max(w, h));
  if (k < 1 || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bm, 0, 0, w, h);
    blob = await new Promise((res) => cv.toBlob(res, 'image/webp', 0.92));
    cv.width = cv.height = 0;
  } else {
    blob = new Blob([await file.arrayBuffer()], { type: file.type }); // File(元ファイルへの参照)ではなく中身を持つ
  }
  bm.close?.();
  if (!blob) { toast('画像の変換に失敗した'); return; }
  // 置く場所: 今見ているページの、画面に見えている部分の真ん中。ページの8割に収まる大きさ
  const i = currentPage(), id = E.doc.pages[i];
  const ps = pageState(id);
  if (!ps.strokes) { ensureLoaded(id); toast('ページを読み込み中。もう一度試して'); return; }
  const a = area();
  const cx = clamp(cam.x + (a.x0 + a.x1) / 2 / cam.z, 0, PAGE_W);
  const cy = clamp(cam.y + (a.y0 + a.y1) / 2 / cam.z - i * PITCH, 0, PAGE_H);
  const s = Math.min((PAGE_W * 0.8) / w, (PAGE_H * 0.8) / h);
  const iw = w * s, ih = h * s;
  const x0 = clamp(cx - iw / 2, 0, PAGE_W - iw), y0 = clamp(cy - ih / 2, 0, PAGE_H - ih);
  const st = makeImage(blob, x0, y0, x0 + iw, y0 + ih);
  selectTool('move');
  // 線の下(ふつうの段のいちばん下)に置く。前に出したいときは選択して「前面」
  if (!addToPage(id, [st], true)) return;
  setSel(id, i * PITCH, [st]);
  toast('画像を置いた。ドラッグで移動・右下の丸で大きさを変える');
}
$('imageBtn').addEventListener('click', () => $('imageFile').click());
$('imageFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  importImage(f);
});
// PCでは貼り付け(Ctrl+V)でも取り込める
window.addEventListener('paste', (e) => {
  if (!E || document.querySelector('dialog[open]')) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); importImage(f); }
});
$('selClear').addEventListener('click', clearSel);

/** 消しゴムで塗りに当たった所を、表示の上だけ抜く(離すまでの見た目)。
 *  circles を渡せばその円だけ、無ければそのページで覚えている円を全部 */
function applyCuts(ctx, pageId, circles) {
  const cut = erasing?.cuts.get(pageId);
  if (!cut) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  for (const [x, y, r] of circles || cut.circles) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
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
  if (!gest) gest = { t0: now(), max: 0, moved: false, start: new Map(), ref: null, vel: [], cam0: { ...cam } };
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
      // 触っただけでぶれないよう、横に一定以上・縦より大きく動いてから追従を始める(設定「めくりの軽さ」)。
      // 指2本でつまんだ後に残った1本は何もしない
      if (gest.max === 1 && !flip.anim) {
        const s0 = gest.start.get(e.pointerId);
        if (!gest.flipping && s0) {
          const tx = Math.abs(t.x - s0.x), ty = Math.abs(t.y - s0.y);
          const fe = flipEase();
          if (tx > fe.start && tx > ty * fe.ratio) gest.flipping = true;
        }
        if (gest.flipping) {
          // 隣が無い方向(1ページ目の前)はゴムのように少しだけ動く
          const nd = flip.dx + dx;
          flip.dx = canFlipSide(nd > 0 ? -1 : 1) ? nd : flip.dx + dx * 0.3;
        }
      }
    } else {
      // 指2本(送りモード)/縦スクロールモード: 移動と拡大。
      // 指を置いている間は動ける範囲の外にも動かせる(端の先は重くなる)。離したら範囲内へ戻す
      if (flip.dx && !flip.anim) animateFlip(0);
      if (!gest.raw) gest.raw = { x: cam.x, y: cam.y };
      cam.x = gest.raw.x; cam.y = gest.raw.y;
      if (cur.n >= 2 && ref.d > 0 && cur.d > 0) zoomAt(cur.cx, cur.cy, cur.d / ref.d);
      cam.x -= dx / cam.z;
      cam.y -= dy / cam.z;
      gest.raw = { x: cam.x, y: cam.y };
      clampCam();
      const RUBBER = 0.45;
      cam.x += (gest.raw.x - cam.x) * RUBBER;
      cam.y += (gest.raw.y - cam.y) * RUBBER;
    }
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
  if (touches.size) { gest.ref = touchInfo(); gest.vel = []; gest.raw = null; return; }
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
    const fe = flipEase();
    const th = Math.min(viewW * fe.commit, 160);
    if (flip.dx > 0 && (flip.dx > th || vx > fe.speed) && canFlipSide(-1)) flipCommit(-1);
    else if (flip.dx < 0 && (flip.dx < -th || vx < -fe.speed) && canFlipSide(1)) flipCommit(1);
    else animateFlip(0);
    return;
  } else if (g.max === 1 && g.vel.length >= 2 && !pageMode()) {
    const a = g.vel[0], b = g.vel[g.vel.length - 1];
    const dt = b.t - a.t;
    if (dt > 0 && now() - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
  }
  if (!inertia) { settleCam(); endInteractionSoon(); }
}
/** 範囲の外に出ていたら、範囲内へ滑らかに戻す */
function settleCam() {
  const from = { x: cam.x, y: cam.y };
  clampCam();
  const to = { x: cam.x, y: cam.y };
  if (Math.abs(to.x - from.x) * cam.z < 0.5 && Math.abs(to.y - from.y) * cam.z < 0.5) return;
  cam.x = from.x; cam.y = from.y;
  const t0 = now();
  beginInteraction();
  const step = () => {
    const t = Math.min(1, (now() - t0) / 200);
    const k = 1 - Math.pow(1 - t, 3);
    cam.x = from.x + (to.x - from.x) * k;
    cam.y = from.y + (to.y - from.y) * k;
    requestRender();
    if (t < 1 && !gest) requestAnimationFrame(step);
    else endInteractionSoon();
  };
  requestAnimationFrame(step);
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
  // 掌でページが動いた直後にペンが触れた → 掌の動きはなかったことにする
  if (gest && now() - gest.t0 < 1500) {
    Object.assign(cam, gest.cam0);
    if (flip.dx && !flip.anim) flip.dx = 0;
    clampCam();
    requestRender();
  }
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
    const fing = drawing?.finger ? drawing : erasing?.finger ? erasing : selOp?.finger ? selOp : null;
    if (fing) {
      if (drawing) cancelStroke(); else if (erasing) endErase(); else cancelSelOp();
      touchDown({ pointerId: fing.id, clientX: fing.cx, clientY: fing.cy });
      capture(e.pointerId);
      touchDown(e);
      return;
    }
    // ペンを使っている最中・直後の指は掌とみなして無視
    if (drawing || erasing || selOp || now() - penSeenAt < 400) return;
    if (settings.fingerDraw && !touches.size && !gest) {
      capture(e.pointerId);
      if (startTool(e)) { for (const o of [drawing, erasing, selOp]) if (o) o.finger = true; return; }
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
  if (drawing || erasing || selOp || flipping()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  capture(e.pointerId);
  startTool(e);
});
function startTool(e) {
  if (wantsEraser(e)) { startErase(e); return true; }
  if (isBlurTool()) { startErase(e, 'blur'); return true; }
  if (isSelTool()) return startSelTool(e);
  if (settings.tool === 'fill') return startFillTool(e);
  return startStroke(e);
}

stage.addEventListener('pointermove', (e) => {
  if (!E) return;
  if (e.pointerType === 'pen' && e.buttons) penSeenAt = now();
  if (drawing && e.pointerId === drawing.id) { moveStroke(e); return; }
  if (erasing && e.pointerId === erasing.id) { moveErase(e); return; }
  if (selOp && e.pointerId === selOp.id) { moveSelOp(e); return; }
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
  // ホバー(ペンを浮かせている/マウス): 消しゴム・ぼかしの円を出す
  if (isEraserTool() || isBlurTool() || (e.pointerType === 'pen' && wantsEraser(e))) {
    cursor = { x: e.clientX, y: e.clientY };
    requestLive();
  } else if (cursor) { cursor = null; requestLive(); }
});

function pointerEnd(e) {
  if (!E) return;
  if (e.pointerType === 'pen') penSeenAt = now();
  if (drawing && e.pointerId === drawing.id) {
    // キャンセル(OSに奪われた等)でも描いた分は残す
    endStroke(e);
    return;
  }
  if (erasing && e.pointerId === erasing.id) { endErase(); return; }
  if (selOp && e.pointerId === selOp.id) { endSelOp(); return; }
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
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel(); return; }
  if (e.key === 'Escape' && sel) { clearSel(); return; }
  if (k === 'e') selectTool('eraser');
  else if (k === 'r') selectTool('blur');
  else if (k === 'v') selectTool('move');
  else if (k === 'l') selectTool('select');
  else if (k === 'g') selectTool('fill');
  else if (k === 't') selectTool('pen' + TEXT_PEN);
  else if (k === 'u') selectTool('pen' + UNDER_PEN);
  else if (k === 's') selectTool('pen' + SHADOW_PEN);
  else if (k === 'w') selectTool('pen' + WHITE_PEN);
  else if (k === '1' || k === '2' || k === '3') selectTool('pen' + (Number(k) - 1));
  else if (k === 'b' || k === 'p') selectTool(settings.lastPen);
  else if (e.key === 'PageDown') goNext();
  else if (e.key === 'PageUp') goPrev();
  else if (e.key === 'ArrowLeft') flipTo(-1);
  else if (e.key === 'ArrowRight') flipTo(1);
});

/* ============================================================
   道具ドック
   ============================================================ */
/** 道具ボタンの左上に、相手にするレイヤーの印を付ける */
function setLayerChip(btn, target) {
  let chip = btn.querySelector('.layer-chip');
  if (!chip) { chip = document.createElement('span'); chip.className = 'layer-chip'; btn.appendChild(chip); }
  const L = LAYERS[resolveTarget(target) || 'all'];
  chip.textContent = L.label;
  chip.style.background = L.chip;
  chip.classList.toggle('auto', target === 'auto'); // 直前のペンに合わせているときは点線で囲む
  chip.title = `対象: ${targetName(target)}（タップで切り替え）`;
}
/** 印をタップ: 対象のレイヤーを 全部→線画→塗り→文字→全部… と切り替える */
function cycleTarget(key, what) {
  const i = TARGETS.indexOf(settings[key]);
  settings[key] = TARGETS[(i + 1) % TARGETS.length];
  saveSettings();
  renderDock();
  toast(`${what}: ${targetName(settings[key])}`);
}
for (const [id, key, what] of [['eraserBtn', 'eraseTarget', '消しゴム'], ['moveBtn', 'selTarget', '選択・移動'], ['selectBtn', 'selTarget', '選択・移動']]) {
  // ボタン本体のクリックより先に拾い、道具の切り替えはさせない
  $(id).addEventListener('click', (e) => {
    if (!e.target.closest('.layer-chip')) return;
    e.stopImmediatePropagation();
    cycleTarget(key, what);
  }, true);
}
// 塗りつぶしの印: 塗る先を 線画→塗り→影→白→文字 の順に切り替える
$('fillBtn').addEventListener('click', (e) => {
  if (!e.target.closest('.layer-chip')) return;
  e.stopImmediatePropagation();
  const i = FILL_LAYERS.indexOf(settings.fill.layer);
  setFill({ layer: FILL_LAYERS[(i + 1) % FILL_LAYERS.length] });
  toast(`塗りつぶし: ${fillModeName()}`);
}, true);
function fillModeName() {
  const L = settings.fill.layer;
  if (L === 'n') return '線画に塗る';
  if (L === 'x') return '文字に塗る（文字を見る）';
  const refs = FILL_LAYERS.filter((k) => settings.fill.ref[k]).map((k) => LAYERS[k].name);
  return `${LAYERS[L].name}に塗る（${refs.join('・') || '何も'}を見る）`;
}
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
  badge.textContent = settings.eraserMode === 'part' ? '部分' : '線ごと';
  setLayerChip(eb, settings.eraseTarget);
  const blb = $('blurBtn');
  blb.classList.toggle('active', isBlurTool());
  blb.querySelector('.pen-w').textContent = settings.blur.size;
  setLayerChip(blb, settings.blur.target);
  setLayerChip($('moveBtn'), settings.selTarget);
  setLayerChip($('selectBtn'), settings.selTarget);
  setLayerChip($('fillBtn'), settings.fill.layer);
  $('moveBtn').classList.toggle('active', settings.tool === 'move');
  const sb = $('selectBtn');
  sb.classList.toggle('active', settings.tool === 'select');
  sb.querySelector('.mode-badge').textContent = settings.selMode === 'rect' ? '四角' : '投縄';
  const tb = $('textPenBtn');
  tb.classList.toggle('active', settings.tool === 'pen' + TEXT_PEN);
  tb.querySelector('.text-ico').style.color = settings.textPen.c;
  tb.querySelector('.mode-badge').textContent = `フチ${settings.textPen.b}`;
  const ub = $('underPenBtn');
  ub.classList.toggle('active', settings.tool === 'pen' + UNDER_PEN);
  ub.querySelector('.under-ico').style.background = settings.underPen.c;
  ub.querySelector('.pen-w').textContent = settings.underPen.w;
  const fb = $('fillBtn');
  fb.classList.toggle('active', settings.tool === 'fill');
  fb.querySelector('.fill-dot').style.background = fillColor();
  const shb = $('shadowPenBtn');
  shb.classList.toggle('active', settings.tool === 'pen' + SHADOW_PEN);
  shb.querySelector('.shadow-ico').style.background = settings.shadowPen.c;
  shb.querySelector('.pen-w').textContent = settings.shadowPen.w;
  const whb = $('whitePenBtn');
  whb.classList.toggle('active', settings.tool === 'pen' + WHITE_PEN);
  whb.querySelector('.mode-badge').textContent = WHITE_MODE[settings.whitePen.m];
  $('dock').classList.toggle('right', settings.dockSide === 'right');
}
function selectTool(t) {
  settings.tool = t;
  if (t.startsWith('pen')) settings.lastPen = t;
  if (t !== 'select' && t !== 'move' && t !== 'fill') clearSel();
  saveSettings();
  renderDock();
  if (!isEraserTool() && !isBlurTool() && cursor) { cursor = null; requestLive(); }
}
$('eraserBtn').addEventListener('click', () => {
  if (isEraserTool()) openEraserDialog();
  else selectTool('eraser');
});
$('blurBtn').addEventListener('click', () => {
  if (isBlurTool()) openBlurDialog();
  else selectTool('blur');
});
// ぼかしの印: 対象を 全部→塗り→影→白 の順に切り替える
const BLUR_TARGETS = ['all', 'u', 's', 'h'];
$('blurBtn').addEventListener('click', (e) => {
  if (!e.target.closest('.layer-chip')) return;
  e.stopImmediatePropagation();
  const i = BLUR_TARGETS.indexOf(settings.blur.target);
  settings.blur.target = BLUR_TARGETS[(i + 1) % BLUR_TARGETS.length];
  saveSettings();
  renderDock();
  toast(`ぼかし: ${settings.blur.target === 'all' ? '塗り・影・白' : LAYERS[settings.blur.target].name}`);
}, true);
/* ---- ぼかしの設定 ---- */
function openBlurDialog() {
  $('blurSize').value = settings.blur.size;
  $('blurSizeOut').textContent = settings.blur.size;
  $('blurStr').value = settings.blur.str;
  $('blurStrOut').textContent = settings.blur.str;
  for (const r of document.querySelectorAll('input[name=blurTarget]')) r.checked = r.value === settings.blur.target;
  $('blurDlg').showModal();
}
const setBlur = (patch) => { Object.assign(settings.blur, patch); saveSettings(); renderDock(); };
$('blurSize').addEventListener('input', (e) => { const v = Number(e.target.value); $('blurSizeOut').textContent = v; setBlur({ size: v }); });
$('blurStr').addEventListener('input', (e) => { const v = Number(e.target.value); $('blurStrOut').textContent = v; setBlur({ str: v }); });
for (const r of document.querySelectorAll('input[name=blurTarget]')) r.addEventListener('change', () => setBlur({ target: r.value }));
$('moveBtn').addEventListener('click', () => selectTool('move'));
$('underPenBtn').addEventListener('click', () => {
  if (settings.tool === 'pen' + UNDER_PEN) openPenDialog(UNDER_PEN);
  else selectTool('pen' + UNDER_PEN);
});
$('textPenBtn').addEventListener('click', () => {
  if (settings.tool === 'pen' + TEXT_PEN) openPenDialog(TEXT_PEN);
  else selectTool('pen' + TEXT_PEN);
});
$('shadowPenBtn').addEventListener('click', () => {
  if (settings.tool === 'pen' + SHADOW_PEN) openPenDialog(SHADOW_PEN);
  else selectTool('pen' + SHADOW_PEN);
});
$('whitePenBtn').addEventListener('click', () => {
  if (settings.tool === 'pen' + WHITE_PEN) openPenDialog(WHITE_PEN);
  else selectTool('pen' + WHITE_PEN);
});
$('fillBtn').addEventListener('click', () => {
  if (settings.tool === 'fill') openFillDialog();
  else selectTool('fill');
});
$('selectBtn').addEventListener('click', () => {
  if (settings.tool === 'select') openSelectDialog();
  else selectTool('select');
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
  const p = penOf(i);
  const text = i === TEXT_PEN, under = i === UNDER_PEN, shadow = i === SHADOW_PEN, white = i === WHITE_PEN;
  $('penDlgTitle').textContent = text ? '文字ペン（いつも一番上に描く）' : under ? '塗りペン（いつも一番下に描く）'
    : shadow ? '影ペン（線画の上に乗算で重なる）' : white ? '白ペン（線・影の上、文字の下に描く）' : 'ペン';
  $('penOpacityRow').hidden = text || under || shadow || white;
  $('penBorderRow').hidden = !text;
  $('penWidth').max = under || shadow || white ? 300 : 120;
  $('penBorder').value = settings.textPen.b;
  $('penBorderOut').textContent = settings.textPen.b;
  // 白ペンは色を選ばない
  $('penColors').hidden = $('penColorRow').hidden = white;
  $('penShadowNote').hidden = !shadow;
  $('penWhiteBox').hidden = !white;
  if (white) for (const r of document.querySelectorAll('input[name=whiteMode]')) r.checked = r.value === p.m;
  $('penBlur').value = p.bl || 0;
  $('penBlurOut').textContent = p.bl || 0;
  $('penAlpha').value = p.a ?? 1;
  $('penAlphaOut').textContent = Math.round((p.a ?? 1) * 100);
  $('penDot').value = p.ds ?? 3;
  $('penDotOut').textContent = p.ds ?? 3;
  $('penDens').value = p.dn ?? 4;
  $('penDensOut').textContent = p.dn ?? 4;
  syncPenRows();
  const sw = $('penColors');
  sw.innerHTML = '';
  for (const col of shadow ? SHADOW_COLORS : COLORS) {
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
/** 影ペン・白ペンの種類で、出す設定を切り替える */
function syncPenRows() {
  const p = penOf(editingPen);
  const shadow = editingPen === SHADOW_PEN, white = editingPen === WHITE_PEN;
  const m = white ? p.m : '';
  $('penBlurRow').hidden = !(shadow || m === 'air');
  $('penAlphaRow').hidden = !(m === 'air' || m === 'spray');
  $('penDotRow').hidden = $('penDensRow').hidden = m !== 'spray';
  $('penPressureLabel').textContent = m === 'spray' ? '筆圧で粒の量を変える' : '筆圧で太さを変える';
  $('penWidthLabel').textContent = m === 'spray' ? 'スプレーの幅' : '太さ';
  $('whiteModeNote').textContent = m === 'flat' ? 'くっきりした不透明な白。白抜き・修正・モザイクの下地に'
    : m === 'air' ? 'ふちがぼけた白（濃さで半透明にもできる）。吐息・もやに'
    : m === 'spray' ? '細かい粒をまく。吐息の粒・キラキラに。部分消しは円に入った粒だけ消える' : '';
}
for (const r of document.querySelectorAll('input[name=whiteMode]')) {
  r.addEventListener('change', () => { updatePen({ m: r.value }); syncPenRows(); });
}
$('penBlur').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penBlurOut').textContent = v;
  updatePen({ bl: v });
});
$('penAlpha').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penAlphaOut').textContent = Math.round(v * 100);
  updatePen({ a: v });
});
$('penDot').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penDotOut').textContent = v;
  updatePen({ ds: v });
});
$('penDens').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('penDensOut').textContent = v;
  updatePen({ dn: v });
});
function syncOpacityInputs() {
  const p = penOf(editingPen);
  const v = { ...OPACITY_DEFAULTS, ...Object.fromEntries(Object.entries({ omin: p.omin, ofull: p.ofull, ogamma: p.ogamma }).filter(([, x]) => x !== undefined)) };
  $('penOmin').value = v.omin;
  $('penOminOut').textContent = Math.round(v.omin * 100);
  $('penOfull').value = v.ofull;
  $('penOfullOut').textContent = Math.round(v.ofull * 100);
  $('penOgamma').value = v.ogamma;
  $('penOgammaOut').textContent = v.ogamma.toFixed(2);
}
function updatePen(patch) {
  Object.assign(penOf(editingPen), patch);
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
$('penBorder').addEventListener('input', (e) => {
  const b = Number(e.target.value);
  $('penBorderOut').textContent = b;
  updatePen({ b });
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
  const p = penOf(editingPen);
  const special = editingPen >= TEXT_PEN;
  $('penOpacityBox').hidden = !p.op || special;
  $('penOpacityNote').hidden = !(p.op && isWhite(p.c)) || special;
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
  const p = penOf(editingPen);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p.c.toLowerCase() === '#ffffff' ? '#cfd4d9' : '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const s = previewScale();
  const st = penStroke(p);
  if (st.x || st.s || st.h) {
    // 文字ペン: フチが見えるよう、背景に斜線(下書きの絵の代わり)を引く。
    // 影ペン・白ペン: 線の上でどう見えるか分かるよう、濃い斜線を引く(影は線を残して暗く、白は線を隠す)
    ctx.strokeStyle = st.x ? '#b9bfc5' : '#3d444b';
    ctx.lineWidth = Math.max(1, (st.x ? 3 : 2.5) * s);
    ctx.beginPath();
    for (let x = -cv.height; x < cv.width; x += Math.max(8, 26 * s)) { ctx.moveTo(x, cv.height); ctx.lineTo(x + cv.height, 0); }
    ctx.stroke();
  }
  ctx.setTransform(s, 0, 0, s, 0, 0);
  // 文字ペンは前に描いた線の中身を、後の線のフチより上に描き直す
  const plain = { ...st, x: 0, b: 0 };
  const done = [];
  const drawOne = (pts, last) => {
    if (st.s || st.h) {
      // 影(乗算)・白(ぼかし・濃さ・粒)は、保存するときと同じ形のストロークにして描く。
      // スプレーの粒は決まった並びの乱数で作るので、描き直しても動かない
      let q;
      if (st.k === 'd') {
        const sp = sprayer(p, seededRandom(done.length * 7919 + 17));
        for (const a of pts) sp.add(a[0], a[1], a[2]);
        q = { ...st, p: new Float32Array(sp.dots) };
      } else {
        q = { ...st, p: new Float32Array(pts.flat()) };
      }
      if (q.p.length) drawStroke(ctx, q);
      done.push(pts);
      return;
    }
    drawLiveStroke(ctx, st, pts, last, () => { for (const q of done) drawLiveStroke(ctx, plain, q, true); });
    done.push(pts);
  };
  if (!testStrokes.length && !testDraw) {
    // 見本: 筆圧が 弱→強→弱 と変わる線
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const x = (40 + t * (cv.width - 80)) / s;
      const y = (cv.height / 2 + Math.sin(t * Math.PI * 2) * cv.height * 0.22) / s;
      pts.push([x, y, Math.pow(Math.sin(t * Math.PI), 1.2) * 0.95 + 0.05]);
    }
    drawOne(pts, true);
  }
  for (const pts of testStrokes) drawOne(pts, true);
  if (testDraw?.length) drawOne(testDraw, false);
}
function testPoint(e) {
  const cv = $('penPreview');
  const r = cv.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  const s = previewScale();
  const pr = pressureOf(e);
  testDraw.push([((e.clientX - r.left) * d) / s, ((e.clientY - r.top) * d) / s, pr]);
  const st = penStroke(penOf(editingPen));
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
  for (const r of document.querySelectorAll('input[name=eraseTarget]')) r.checked = r.value === settings.eraseTarget;
  syncLayerNote();
  $('eraserSize').value = settings.eraserSize;
  $('eraserSizeOut').textContent = settings.eraserSize;
  $('eraserDlg').showModal();
}
for (const [name, key] of [['eraseTarget', 'eraseTarget'], ['selTarget', 'selTarget']]) {
  for (const r of document.querySelectorAll(`input[name=${name}]`)) {
    r.addEventListener('change', () => { settings[key] = r.value; saveSettings(); renderDock(); syncLayerNote(); });
  }
}
function syncLayerNote() {
  const name = LAYERS[penLayer()].name;
  $('eraseAutoNote').textContent = `今は${name}`;
  $('selAutoNote').textContent = `今は${name}`;
}
for (const r of document.querySelectorAll('input[name=eraserMode]')) {
  r.addEventListener('change', () => { settings.eraserMode = r.value; saveSettings(); renderDock(); });
}
$('eraserSize').addEventListener('input', (e) => {
  settings.eraserSize = Number(e.target.value);
  $('eraserSizeOut').textContent = settings.eraserSize;
  saveSettings();
});

/* ---- 塗りつぶしの設定 ---- */
function openFillDialog() {
  const sw = $('fillColors');
  sw.innerHTML = '';
  const L = settings.fill.layer;
  const cur = fillColor();
  for (const col of L === 's' ? SHADOW_COLORS : COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (col.toLowerCase() === cur.toLowerCase() ? ' active' : '');
    b.style.background = col;
    b.title = col;
    b.addEventListener('click', () => { setFillColor(col); openFillDialog(); });
    sw.appendChild(b);
  }
  // 白に塗るときは色を選ばない。影に塗るときは影ペンの色を変える
  sw.hidden = $('fillColorRow').hidden = L === 'h';
  $('fillColorNote').textContent = L === 's' ? '影の色（影ペンと同じ色を使う。白に近いほど薄い影）' : L === 'h' ? '白に塗る（色は白で決まり）' : '';
  $('fillColorNote').hidden = L !== 's' && L !== 'h';
  $('fillColorInput').value = cur;
  $('fillExpand').value = settings.fill.e;
  $('fillExpandOut').textContent = settings.fill.e;
  for (const r of document.querySelectorAll('input[name=fillLayer]')) r.checked = r.value === settings.fill.layer;
  for (const k of FILL_LAYERS) $('fillRef_' + k).checked = !!settings.fill.ref[k];
  syncFillRef();
  if (!$('fillDlg').open) $('fillDlg').showModal();
}
function syncFillRef() {
  $('fillRefBox').hidden = !fillUsesRef(settings.fill.layer);
  $('fillModeNote').textContent = `今: ${fillModeName()}`;
}
for (const r of document.querySelectorAll('input[name=fillLayer]')) {
  r.addEventListener('change', () => { setFill({ layer: r.value }); openFillDialog(); });
}
for (const k of FILL_LAYERS) {
  $('fillRef_' + k).addEventListener('change', (e) => {
    setFill({ ref: { ...settings.fill.ref, [k]: e.target.checked } });
    syncFillRef();
  });
}
function setFill(patch) {
  Object.assign(settings.fill, patch);
  saveSettings();
  renderDock();
}
/** 塗りつぶしの色を変える。影に塗るときは影ペンの色を変える(白は変えない) */
function setFillColor(c) {
  const L = settings.fill.layer;
  if (L === 'h') return;
  if (L === 's') { settings.shadowPen.c = c; saveSettings(); renderDock(); return; }
  setFill({ c });
}
$('fillColorInput').addEventListener('input', (e) => setFillColor(e.target.value));
$('fillColorInput').addEventListener('change', () => openFillDialog());
$('fillExpand').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('fillExpandOut').textContent = v;
  setFill({ e: v });
});

/* ---- 範囲選択の設定 ---- */
function openSelectDialog() {
  for (const r of document.querySelectorAll('input[name=selMode]')) r.checked = r.value === settings.selMode;
  for (const r of document.querySelectorAll('input[name=selTarget]')) r.checked = r.value === settings.selTarget;
  syncLayerNote();
  $('selectDlg').showModal();
}
for (const r of document.querySelectorAll('input[name=selMode]')) {
  r.addEventListener('change', () => { settings.selMode = r.value; saveSettings(); renderDock(); });
}

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
  doc.pages.forEach((id) => {
    const el = document.createElement('div');
    el.className = 'pg' + (pgSelected.has(id) ? ' checked' : '');
    el.dataset.id = id;
    const th = document.createElement('div');
    th.className = 'pg-thumb';
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
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
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pg-more';
    more.textContent = '⋯';
    more.title = 'このページの操作';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      const i = E.doc.pages.indexOf(id);
      if (i >= 0) showPageMenu(i, r.right, r.bottom);
    });
    row.append(num, more);
    el.append(th, row);
    el.addEventListener('click', () => {
      if (now() - pgDragEndAt < 400) return; // 並べ替えのドラッグの後に来るクリックは無視
      if (pgSelectMode) {
        if (pgSelected.has(id)) pgSelected.delete(id); else pgSelected.add(id);
        el.classList.toggle('checked', pgSelected.has(id));
        updatePgFoot();
        return;
      }
      const i = E.doc.pages.indexOf(id);
      if (i < 0) return;
      $('pagesDlg').close();
      showPage(i);
    });
    grid.appendChild(el);
  });
  labelPageGrid();
  updatePgFoot();
}
/** ページ番号と「表示中」の印を、今の並びで付け直す */
function labelPageGrid() {
  const curId = E.doc.pages[currentPage()];
  [...$('pageGrid').children].forEach((el, i) => {
    const isCur = el.dataset.id === curId;
    el.classList.toggle('cur', isCur);
    el.querySelector('.pg-num').textContent = isCur ? `${i + 1}（表示中）` : String(i + 1);
  });
}

/* ---- ページ一覧: ドラッグで並べ替え ----
   ペン・マウス … サムネイルをそのままドラッグ
   指         … 横にスワイプして動かし始めるか、長押ししてからドラッグ(縦に動かすと一覧のスクロール)
   ドラッグ中は他のページが滑らかによけ、一覧の上下の端に近づけると自動でスクロールする */
let pgDrag = null;    // { pid, el, type, sx, sy, x, y, active, timer, ghost, offX, offY, raf }
let pgDragEndAt = -1e9;
const PG_LONGPRESS = 300;

function pgDragStart() {
  const d = pgDrag;
  if (!d || d.active) return;
  clearTimeout(d.timer);
  d.active = true;
  const grid = $('pageGrid');
  try { grid.setPointerCapture(d.pid); } catch (_) {}
  const th = d.el.querySelector('.pg-thumb');
  const r = th.getBoundingClientRect();
  d.offX = d.sx - r.left;
  d.offY = d.sy - r.top;
  const ghost = th.cloneNode(true);
  ghost.classList.add('pg-ghost');
  ghost.style.width = r.width + 'px';
  ghost.style.height = r.height + 'px';
  $('pagesDlg').appendChild(ghost); // モーダルの上に出すため、ダイアログの中に置く
  d.ghost = ghost;
  d.el.classList.add('dragging');
  grid.classList.add('reordering');
  navigator.vibrate?.(15);
  pgDragMove();
  d.raf = requestAnimationFrame(pgAutoScroll);
}
function pgDragMove() {
  const d = pgDrag;
  d.ghost.style.transform = `translate(${d.x - d.offX}px, ${d.y - d.offY}px) scale(1.06)`;
  // 指の下にあるページの位置へ、ドラッグ中のページを差し込む
  const grid = $('pageGrid');
  const under = document.elementsFromPoint(d.x, d.y).find((n) => n.classList?.contains('pg') && n.parentElement === grid);
  if (!under || under === d.el || under.getAnimations().length) return;
  const kids = [...grid.children];
  const from = kids.indexOf(d.el), to = kids.indexOf(under);
  const before = new Map(kids.map((k) => [k, k.getBoundingClientRect()]));
  if (to > from) under.after(d.el); else under.before(d.el);
  labelPageGrid(); // 番号は動かしながら付け直す
  // FLIP: 動いたページを元の位置から新しい位置へ滑らせる
  for (const k of kids) {
    if (k === d.el) continue;
    const a = before.get(k), b = k.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) k.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }
}
function pgAutoScroll() {
  const d = pgDrag;
  if (!d?.active) return;
  const grid = $('pageGrid');
  const r = grid.getBoundingClientRect();
  const edge = Math.min(70, r.height / 4);
  let v = 0;
  if (d.y < r.top + edge) v = -(r.top + edge - d.y) / edge;
  else if (d.y > r.bottom - edge) v = (d.y - (r.bottom - edge)) / edge;
  if (v) grid.scrollTop += clamp(v, -1, 1) * 14;
  // スクロールした時や、よけるアニメーションが終わった時にも差し込み先を見直す
  pgDragMove();
  d.raf = requestAnimationFrame(pgAutoScroll);
}
function pgDragFinish() {
  const d = pgDrag;
  pgDrag = null;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  pgDragEndAt = now();
  d.ghost.remove();
  d.el.classList.remove('dragging');
  const grid = $('pageGrid');
  grid.classList.remove('reordering');
  const order = [...grid.children].map((k) => k.dataset.id);
  const pages = E.doc.pages;
  if (order.length !== pages.length || order.every((id, i) => id === pages[i])) return;
  const viewing = pages[currentPage()];
  pages.splice(0, pages.length, ...order);
  // 縦スクロール表示では、見ていたページをそのまま見せ続ける
  if (!pageMode()) showPage(pages.indexOf(viewing), cam.z);
  labelPageGrid();
  afterPageOp({ regrid: false });
  const n = pages.indexOf(d.el.dataset.id) + 1;
  toast(`${n}ページ目へ移動した`);
}
{
  const grid = $('pageGrid');
  grid.addEventListener('pointerdown', (e) => {
    if (pgDrag || !E) return;
    const el = e.target.closest('.pg');
    if (!el || el.parentElement !== grid || e.target.closest('.pg-more')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pgDrag = { pid: e.pointerId, el, type: e.pointerType, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, active: false, timer: 0 };
    if (e.pointerType === 'mouse') e.preventDefault(); // ドラッグで文字選択が始まらないように
    if (e.pointerType === 'touch') pgDrag.timer = setTimeout(pgDragStart, PG_LONGPRESS);
  });
  grid.addEventListener('pointermove', (e) => {
    const d = pgDrag;
    if (!d || e.pointerId !== d.pid) return;
    d.x = e.clientX; d.y = e.clientY;
    if (d.active) { pgDragMove(); return; }
    const dx = Math.abs(d.x - d.sx), dy = Math.abs(d.y - d.sy);
    if (Math.max(dx, dy) < 8) return;
    // 指: 横に動かしたら並べ替え、縦ならスクロールに任せる。ペン・マウスはどちらでも並べ替え
    if (d.type !== 'touch' || dx > dy * 1.2) pgDragStart();
    else { clearTimeout(d.timer); pgDrag = null; }
  });
  grid.addEventListener('pointerup', pgDragFinish);
  grid.addEventListener('pointercancel', pgDragFinish);
  // 並べ替え中(と、ペン・マウスで押している間)は一覧をスクロールさせない
  grid.addEventListener('touchmove', (e) => {
    if (pgDrag && (pgDrag.active || pgDrag.type !== 'touch')) e.preventDefault();
  }, { passive: false });
  grid.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しのメニューを出さない
  $('pagesDlg').addEventListener('close', () => {
    if (pgDrag?.active) pgDragFinish();
    else if (pgDrag) { clearTimeout(pgDrag.timer); pgDrag = null; }
  });
}
function updatePgFoot() {
  const n = pageCount();
  $('pgSelectBtn').textContent = pgSelectMode ? '選択をやめる' : '選択';
  $('pgSelAll').hidden = !pgSelectMode;
  $('pgDelSel').hidden = !pgSelectMode;
  $('pgAddEnd').hidden = pgSelectMode;
  $('pgImport').hidden = pgSelectMode;
  $('pgSendSel').hidden = !pgSelectMode;
  $('pgSendSel').disabled = pgSelected.size === 0;
  $('pgDelSel').disabled = pgSelected.size === 0;
  $('pgDelSel').textContent = pgSelected.size ? `削除（${pgSelected.size}ページ）` : '削除';
  $('pageSelInfo').textContent = pgSelectMode
    ? `${pgSelected.size}ページ選択中`
    : `全${n}ページ・タップで移動／ドラッグで並べ替え／⋯で操作`;
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
async function afterPageOp({ regrid = true } = {}) {
  markDocDirty();
  await flushSave();
  if (regrid && $('pagesDlg').open) await renderPageGrid();
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
$('pgImport').addEventListener('click', () => openXfer('import'));
$('pgSendSel').addEventListener('click', () => { if (pgSelected.size) openXfer('send'); });

/* ---- ほかのネームとのページのやりとり ----
   取り込む: ほかのネームを選び、そのページを選んで、今のページの後ろへ写す(線・塗り・画像・文字もそのまま)
   送る   : ページ一覧の「選択」で選んだページを、ほかのネーム(または新しいネーム)の最後へ写す
   どちらも写しを作るだけで、元のネームは変わらない。写したページには新しいページIDを付ける */
const xfer = { mode: '', src: null, picked: new Set(), urls: [] };
function xferRevoke() { while (xfer.urls.length) URL.revokeObjectURL(xfer.urls.pop()); }
function thumbInto(img, docId, pageId) {
  db.getThumb(docId, pageId).then((b) => {
    if (!b) return;
    const u = URL.createObjectURL(b);
    xfer.urls.push(u);
    img.src = u;
  });
}
function xferCard(label, sub, docId, pageId, onClick) {
  const el = document.createElement('div');
  el.className = 'pg';
  const th = document.createElement('div');
  th.className = 'pg-thumb';
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  th.appendChild(img);
  const check = document.createElement('span');
  check.className = 'pg-check';
  th.appendChild(check);
  if (pageId) thumbInto(img, docId, pageId);
  const row = document.createElement('div');
  row.className = 'pg-row xfer-row';
  const t = document.createElement('span');
  t.className = 'pg-num';
  t.textContent = label;
  row.appendChild(t);
  if (sub) { const sm = document.createElement('span'); sm.className = 'muted small'; sm.textContent = sub; row.appendChild(sm); }
  el.append(th, row);
  el.addEventListener('click', onClick);
  return el;
}
async function openXfer(mode) {
  await flushSave();
  xfer.mode = mode;
  xfer.src = null;
  xfer.picked.clear();
  await renderXferDocs();
  if (!$('xferDlg').open) $('xferDlg').showModal();
}
/** ネームを選ぶ画面 */
async function renderXferDocs() {
  xferRevoke();
  const send = xfer.mode === 'send';
  $('xferTitle').textContent = send ? `${pgSelected.size}ページを送る先のネーム` : '取り込み元のネーム';
  $('xferBack').hidden = true;
  $('xferAll').hidden = $('xferGo').hidden = true;
  const grid = $('xferGrid');
  grid.innerHTML = '';
  grid.classList.remove('selecting');
  const docs = (await db.listDocs())
    .filter((d) => d.id !== E.doc.id)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (send) {
    const el = xferCard('＋ 新しいネームにする', '', null, null, () => sendPages(null));
    el.classList.add('xfer-new');
    grid.appendChild(el);
  }
  for (const d of docs) {
    grid.appendChild(xferCard(d.title, `${d.pages.length}ページ`, d.id, d.pages[0], () => (send ? sendPages(d) : renderXferPages(d))));
  }
  $('xferInfo').textContent = docs.length || send
    ? (send ? 'タップでそのネームの最後へ写す（このネームからは消えない）' : 'ネームをタップしてページを選ぶ')
    : 'ほかのネームがない';
}
/** 取り込むページを選ぶ画面 */
function renderXferPages(doc) {
  xferRevoke();
  xfer.src = doc;
  xfer.picked.clear();
  $('xferTitle').textContent = `「${doc.title}」から取り込む`;
  $('xferBack').hidden = false;
  $('xferAll').hidden = $('xferGo').hidden = false;
  const grid = $('xferGrid');
  grid.innerHTML = '';
  grid.classList.add('selecting');
  doc.pages.forEach((pid, i) => {
    const el = xferCard(String(i + 1), '', doc.id, pid, () => {
      if (xfer.picked.has(pid)) xfer.picked.delete(pid); else xfer.picked.add(pid);
      el.classList.toggle('checked', xfer.picked.has(pid));
      updateXferFoot();
    });
    grid.appendChild(el);
  });
  updateXferFoot();
}
function updateXferFoot() {
  const n = xfer.picked.size;
  $('xferGo').disabled = !n;
  $('xferGo').textContent = n ? `取り込む（${n}ページ）` : '取り込む';
  $('xferInfo').textContent = `今のページ（${currentPage() + 1}）の後ろへ写す`;
}
$('xferBack').addEventListener('click', renderXferDocs);
$('xferAll').addEventListener('click', () => {
  const doc = xfer.src;
  if (!doc) return;
  const all = xfer.picked.size === doc.pages.length;
  xfer.picked.clear();
  if (!all) for (const pid of doc.pages) xfer.picked.add(pid);
  [...$('xferGrid').children].forEach((el, i) => el.classList.toggle('checked', xfer.picked.has(doc.pages[i])));
  updateXferFoot();
});
$('xferGo').addEventListener('click', async () => {
  const doc = xfer.src;
  if (!doc || !xfer.picked.size) return;
  const pids = doc.pages.filter((pid) => xfer.picked.has(pid));
  $('xferGo').disabled = true;
  const at = currentPage() + 1;
  let k = 0;
  for (const pid of pids) {
    const strokes = (await db.getPage(doc.id, pid))?.strokes || [];
    insertPage(at + k, strokes.slice());
    k++;
  }
  $('xferDlg').close();
  await afterPageOp();
  toast(`「${doc.title}」から${k}ページ取り込んだ`);
});
/** 選んだページを target(null なら新しいネーム)の最後へ写す */
async function sendPages(target) {
  const ids = E.doc.pages.filter((id) => pgSelected.has(id));
  if (!ids.length) return;
  await flushSave();
  if (!target) {
    const title = await askName('新しいネーム', `${E.doc.title}（抜き出し）`, '作る');
    if (title === null) return;
    const t = new Date().toISOString();
    target = { id: uid('doc'), title: title.trim() || defaultTitle(), createdAt: t, updatedAt: t, w: PAGE_W, h: PAGE_H, pages: [] };
  } else {
    target = await db.getDoc(target.id); // 最新を読み直す
    if (!target) { toast('送り先のネームが見つからない'); return; }
  }
  const recs = [], thumbs = [], newIds = [];
  for (const id of ids) {
    const strokes = await persistStrokes(await strokesOf(id));
    const nid = uid('pg');
    newIds.push(nid);
    recs.push([nid, { strokes }]);
    const th = (await db.getThumb(E.doc.id, id)) || (await makeThumb(null, { strokes }));
    thumbs.push([nid, th]);
  }
  target.pages = target.pages.concat(newIds);
  target.updatedAt = new Date().toISOString();
  cloud.noteLocalChange(target, newIds, true);
  try {
    await db.savePages(target, recs, thumbs);
  } catch (err) {
    console.error(err);
    toast('送れなかった（容量不足かも）');
    return;
  }
  cloud.touch();
  cloud.syncSoon();
  $('xferDlg').close();
  pgSelectMode = false;
  pgSelected.clear();
  await renderPageGrid();
  toast(`「${target.title}」の最後へ${ids.length}ページ送った`);
}
$('xferDlg').addEventListener('close', xferRevoke);
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
  $('exZip').checked = settings.exportZip;
  $('exDbx').checked = settings.exportDbx;
  $('exFolder').value = settings.exportFolder;
  syncExportRange();
  $('exportDlg').showModal();
}
const exportToDbx = () => cloud.connected() && $('exDbx').checked;
function syncExportRange() {
  $('exRangeRow').hidden = document.querySelector('input[name=exRange]:checked').value !== 'range';
  const conn = cloud.connected();
  $('exDbx').disabled = !conn;
  $('exDbxRow').hidden = !exportToDbx();
  $('exDbxOff').hidden = conn || !settings.exportDbx;
}
for (const r of document.querySelectorAll('input[name=exRange]')) r.addEventListener('change', syncExportRange);
$('exDbx').addEventListener('change', (e) => { settings.exportDbx = e.target.checked; saveSettings(); syncExportRange(); });
$('exZip').addEventListener('change', (e) => { settings.exportZip = e.target.checked; saveSettings(); });
$('exportBtn').addEventListener('click', openExportDialog);

async function strokesOf(id) {
  const ps = E.pages.get(id);
  if (ps?.strokes) return ps.strokes;
  return (await db.getPage(E.doc.id, id))?.strokes || [];
}
let exportCanvas = null;
async function renderPagePng(strokes, white) {
  await ensureImages(strokes);
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
  drawStrokes(ctx, strokes);
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
  const toDbx = exportToDbx();
  const folder = cloud.normalizeFolder($('exFolder').value);
  const zip = from !== to && $('exZip').checked;
  const where = toDbx ? `Dropboxの「${folder ? '/' + folder : 'トップ'}」に` : '';
  $('exGo').disabled = true;
  try {
    await flushSave();
    // 1枚ずつ: Dropboxなら上げる / 端末ならダウンロード(続けて出すとブラウザが止めることがあるので少し間を空ける)
    const put = async (blob, name) => {
      if (toDbx) await cloud.uploadTo(folder, name, blob);
      else { download(blob, name); await new Promise((r) => setTimeout(r, 400)); }
    };
    const files = [];
    const count = to - from + 1;
    for (let i = from; i <= to; i++) {
      status.textContent = count > 1 ? `書き出し中… ${i - from + 1} / ${count}` : '書き出し中…';
      const blob = await renderPagePng(await strokesOf(E.doc.pages[i]), white);
      const name = `${title}_p${pad3(i + 1)}.png`;
      if (zip) files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      else {
        if (toDbx) status.textContent = count > 1 ? `Dropboxへ保存中… ${i - from + 1} / ${count}` : 'Dropboxへ保存中…';
        await put(blob, name);
      }
    }
    if (zip) {
      status.textContent = 'ZIPにまとめ中…';
      const z = makeZip(files);
      if (toDbx) status.textContent = 'Dropboxへ保存中…';
      await put(z, `${title}_p${pad3(from + 1)}-${pad3(to + 1)}.zip`);
    }
    status.textContent = where + '保存した';
    if (toDbx) toast(where + '保存した');
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
  $('noMargin').checked = settings.noMargin;
  $('exportFolderDef').value = settings.exportFolder;
  for (const r of document.querySelectorAll('input[name=dockSide]')) r.checked = r.value === settings.dockSide;
  for (const n of ['viewMode', 'readDir', 'barMode']) {
    for (const r of document.querySelectorAll(`input[name=${n}]`)) r.checked = r.value === settings[n];
  }
  $('flipEase').value = settings.flipEase;
  $('flipEaseOut').textContent = FLIP_EASE_LABEL[settings.flipEase] || settings.flipEase;
  $('flipNear').value = settings.flipNear;
  $('flipNearOut').textContent = Math.round(settings.flipNear * 100) + '%';
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
$('exportFolderDef').addEventListener('change', (e) => {
  settings.exportFolder = cloud.normalizeFolder(e.target.value);
  e.target.value = settings.exportFolder;
  saveSettings();
});
$('noMargin').addEventListener('change', (e) => {
  settings.noMargin = e.target.checked;
  saveSettings();
  if (E) showPage(currentPage()); // 新しい余白で全体表示し直す
});
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
const FLIP_EASE_LABEL = { 1: '重い', 2: 'やや重い', 3: '標準', 4: 'やや軽い', 5: '軽い' };
$('flipEase').addEventListener('input', (e) => {
  settings.flipEase = Number(e.target.value);
  $('flipEaseOut').textContent = FLIP_EASE_LABEL[settings.flipEase];
  saveSettings();
});
$('flipNear').addEventListener('input', (e) => {
  settings.flipNear = Number(e.target.value);
  $('flipNearOut').textContent = Math.round(settings.flipNear * 100) + '%';
  saveSettings();
});
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
  cancelSelOp();
  clearSel();
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
  sel = selOp = null;
  selShown = false;
  $('selBar').hidden = true;
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
