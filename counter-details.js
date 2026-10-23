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
  if (!s.total) return `${label} : aucun jeu`;
  const digits = s.counts.map((n, d) => `${DIGITS[d]}×${n}`).join(' ');
  return [
    `${label} : ${plural(s.total, 'jeu')} · élevées (5-9) ${s.high} · basses (0-4) ${s.low}`,
    `   ${digits}`,
    `   🔝 fin la plus fréquente : ${s.top.map((d) => DIGITS[d]).join(' ')} (${s.max})`,
  ].join('\n');
}

// pair / impair : tableaux de 10 compteurs ; renvoie le texte du bloc « DÉTAILS » (une ligne vide avant)
function detailsText(pair, impair, title) {
  const p = summarize(pair); const i = summarize(impair);
  return ['📋 DÉTAILS' + (title ? ` — ${title}` : ''), lineOf('➖ Pair', p), lineOf('➕ Impair', i)].join('\n');
}
// version structurée pour le tableau de bord
function detailsView(pair, impair) {
  const f = (s) => ({ total: s.total, high: s.high, low: s.low, top: s.top, topCount: s.max });
  return { pair: f(summarize(pair)), impair: f(summarize(impair)) };
}

module.exports = { detailsText, detailsView, summarize };
