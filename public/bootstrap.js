// bootstrap.js — point d'entrée réel (voir package.json : "start": "node bootstrap.js").
//
// CORRECTIF « survivre à un disque non persistant » : sur Render (plan
// gratuit, aucun disque persistant déclaré dans render.yaml), rien ne
// garantit que le système de fichiers local survit à un redémarrage du
// processus — data.json comme strategies.js pourraient très bien revenir à
// leur état d'origine (celui du dernier déploiement Git) si l'hébergeur
// redémarre le service dans un nouveau conteneur plutôt que dans le même.
//
// La « Réparation IA » (ai-repair.js) sauvegarde donc le CODE SOURCE exact
// de chaque stratégie qu'elle crée dans la base de données PostgreSQL
// (setting `ai_strategy_code_blocks`) — la base, elle, est bien persistante.
//
// Ce script s'exécute avant TOUT le reste de l'application (avant même
// `require('./strategies')`, qui est chargé une seule fois et mis en cache
// par Node) : il vérifie, pour chaque stratégie connue en base, si son code
// est bien présent dans strategies.js sur disque — et le réinjecte sinon,
// AVANT de démarrer le vrai serveur. Ainsi, même si le disque a été
// réinitialisé, les stratégies créées par l'IA reviennent automatiquement,
// sans jamais dépendre d'un redémarrage manuel ni d'un disque persistant.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STRAT_FILE = path.join(ROOT, 'strategies.js');

async function restoreMissingStrategies() {
  const db = require('./db');
  const status = await db.connect(); // lit DATABASE_URL depuis store.js/config.js comme d'habitude
  if (!status.ready) {
    console.log('ℹ️  Base non joignable au démarrage — reprise directe sans restauration de stratégies IA (' + (status.error || '') + ').');
    return;
  }

  let raw;
  try { raw = await db.getSetting('ai_strategy_code_blocks'); }
  catch (e) { console.error('⚠️ Lecture des stratégies IA en base impossible :', e.message); return; }
  if (!raw) return; // aucune stratégie créée par l'IA pour l'instant — rien à faire

  let blocks;
  try { blocks = JSON.parse(raw); } catch (_) { return; } // donnée corrompue — on ne bloque pas le démarrage pour ça
  const keys = Object.keys(blocks || {});
  if (!keys.length) return;

  let current;
  try { current = fs.readFileSync(STRAT_FILE, 'utf8'); }
  catch (e) { console.error('⚠️ strategies.js introuvable — restauration IA annulée :', e.message); return; }

  let changed = false;
  for (const key of keys) {
    // déjà présente sur disque (cas normal : le disque a bien survécu, ou la
    // stratégie vient d'être créée dans CETTE même session) → rien à faire.
    if (new RegExp(`key\\s*:\\s*'${key}'`).test(current)) continue;

    const listMatch = current.match(/const LIST = \[([^\]]*)\];/);
    if (!listMatch) { console.error('⚠️ Impossible de localiser LIST dans strategies.js — restauration de « ' + key + ' » annulée.'); continue; }

    const code = blocks[key];
    if (!/detect\s*\(/.test(code) || !/enabled\s*:\s*false/.test(code)) {
      console.error(`⚠️ Code sauvegardé pour « ${key} » suspect (pas de detect() ou pas désactivé par défaut) — restauration ignorée par sécurité.`);
      continue;
    }

    const beforeList = current.slice(0, listMatch.index);
    const afterList = current.slice(listMatch.index + listMatch[0].length);
    const newListLine = `const LIST = [${listMatch[1].trim()}, ${key}];`;
    current = `${beforeList}${code}\n\n${newListLine}${afterList}`;
    changed = true;
    console.log(`♻️  Stratégie « ${key} » réinjectée depuis la base (disque probablement réinitialisé par l'hébergeur).`);
  }

  if (changed) {
    // vérification de syntaxe minimale avant d'écrire quoi que ce soit —
    // mêmes précautions qu'ai-repair.js : mieux vaut démarrer avec l'ancien
    // strategies.js (sans la stratégie récupérée) que de casser tout le
    // fichier avec un JSON corrompu venu de la base.
    const { execFileSync } = require('child_process');
    const tmp = path.join(require('os').tmpdir(), `bootstrap-check-${Date.now()}.js`);
    fs.writeFileSync(tmp, current);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      fs.writeFileSync(STRAT_FILE, current);
      console.log('✅ strategies.js mis à jour avec les stratégies IA restaurées.');
    } catch (e) {
      console.error('⚠️ Le strategies.js reconstruit est invalide — restauration annulée, on démarre avec le fichier existant :', String(e.stderr || e.message).slice(0, 300));
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* fichier temporaire, tant pis */ }
    }
  }
}

restoreMissingStrategies()
  .catch((e) => console.error('⚠️ Restauration des stratégies IA : erreur inattendue, démarrage normal quand même :', e.message))
  .finally(() => {
    require('./server.js');
  });
