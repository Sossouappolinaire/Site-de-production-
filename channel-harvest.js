// channel-harvest.js — récupère TOUS les ID de canaux Telegram présents dans la
// configuration, quel que soit le panneau ou le bouton qui les a enregistrés
// (stratégies, Après perte, Rupture, Chevauchement, Meilleur/Faible, Retour
// après perte, Formation, J'aime, VIP, Comptage de cartes, Copie et annonce…).
//
// Principe : on parcourt récursivement la configuration (sans liste de champs
// codée en dur, donc un futur bouton est couvert automatiquement) et on retient
// toute valeur qui ressemble à un ID de canal/supergroupe (-100xxxxxxxxxx),
// ainsi que les CLÉS d'objets de ce type (ex. channelTitles : { "-100…": "Titre" }).
// Le titre est repris là où il existe (channelTitles, channelInfos, channelLinks…).
'use strict';

const ID_RE = /^-100\d{8,}$/;

function asId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) { const s = String(Math.trunc(v)); return ID_RE.test(s) ? s : null; }
  if (typeof v === 'string') { const s = v.trim(); return ID_RE.test(s) ? s : null; }
  return null;
}

// sources : tableau d'objets { name, value } — name = origine lisible (ex. « panneau bestWeakTop »)
// retourne : Map id -> { id, title, usedBy:Set }
function harvest(sources) {
  const found = new Map();
  const touch = (id, origin) => {
    let e = found.get(id);
    if (!e) { e = { id, title: '', usedBy: new Set() }; found.set(id, e); }
    if (origin) e.usedBy.add(origin);
    return e;
  };
  const setTitle = (id, title) => {
    if (typeof title !== 'string') return;
    const t = title.trim();
    if (!t) return;
    const e = touch(id, null);
    if (!e.title) e.title = t.slice(0, 120);
  };

  const walk = (node, origin, depth) => {
    if (depth > 12 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, origin, depth + 1); return; }
    if (typeof node === 'object') {
      // objet « { id, title } » (channelInfos, détectés…)
      const own = asId(node.id) || asId(node.chatId) || asId(node.channelId);
      if (own) { touch(own, origin); setTitle(own, node.title || node.name || node.titre); }
      for (const [k, v] of Object.entries(node)) {
        const kid = asId(k);
        if (kid) { touch(kid, origin); if (typeof v === 'string') setTitle(kid, v); }
        walk(v, origin, depth + 1);
      }
      return;
    }
    const id = asId(node);
    if (id) touch(id, origin);
  };

  for (const s of sources || []) walk(s && s.value, s && s.name, 0);
  return found;
}

module.exports = { harvest, asId, ID_RE };
