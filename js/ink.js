/* ============================================================
   ストローク(線)の幾何
   stroke = { c:'#rrggbb', w:最大太さ(page-px), t:筆圧の効き(0=一定), p:Float32Array[x,y,pr, …],
              o?:筆圧0のときの濃さ(0..1。あれば「筆圧で濃さが変わる線」),
              of?:真っ黒(濃さ100%)になる筆圧(0..1。無ければ1), og?:濃さのカーブ(無ければ1) }
   - 点列はページ座標(0..W, 0..H)。手ブレ補正は入力時に済ませた後の座標を保存する
     (描き直し・部分消しで形が変わらないよう、描画側では平滑化をかけない)
   - 輪郭は perfect-freehand で生成し、Path2D をストロークごとにキャッシュ
   ============================================================ */
import { getStroke } from '../vendor/perfect-freehand.mjs';

const pathCache = new WeakMap();
const bboxCache = new WeakMap();

/** 最大太さ w を perfect-freehand の size に換算(筆圧1.0で直径がwになる) */
export const pfSize = (st) => st.w / (1 + st.t);

function pfOptions(st, last) {
  return {
    size: pfSize(st),
    thinning: st.t,
    smoothing: 0.5,
    streamline: 0,
    simulatePressure: false,
    last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  };
}

/** 点(x,y,筆圧)における描画半径 */
export const radiusAt = (st, pr) => pfSize(st) * (0.5 - st.t * (0.5 - pr));

function toInput(p, n = p.length) {
  const out = new Array(n / 3);
  for (let i = 0, j = 0; i < n; i += 3, j++) out[j] = [p[i], p[i + 1], p[i + 2]];
  return out;
}

function outlineToPath(pts, path = new Path2D()) {
  const n = pts.length;
  if (n < 2) return path;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

/** 点が1つだけ(タップ)のときは円を描く */
function dotPath(st, p) {
  const path = new Path2D();
  path.arc(p[0], p[1], Math.max(0.5, radiusAt(st, p[2])), 0, Math.PI * 2);
  return path;
}

export function strokePath(st) {
  let path = pathCache.get(st);
  if (!path) {
    path = st.p.length <= 3 ? dotPath(st, st.p) : outlineToPath(getStroke(toInput(st.p), pfOptions(st, true)));
    pathCache.set(st, path);
  }
  return path;
}

/** 描画中(未確定)の線。points は [x,y,pr] の配列 */
export function livePath(st, points, last = false) {
  if (points.length === 1) return dotPath(st, points[0]);
  return outlineToPath(getStroke(points, pfOptions(st, last)));
}

/* ---- 筆圧で濃さが変わる線 ----
   半透明の部品を重ねると重なった所だけ濃くなって数珠状になるので、
   「白と混ぜた不透明な色」で描き、合成を darken(各チャンネルの小さい方=濃い方を残す)にする。
   白い紙の上ではクリスタの「筆圧→不透明度」とほぼ同じ見え方になり、同じ線の中で
   重なっても濃くならない。濃さは32段階に丸め、段階ごとに1つの Path2D にまとめて塗る */
export const isOpacityStroke = (st) => st.o !== undefined && st.o < 1;
/** 筆圧 pr での濃さ(0..1)。筆圧 of 以上で100%、カーブ og が1未満なら軽い力で早く濃くなる */
export function opacityAt(st, pr) {
  const full = st.of ?? 1, g = st.og ?? 1;
  const t = Math.min(1, Math.max(0, pr) / Math.max(0.05, full));
  return st.o + (1 - st.o) * Math.pow(t, g);
}
const LEVELS = 32;
const groupCache = new WeakMap();

function mixWhite(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(255 - a * (255 - v));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
function addCircle(path, x, y, r) {
  path.moveTo(x + r, y);
  path.arc(x, y, r, 0, Math.PI * 2, true);
}
/** points: [[x,y,pr], …] → [{ color, path }] (濃さの段階ごと) */
function buildGroups(st, points) {
  const groups = new Map();
  const pathOf = (lvl) => {
    let p = groups.get(lvl);
    if (!p) { p = new Path2D(); groups.set(lvl, p); }
    return p;
  };
  const level = (pr) => Math.round(opacityAt(st, pr) * LEVELS);
  const rad = (pr) => Math.max(0.3, radiusAt(st, pr));
  const n = points.length;
  if (n === 1) {
    const [x, y, pr] = points[0];
    addCircle(pathOf(level(pr)), x, y, rad(pr));
  }
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay, ap] = points[i], [bx, by, bp] = points[i + 1];
    const ra = rad(ap), rb = rad(bp);
    const path = pathOf(level((ap + bp) / 2));
    addCircle(path, ax, ay, ra);
    if (i === n - 2) addCircle(path, bx, by, rb);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    // 円(反時計回り)と同じ向きで四角形を作る。向きが揃っていれば非ゼロ規則で穴があかない
    path.moveTo(ax + nx * ra, ay + ny * ra);
    path.lineTo(bx + nx * rb, by + ny * rb);
    path.lineTo(bx - nx * rb, by - ny * rb);
    path.lineTo(ax - nx * ra, ay - ny * ra);
    path.closePath();
  }
  return [...groups].map(([lvl, path]) => ({ color: mixWhite(st.c, lvl / LEVELS), path }));
}
function fillGroups(ctx, groups, thicken) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'darken';
  for (const { color, path } of groups) {
    ctx.fillStyle = color;
    ctx.fill(path);
    if (thicken) { ctx.strokeStyle = color; ctx.lineWidth = thicken; ctx.stroke(path); }
  }
  ctx.globalCompositeOperation = prev;
}

/** thicken: 輪郭をこの太さで縁取って太らせる(縮小サムネ用) */
export function drawStroke(ctx, st, thicken = 0) {
  if (isOpacityStroke(st)) {
    let g = groupCache.get(st);
    if (!g) { g = buildGroups(st, toInput(st.p)); groupCache.set(st, g); }
    fillGroups(ctx, g, thicken);
    return;
  }
  const path = strokePath(st);
  ctx.fillStyle = st.c;
  ctx.fill(path);
  if (thicken) {
    ctx.strokeStyle = st.c;
    ctx.lineWidth = thicken;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
}

/** 描画中(未確定)の線を描く。points は [x,y,pr] の配列 */
export function drawLiveStroke(ctx, st, points, last = false) {
  if (isOpacityStroke(st)) { fillGroups(ctx, buildGroups(st, points), 0); return; }
  ctx.fillStyle = st.c;
  ctx.fill(livePath(st, points, last));
}

/** [minX, minY, maxX, maxY](太さ込み) */
export function bbox(st) {
  let b = bboxCache.get(st);
  if (!b) {
    const p = st.p;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const pad = st.w * 0.6 + 1;
    b = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    bboxCache.set(st, b);
  }
  return b;
}

export const bboxHit = (b, x0, y0, x1, y1) => !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** 消しゴム円(x,y,r)が線に触れているか */
export function hitStroke(st, x, y, r) {
  const b = bbox(st);
  if (x + r < b[0] || x - r > b[2] || y + r < b[1] || y - r > b[3]) return false;
  const p = st.p;
  if (p.length === 3) {
    const rr = r + radiusAt(st, p[2]);
    return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr * rr;
  }
  for (let i = 3; i < p.length; i += 3) {
    const rr = r + radiusAt(st, Math.max(p[i - 1], p[i + 2]));
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= rr * rr) return true;
  }
  return false;
}

/** 部分消し: 円に入った区間を取り除き、残りを別々の線として返す。
 *  触れていなければ null。点の間隔が粗いと削れ方が粗くなるので、
 *  触れた線だけ細かく補間してから判定する */
export function eraseSplit(st, x, y, r) {
  if (!hitStroke(st, x, y, r)) return null;
  const p = st.p;
  const step = Math.max(0.75, Math.min(r * 0.35, st.w * 0.35));
  const pieces = [];
  let cur = [];
  const inside = (px, py, pr) => {
    const rr = r + radiusAt(st, pr) * 0.6;
    return (px - x) ** 2 + (py - y) ** 2 <= rr * rr;
  };
  const push = (px, py, pr) => {
    if (inside(px, py, pr)) {
      if (cur.length) { pieces.push(cur); cur = []; }
    } else {
      cur.push(px, py, pr);
    }
  };
  push(p[0], p[1], p[2]);
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], ap = p[i - 1];
    const bx = p[i], by = p[i + 1], bp = p[i + 2];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(len / step);
    // 区間の端が両方とも円から十分遠ければ補間しない
    const far = segDist2(x, y, ax, ay, bx, by) > (r + st.w) ** 2;
    if (!far && n > 1) {
      for (let k = 1; k < n; k++) {
        const t = k / n;
        push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
      }
    }
    push(bx, by, bp);
  }
  if (cur.length) pieces.push(cur);
  // 1点だけ残った切れ端は点として残ると汚いので捨てる
  return pieces
    .filter((a) => a.length >= 6)
    .map((a) => ({ ...st, p: new Float32Array(a) }));
}

/** 消しゴムのドラッグ1区間(前回位置→今回位置)を、半径の半分刻みで補間した円の列にする */
export function sweep(x0, y0, x1, y1, r) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / Math.max(1, r * 0.5)));
  const out = [];
  for (let k = 1; k <= n; k++) out.push([x0 + (x1 - x0) * (k / n), y0 + (y1 - y0) * (k / n)]);
  return out;
}
