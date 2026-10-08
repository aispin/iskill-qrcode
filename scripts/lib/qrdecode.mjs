/**
 * qrdecode.mjs —— 图片 → 二维码文本（零依赖，配合系统 sips 解图）
 *
 * 管线：sips 转 BMP → 二值化（Bradley 自适应，积分图）→ 行扫 1:1:3:1:1 找
 * 三个 finder → 仿射映射采样矩阵 → 读格式位（两份副本 BCH 校验）→ 去掩码 →
 * 提取码字 → 去交错 → RS 纠错（Berlekamp–Massey + Chien + Forney）→ 解析。
 *
 * 支持范围：Model 2，byte 模式，纠错级别 M，版本 1–10 —— 即本技能 encode
 * 产出的码；轻微透视/旋转（三 finder 仿射可覆盖）与少量污损（RS 纠错 ≤ t/块）
 * 也能解。Q/L/H 级、alnum/kanji 模式不支持（报错说明）。
 * 镜像图自动转置重试。SVG 不支持（先转 PNG：`qlmanage -t -s 1024 -o . x.svg`）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── GF(256) 与 RS 纠错解码 ──────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const ginv = a => EXP[255 - LOG[a]];

/** RS 纠错：msg（降幂 data…ec），nsym 个纠错码字。成功返回 { msg, fixed }，失败 null */
export function rsDecode(msg, nsym) {
  const synd = [];
  for (let j = 0; j < nsym; j++) {
    let s = 0;
    for (const c of msg) s = gmul(s, EXP[j]) ^ c;
    synd.push(s);
  }
  if (synd.every(x => x === 0)) return { msg: msg.slice(), fixed: 0 };

  // Berlekamp–Massey 求错误定位多项式 Λ（C[i] = x^i 系数）
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let n = 0; n < nsym; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, synd[n - i]);
    if (d === 0) { m++; continue; }
    const T = C.slice();
    const coef = gmul(d, ginv(b));
    if (C.length < B.length + m) C.length = B.length + m;
    for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
    C = C.map(x => x || 0);
    if (2 * L <= n) { B = T; L = n + 1 - L; b = d; m = 1; }
    else m++;
  }
  if (L === 0 || L > nsym / 2) return null;

  // Chien 搜根：Λ(α^{-(n-1-k)}) = 0 → 位置 k（自码字起点数）
  const n = msg.length;
  const pos = [];
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < C.length; i++) {
      if (!C[i]) continue;
      sum ^= gmul(C[i], EXP[(255 * 2 - ((n - 1 - k) * i) % 255) % 255]);
    }
    if (sum === 0) pos.push(k);
  }
  if (pos.length !== L) return null;

  // Forney（fcr=0）：Ω = S·Λ mod x^nsym；e = X_i · Ω(X_i⁻¹) / Λ'(X_i⁻¹)
  const S = synd;
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    let v = 0;
    for (let j = 0; j <= i && j < C.length; j++) v ^= gmul(C[j], S[i - j]);
    omega[i] = v;
  }
  const out = msg.slice();
  let fixed = 0;
  for (const k of pos) {
    const Xexp = (n - 1 - k) % 255;
    const XinvExp = (255 - Xexp) % 255;
    // Ω(X⁻¹)
    let om = 0;
    for (let i = 0; i < omega.length; i++) if (omega[i]) om ^= gmul(omega[i], EXP[(XinvExp * i) % 255]);
    // Λ'(X⁻¹)：奇次项导数
    let dl = 0;
    for (let i = 1; i < C.length; i += 2) if (C[i]) dl ^= gmul(C[i], EXP[(XinvExp * (i - 1)) % 255]);
    if (!dl) return null;
    const mag = gmul(EXP[Xexp], gmul(om, ginv(dl)));
    out[k] ^= mag;
    fixed++;
  }
  // 纠后再验一遍
  for (let j = 0; j < nsym; j++) {
    let s = 0;
    for (const c of out) s = gmul(s, EXP[j]) ^ c;
    if (s) return null;
  }
  return { msg: out, fixed };
}

// ── 图像 → 二值网格（sips → BMP）────────────────────────────────────────
/** sips 转 BMP 并解析成灰度/二值网格。BMP 24bpp；高为负 = top-down */
function toBinaryGrid(file, { thresholdScale = 0.85 } = {}) {
  const tmp = path.join(os.tmpdir(), `qrdec-${process.pid}-${Math.random().toString(36).slice(2)}.bmp`);
  try {
    execFileSync('sips', ['-s', 'format', 'bmp', String(file), '--out', tmp], { stdio: 'ignore' });
    const buf = fs.readFileSync(tmp);
    const offset = buf.readUInt32LE(10);
    const w = buf.readInt32LE(18);
    const hRaw = buf.readInt32LE(22);
    const bpp = buf.readUInt16LE(28);
    if (bpp !== 24) throw new Error(`BMP ${bpp}bpp（预期 24）`);
    const topDown = hRaw < 0;
    const h = Math.abs(hRaw);
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const gray = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const src = topDown ? r : h - 1 - r;
      const row = offset + src * rowSize;
      for (let c = 0; c < w; c++) {
        const b = buf[row + c * 3], g = buf[row + c * 3 + 1], rr = buf[row + c * 3 + 2];
        gray[r * w + c] = (rr * 299 + g * 587 + b * 114) / 1000;
      }
    }
    // Bradley 自适应二值化（积分图，窗口 = 边长 1/16）
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let r = 0; r < h; r++) {
      let rowSum = 0;
      for (let c = 0; c < w; c++) {
        rowSum += gray[r * w + c];
        integ[(r + 1) * (w + 1) + c + 1] = integ[r * (w + 1) + c + 1] + rowSum;
      }
    }
    const win = Math.max(8, Math.floor(Math.min(w, h) / 16));
    const bin = new Uint8Array(w * h); // 1 = dark
    for (let r = 0; r < h; r++) {
      const y0 = Math.max(0, r - win), y1 = Math.min(h - 1, r + win);
      for (let c = 0; c < w; c++) {
        const x0 = Math.max(0, c - win), x1 = Math.min(w - 1, c + win);
        const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integ[(y1 + 1) * (w + 1) + x1 + 1] - integ[y0 * (w + 1) + x1 + 1]
          - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        bin[r * w + c] = gray[r * w + c] < (sum / cnt) * thresholdScale ? 1 : 0;
      }
    }
    return { bin, w, h };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 留给系统清理 */ }
  }
}

// ── finder 定位 ─────────────────────────────────────────────────────────
/** 行扫 1:1:3:1:1 候选 + 竖向校验，聚类成 finder 中心（像素坐标） */
function findFinders(bin, w, h) {
  const cands = [];
  for (let r = 0; r < h; r++) {
    // 整行游程 [start, len, dark]
    const runs = [];
    let c = 0;
    while (c < w) {
      const dark = bin[r * w + c] === 1;
      const start = c;
      while (c < w && (bin[r * w + c] === 1) === dark) c++;
      runs.push([start, c - start, dark]);
    }
    for (let i = 0; i + 5 <= runs.length; i++) {
      const [s0, l0, d0] = runs[i];
      const [, l1, d1] = runs[i + 1];
      const [, l2, d2] = runs[i + 2];
      const [, l3, d3] = runs[i + 3];
      const [, l4, d4] = runs[i + 4];
      if (!d0 || d1 || !d2 || d3 || !d4) continue; // 需 暗-亮-暗-亮-暗
      const m = l2 / 3;
      if (m < 2) continue;
      if (Math.abs(l0 - m) > m * 0.55 || Math.abs(l1 - m) > m * 0.55
        || Math.abs(l3 - m) > m * 0.55 || Math.abs(l4 - m) > m * 0.55) continue;
      const cCol = Math.round(s0 + l0 + l1 + l2 / 2);
      if (cCol <= 0 || cCol >= w) continue;
      // 竖向校验：中心列上暗模块总高 ≈ 3m
      let up = 0, dn = 0;
      while (r - up - 1 >= 0 && bin[(r - up - 1) * w + cCol]) up++;
      while (r + dn + 1 < h && bin[(r + dn + 1) * w + cCol]) dn++;
      if (Math.abs(up + dn + 1 - m * 3) <= m * 1.2) cands.push({ x: cCol + 0.5, y: r + 0.5, m });
    }
  }
  // 聚类（2.5m 内合并，取均值）
  const clusters = [];
  for (const p of cands) {
    const hit = clusters.find(cl => Math.abs(cl.x - p.x) < p.m * 2.5 && Math.abs(cl.y - p.y) < p.m * 2.5);
    if (hit) {
      const k = hit.n + 1;
      hit.x = (hit.x * hit.n + p.x) / k; hit.y = (hit.y * hit.n + p.y) / k;
      hit.m = (hit.m * hit.n + p.m) / k; hit.n = k;
    } else clusters.push({ ...p, n: 1 });
  }
  return clusters.filter(cl => cl.n >= 2) // 单票多为噪声
    .sort((a, b) => b.n - a.n).slice(0, 8);
}

/** 选最优三元组：两条腿等长且垂直（右三角） */
function pickTriple(fs) {
  let best = null, bestScore = -Infinity;
  for (let a = 0; a < fs.length; a++) for (let b = 0; b < fs.length; b++) {
    if (a === b) continue;
    for (let c = b + 1; c < fs.length; c++) {
      if (c === a) continue;
      const A = fs[a], B2 = fs[b], C2 = fs[c];
      const v1 = { x: B2.x - A.x, y: B2.y - A.y }, v2 = { x: C2.x - A.x, y: C2.y - A.y };
      const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
      if (l1 < 20 || l2 < 20) continue;
      const ratio = Math.min(l1, l2) / Math.max(l1, l2);
      const cross = Math.abs(v1.x * v2.y - v1.y * v2.x) / (l1 * l2); // sin 夹角
      const mm = Math.min(A.m, B2.m, C2.m) / Math.max(A.m, B2.m, C2.m);
      const score = ratio * cross * mm;
      if (ratio > 0.8 && cross > 0.85 && score > bestScore) {
        bestScore = score;
        best = [A, B2, C2];
      }
    }
  }
  return best;
}

// ── 主解码 ──────────────────────────────────────────────────────────────
function readFormatCopies(mat, size) {
  const readV = i => (i <= 5 ? mat[i][8] : i <= 7 ? mat[i + 1][8] : mat[size - 15 + i][8]);
  const readH = i => (i <= 7 ? mat[8][size - 1 - i] : i === 8 ? mat[8][7] : mat[8][14 - i]);
  const outs = [];
  for (const read of [readV, readH]) {
    let fmt = 0;
    for (let i = 0; i < 15; i++) fmt |= (read(i) ? 1 : 0) << i;
    const fdata = fmt ^ 0x5412;
    const digit = x => { let n = 0; while (x) { n++; x >>>= 1; } return n; };
    let d = fdata;
    while (digit(d) - digit(0x537) >= 0) d ^= 0x537 << (digit(d) - digit(0x537));
    if (d === 0) outs.push({ mask: (fdata >>> 10) & 7, ecl: (fdata >>> 13) & 3 });
  }
  return outs;
}

const BLOCKS_M = {
  1: { total: 26, ec: 10, blocks: [16] },
  2: { total: 44, ec: 16, blocks: [28] },
  3: { total: 70, ec: 26, blocks: [44] },
  4: { total: 100, ec: 18, blocks: [32, 32] },
  5: { total: 134, ec: 24, blocks: [43, 43] },
  6: { total: 172, ec: 16, blocks: [27, 27, 27, 27] },
  7: { total: 196, ec: 18, blocks: [31, 31, 31, 31] },
  8: { total: 242, ec: 22, blocks: [38, 39, 38, 39] },
  9: { total: 292, ec: 22, blocks: [36, 37, 36, 37, 36] },
  10: { total: 346, ec: 26, blocks: [43, 43, 43, 43, 44] },
};

function buildReserved(size, v) {
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]])
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  const ap = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }[v];
  for (const r of ap) for (const c of ap) {
    if (res[r][c]) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  mark(size - 8, 8);
  for (let i = 0; i < 15; i++) {
    if (i <= 5) mark(i, 8); else if (i <= 7) mark(i + 1, 8); else mark(size - 15 + i, 8);
    if (i <= 7) mark(8, size - 1 - i); else if (i === 8) mark(8, 7); else mark(8, 14 - i);
  }
  if (v >= 7) for (let i = 0; i < 18; i++) {
    mark(size - 11 + (i % 3), Math.floor(i / 3));
    mark(Math.floor(i / 3), size - 11 + (i % 3));
  }
  return res;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  r => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

/** 从采样矩阵解出文本。返回 { text, version, mask, fixed } 或抛错 */
function decodeMatrix(mat) {
  const size = mat.length;
  const v = (size - 17) / 4;
  const spec = BLOCKS_M[v];
  if (!spec) throw new Error(`版本 v${v} 超出支持范围（1–10）`);
  const copies = readFormatCopies(mat, size);
  const fmt = copies.find(c => c.ecl === 0); // M = 00
  if (!fmt) {
    if (copies.length) throw new Error(`纠错级别非 M（本解码器仅支持 M 级）`);
    throw new Error('格式位 BCH 校验失败（图像质量不足或非标准码）');
  }
  const res = buildReserved(size, v);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!res[r][c]) bits.push(mat[r][c] !== MASKS[fmt.mask](r, c));
      }
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length && cw.length < spec.total; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  const dataLens = spec.blocks, nB = dataLens.length;
  const dataBlocks = Array.from({ length: nB }, () => []);
  let idx = 0;
  const maxLen = Math.max(...dataLens);
  for (let i = 0; i < maxLen; i++)
    for (let b = 0; b < nB; b++) if (i < dataLens[b]) dataBlocks[b].push(cw[idx++]);
  const ecBlocks = Array.from({ length: nB }, () => []);
  for (let i = 0; i < spec.ec; i++)
    for (let b = 0; b < nB; b++) ecBlocks[b].push(cw[idx++]);
  let fixed = 0;
  const fixedData = [];
  for (let b = 0; b < nB; b++) {
    const r = rsDecode(dataBlocks[b].concat(ecBlocks[b]), spec.ec);
    if (!r) throw new Error(`块 ${b} 纠错失败（污损超出 M 级纠错能力）`);
    fixed += r.fixed;
    fixedData.push(r.msg.slice(0, dataLens[b]));
  }
  const stream = [];
  for (const blk of fixedData) stream.push(...blk);
  const bitArr = [];
  for (const b of stream) for (let i = 7; i >= 0; i--) bitArr.push((b >>> i) & 1);
  let p = 0;
  const take = n => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | bitArr[p++]; return x; };
  if (take(4) !== 0b0100) throw new Error('非 byte 模式（alnum/kanji 暂不支持）');
  const n = take(v >= 10 ? 16 : 8);
  if (n < 0 || p + n * 8 > bitArr.length) throw new Error('长度字段越界（图像质量不足）');
  const text = Buffer.from(Uint8Array.from({ length: n }, () => take(8))).toString('utf8');
  return { text, version: v, mask: fmt.mask, fixed };
}

/** 主入口：解码一张图片（png/jpg/bmp/tiff/heic 等 sips 能读的位图） */
export function decodeImage(file) {
  const { bin, w, h } = toBinaryGrid(file);
  const finders = findFinders(bin, w, h);
  if (finders.length < 3) throw new Error(`只找到 ${finders.length} 个 finder（需 3 个）——图片太小或码面不完整`);
  const triple = pickTriple(finders);
  if (!triple) throw new Error('finder 三角形校验失败');
  // TL = 距图像左上角最近者；TR = 另两者中 x 较大（旋转 ≤45° 假设下），BL = 剩余
  const sorted = [...triple].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const TL = sorted[0];
  const rest = sorted.slice(1);
  let TR = rest[0], BL = rest[1];
  // TR 应与 TL 同一行附近：比较 |dy|；若 BL 才是同行者则交换（旋转 >45°/镜像时）
  if (Math.abs(TR.y - TL.y) > Math.abs(BL.y - TL.y)) { TR = rest[1]; BL = rest[0]; }
  const legPx = Math.hypot(TR.x - TL.x, TR.y - TL.y);
  const mPx = (TL.m + TR.m + BL.m) / 3;
  // 版本取整：v = round((legPx/mPx + 7 - 17)/4)，试 v-1/v/v+1（module 估宽有 ±% 误差）
  const vEst = Math.round((legPx / mPx + 7 - 17) / 4);
  const tries = [];
  for (const v of [vEst, vEst - 1, vEst + 1, vEst - 2, vEst + 2]) {
    if (v >= 1 && v <= 10 && !tries.includes(17 + 4 * v)) tries.push(17 + 4 * v);
  }
  const errors = [];
  for (const size of tries) {
    for (const mirrored of [false, true]) {
      const S = size - 7;
      const mat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        const u = ((mirrored ? r : c) + 0.5 - 3.5) / S;
        const vv = ((mirrored ? c : r) + 0.5 - 3.5) / S;
        const x = TL.x + (TR.x - TL.x) * u + (BL.x - TL.x) * vv;
        const y = TL.y + (TR.y - TL.y) * u + (BL.y - TL.y) * vv;
        // 3×3 多数票
        let dark = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx)));
          const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
          dark += bin[yy * w + xx];
        }
        mat[r][c] = dark >= 5;
      }
      try {
        const out = decodeMatrix(mat);
        return { ...out, size };
      } catch (e) {
        errors.push(`size=${size}${mirrored ? '(镜像)' : ''}: ${e.message}`);
      }
    }
  }
  throw new Error('解码失败：' + errors.join('；'));
}
