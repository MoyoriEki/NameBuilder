/* ============================================================
   ストローク(線)の幾何
   stroke = { c:'#rrggbb', w:最大太さ(page-px), t:筆圧の効き(0=一定), p:Float32Array[x,y,pr, …],
              o?:筆圧0のときの濃さ(0..1。あれば「筆圧で濃さが変わる線」),
              of?:真っ黒(濃さ100%)になる筆圧(0..1。無ければ1), og?:濃さのカーブ(無ければ1),
              x?:1 なら文字ペンの線(オートレイヤー: いつも一番上に描く), b?:文字ペンのフチの太さ(page-px),
              k?:'f' なら塗り(バケツ)。p は輪郭の点列で、筆圧の欄が1の点から新しい輪郭が始まる。w=0 }
   - 文字ペンの線は、ほかの線・塗りより必ず上に描く。フチ(白)を全部描いてから中身を描くので、
     フチが隣の文字を隠さない。配列の中でも文字ペンの線は後ろにまとめる(addStrokes)
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

/* ---- 塗り(バケツ) ---- */
export const isFill = (st) => st.k === 'f';
export const isText = (st) => !!st.x;
const fillCache = new WeakMap();
/** 塗りの輪郭を Path2D に。偶奇規則で塗るので、穴(線の内側など)はそのまま穴になる */
export function fillPath(st) {
  let path = fillCache.get(st);
  if (!path) {
    path = new Path2D();
    const p = st.p;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 2] > 0.5 || i === 0) { if (i) path.closePath(); path.moveTo(p[i], p[i + 1]); }
      else path.lineTo(p[i], p[i + 1]);
    }
    path.closePath();
    fillCache.set(st, path);
  }
  return path;
}
/** 輪郭の配列 [[x,y,x,y,…], …] → 塗りのストローク */
export function makeFill(c, contours) {
  const n = contours.reduce((a, q) => a + q.length / 2, 0);
  const p = new Float32Array(n * 3);
  let k = 0;
  for (const q of contours) {
    for (let i = 0; i < q.length; i += 2, k += 3) {
      p[k] = q[i]; p[k + 1] = q[i + 1]; p[k + 2] = i === 0 ? 1 : 0;
    }
  }
  return { c, w: 0, t: 0, k: 'f', p };
}
/** 塗りの中に点があるか(偶奇規則) */
function inFill(st, x, y) {
  const p = st.p;
  let inside = false, start = 0;
  for (let i = 0; i < p.length; i += 3) {
    const next = i + 3 >= p.length || p[i + 5] > 0.5 ? start : i + 3; // 輪郭の最後の点は最初の点へつなぐ
    const xi = p[i], yi = p[i + 1], xj = p[next], yj = p[next + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    if (next === start) start = i + 3;
  }
  return inside;
}
function fillEdgeNear(st, x, y, r) {
  const p = st.p, rr = r * r;
  let start = 0;
  for (let i = 0; i < p.length; i += 3) {
    const next = i + 3 >= p.length || p[i + 5] > 0.5 ? start : i + 3;
    if (segDist2(x, y, p[i], p[i + 1], p[next], p[next + 1]) <= rr) return true;
    if (next === start) start = i + 3;
  }
  return false;
}

/** 文字ペンのフチ(白)。中身より先に描く */
function drawBorder(ctx, path, b) {
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = b * 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(path);
}

/** 線の並びを描く。文字ペンの線は最後に、フチ → 中身 の順でまとめて描く。
 *  skip: 描かない線の Set(動かしている最中の線など) */
export function drawStrokes(ctx, strokes, thicken = 0, skip = null) {
  let text = null;
  for (const st of strokes) {
    if (skip && skip.has(st)) continue;
    if (st.x) { (text ||= []).push(st); continue; }
    drawStroke(ctx, st, thicken);
  }
  if (!text) return;
  for (const st of text) if (st.b > 0) drawBorder(ctx, strokePath(st), st.b);
  for (const st of text) drawStroke(ctx, st, thicken);
}
/** 新しい線を足した配列を返す。文字ペンの線はいつも後ろ(上)、それ以外は文字ペンの線より前に入れる */
export function addStrokes(arr, news) {
  const plain = news.filter((s) => !s.x), text = news.filter((s) => s.x);
  if (!plain.length) return arr.concat(text);
  let i = arr.length;
  while (i > 0 && arr[i - 1].x) i--;
  return arr.slice(0, i).concat(plain, arr.slice(i), text);
}

/** thicken: 輪郭をこの太さで縁取って太らせる(縮小サムネ用) */
export function drawStroke(ctx, st, thicken = 0) {
  if (st.k === 'f') {
    const path = fillPath(st);
    ctx.fillStyle = st.c;
    ctx.fill(path, 'evenodd');
    if (thicken) { ctx.strokeStyle = st.c; ctx.lineWidth = thicken; ctx.stroke(path); }
    return;
  }
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

/** 描画中(未確定)の線を描く。points は [x,y,pr] の配列。
 *  文字ペンの線は フチ → under()(既にある文字の中身を描き直す) → 中身 の順 */
export function drawLiveStroke(ctx, st, points, last = false, under = null) {
  if (isOpacityStroke(st)) { fillGroups(ctx, buildGroups(st, points), 0); return; }
  const path = livePath(st, points, last);
  if (st.x && st.b > 0) { drawBorder(ctx, path, st.b); under?.(); }
  ctx.fillStyle = st.c;
  ctx.fill(path);
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
    const pad = st.w * 0.6 + 1 + (st.b || 0);
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
  if (st.k === 'f') return inFill(st, x, y) || fillEdgeNear(st, x, y, r);
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
  if (st.k === 'f') return null; // 塗りの部分消しは別扱い(消しゴムを離したときに削る)
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

/* ---- 選択(投げ縄・四角)と変形 ---- */

/** 点(x,y)が多角形 poly([[x,y], …])の中か(偶奇規則) */
export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 線の点のうち、多角形の中にある割合(0..1)。pb は多角形の外接矩形 [x0,y0,x1,y1] */
export function fractionInPoly(st, poly, pb) {
  const b = bbox(st);
  if (!bboxHit(b, pb[0], pb[1], pb[2], pb[3])) return 0;
  const p = st.p;
  const n = p.length / 3;
  // 長い線は間引いて調べる(最大400点)
  const step = Math.max(1, Math.floor(n / 400));
  let hit = 0, total = 0;
  for (let i = 0; i < n; i += step) {
    const x = p[i * 3], y = p[i * 3 + 1];
    total++;
    if (x >= pb[0] && x <= pb[2] && y >= pb[1] && y <= pb[3] && pointInPoly(x, y, poly)) hit++;
  }
  return total ? hit / total : 0;
}

/** 点(x,y)から r 以内にある線のうち、いちばん上(最後に描いた)もの */
export function topStrokeAt(strokes, x, y, r) {
  for (let i = strokes.length - 1; i >= 0; i--) if (hitStroke(strokes[i], x, y, r)) return strokes[i];
  return null;
}

/** 線の集まりの外接矩形(太さ込み) */
export function unionBox(strokes) {
  let b = null;
  for (const st of strokes) {
    const s = bbox(st);
    b = b ? [Math.min(b[0], s[0]), Math.min(b[1], s[1]), Math.max(b[2], s[2]), Math.max(b[3], s[3])] : s.slice();
  }
  return b;
}

/** 変形した新しい線を返す: (ax,ay) を中心に s 倍し、(dx,dy) ずらす。太さも s 倍 */
export function transformStroke(st, ax, ay, s, dx, dy) {
  const p = st.p, q = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    q[i] = ax + (p[i] - ax) * s + dx;
    q[i + 1] = ay + (p[i + 1] - ay) * s + dy;
    q[i + 2] = p[i + 2];
  }
  const out = { ...st, p: q };
  if (s !== 1 && st.k !== 'f') out.w = Math.max(0.3, Math.round(st.w * s * 100) / 100);
  if (s !== 1 && st.b) out.b = Math.round(st.b * s * 100) / 100;
  return out;
}
