# iskill-qrcode

二维码「生成 + 解码」二合一：零依赖（Node ≥ 18 标准库），种子无随机、同文本同图。
生成 5 款风格化 SVG（可直接内嵌网页 / README，GitHub 原生渲染）；解码支持轻微
旋转、透视与污损（自带 RS 纠错）。

## 何时用

- 用户说「做个二维码 / 把链接变成码 / 带logo的码 / 二维码美化」。
- 用户给一张二维码截图问「这里面是什么 / 帮我读一下」。
- 项目里需要程序化产码（CLI / import 均可）。

## 快速上手

```bash
# 经典黑白
node scripts/qr.mjs encode "https://example.com" --out qr.svg

# 带中心徽章（♥/¥/Z 等 1–2 字符），青色描边
node scripts/qr.mjs encode "https://paypal.me/you" --style icon --icon ♥ --accent "#10C8A1" --out qr.svg

# 渐变点阵 / 圆角 / 中心圆图
node scripts/qr.mjs encode "https://example.com" --style dots  --accent "#0070BA" --out qr.svg
node scripts/qr.mjs encode "https://example.com" --style photo --image avatar.jpg --out qr.svg

# 解码（png/jpg/bmp/tiff/heic…凡 sips 能读的位图；支持多张）
node scripts/qr.mjs decode screenshot.png shot2.png

# 编码器回归自检（round-trip）
node scripts/qr.mjs selfcheck
```

## 风格

| style | 观感 | 备注 |
| --- | --- | --- |
| `classic` | 方模块黑白 | 最稳，扫码器兼容性最好 |
| `rounded` | 圆角胶囊 + 圆角码眼 | 单色（`--dark`） |
| `dots` | 圆点/胶囊 + 竖向渐变 | `--accent` → `--dark` 两色渐变 |
| `icon` | 中心白底圆角徽章放字符 | `--icon`（默认 ♥）+ `--accent` 描边 |
| `photo` | 中心圆形照片 | `--image` 路径，base64 内嵌，SVG 自包含 |

中心孔按 M 级纠错预算实测标定（**不可随意放大**，孔过大 RS 纠不动）：
v1–2 → 3×3，v3 → 5×5，v4+ → 7×7 模块。

## 选项

| 参数 | 说明 |
| --- | --- |
| `--style` | `classic`（默认）/ `rounded` / `dots` / `icon` / `photo` |
| `--out` | `.svg` 文件或目录（目录则自动命名 `qr-<style>.svg`） |
| `--size <px>` | 输出像素边长，默认 512（SVG 矢量，任意缩放不糊） |
| `--dark <#hex>` | 码色，默认 `#111827` |
| `--accent <#hex>` | 渐变起点 / 徽章描边色，默认取 `--dark` |
| `--icon <字符>` | icon 风格中心字符，默认 `♥` |
| `--image <路径>` | photo 风格中心图（png/jpg/gif/webp） |
| `--stdin` | 文本从 stdin 读 |

## 解码能力与边界

- 支持：Model 2、byte 模式、纠错级别 **M**、版本 1–10（即本技能产出的码）。
- 容忍：轻微旋转/透视（三 finder 仿射）、镜像（自动转置重试）、
  局部污损（RS 纠错 ≤ 每块 t 个码字，Berlekamp–Massey + Chien + Forney）。
- 不支持：L/Q/H 级、alnum/kanji 模式、SVG 输入（先转 PNG：
  `qlmanage -t -s 1024 -o . x.svg`，或浏览器截图）。
- 解码输出会注明版本、掩码与 RS 纠错码字数——纠错数接近上限时提示图片质量。

## 程序化使用

```js
import { qrMatrix, qrSvg, qrSvgDataUri, qrSelfCheck } from './scripts/lib/qrcode.mjs';
import { renderStyledSvg } from './scripts/lib/qrstyles.mjs';
import { decodeImage, rsDecode } from './scripts/lib/qrdecode.mjs';

const svg = qrSvg('https://…');                                  // 经典 SVG 字符串
const uri = qrSvgDataUri('https://…');                           // data URI（<img src> 即用）
const styled = renderStyledSvg(qrMatrix('https://…'), { style: 'icon', icon: '♥', accent: '#10C8A1' });
const { text, version, fixed } = decodeImage('shot.png');        // 解码
qrSelfCheck(text);                                               // 编码器 round-trip 自检
```

## 验收（勿省）

1. `node scripts/qr.mjs selfcheck` —— 编码器 round-trip（v1–10、全掩码）。
2. **外部真解**：生成的 SVG 用 Chrome 打开后 `new BarcodeDetector().detect()`
   解出原文（苹果 Vision 底层，独立于本实现），或手机实扫。
3. `decode` 往返：encode 出的 SVG 渲染成 PNG 再 decode，文本必须逐字一致。
   五款风格都要过（icon/photo 因中心遮挡会动用 RS 纠错，输出里看 fixed 数）。

## 踩坑实录（改代码前必读）

- **`1 !== true` 恒真**：数据位是 0/1 数字、掩码返回 boolean，`!==` 严格比较
  跨类型必真——放置前必须 `!!` 转布尔。此 bug 让「数据位=1 且掩码=true」的格子
  全部放反，且 selfcheck 能过（读回时同样错误相互抵消），只有外部解码能暴露。
- **格式位布局**：15 位 = 高 5 位 (ecl<<3|mask) + 低 10 位 BCH；掩码在**高位**，
  `fdata & 7` 读到的是 BCH 尾比特。两份副本位序：竖排 col8 i0-5→(i,8)、
  横排 row8 i0-7→(8,size-1-i)，**不是转置**。
- **对齐图案先于 timing 绘制**：重叠区（如 v3 的 (6,22)/(22,6)）alignment 必须
  完整保留，timing 跳过已设格——反了整个码解不出。
- **去交错后解析**：原始码流 = 各块数据**顺序拼接**；轮转序还原的是交错序列，
  两者都会 syndrome=0（块各自成码），但只有块拼接序能解出文本。
- **EC 段也是轮转交错**（与数据段同规则），不是按块顺序排列。
- v2–v6 有 7 个 remainder bits（几何上多出的数据格），提取时按码字数截断即可。
- QR 的 RS 生成多项式 fcr=0（α⁰ 起），Forney 公式带 `X_i¹` 因子；注错 200 组
  回归验证过。

## 依赖

零三方依赖。图像解码走 macOS 自带 `sips`（BMP 24bpp 中转）；无 sips 环境仅
encode 可用。外部验证复用 Chrome `BarcodeDetector`（`agent-browser` 可驱动）。

## 安装（AI skill）

对 agent 说：**请帮我安装 Skill：aispin/iskill-qrcode**

## 共享真源

本仓库是 `scripts/lib/qrcode.mjs` 的**唯一真源**（零依赖 QR 编码器，文件头带
`@iskill-source` / `@iskill-version` 戳）。iskill-generate-sponsors 等以 vendored 副本消费
（声明见各仓库 `package.json` 的 `iskillDeps`）。

- **改本文件必须同一 commit 升 `@iskill-version`**（bug 升 patch、加能力升 minor）
- 升版后用 iskill-dep-sync 同步各消费方：
  `node ~/.workbuddy/skills/iskill-dep-sync/scripts/skill-deps.mjs check ~/WorkBuddy/ISkills/*`
  → 对报 `[UPDATE]` 的仓库逐个 `sync`
