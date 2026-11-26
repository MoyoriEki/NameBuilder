/* ============================================================
   画像の段(塗り・影・白)のキャンバス操作
   - 1ページ・1段につき1枚。解像度はページの半分(RS)。2508×3541 → 1254×1771(約9MB)
     フル解像度だと1枚35MBになり、Androidではすぐ落ちる。ネームの塗り・影・白なら半分で足りる
   - 座標は呼ぶ側ではページ座標(page-px)で渡す。pageCtx() が RS 倍の変換を付ける
   ============================================================ */
import { rasterSource } from './ink.js?v=31';

export const RS = 0.5;

/** 空の段のキャンバス(ページの大きさ W×H に対して RS 倍) */
export function layerCanvas(W, H) {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(W * RS);
  cv.height = Math.ceil(H * RS);
  return cv;
}
/** 段の画素を写した新しいキャンバス。st が無ければ空。画素がまだ展開されていなければ null */
export function copyLayer(st, W, H) {
  const cv = layerCanvas(W, H);
  if (!st) return cv;
  const src = rasterSource(st);
  if (!src) return null;
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
/** ページ座標で描けるようにした 2d コンテキスト */
export function pageCtx(cv) {
  const g = cv.getContext('2d');
  g.setTransform(RS, 0, 0, RS, 0, 0);
  return g;
}

/** 消しゴム: 円(x, y, r)の中を消す */
export function eraseDab(cv, x, y, r) {
  const g = pageCtx(cv);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = '#000';
  g.fill();
  g.restore();
}

/* ぼかし: 円(x, y, r)の中を、強さ sigma(page-px)でぼかす。
   円のふちに向かって効きを弱める(継ぎ目が出ないように)。何度もこすると、よりぼける。
   元の画素と、ぼかした画素を、効き m で混ぜる: 元×(1−m) + ぼかし×m。
   (元を destination-out で m だけ減らし、ぼかし×m を lighter で足す。どちらも乗算済みアルファで正しく混ざる) */
let tmpA = null, tmpB = null;
const tmp = (c, w, h) => {
  if (!c) c = document.createElement('canvas');
  if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  return c;
};
export function blurDab(cv, x, y, r, sigma) {
  const cx = x * RS, cy = y * RS, rr = r * RS, sg = Math.max(0.5, sigma * RS);
  const m = Math.ceil(sg * 3);
  const x0 = Math.max(0, Math.floor(cx - rr - m)), y0 = Math.max(0, Math.floor(cy - rr - m));
  const x1 = Math.min(cv.width, Math.ceil(cx + rr + m)), y1 = Math.min(cv.height, Math.ceil(cy + rr + m));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  tmpA = tmp(tmpA, w, h); tmpB = tmp(tmpB, w, h);
  // A: ぼかした画素
  const a = tmpA.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.clearRect(0, 0, w, h);
  a.filter = `blur(${sg.toFixed(2)}px)`;
  a.drawImage(cv, x0, y0, w, h, 0, 0, w, h);
  a.filter = 'none';
  // B: 効きのマスク(真ん中1 → ふち0)
  const b = tmpB.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, w, h);
  const gr = b.createRadialGradient(cx - x0, cy - y0, 0, cx - x0, cy - y0, Math.max(1, rr));
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.85)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  b.fillStyle = gr;
  b.fillRect(0, 0, w, h);
  // A をマスクで切る(ぼかし×m)
  a.globalCompositeOperation = 'destination-in';
  a.drawImage(tmpB, 0, 0, w, h, 0, 0, w, h);
  a.globalCompositeOperation = 'source-over';
  const g = cv.getContext('2d');
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(tmpB, 0, 0, w, h, x0, y0, w, h);
  g.globalCompositeOperation = 'lighter';
  g.drawImage(tmpA, 0, 0, w, h, x0, y0, w, h);
  g.restore();
}

/* ---- 囲んで動かす(投げ縄・四角) ---- */
const polyPath = (poly) => {
  const p = new Path2D();
  poly.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
};
/** 段の画素のうち、多角形 poly(page座標)の中だけを切り出す。
 *  戻り値 { img: キャンバス(外接矩形の大きさ), box: [x0,y0,x1,y1](page座標・段の画素の境目に揃える) }。中が空なら null */
export function extractPoly(src, poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const W = src.width, H = src.height;
  const lx0 = Math.max(0, Math.floor(x0 * RS) - 1), ly0 = Math.max(0, Math.floor(y0 * RS) - 1);
  const lx1 = Math.min(W, Math.ceil(x1 * RS) + 1), ly1 = Math.min(H, Math.ceil(y1 * RS) + 1);
  const w = lx1 - lx0, h = ly1 - ly0;
  if (w <= 0 || h <= 0) return null;
  const img = document.createElement('canvas');
  img.width = w; img.height = h;
  const g = img.getContext('2d');
  g.drawImage(src, lx0, ly0, w, h, 0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.setTransform(RS, 0, 0, RS, -lx0, -ly0);
  g.fill(polyPath(poly));
  return { img, box: [lx0 / RS, ly0 / RS, lx1 / RS, ly1 / RS] };
}
/** 多角形 poly(page座標)の中を消す */
export function clearPoly(cv, poly) {
  const g = pageCtx(cv);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.fill(polyPath(poly));
  g.restore();
}
/** 切り出した画素 f({img, box})を、(ax,ay) を中心に s 倍して (dx,dy) ずらした所に貼る */
export function pasteFloat(cv, f, t) {
  const g = pageCtx(cv);
  g.save();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.translate(t.ax + t.dx, t.ay + t.dy);
  g.scale(t.s, t.s);
  g.translate(-t.ax, -t.ay);
  const [x0, y0, x1, y1] = f.box;
  g.drawImage(f.img, x0, y0, x1 - x0, y1 - y0);
  g.restore();
}
