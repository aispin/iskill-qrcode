#!/usr/bin/env node
/**
 * qr.mjs —— iskill-qrcode CLI（零依赖，Node ≥ 18）
 *
 *   node qr.mjs encode <text|-> [选项]      生成风格化 SVG
 *   node qr.mjs decode <图片...>            解码图片里的二维码
 *   node qr.mjs selfcheck [text]            编码器 round-trip 回归自检
 *
 * encode 选项：
 *   --style classic|rounded|dots|icon|photo   风格（默认 classic）
 *   --out <file.svg|dir>                      输出路径（默认 ./qr-<style>.svg；目录则自动命名）
 *   --size <px>                               输出像素边长（默认 512）
 *   --dark <#hex>                             码色（默认 #111827）
 *   --accent <#hex>                           点阵渐变/徽章描边色（默认取 --dark）
 *   --icon <字符>                             icon 风格的中心徽章字符（默认 ♥，1–2 字）
 *   --image <路径>                            photo 风格的中心圆图（base64 内嵌）
 *   --stdin                                   从 stdin 读文本
 *
 * 示例：
 *   node qr.mjs encode "https://paypal.me/you" --style icon --icon ♥ --accent #10C8A1
 *   node qr.mjs decode screenshot.png shot2.png
 */

import fs from 'node:fs';
import path from 'node:path';
import { qrMatrix, qrSelfCheck } from './lib/qrcode.mjs';
import { renderStyledSvg, svgDataUri } from './lib/qrstyles.mjs';
import { decodeImage } from './lib/qrdecode.mjs';

const HELP = `用法见文件头注释；或直接读 SKILL.md。`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') opts.stdin = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

function imageDataUriOf(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`--image 文件不存在：${abs}`);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error(`--image 仅支持 png/jpg/gif/webp：${abs}`);
  return `data:${mime};base64,` + fs.readFileSync(abs).toString('base64');
}

function cmdEncode(opts) {
  let text = opts._[0];
  if (opts.stdin) text = fs.readFileSync(0, 'utf8').trim();
  if (!text && !opts.stdin) { console.error('缺少文本：node qr.mjs encode <text> …'); process.exit(2); }
  const matrix = qrMatrix(text);
  if (!matrix) { console.error(`文本过长（utf8 ${Buffer.byteLength(text)} 字节 > 213），超出 v10-M 容量`); process.exit(1); }
  const style = ['classic', 'rounded', 'dots', 'icon', 'photo'].includes(opts.style) ? opts.style : 'classic';
  const svg = renderStyledSvg(matrix, {
    style, px: opts.size, dark: opts.dark, accent: opts.accent,
    icon: opts.icon, imageDataUri: opts.image ? imageDataUriOf(opts.image) : undefined,
  });
  let out = opts.out || `./qr-${style}.svg`;
  if (!out.endsWith('.svg')) out = path.join(out, `qr-${style}.svg`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, svg);
  const v = (matrix.size - 17) / 4;
  console.log(`✓ ${path.resolve(out)}  (${style} · v${v} · ${matrix.size}×${matrix.size} · ${(svg.length / 1024).toFixed(1)} KB)`);
}

function cmdDecode(opts) {
  const files = opts._;
  if (!files.length) { console.error('缺少图片：node qr.mjs decode <图片...>'); process.exit(2); }
  let fail = 0;
  for (const f of files) {
    try {
      const r = decodeImage(f);
      const fix = r.fixed ? ` · RS 纠错 ${r.fixed} 码字` : '';
      console.log(`✓ ${f} → ${r.text}  (v${r.version} · mask ${r.mask}${fix})`);
    } catch (e) {
      fail++;
      console.error(`✗ ${f} → ${e.message}`);
    }
  }
  process.exit(fail ? 1 : 0);
}

function cmdSelfCheck(opts) {
  const samples = opts._[0] ? [opts._[0]] : [
    'HELLO', 'https://www.paypal.com/ncp/payment/SN6RMEF7FNKU4', '中文字符串也要过',
    'x'.repeat(213), 'https://example.com/pay?q=' + 'x'.repeat(180),
  ];
  let pass = 0;
  for (const t of samples) {
    const r = qrSelfCheck(t);
    if (r.ok) pass++;
    else console.error(`✗ len=${t.length} ${JSON.stringify(r).slice(0, 120)}`);
  }
  console.log(`${pass}/${samples.length} round-trip 通过`);
  process.exit(pass === samples.length ? 0 : 1);
}

const cmd = process.argv[2];
const opts = parseArgs(process.argv.slice(3));
if (cmd === 'encode') cmdEncode(opts);
else if (cmd === 'decode') cmdDecode(opts);
else if (cmd === 'selfcheck') cmdSelfCheck(opts);
else { console.log(HELP); process.exit(cmd ? 2 : 0); }
