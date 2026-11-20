/* ============================================================
   塗りつぶし(バケツ)
   - ページの線を等倍の画像に描き、タップした点から同じ色の範囲を広げる(flood fill)
   - 線のきわの薄い所に隙間が残らないよう、範囲を数px広げて線の下にもぐらせる(はみ出し)
   - 範囲(マスク)の輪郭をたどってベクターの多角形にし、点を間引いて「塗り」として保存する
     (線と同じく、選択して移動・拡大縮小・undo・同期ができる)
   ============================================================ */
import { drawStrokes, makeFill, fillPath } from './ink.js?v=25';

const TOL = 24; // タップした色との差がこれ以内なら同じ色とみなす(0..255)

let refCanvas = null;
function canvasOf(w, h) {
  if (!refCanvas) refCanvas = document.createElement('canvas');
  if (refCanvas.width !== w || refCanvas.height !== h) { refCanvas.width = w; refCanvas.height = h; }
  return refCanvas;
}
/** 使い終わったら画素を手放す(ページ全体の大きさだと数十MBある) */
function release() {
  if (refCanvas) refCanvas.width = refCanvas.height = 0;
}

/** バケツ: strokes(文字ペン・塗りペンの線は見ない)を背景白で描き、(x,y) から塗る範囲を求める。
 *  戻り値は塗りのストローク(範囲が無ければ null) */
export function bucketFill(strokes, W, H, x, y, color, expand) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const cv = canvasOf(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  drawStrokes(ctx, strokes.filter((s) => !s.x && !s.u)); // 文字ペン・塗りペンは見ない(線画だけで範囲を決める)
  const data = ctx.getImageData(0, 0, W, H).data;
  release();
  // 同じ色の範囲(4近傍のスキャンライン塗り)
  const mask = new Uint8Array(W * H);
  const s0 = (y * W + x) * 4;
  const r0 = data[s0], g0 = data[s0 + 1], b0 = data[s0 + 2];
  const same = (i) => {
    const k = i * 4;
    return Math.abs(data[k] - r0) <= TOL && Math.abs(data[k + 1] - g0) <= TOL && Math.abs(data[k + 2] - b0) <= TOL;
  };
  let x0 = x, x1 = x, y0 = y, y1 = y;
  const stack = [x, y];
  while (stack.length) {
    const sy = stack.pop(), sx = stack.pop();
    let l = sx, row = sy * W;
    if (mask[row + l] || !same(row + l)) continue;
    while (l > 0 && !mask[row + l - 1] && same(row + l - 1)) l--;
    let r = sx;
    while (r < W - 1 && !mask[row + r + 1] && same(row + r + 1)) r++;
    for (let i = l; i <= r; i++) mask[row + i] = 1;
    if (l < x0) x0 = l; if (r > x1) x1 = r;
    if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= H) continue;
      const nrow = ny * W;
      let inRun = false;
      for (let i = l; i <= r; i++) {
        const ok = !mask[nrow + i] && same(nrow + i);
        if (ok && !inRun) { stack.push(i, ny); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
  // はみ出し: 範囲を expand px 広げる(正方形の膨張を縦横に分けて)
  const e = Math.max(0, Math.round(expand));
  const bx0 = Math.max(0, x0 - e), by0 = Math.max(0, y0 - e);
  const bx1 = Math.min(W - 1, x1 + e), by1 = Math.min(H - 1, y1 + e);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  let m = new Uint8Array(bw * bh);
  for (let yy = y0; yy <= y1; yy++) {
    const src = yy * W, dst = (yy - by0) * bw - bx0;
    for (let xx = x0; xx <= x1; xx++) if (mask[src + xx]) m[dst + xx] = 1;
  }
  if (e) m = dilate(m, bw, bh, e);
  const contours = traceMask(m, bw, bh, bx0, by0);
  return contours.length ? makeFill(color, contours) : null;
}

/** 多角形(page座標 [[x,y], …])をそのまま塗る(範囲選択の塗りつぶし。線は見ない) */
export function polygonFill(poly, color) {
  if (poly.length < 3) return null;
  const q = [];
  for (const [x, y] of poly) q.push(x, y);
  return makeFill(color, [q]);
}

/** 塗りから、消しゴムで通った円(circles: [[x,y,r], …])の分を削る。全部消えたら null */
export function subtractCircles(fill, circles, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = fill.p;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1);
  x1 = Math.min(W, Math.ceil(x1) + 1); y1 = Math.min(H, Math.ceil(y1) + 1);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return null;
  const cv = canvasOf(bw, bh);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.translate(-x0, -y0);
  ctx.fillStyle = '#000';
  ctx.fill(fillPath(fill), 'evenodd');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  for (const [cx, cy, r] of circles) { ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); }
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  const data = ctx.getImageData(0, 0, bw, bh).data;
  release();
  const m = new Uint8Array(bw * bh);
  for (let i = 0; i < m.length; i++) m[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  const contours = traceMask(m, bw, bh, x0, y0);
  return contours.length ? makeFill(fill.c, contours) : null;
}

function dilate(m, w, h, e) {
  const t = new Uint8Array(w * h), out = new Uint8Array(w * h);
  // 横: 左右 e px 以内に1があれば1
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[row + x]) last = x; if (x - last <= e) t[row + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[row + x]) last = x; if (last - x <= e) t[row + x] = 1; }
  }
  // 縦
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (t[y * w + x]) last = y; if (y - last <= e) out[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (t[y * w + x]) last = y; if (last - y <= e) out[y * w + x] = 1; }
  }
  return out;
}

/** マスクの境界(画素の角を結ぶ辺)をつないで輪郭の列にする。点は間引いて返す。
 *  偶奇規則で塗るので、輪郭の向きやつなぎ方の選び方で結果は変わらない */
export function traceMask(m, w, h, ox, oy) {
  const W1 = w + 1;
  const from = [], to = [];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (!at(x, y - 1)) { from.push(y * W1 + x); to.push(y * W1 + x + 1); }
      if (!at(x + 1, y)) { from.push(y * W1 + x + 1); to.push((y + 1) * W1 + x + 1); }
      if (!at(x, y + 1)) { from.push((y + 1) * W1 + x + 1); to.push((y + 1) * W1 + x); }
      if (!at(x - 1, y)) { from.push((y + 1) * W1 + x); to.push(y * W1 + x); }
    }
  }
  // 頂点 → そこから出る辺(1つの頂点から出る辺は最大2本)
  const out = new Map();
  for (let i = 0; i < from.length; i++) {
    const v = from[i], e = out.get(v);
    if (e === undefined) out.set(v, i); else out.set(v, Array.isArray(e) ? (e.push(i), e) : [e, i]);
  }
  const used = new Uint8Array(from.length);
  const take = (v) => {
    const e = out.get(v);
    if (e === undefined) return -1;
    if (!Array.isArray(e)) return used[e] ? -1 : e;
    for (const i of e) if (!used[i]) return i;
    return -1;
  };
  const contours = [];
  for (let s = 0; s < from.length; s++) {
    if (used[s]) continue;
    const loop = [];
    let i = s;
    while (i >= 0 && !used[i]) {
      used[i] = 1;
      const v = from[i];
      loop.push((v % W1) + ox, Math.floor(v / W1) + oy);
      i = take(to[i]);
    }
    const q = simplifyLoop(loop, 0.8);
    if (q.length >= 6 && Math.abs(area(q)) >= 2) contours.push(q);
  }
  return contours;
}

function area(q) {
  let a = 0;
  for (let i = 0, n = q.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += q[i] * q[j + 1] - q[j] * q[i + 1];
  }
  return a / 2;
}

/** 閉じた点列を間引く: まっすぐ並んだ点を落としてから Douglas-Peucker(許容 eps px) */
function simplifyLoop(loop, eps) {
  // 一直線上の点を除く(階段状の輪郭は点が多い)
  const n = loop.length / 2;
  if (n < 4) return loop;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    const ax = loop[a * 2], ay = loop[a * 2 + 1], x = loop[i * 2], y = loop[i * 2 + 1], bx = loop[b * 2], by = loop[b * 2 + 1];
    if ((x - ax) * (by - y) - (y - ay) * (bx - x) !== 0) keep.push(x, y);
  }
  const k = keep.length / 2;
  if (k < 3) return keep;
  // 始点と、そこから一番遠い点で2つに分け、それぞれを Douglas-Peucker
  let far = 0, fd = -1;
  for (let i = 1; i < k; i++) {
    const d = (keep[i * 2] - keep[0]) ** 2 + (keep[i * 2 + 1] - keep[1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const mark = new Uint8Array(k + 1);
  mark[0] = mark[far] = mark[k] = 1;
  const px = (i) => keep[(i % k) * 2], py = (i) => keep[(i % k) * 2 + 1];
  const stack = [0, far, far, k];
  const e2 = eps * eps;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const ax = px(a), ay = py(a), dx = px(b) - ax, dy = py(b) - ay;
    const l2 = dx * dx + dy * dy || 1;
    let best = -1, bd = e2;
    for (let i = a + 1; i < b; i++) {
      const cr = (px(i) - ax) * dy - (py(i) - ay) * dx;
      const d = (cr * cr) / l2;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { mark[best] = 1; stack.push(a, best, best, b); }
  }
  const out = [];
  for (let i = 0; i < k; i++) if (mark[i]) out.push(keep[i * 2], keep[i * 2 + 1]);
  return out;
}
