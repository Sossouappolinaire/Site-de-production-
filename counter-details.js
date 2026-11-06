// counter-details.js — « détails » des bilans de « Compte parité » et « Compte distribution » (v100, demande admin).
// À partir des comptes par fin de numéro (0 à 9) des jeux à point PAIR et à point IMPAIR d'un côté, construit :
//   • le nombre de jeux pair / impair ;
//   • le nombre de fins de numéro ÉLEVÉES (5 à 9) et BASSES (0 à 4), pour les jeux pair puis impair ;
//   • le détail chiffre par chiffre (0 à 9) et la fin de numéro la plus fréquente (la plus « élevée » en nombre de jeux).
'use strict';

const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const sum = (a) => a.reduce((n, x) => n + (Number(x) || 0), 0);
const plural = (n, w) => `${n} ${w}${n > 1 ? 'x' : ''}`;

function summarize(arr) {
  const a = Array.from({ length: 10 }, (_, i) => Number(arr && arr[i]) || 0);
  const total = sum(a);
  const high = sum(a.slice(5)); const low = sum(a.slice(0, 5));
  const max = Math.max(...a);
  const top = total > 0 ? a.map((n, d) => ({ n, d })).filter((x) => x.n === max).map((x) => x.d) : [];
  return { counts: a, total, high, low, max, top };
}

function lineOf(label, s) {
  if (!s.total) return `${label}\n   aucun jeu`;
  const cell = (n, d) => `${DIGITS[d]} ×${n}`;
  const row1 = s.counts.slice(0, 5).map((n, d) => cell(n, d)).join('   ');
  const row2 = s.counts.slice(5).map((n, i) => cell(n, i + 5)).join('   ');
  const hp = Math.round((s.high / s.total) * 100);
  return [
    `${label} — ${plural(s.total, 'jeu')}`,
    `   🔼 Fins hautes (5-9) : ${s.high}  ·  🔽 Fins basses (0-4) : ${s.low}`,
    `   ${'▰'.repeat(Math.round(hp / 10))}${'▱'.repeat(10 - Math.round(hp / 10))} hautes ${hp} %`,
    '   🔢 Jeux par fin de numéro :',
    `      ${row1}`,
    `      ${row2}`,
    `   🔝 Plus fréquente : ${s.top.map((d) => DIGITS[d]).join(' ')} (${s.max} jeu${s.max > 1 ? 'x' : ''})`,
  ].join('\n');
}

// pair / impair : tableaux de 10 compteurs ; renvoie le texte du bloc « DÉTAILS » (une ligne vide avant)
function detailsText(pair, impair, title) {
  const p = summarize(pair); const i = summarize(impair);
  return ['📋 DÉTAILS' + (title ? ` — ${title}` : ''), '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', lineOf('➖ Jeux à point PAIR', p), '', lineOf('➕ Jeux à point IMPAIR', i)].join('\n');
}
// version structurée pour le tableau de bord
function detailsView(pair, impair) {
  const f = (s) => ({ total: s.total, high: s.high, low: s.low, top: s.top, topCount: s.max });
  return { pair: f(summarize(pair)), impair: f(summarize(impair)) };
}

module.exports = { detailsText, detailsView, summarize };
