import { cardRows, footerFor, summaryText, type StoryLine } from "./story";

export const CARD_STORY_LIMIT = 12;
export const CARD_WRAP_ROWS = 2;

export interface CardVisualRow {
  color: string;
  text: string;
  bullet: boolean;
}

const PAGE: Rgb = [16, 14, 12];
const CARD: Rgb = [28, 25, 22];
const INK: Rgb = [244, 239, 230];
const MUTED: Rgb = [163, 152, 136];

type Rgb = [number, number, number];

const SCALE = 2;
const GLYPH_W = 5;
const GLYPH_H = 7;

/** 5×7 glyphs, one hex row per line, bits left to right. */
const FONT = parseFont(`
  00 00 00 00 00 00 00
! 04 04 04 04 04 00 04
" 0a 0a 0a 00 00 00 00
# 0a 0a 1f 0a 1f 0a 0a
$ 04 0f 14 0e 05 1e 04
% 19 19 02 04 08 13 13
& 08 14 14 08 15 12 0d
' 04 04 04 00 00 00 00
( 02 04 08 08 08 04 02
) 08 04 02 02 02 04 08
* 00 0a 04 1f 04 0a 00
+ 00 04 04 1f 04 04 00
, 00 00 00 00 04 04 08
- 00 00 00 1f 00 00 00
. 00 00 00 00 00 0c 0c
/ 01 02 04 08 10 00 00
0 0e 11 13 15 19 11 0e
1 04 0c 04 04 04 04 0e
2 0e 11 01 06 08 10 1f
3 1f 02 04 02 01 11 0e
4 02 06 0a 12 1f 02 02
5 1f 10 1e 01 01 11 0e
6 06 08 10 1e 11 11 0e
7 1f 01 02 04 08 08 08
8 0e 11 11 0e 11 11 0e
9 0e 11 11 0f 01 02 0c
: 00 0c 0c 00 0c 0c 00
; 00 0c 0c 00 0c 04 08
< 02 04 08 10 08 04 02
= 00 00 1f 00 1f 00 00
> 08 04 02 01 02 04 08
? 0e 11 01 02 04 00 04
@ 0e 11 17 15 17 10 0e
A 0e 11 11 1f 11 11 11
B 1e 11 11 1e 11 11 1e
C 0e 11 10 10 10 11 0e
D 1c 12 11 11 11 12 1c
E 1f 10 10 1e 10 10 1f
F 1f 10 10 1e 10 10 10
G 0e 11 10 17 11 11 0f
H 11 11 11 1f 11 11 11
I 0e 04 04 04 04 04 0e
J 07 02 02 02 02 12 0c
K 11 12 14 18 14 12 11
L 10 10 10 10 10 10 1f
M 11 1b 15 15 11 11 11
N 11 11 19 15 13 11 11
O 0e 11 11 11 11 11 0e
P 1e 11 11 1e 10 10 10
Q 0e 11 11 11 15 12 0d
R 1e 11 11 1e 14 12 11
S 0e 11 10 0e 01 11 0e
T 1f 04 04 04 04 04 04
U 11 11 11 11 11 11 0e
V 11 11 11 11 11 0a 04
W 11 11 11 15 15 15 0a
X 11 11 0a 04 0a 11 11
Y 11 11 0a 04 04 04 04
Z 1f 01 02 04 08 10 1f
[ 0e 08 08 08 08 08 0e
] 0e 02 02 02 02 02 0e
_ 00 00 00 00 00 00 1f
a 00 00 0e 01 0f 11 0f
b 10 10 16 19 11 11 1e
c 00 00 0e 10 10 11 0e
d 01 01 0d 13 11 11 0f
e 00 00 0e 11 1f 10 0e
f 06 09 08 1c 08 08 08
g 00 00 0f 11 0f 01 0e
h 10 10 16 19 11 11 11
i 04 00 0c 04 04 04 0e
j 02 00 06 02 02 12 0c
k 10 10 12 14 18 14 12
l 0c 04 04 04 04 04 0e
m 00 00 1a 15 15 15 15
n 00 00 16 19 11 11 11
o 00 00 0e 11 11 11 0e
p 00 00 1e 11 1e 10 10
q 00 00 0d 13 0f 01 01
r 00 00 16 19 10 10 10
s 00 00 0e 10 0e 01 1e
t 08 08 1c 08 08 09 06
u 00 00 11 11 11 13 0d
v 00 00 11 11 11 0a 04
w 00 00 11 11 15 15 0a
x 00 00 11 0a 04 0a 11
y 00 00 11 11 0f 01 0e
z 00 00 1f 02 04 08 1f
`);

export function planCard(lines: StoryLine[], width = 720): CardVisualRow[] {
  const advance = (GLYPH_W + 1) * SCALE;
  const textWidth = Math.floor((width - 56) / advance);
  const rows = cardRows(lines);
  const shown = rows.slice(0, CARD_STORY_LIMIT);
  const hidden = rows.length - shown.length;
  const body: CardVisualRow[] = [];
  for (const row of shown) {
    const wrapped = wrapCard(row.text, textWidth, CARD_WRAP_ROWS);
    wrapped.forEach((text, index) => {
      body.push({ color: row.color, text, bullet: index === 0 });
    });
  }
  if (hidden > 0) body.push({ color: "#5c564c", text: `+${hidden} more`, bullet: false });
  return body;
}

export async function renderCardPng(lines: StoryLine[], title: string, caption = "SESSION DIFF"): Promise<Uint8Array> {
  const width = 720;
  const advance = (GLYPH_W + 1) * SCALE;
  const maxChars = Math.floor((width - 88) / advance);
  const headline = wrapCard(title, maxChars, 2);
  const counts = wrapCard(summaryText(lines), maxChars, 2);
  const body = planCard(lines, width);
  const footer = wrapCard(footerFor(lines), maxChars, 2);
  const lineH = 26;
  const pad = 28;
  const height = pad + 22 + headline.length * lineH + (counts[0] ? counts.length * lineH : 0) + 8 + Math.max(body.length, 1) * lineH + footer.length * lineH + pad;
  const pixels = new Uint8Array(width * height * 3);
  fill(pixels, PAGE);
  roundedRect(pixels, width, 12, 12, width - 24, height - 24, 18, CARD);
  let y = pad;
  drawText(pixels, width, 32, y, cardPlain(caption), MUTED);
  y += 22;
  headline.forEach((text) => {
    drawText(pixels, width, 32, y, text, INK);
    y += lineH;
  });
  if (counts[0]) {
    counts.forEach((text) => {
      drawText(pixels, width, 32, y, text, INK);
      y += lineH;
    });
  }
  y += 6;
  body.forEach((row) => {
    if (row.bullet) rect(pixels, width, 32, y + 2, 8, 14, hex(row.color));
    drawText(pixels, width, 48, y, row.text, INK);
    y += lineH;
  });
  footer.forEach((text) => {
    if (!text) return;
    drawText(pixels, width, 32, y, text, MUTED);
    y += lineH;
  });
  return encodePng(width, height, pixels);
}

export function receiptCardKey(jsonKey: string): string {
  return jsonKey.endsWith(".json") ? `${jsonKey.slice(0, -".json".length)}.png` : `${jsonKey}.png`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function parseFont(source: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const line of source.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    const ch = parts[0] === "" ? " " : parts[0];
    if (!ch || parts.length < 8) continue;
    map.set(ch, parts.slice(1, 8).map((hex) => Number.parseInt(hex, 16)));
  }
  map.set(" ", [0, 0, 0, 0, 0, 0, 0]);
  return map;
}

const EXTRA: Record<string, number[]> = {
  "\u00b7": [0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00],
};

for (const [ch, rows] of Object.entries(EXTRA)) FONT.set(ch, rows);

const FOLD: Record<string, string> = {
  "\u00a0": " ",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2022": "*",
  "\u00ab": "\"",
  "\u00bb": "\"",
  "\u201c": "\"",
  "\u201d": "\"",
  "\u201e": "\"",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u2026": ".",
  "\u2192": "-",
};

/** Font key for a character. Empty means the character is skipped, never drawn as "?". */
export function glyphKey(ch: string): string {
  if (FONT.has(ch)) return ch;
  const folded = FOLD[ch];
  if (folded && FONT.has(folded)) return folded;
  const lower = ch.toLowerCase();
  if (FONT.has(lower)) return lower;
  return "";
}

export function glyphRows(ch: string): number[] | null {
  const key = glyphKey(ch);
  if (!key) return null;
  return FONT.get(key) ?? null;
}

function hex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match?.[1]) return INK;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function roundedRect(pixels: Uint8Array, width: number, x: number, y: number, w: number, h: number, radius: number, color: Rgb): void {
  const height = pixels.length / 3 / width;
  for (let yy = y; yy < y + h; yy += 1) {
    if (yy < 0 || yy >= height) continue;
    for (let xx = x; xx < x + w; xx += 1) {
      if (xx < 0 || xx >= width) continue;
      if (!insideRound(xx - x, yy - y, w, h, radius)) continue;
      const i = (yy * width + xx) * 3;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
    }
  }
}

function insideRound(x: number, y: number, w: number, h: number, radius: number): boolean {
  const r = Math.min(radius, Math.floor(w / 2), Math.floor(h / 2));
  let dx = 0;
  let dy = 0;
  if (x < r) dx = r - x;
  else if (x >= w - r) dx = x - (w - r - 1);
  if (y < r) dy = r - y;
  else if (y >= h - r) dy = y - (h - r - 1);
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= r * r;
}

function fill(pixels: Uint8Array, color: Rgb): void {
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
  }
}

function rect(pixels: Uint8Array, width: number, x: number, y: number, w: number, h: number, color: Rgb): void {
  const height = pixels.length / 3 / width;
  for (let yy = y; yy < y + h; yy += 1) {
    if (yy < 0 || yy >= height) continue;
    for (let xx = x; xx < x + w; xx += 1) {
      if (xx < 0 || xx >= width) continue;
      const i = (yy * width + xx) * 3;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
    }
  }
}

/** Map punctuation onto glyphs this bitmap font actually has, then wrap instead of cutting the line off. */
export function cardPlain(value: string): string {
  return [...value].map((ch) => (ch === "\u2026" ? "..." : ch === "\u2192" ? "->" : ch === "\u2197" ? ">" : FOLD[ch] ?? ch)).join("");
}

export function wrapCard(text: string, maxChars: number, maxLines?: number): string[] {
  const plain = cardPlain(text).replace(/\s+/g, " ").trim();
  if (!plain) return [""];
  const limit = Math.max(8, maxChars);
  const lines: string[] = [];
  let current = "";
  for (const word of plain.split(" ")) {
    let rest = word;
    while (rest.length > limit) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (!rest) continue;
    if (!current) current = rest;
    else if (`${current} ${rest}`.length <= limit) current = `${current} ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current) lines.push(current);
  const wrapped = lines.length > 0 ? lines : [""];
  if (!maxLines || wrapped.length <= maxLines) return wrapped;
  const kept = wrapped.slice(0, maxLines);
  const ellipsis = "...";
  const last = kept[maxLines - 1] ?? "";
  const room = Math.max(0, limit - ellipsis.length);
  const base = last.length <= room ? last : last.slice(0, room).trimEnd();
  kept[maxLines - 1] = `${base}${ellipsis}`;
  return kept;
}

function drawText(pixels: Uint8Array, width: number, x: number, y: number, text: string, color: Rgb): void {
  const advance = (GLYPH_W + 1) * SCALE;
  let cursor = x;
  for (const ch of text) {
    if (cursor + advance > width - 8) break;
    const glyph = glyphRows(ch);
    if (glyph) blit(pixels, width, cursor, y, glyph, color);
    cursor += advance;
  }
}

function blit(pixels: Uint8Array, width: number, x: number, y: number, rows: number[], color: Rgb): void {
  const height = pixels.length / 3 / width;
  for (let row = 0; row < GLYPH_H; row += 1) {
    const bits = rows[row] ?? 0;
    for (let col = 0; col < GLYPH_W; col += 1) {
      if ((bits & (1 << (GLYPH_W - 1 - col))) === 0) continue;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const px = x + col * SCALE + sx;
          const py = y + row * SCALE + sy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const i = (py * width + px) * 3;
          pixels[i] = color[0];
          pixels[i + 1] = color[1];
          pixels[i + 2] = color[2];
        }
      }
    }
  }
}

async function encodePng(width: number, height: number, rgb: Uint8Array): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    raw[start] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), start + 1);
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())];
  const size = signature.length + chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  png.set(signature, 0);
  let offset = signature.length;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
