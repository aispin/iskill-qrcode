/**
 * qrstyles.mjs —— 矩阵 → 风格化 SVG（零依赖）
 *
 * 五种风格，全部保留 4 模块静区、恒白底深码（扫码可靠性优先）：
 *   classic 经典   方模块黑白，最稳
 *   rounded 圆角   圆角模块 + 圆角「码眼」，单色（--dark 或 --accent）
 *   dots    点阵   圆点模块 + 双色渐变（--accent → --dark），码眼圆环
 *   icon    徽标   rounded 变体，中心白底圆角徽章放 1–2 字符 icon（--icon ♥/¥/…）
 *   photo   图片   dots 变体，中心圆孔嵌图片（--image 路径，base64 内嵌）
 *
 * 中心遮挡的安全边界：纠错级别 M 可纠约 15% 码字，icon/photo 遮挡
 * 控制在 ~9–11% 面积内（v1/v2 自动缩小徽章），实测扫码稳定。
 */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isFinder = (r, c, size) =>
  (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

/** 把暗模块按行合并成 runs（圆角/方模块渲染共用，产物小一个量级） */
function rowRuns(matrix, skip) {
  const size = matrix.length;
  const runs = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (matrix[r][c] && !skip(r, c)) {
        let w = 1;
        while (c + w < size && matrix[r][c + w] && !skip(r, c + w)) w++;
        runs.push([r, c, w]);
        c += w;
      } else c++;
    }
  }
  return runs;
}

/** 方模块 path（classic 用，整图一条 path） */
function squarePath(matrix, ox, oy) {
  return rowRuns(matrix, () => false)
    .map(([r, c, w]) => `M${ox + c} ${oy + r}h${w}v1h-${w}z`)
    .join('');
}

/** 三个 finder「码眼」：外环圆角方 + 内核圆角方（rounded/dots/icon/photo 共用） */
function finderEyes(size, color, { coreRing = false } = {}) {
  const spots = [[0, 0], [0, size - 7], [size - 7, 0]];
  return spots.map(([r, c]) =>
    `<rect x="${c + 0.5}" y="${r + 0.5}" width="6" height="6" rx="1.9" fill="none" stroke="${color}" stroke-width="1"/>`
    + `<rect x="${c + 2}" y="${r + 2}" width="3" height="3" rx="${coreRing ? 1.5 : 0.9}" fill="${color}"/>`
  ).join('');
}

/** 圆角模块：按 run 画圆角 rect */
function roundedRects(runs, color, rx = 0.32) {
  return runs.map(([r, c, w]) =>
    `<rect x="${c + 0.06}" y="${r + 0.06}" width="${w - 0.12}" height="0.88" rx="${Math.min(rx, (w - 0.12) / 2)}" fill="${color}"/>`
  ).join('');
}

/** 圆点模块 */
function dots(runs, fill) {
  return runs.map(([r, c, w]) => {
    if (w === 1) return `<circle cx="${c + 0.5}" cy="${r + 0.5}" r="0.42" fill="${fill}"/>`;
    // 连 run 画胶囊（更顺滑）
    return `<rect x="${c + 0.08}" y="${r + 0.08}" width="${w - 0.16}" height="0.84" rx="0.42" fill="${fill}"/>`;
  }).join('');
}

function svgWrap(n, px, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges">`
    + (defs ? `<defs>${defs}</defs>` : '')
    + `<rect width="${n}" height="${n}" fill="#fff"/><g>${body}</g></svg>`;
}

/**
 * 主入口：renderStyledSvg({size, matrix}, opts) → svg 字符串
 * opts: style, px, dark, accent, light, icon, imageDataUri
 */
export function renderStyledSvg(qr, opts = {}) {
  const { size, matrix } = qr;
  const style = opts.style || 'classic';
  const px = Math.max(64, Math.min(4096, Number(opts.px) || 512));
  const margin = 4;
  const n = size + margin * 2;
  const dark = opts.dark || '#111827';
  const accent = opts.accent || dark;
  const M = margin; // 静区

  if (style === 'classic') {
    const body = `<path d="${squarePath(matrix, M, M)}" fill="${dark}"/>`;
    return svgWrap(n, px, body);
  }

  if (style === 'rounded') {
    const runs = rowRuns(matrix, (r, c) => isFinder(r, c, size));
    const body = roundedRects(runs, dark) + finderEyes(size, dark);
    return svgWrap(n, px, `<g transform="translate(${M} ${M})">${body}</g>`);
  }

  if (style === 'dots') {
    const runs = rowRuns(matrix, (r, c) => isFinder(r, c, size));
    const gid = 'qrg';
    const defs = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`;
    const body = dots(runs, `url(#${gid})`) + finderEyes(size, dark, { coreRing: true });
    return svgWrap(n, px, `<g transform="translate(${M} ${M})">${body}</g>`, defs);
  }

  if (style === 'icon' || style === 'photo') {
    // 中心孔按「M 级纠错预算」分级（实测标定：孔过大 RS 纠不动）：
    //   v1-2 (21/25) → 3×3   v3 (29) → 5×5   v4+ (≥33) → 7×7
    const holeR = size >= 33 ? 3.5 : size >= 29 ? 2.5 : 1;
    const runs = rowRuns(matrix, (r, c) =>
      isFinder(r, c, size) ||
      // 中心遮挡区：徽章/圆图覆盖的模块不再画点（EC M 会纠回来）
      (Math.abs(r - (size - 1) / 2) <= holeR && Math.abs(c - (size - 1) / 2) <= holeR));
    const cx = size / 2, cy = size / 2;
    let defs = '';
    let rest = '';
    if (style === 'icon') {
      const badge = holeR * 2 + 1.2;
      const icon = esc(opts.icon || '♥');
      const fs = icon.length > 1 ? holeR * 1.1 : holeR * 1.5;
      rest = `<rect x="${cx - badge / 2}" y="${cy - badge / 2}" width="${badge}" height="${badge}"`
        + ` rx="${badge * 0.28}" fill="#fff" stroke="${accent}" stroke-width="0.35"/>`
        + `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"`
        + ` font-family="-apple-system,'PingFang SC','Segoe UI Emoji',sans-serif" font-weight="700"`
        + ` font-size="${fs}" fill="${accent}">${icon}</text>`;
    } else {
      const img = opts.imageDataUri;
      if (!img) throw new Error('photo 风格需要 --image <图片路径>');
      const rr = holeR + 0.5;
      defs = `<clipPath id="qrc"><circle cx="${cx}" cy="${cy}" r="${rr}"/></clipPath>`;
      rest = `<image href="${img}" x="${cx - rr}" y="${cy - rr}" width="${rr * 2}" height="${rr * 2}"`
        + ` preserveAspectRatio="xMidYMid slice" clip-path="url(#qrc)"/>`
        + `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="#fff" stroke-width="0.3"/>`
        + `<circle cx="${cx}" cy="${cy}" r="${rr + 0.15}" fill="none" stroke="${accent}" stroke-width="0.2"/>`;
    }
    const body = dots(runs, dark) + finderEyes(size, dark, { coreRing: true }) + rest;
    return svgWrap(n, px, `<g transform="translate(${M} ${M})">${body}</g>`, defs);
  }

  throw new Error(`未知风格：${style}（可选 classic / rounded / dots / icon / photo）`);
}

/** → data URI */
export function svgDataUri(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
