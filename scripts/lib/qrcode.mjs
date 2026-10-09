/**
 * @iskill-source iskill-qrcode/scripts/lib/qrcode.mjs
 * @iskill-version 1.0.1
 *
 * qrcode.mjs —— 零依赖二维码编码器（Node ≥ 24 标准库）
 *
 * 产出供「外链赞助方式」（PayPal 等）展示的二维码：整卡可点（target=_blank），
 * 码面可扫，两条路都能到达同一个网址。
 *
 *   qrSvgDataUri('https://...')  → data:image/svg+xml;base64,...（放进 <img src> 即用）
 *   qrMatrix('https://...')      → { size, matrix }（自绘 SVG / Canvas 时用）
 *
 * 实现范围：QR Model 2，byte 模式，纠错级别 M（15%），版本 1–10 自动选
 * （容量 14–196 字节，覆盖一切常规链接；超长返回 null 由调用方兜底）。
 * 掩码 0–7 全试、按标准四条罚分规则挑最优。SVG 走「按行游程合并」的 path，
 * 一张码 ~40 条指令、1–2 KB，比逐模块 <rect> 小一个量级。
 *
 * 关键表（级别 M）——total = Σblock 数据码字 + 块数×EC码字，勿凭记忆改：
 *   v : total  ec/块  各块数据码字
 *   1 :  26    10     [16]
 *   2 :  44    16     [28]
 *   3 :  70    26     [44]
 *   4 : 100    18     [32,32]
 *   5 : 134    24     [43,43]
 *   6 : 172    16     [27,27,27,27]
 *   7 : 196    18     [31,31,31,31]
 *   8 : 242    22     [38,39,38,39]
 *   9 : 292    22     [36,37,36,37,36]
 *   10: 346    26     [43,43,43,43,44]
 */

// ── GF(256)，生成多项式 0x11d（QR 标准）──
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

/** RS 生成多项式系数（度数 n），g[0]=1 惯例下按降幂存 */
function rsGenPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    // g = g * (x - α^i)；降幂数组（index 0 = 最高次）：×x 度数齐 +1、下标不变，×α^i 落 j+1
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];                   // × x
      next[j + 1] ^= gmul(g[j], EXP[i]); // × α^i
    }
    g = next;
  }
  return g;
}

/** 数据码字 → RS 纠错码字（余式） */
function rsEc(data, n) {
  const g = rsGenPoly(n);
  let rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem = rem.slice(1).concat(0);
    if (factor) for (let i = 0; i < n; i++) rem[i] ^= gmul(g[i + 1], factor);
  }
  return rem;
}

const BLOCKS = {
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
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
/** byte 模式容量（数据比特 = Σ数据码字×8 − 4 模式位 − 计数位(≤v9:8, v10+:16)，向下取整到字节） */
const CAPACITY = {
  1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 105, 7: 122, 8: 151, 9: 180, 10: 213,
};

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) if (byteLen <= CAPACITY[v]) return v;
  return null;
}

/** bit 数组（MSB first） */
function buildDataBits(text, v) {
  const spec = BLOCKS[v];
  const dataCw = spec.blocks.reduce((a, b) => a + b, 0);
  const countBits = v >= 10 ? 16 : 8;
  const bytes = Buffer.from(text, 'utf8');
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);                 // byte 模式
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  const capBits = dataCw * 8;
  // 终止符（至多 4 个 0）+ 对齐到字节
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  // 0xEC / 0x11 交替填充
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) { push(pads[pi++ % 2], 8); }
  // → 码字
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  // 分块 + 纠错 + 交错
  const dataBlocks = [], ecBlocks = [];
  let off = 0;
  for (const len of spec.blocks) {
    dataBlocks.push(cw.slice(off, off + len)); off += len;
  }
  for (const db of dataBlocks) ecBlocks.push(rsEc(db, spec.ec));
  const out = [];
  const maxLen = Math.max(...spec.blocks);
  for (let i = 0; i < maxLen; i++)
    for (const db of dataBlocks) if (i < db.length) out.push(db[i]);
  for (let i = 0; i < spec.ec; i++)
    for (const eb of ecBlocks) out.push(eb[i]);
  return out; // 最终码字序列
}

function formatBits(mask) {
  const data = (0b00 << 3) | mask; // 级别 M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) & 1 ? 0x537 : 0);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) & 1 ? 0x1f25 : 0);
  return (v << 12) | rem;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

/** 底图：finder/separator/timing/alignment/dark module，全部记入 reserved */
function buildBase(v) {
  const size = 17 + 4 * v;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, val) => { m[r][c] = val; res[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, inRing || inCore);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // ⚠️ 顺序：alignment 先于 timing（与 qrcode-generator 一致）——
  //    两者重叠时（如 v3 的 (6,22)/(22,6)）alignment 必须完整保留，
  //    timing 跳过已设格。反过来的话对齐图案整块丢失，码解不出。
  const ap = ALIGN[v];
  for (const r of ap) for (const c of ap) {
    if (res[r][c]) continue; // 只跳过与 finder 重叠的左上角
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      const core = dr === 0 && dc === 0;
      set(r + dr, c + dc, edge || core);
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === null) set(6, i, i % 2 === 0);
    if (m[i][6] === null) set(i, 6, i % 2 === 0);
  }

  set(size - 8, 8, true); // dark module

  // 版本信息（v≥7）：左下 & 右上两个 6×3 块
  if (v >= 7) {
    const vb = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >>> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      set(size - 11 + c, r, bit);          // 左下
      set(r, size - 11 + c, bit);          // 右上
    }
  }

  // 格式信息占位（两份，选定掩码后回填）。标准位序（i = 格式位 0..14，LSB 在前）：
  //   竖排 col 8 : i0-5→(i,8)  i6→(7,8)  i7→(8,8)  i8-14→(size-15+i,8)
  //   横排 row 8 : i0-7→(8,size-1-i)  i8→(8,7)  i9-14→(8,14-i)
  // ⚠️ 只保留这两份副本实际覆盖的格子 —— col8 的 rows 9..13、row8 的 cols 9..12/14
  //    都是数据区，多标一格数据就整体错位（第一版在此栽过）。
  for (let i = 0; i < 15; i++) {
    if (i <= 5) res[i][8] = true;
    else if (i <= 7) res[i + 1][8] = true;
    else res[size - 15 + i][8] = true;
    if (i <= 7) res[8][size - 1 - i] = true;
    else if (i === 8) res[8][7] = true;
    else res[8][14 - i] = true;
  }
  return { size, m, res };
}

function writeFormat(m, size, mask) {
  const bits = formatBits(mask); // 15 bits，bit i = (bits >>> i) & 1
  for (let i = 0; i < 15; i++) {
    const bit = (bits >>> i) & 1;
    // 竖排（col 8）
    if (i <= 5) m[i][8] = bit;
    else if (i <= 7) m[i + 1][8] = bit;          // i6→row7, i7→row8
    else m[size - 15 + i][8] = bit;              // i8-14 → rows size-7..size-1
    // 横排（row 8）
    if (i <= 7) m[8][size - 1 - i] = bit;        // i0-7 → cols size-1..size-8
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;                     // i9-14 → cols 5..0
  }
  m[size - 8][8] = true;                         // dark module 恒黑
}

function penalty(m) {
  const size = m.length;
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1, prev = get(a, 0);
      for (let b = 1; b < size; b++) {
        const cur = get(a, b);
        if (cur === prev) {
          run++;
          if (b === size - 1 && run >= 5) p += 3 + run - 5;
        } else {
          if (run >= 5) p += 3 + run - 5;
          run = 1; prev = cur;
        }
      }
    }
  };
  line((a, b) => m[a][b]);
  line((a, b) => m[b][a]);
  // N2 2×2 同色
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  // N3 1011101（两侧 4 白）
  const pat1 = [1, 0, 1, 1, 1, 0, 1];
  const check = (get) => {
    for (let a = 0; a < size; a++) {
      const s = Array.from({ length: size }, (_, b) => get(a, b) ? 1 : 0);
      for (let i = 0; i <= size - 11; i++) {
        let ok1 = true, ok2 = true;
        for (let j = 0; j < 7; j++) {
          if (s[i + 4 + j] !== pat1[j]) ok1 = false;
          if (s[i + j] !== pat1[j]) ok2 = false;
        }
        if (ok1 && s[i] === 0 && s[i + 1] === 0 && s[i + 2] === 0 && s[i + 3] === 0) p += 40;
        if (ok2 && s[i + 7] === 0 && s[i + 8] === 0 && s[i + 9] === 0 && s[i + 10] === 0) p += 40;
      }
    }
  };
  check((a, b) => m[a][b]);
  check((a, b) => m[b][a]);
  // N4 明暗比例
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

/** 主入口：返回 { size, matrix }，超长（>196B）返回 null */
export function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const v = pickVersion(bytes.length);
  if (!v) return null;
  const cw = buildDataBits(text, v);
  const bits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  const { size, m: base, res } = buildBase(v);

  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => row.slice());
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (m[r][c] === null && !res[r][c]) {
            // ⚠️ bits 是 0/1 数字，必须先转布尔 —— 否则 1 !== true 恒真，
            //    「数据位=1 且掩码=true」的格子全部放反（第一版在此栽过）
            const dark = !!(bi < bits.length ? bits[bi] : false);
            m[r][c] = dark !== MASKS[mask](r, c); // XOR 掩码
            bi++;
          }
        }
      }
    }
    writeFormat(m, size, mask);
    const p = penalty(m);
    if (p < bestP) { bestP = p; best = m; }
  }
  return { size, matrix: best };
}

/** 矩阵 → SVG 字符串（白底黑码，4 模块静区，按行游程合并 path） */
export function qrSvg(text, { margin = 4 } = {}) {
  const { size, matrix } = qrMatrix(text) || {};
  if (!matrix) return null;
  const n = size + margin * 2;
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (matrix[r][c]) {
        let w = 1;
        while (c + w < size && matrix[r][c + w]) w++;
        d += `M${margin + c} ${margin + r}h${w}v1h-${w}z`;
        c += w;
      } else c++;
    }
  }
  // width/height 给出自然尺寸（无它们 createImageBitmap/部分解码器会拒绝无固有尺寸的 SVG）
  const px = n * 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** → data URI（<img src> 直接可用；超长返回 null） */
export function qrSvgDataUri(text, opts) {
  const svg = qrSvg(text, opts);
  return svg ? 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') : null;
}

/** 自解码 round-trip：从最终矩阵读回格式位 → 去掩码 → 提取码字 → RS 综合校验 → 还原文本。
 *  编码器回归测试用（结构、格式位、交错、RS 全链路对拍）；通过则 ok=true 且文本逐字节一致。 */
export function qrSelfCheck(text) {
  const { size, matrix } = qrMatrix(text) || {};
  if (!matrix) return { ok: false, reason: 'too-long' };
  const v = (size - 17) / 4;
  const readV = i => (i <= 5 ? matrix[i][8] : i <= 7 ? matrix[i + 1][8] : matrix[size - 15 + i][8]);
  const readH = i => (i <= 7 ? matrix[8][size - 1 - i] : i === 8 ? matrix[8][7] : matrix[8][14 - i]);
  let fmt = 0, fmt2 = 0;
  for (let i = 0; i < 15; i++) { fmt |= readV(i) << i; fmt2 |= readH(i) << i; }
  if (fmt !== fmt2) return { ok: false, reason: 'format-copies-differ' };
  const fdata = fmt ^ 0x5412;
  const digit = x => { let n = 0; while (x) { n++; x >>>= 1; } return n; };
  let d = fdata;
  while (digit(d) - digit(0x537) >= 0) d ^= 0x537 << (digit(d) - digit(0x537));
  if (d !== 0) return { ok: false, reason: 'format-bch' };
  // 格式数据布局：高 5 位 = (ecl<<3)|mask，低 10 位 = BCH —— mask 在高位，别 &7
  const mask = (fdata >>> 10) & 7;
  if (fdata >>> 13 !== 0) return { ok: false, reason: 'ecl-not-M' };
  const { res } = buildBase(v);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!res[r][c]) bits.push(matrix[r][c] !== MASKS[mask](r, c));
      }
    }
  }
  const spec = BLOCKS[v];
  const cw = [];
  for (let i = 0; i + 8 <= bits.length && cw.length < spec.total; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  const dataLens = spec.blocks, nB = dataLens.length;
  // 去交错：数据码字是按块轮转的（buildDataBits 同款顺序），不能顺序切块
  const dataBlocks = Array.from({ length: nB }, () => []);
  let idx = 0;
  const maxLen = Math.max(...dataLens);
  for (let i = 0; i < maxLen; i++)
    for (let b = 0; b < nB; b++) if (i < dataLens[b]) dataBlocks[b].push(cw[idx++]);
  // EC 段：与数据段一样按块轮转交错（spec 如此）
  const ecBlocks = Array.from({ length: nB }, () => []);
  for (let i = 0; i < spec.ec; i++)
    for (let b = 0; b < nB; b++) ecBlocks[b].push(cw[idx++]);
  for (let b = 0; b < nB; b++) {
    const msg = dataBlocks[b].concat(ecBlocks[b]);
    for (let j = 0; j < spec.ec; j++) {
      let s = 0;
      for (const c of msg) s = gmul(s, EXP[j]) ^ c;
      if (s) return { ok: false, reason: 'rs-syndrome', block: b, exp: j };
    }
  }
  // 原始码流 = 各块数据顺序拼接（block0 的码字就是码流前 32 字节…），
  // 不是轮转交错序 —— 交错只存在于 cw 排布里，去交错后按块拼回即可
  const all = [];
  for (let b = 0; b < nB; b++) all.push(...dataBlocks[b]);
  const bitArr = [];
  for (const b of all) for (let i = 7; i >= 0; i--) bitArr.push((b >>> i) & 1);
  let p = 0; const take = n => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | bitArr[p++]; return x; };
  if (take(4) !== 0b0100) return { ok: false, reason: 'mode' };
  const n = take(v >= 10 ? 16 : 8);
  const out = Buffer.from(Uint8Array.from({ length: n }, () => take(8))).toString('utf8');
  return out === text ? { ok: true, reason: 'roundtrip', mask } : { ok: false, reason: 'text-mismatch', got: out };
}
