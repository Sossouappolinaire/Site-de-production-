// bilan-chart.js — COURBE DE VARIATIONS envoyée après chaque bilan (demande admin).
//
//   • ordonnée : résultat de chaque prédiction vérifiée → 0, 1, 2… = victoire au rattrapage N (✅0️⃣, ✅1️⃣…),
//                niveau le plus haut (croix rouge) = PERTE ;
//   • abscisse : numéro du jeu prédit, avec le costume prédit dessiné dessous ;
//   • une courbe de couleur par canal (la légende est dans la légende de la photo Telegram).
//
// Image PNG dessinée en pur Node (zlib), sans aucune dépendance : pas de service externe, pas de police à installer.
'use strict';
const zlib = require('zlib');

const DIGITS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
// couleur de chaque courbe ↔ carré coloré de la légende
const PALETTE = [
  { rgb: [31, 111, 208], emoji: '🟦' }, { rgb: [214, 39, 40], emoji: '🟥' }, { rgb: [44, 160, 44], emoji: '🟩' },
  { rgb: [255, 127, 14], emoji: '🟧' }, { rgb: [142, 91, 196], emoji: '🟪' }, { rgb: [140, 86, 75], emoji: '🟫' },
];
const MAX_TARGETS = 24; // derniers jeux affichés (lisibilité)
const MAX_SERIES = 6;

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.buf = Buffer.alloc(w * h * 3, 255); }
  blend(x, y, c, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 3; const k = Math.min(1, a);
    this.buf[i] = Math.round(this.buf[i] * (1 - k) + c[0] * k);
    this.buf[i + 1] = Math.round(this.buf[i + 1] * (1 - k) + c[1] * k);
    this.buf[i + 2] = Math.round(this.buf[i + 2] * (1 - k) + c[2] * k);
  }
  rect(x, y, w, h, c) { for (let j = Math.floor(y); j < y + h; j++) for (let i = Math.floor(x); i < x + w; i++) this.blend(i, j, c, 1); }
  line(x0, y0, x1, y1, th, c) {
    const r = th / 2;
    const minX = Math.floor(Math.min(x0, x1) - r - 1); const maxX = Math.ceil(Math.max(x0, x1) + r + 1);
    const minY = Math.floor(Math.min(y0, y1) - r - 1); const maxY = Math.ceil(Math.max(y0, y1) + r + 1);
    const dx = x1 - x0; const dy = y1 - y0; const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      let t = ((x - x0) * dx + (y - y0) * dy) / len2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
      this.blend(x, y, c, r + 0.5 - d);
    }
  }
  dashedHLine(x0, x1, y, c) { for (let x = x0; x < x1; x += 8) this.rect(x, y, 4, 1, c); }
  circle(cx, cy, r, c) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      this.blend(x, y, c, r + 0.5 - Math.hypot(x - cx, y - cy));
    }
  }
  ring(cx, cy, r, th, c) {
    for (let y = Math.floor(cy - r - th); y <= cy + r + th; y++) for (let x = Math.floor(cx - r - th); x <= cx + r + th; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      this.blend(x, y, c, th / 2 + 0.5 - d);
    }
  }
  poly(pts, c) {
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    const inside = (px, py) => {
      let ins = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ins = !ins;
      }
      return ins;
    };
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      let n = 0; for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) n++;
      if (n) this.blend(x, y, c, n / 9);
    }
  }
  digits(str, x, y, scale, c) { // x = bord gauche
    for (const ch of String(str)) {
      const g = DIGITS[ch];
      if (g) for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') this.rect(x + q * scale, y + r * scale, scale, scale, c);
      x += 6 * scale;
    }
  }
  digitsWidth(str, scale) { return String(str).length * 6 * scale - scale; }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 3 + 1)] = 0; this.buf.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3); }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const RED = [214, 39, 40]; const BLACK = [30, 30, 30];
function suitKind(s) {
  const c = String(s || '');
  if (c.includes('♠')) return 'S'; if (c.includes('♣')) return 'C'; if (c.includes('♦')) return 'D';
  if (c.includes('♥') || c.includes('❤')) return 'H';
  return null;
}
function drawSuit(cv, kind, cx, cy, s) {
  if (kind === 'D') cv.poly([[cx, cy - s * 0.5], [cx + s * 0.38, cy], [cx, cy + s * 0.5], [cx - s * 0.38, cy]], RED);
  else if (kind === 'H') {
    cv.circle(cx - s * 0.25, cy - s * 0.17, s * 0.27, RED); cv.circle(cx + s * 0.25, cy - s * 0.17, s * 0.27, RED);
    cv.poly([[cx - s * 0.5, cy - s * 0.06], [cx + s * 0.5, cy - s * 0.06], [cx, cy + s * 0.5]], RED);
  } else if (kind === 'S') {
    cv.circle(cx - s * 0.25, cy + s * 0.08, s * 0.27, BLACK); cv.circle(cx + s * 0.25, cy + s * 0.08, s * 0.27, BLACK);
    cv.poly([[cx - s * 0.5, cy + s * 0.0], [cx + s * 0.5, cy + s * 0.0], [cx, cy - s * 0.5]], BLACK);
    cv.poly([[cx, cy + s * 0.1], [cx - s * 0.2, cy + s * 0.5], [cx + s * 0.2, cy + s * 0.5]], BLACK);
  } else if (kind === 'C') {
    cv.circle(cx, cy - s * 0.25, s * 0.24, BLACK); cv.circle(cx - s * 0.27, cy + s * 0.08, s * 0.24, BLACK); cv.circle(cx + s * 0.27, cy + s * 0.08, s * 0.24, BLACK);
    cv.poly([[cx, cy], [cx - s * 0.2, cy + s * 0.5], [cx + s * 0.2, cy + s * 0.5]], BLACK);
  }
}

// entries : prédictions vérifiées { target, suit, status:'gagné'|'perdu', step, maxR, resolvedAt, … }
// keyOf(entry) → identifiant de la courbe ; nameOf(key) → nom du canal (légende)
function build({ title, entries, keyOf, nameOf }) {
  const groups = new Map();
  for (const e of entries) {
    if (!e || !Number.isFinite(Number(e.target)) || (e.status !== 'gagné' && e.status !== 'perdu')) continue;
    const k = String(keyOf(e));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  if (!groups.size) return null;
  const targets = [...new Set(entries.filter((e) => e && Number.isFinite(Number(e.target))).map((e) => Number(e.target)))].sort((a, b) => a - b).slice(-MAX_TARGETS);
  const tset = new Set(targets);
  const series = [...groups.entries()]
    .map(([key, list]) => ({ key, list: list.filter((e) => tset.has(Number(e.target))).sort((a, b) => Number(a.target) - Number(b.target)) }))
    .filter((s) => s.list.length)
    .sort((a, b) => b.list.length - a.list.length).slice(0, MAX_SERIES);
  if (!series.length) return null;
  const all = series.flatMap((s) => s.list);
  const maxLevel = Math.max(2, ...all.map((e) => (Number(e.maxR) || 0) + 1), ...all.filter((e) => e.status === 'gagné').map((e) => (Number(e.step) || 0) + 1));
  const levelOf = (e) => (e.status === 'perdu' ? maxLevel : Math.min(Number(e.step) || 0, maxLevel - 1));

  const colW = 50; const left = 74; const top = 34; const plotH = 90 * maxLevel; const bottom = 100;
  const W = Math.max(560, left + 30 + targets.length * colW); const H = top + plotH + bottom;
  const cv = new Canvas(W, H);
  const yOf = (lvl) => top + plotH - (lvl / maxLevel) * plotH;
  const xOf = (i) => left + 26 + i * colW;
  const GRID = [222, 226, 232]; const AXIS = [90, 98, 110];
  for (let l = 0; l <= maxLevel; l++) {
    cv.dashedHLine(left, W - 16, Math.round(yOf(l)), l === maxLevel ? [240, 190, 190] : GRID);
    const y = yOf(l);
    if (l === maxLevel) { cv.line(left - 30, y - 8, left - 14, y + 8, 3, RED); cv.line(left - 30, y + 8, left - 14, y - 8, 3, RED); }
    else cv.digits(String(l), left - 14 - cv.digitsWidth(String(l), 3), Math.round(y - 10), 3, AXIS);
  }
  cv.rect(left, top - 6, 2, plotH + 12, AXIS); cv.rect(left, top + plotH + 5, W - left - 12, 2, AXIS);
  targets.forEach((n, i) => {
    const x = xOf(i);
    cv.rect(Math.round(x), top + plotH + 5, 1, 6, AXIS);
    cv.digits(String(n), Math.round(x - cv.digitsWidth(String(n), 2) / 2), top + plotH + 16, 2, [40, 46, 56]);
    // costumes prédits pour ce jeu (plusieurs canaux peuvent prédire des costumes différents) : 3 par ligne
    const kinds = [];
    for (const sr of series) for (const e of sr.list) if (Number(e.target) === n) { const k = suitKind(e.suit); if (k && !kinds.includes(k)) kinds.push(k); }
    kinds.forEach((k, j) => drawSuit(cv, k, x + ((j % 3) - (Math.min(kinds.length, 3) - 1) / 2) * 16, top + plotH + 46 + Math.floor(j / 3) * 18, 14));
  });
  series.forEach((s, si) => {
    const col = PALETTE[si % PALETTE.length].rgb;
    const dy = (si - (series.length - 1) / 2) * 5;
    const pts = s.list.map((e) => ({ x: xOf(targets.indexOf(Number(e.target))), y: yOf(levelOf(e)) + dy, loss: e.status === 'perdu' }));
    for (let i = 1; i < pts.length; i++) cv.line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, 3, col);
    for (const p of pts) { cv.circle(p.x, p.y, 7, col); cv.circle(p.x, p.y, 3.2, p.loss ? [255, 255, 255] : col); if (p.loss) cv.ring(p.x, p.y, 7, 2.2, col); }
  });
  const caption = [
    `📈 ${title}`,
    '↕ Ordonnée : rattrapage (0, 1, 2…) · ❌ en haut = perte',
    '↔ Abscisse : numéro du jeu prédit + costume',
    ...series.map((s, si) => {
      const w = s.list.filter((e) => e.status === 'gagné').length; const l = s.list.length - w;
      return `${PALETTE[si % PALETTE.length].emoji} ${nameOf(s.key) || s.key} — ${w}✅ ${l}❌`;
    }),
  ].join('\n').slice(0, 1000);
  return { png: cv.png(), caption, series: series.length, points: all.length };
}


// COURBE CUMULÉE d'UN canal (meilleur ou plus faible) : toutes ses prédictions vérifiées depuis 00h00, dans l'ordre.
//   ordonnée : 0 (en haut) = ✅0️⃣, puis rattrapage 1, 2… ; croix rouge tout en bas = PERTE
//   → un segment qui DESCEND (résultat qui se dégrade) est tracé en ROUGE, un segment qui monte ou reste stable en VERT.
// entries : { target, suit, status:'gagné'|'perdu', step, maxR, resolvedAt } (déjà dans l'ordre chronologique)
const MAX_CUM = 36;
function buildCumulative({ title, entries }) {
  const list = (entries || []).filter((e) => e && Number.isFinite(Number(e.target)) && (e.status === 'gagné' || e.status === 'perdu'));
  if (!list.length) return null;
  const wins = list.filter((e) => e.status === 'gagné').length; const losses = list.length - wins;
  const shown = list.slice(-MAX_CUM);
  const maxLevel = Math.max(2, ...shown.map((e) => (Number(e.maxR) || 0) + 1), ...shown.filter((e) => e.status === 'gagné').map((e) => (Number(e.step) || 0) + 1));
  const levelOf = (e) => (e.status === 'perdu' ? maxLevel : Math.min(Number(e.step) || 0, maxLevel - 1));
  const colW = 46; const left = 74; const top = 34; const plotH = 90 * maxLevel; const bottom = 84;
  const W = Math.max(560, left + 30 + shown.length * colW); const H = top + plotH + bottom;
  const cv = new Canvas(W, H);
  const yOf = (lvl) => top + (lvl / maxLevel) * plotH; // niveau 0 en haut, perte en bas
  const xOf = (i) => left + 26 + i * colW;
  const GRID = [222, 226, 232]; const AXIS = [90, 98, 110]; const GREEN = [34, 160, 70];
  for (let l = 0; l <= maxLevel; l++) {
    const y = yOf(l);
    cv.dashedHLine(left, W - 16, Math.round(y), l === maxLevel ? [240, 190, 190] : GRID);
    if (l === maxLevel) { cv.line(left - 30, y - 8, left - 14, y + 8, 3, RED); cv.line(left - 30, y + 8, left - 14, y - 8, 3, RED); }
    else cv.digits(String(l), left - 14 - cv.digitsWidth(String(l), 3), Math.round(y - 10), 3, AXIS);
  }
  cv.rect(left, top - 6, 2, plotH + 12, AXIS); cv.rect(left, top + plotH + 5, W - left - 12, 2, AXIS);
  shown.forEach((e, i) => {
    const x = xOf(i);
    cv.rect(Math.round(x), top + plotH + 5, 1, 6, AXIS);
    cv.digits(String(e.target), Math.round(x - cv.digitsWidth(String(e.target), 2) / 2), top + plotH + 16, 2, [40, 46, 56]);
    drawSuit(cv, suitKind(e.suit), x, top + plotH + 54, 18);
  });
  const pts = shown.map((e, i) => ({ x: xOf(i), y: yOf(levelOf(e)), lvl: levelOf(e), loss: e.status === 'perdu' }));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i];
    const down = b.lvl > a.lvl || (b.loss && a.loss); // descente = rattrapage plus lourd ou perte
    cv.line(a.x, a.y, b.x, b.y, 4, down ? RED : GREEN);
  }
  for (const p of pts) {
    const col = p.loss ? RED : GREEN;
    cv.circle(p.x, p.y, 7.5, col); if (p.loss) { cv.circle(p.x, p.y, 3.8, [255, 255, 255]); } else cv.circle(p.x, p.y, 3, [255, 255, 255]);
  }
  const rate = list.length ? ((wins / list.length) * 100).toFixed(1).replace('.', ',') : '0';
  const caption = [
    `📈 ${title}`,
    '↕ Ordonnée : rattrapage (0, 1, 2…) · ❌ en bas = perte',
    '↔ Abscisse : numéro du jeu prédit + costume',
    '🔴 descente = résultat qui se dégrade · 🟢 montée / stable',
    `📊 Cumul depuis 00h00 : ${wins}✅ ${losses}❌ sur ${list.length} prédiction${list.length > 1 ? 's' : ''} (${rate} %)`,
    list.length > shown.length ? `🔎 Les ${shown.length} dernières sont tracées` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);
  return { png: cv.png(), caption, points: shown.length, total: list.length };
}

module.exports = { build, buildCumulative, Canvas };
