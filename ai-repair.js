// ai-repair.js — « Réparation IA » : l'IA (Groq) lit le code du projet, écrit
// la liste des problèmes qu'elle identifie, puis les corrige elle-même (un
// problème après l'autre, avec pourcentage d'avancement) et vérifie enfin que
// tout est bien corrigé.
//
// Flux d'utilisation (voir les routes /api/ai/repair/* dans server.js) :
//   1. diagnose(message) -> liste des problèmes { id, title, file, severity, detail }
//   2. fixNext()          -> corrige LE prochain problème, renvoie le pourcentage
//   3. verify()           -> vérifie que tous les problèmes sont bien corrigés
//      (contrôle de syntaxe Node réel + relecture par l'IA)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

const ROOT = __dirname;
const BACKUP_DIR = path.join(ROOT, '.repair-backups');
// Groq (palier gratuit) limite à ~8000 tokens par minute : le contexte envoyé
// doit rester petit. On n'envoie donc PAS tout le projet, mais un inventaire
// des fichiers + des extraits des fichiers les plus pertinents.
const MAX_FILE_CHARS = 5000;      // taille max d'un extrait de fichier envoyé à l'IA
const MAX_CONTEXT_CHARS = 12000;  // budget total du contexte code envoyé
const MAX_FULL_FILE_CHARS = 12000; // au-delà, on corrige par remplacement ciblé

// fichiers/dossiers jamais lus ni modifiés par la réparation
const SKIP = new Set(['node_modules', '.git', '.repair-backups', 'package-lock.json', 'data.json']);

// ---------------------------------------------------------------------------
// état de la session de réparation (en mémoire, remis à zéro à chaque
// diagnostic)
// ---------------------------------------------------------------------------
const session = {
  message: '',
  startedAt: null,
  problems: [],   // { id, title, file, severity, detail, status, note, at }
  logs: [],       // { at, text }
  percent: 0,
  phase: 'idle',  // idle | diagnosed | fixing | fixed | verified
  verification: null,
  lastError: null,
};

function log(text) {
  session.logs.unshift({ at: new Date().toISOString(), text: String(text).slice(0, 400) });
  session.logs = session.logs.slice(0, 60);
}

function listFiles() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const full = path.join(ROOT, name);
    const st = fs.statSync(full);
    if (st.isFile() && /\.(js|json|html|yaml|yml|md)$/i.test(name)) out.push(name);
    else if (st.isDirectory() && name === 'public') {
      for (const sub of fs.readdirSync(full)) {
        if (/\.(html|js|css)$/i.test(sub)) out.push(`public/${sub}`);
      }
    }
  }
  return out.sort();
}

function readFileSafe(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
}

function isAllowed(rel) {
  const clean = String(rel || '').replace(/^[./]+/, '');
  if (!clean || clean.includes('..')) return false;
  return listFiles().includes(clean);
}

// inventaire compact du projet (nom + taille + première ligne de commentaire)
function inventory() {
  return listFiles().map((rel) => {
    const content = readFileSafe(rel) || '';
    const first = (content.split('\n')[0] || '').slice(0, 110);
    return `${rel} (${content.split('\n').length} lignes) — ${first}`;
  }).join('\n');
}

// mots-clés utiles extraits de la demande de l'utilisateur
function keywords(message) {
  return String(message || '')
    .toLowerCase()
    .split(/[^a-z0-9éèêàùçûôïî_.\/-]+/i)
    .filter((w) => w.length > 3)
    .slice(0, 25);
}

// classe les fichiers du plus au moins pertinent pour la demande
function rankFiles(message) {
  const words = keywords(message);
  return listFiles()
    .map((rel) => {
      const content = (readFileSafe(rel) || '').toLowerCase();
      const name = rel.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 6;
        const hits = content.split(w).length - 1;
        score += Math.min(hits, 8);
      }
      return { rel, score };
    })
    .sort((a, b) => b.score - a.score);
}

// extrait d'un fichier centré sur les passages qui contiennent les mots-clés
function excerpt(rel, message) {
  const content = readFileSafe(rel);
  if (content == null) return '';
  if (content.length <= MAX_FILE_CHARS) return content;
  const lines = content.split('\n');
  const words = keywords(message);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i += 20) {
    const chunk = lines.slice(i, i + 80).join('\n').toLowerCase();
    const score = words.reduce((acc, w) => acc + (chunk.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const start = Math.max(0, best - 10);
  const slice = lines.slice(start, start + 120).join('\n').slice(0, MAX_FILE_CHARS);
  return `/* extrait à partir de la ligne ${start + 1} sur ${lines.length} */\n${slice}`;
}

// contexte code envoyé à l'IA, borné par MAX_CONTEXT_CHARS
function codeContext(files, message) {
  const chosen = files && files.length ? files : rankFiles(message).map((f) => f.rel);
  let total = 0;
  const parts = [];
  for (const rel of chosen) {
    const slice = excerpt(rel, message);
    if (!slice) continue;
    if (total + slice.length > MAX_CONTEXT_CHARS) break;
    total += slice.length;
    parts.push(`--- FICHIER ${rel} ---\n${slice}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Appel Groq (API OpenAI-compatible) — fournisseur exclusif de ce module.
// ---------------------------------------------------------------------------
function groqKey() {
  return String(config.GROQ.API_KEY || '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le palier gratuit de Groq limite le débit (tokens par minute). En cas de 429
// on attend le délai indiqué par Groq puis on réessaie automatiquement, au
// lieu de faire échouer la réparation.
async function groqChat(options) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await groqChatOnce(options);
    } catch (e) {
      lastError = e;
      if (e.status !== 429 && e.status !== 503 && !(e.status >= 500)) throw e;
      const hint = /try again in ([\d.]+)s/i.exec(e.message);
      const wait = Math.min(65000, hint ? Math.ceil(parseFloat(hint[1]) * 1000) + 1500 : 8000 * (attempt + 1));
      log(`Groq saturé — nouvelle tentative dans ${Math.round(wait / 1000)} s…`);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function groqChatOnce({ system, user, temperature = 0.1, timeoutMs = 120000, json = false }) {
  const key = groqKey();
  if (!key) {
    const e = new Error("Aucune clé Groq configurée (GROQ_API_KEY) — la réparation IA en a besoin.");
    e.code = 'GROQ_NOT_CONFIGURED';
    throw e;
  }
  const body = {
    model: config.GROQ.MODEL,
    temperature,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(config.GROQ.CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Groq a répondu ${res.status}`;
    const e = new Error(
      res.status === 429 ? `Groq est momentanément saturé (limite de débit). Réessayez dans quelques secondes. ${message}`
      : res.status === 401 ? `Clé Groq refusée (401) : vérifiez GROQ_API_KEY. ${message}`
      : res.status === 402 ? `Crédit Groq épuisé. ${message}`
      : message
    );
    e.status = res.status;
    throw e;
  }
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error("Groq a renvoyé une réponse vide.");
  return text;
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  const err = new Error(`Réponse IA illisible (JSON invalide). Début de la réponse : ${candidate.slice(0, 300)}`);
  err.code = 'BAD_JSON';
  throw err;
}

// ---------------------------------------------------------------------------
// 1) Diagnostic : l'IA identifie les problèmes
// ---------------------------------------------------------------------------
const DIAG_SYSTEM = `Tu es un ingénieur logiciel senior chargé de réparer un projet Node.js/Express (bot Baccara + tableau de bord web).
Tu reçois la demande de l'utilisateur et le code source du projet.
Identifie UNIQUEMENT des problèmes réels et concrets (bugs, erreurs de logique, code cassé, incohérences, risques de plantage, ce que l'utilisateur décrit).
Réponds STRICTEMENT en JSON :
{"summary":"résumé court en français","problems":[{"title":"titre court","file":"chemin/relatif.js","severity":"critique|majeur|mineur","detail":"explication en français : cause, ligne/fonction concernée","fix":"comment le corriger précisément"}]}
Règles : 1 à 8 problèmes maximum, du plus grave au moins grave. "file" doit être un fichier existant du projet. Français uniquement dans les textes.`;

async function diagnose(message) {
  const question = String(message || '').trim();
  if (!question) {
    const e = new Error("Écris d'abord ce qui ne va pas (ou ce que l'IA doit vérifier).");
    e.code = 'NO_MESSAGE';
    throw e;
  }
  session.message = question;
  session.startedAt = new Date().toISOString();
  session.problems = [];
  session.logs = [];
  session.percent = 0;
  session.phase = 'idle';
  session.verification = null;
  session.lastError = null;

  const top = rankFiles(question).slice(0, 5).map((f) => f.rel);
  const user = `DEMANDE DE L'UTILISATEUR :\n${question}\n\nINVENTAIRE DU PROJET :\n${inventory()}\n\nEXTRAITS DES FICHIERS LES PLUS PERTINENTS :\n${codeContext(top, question)}`;
  let parsed;
  try {
    parsed = extractJson(await groqChat({ system: DIAG_SYSTEM, user, json: true }));
  } catch (e) {
    session.lastError = e.message;
    throw e;
  }

  const problems = (Array.isArray(parsed.problems) ? parsed.problems : []).slice(0, 8).map((p, i) => ({
    id: `p${i + 1}`,
    title: String(p.title || `Problème ${i + 1}`).slice(0, 160),
    file: isAllowed(p.file) ? String(p.file).replace(/^[./]+/, '') : '',
    severity: ['critique', 'majeur', 'mineur'].includes(String(p.severity)) ? p.severity : 'majeur',
    detail: String(p.detail || '').slice(0, 1500),
    fix: String(p.fix || '').slice(0, 1500),
    status: 'pending',
    note: '',
    at: null,
  }));

  session.problems = problems;
  session.summary = String(parsed.summary || '').slice(0, 800);
  session.phase = problems.length ? 'diagnosed' : 'verified';
  session.percent = problems.length ? 0 : 100;
  log(problems.length ? `${problems.length} problème(s) identifié(s) par l'IA.` : "Aucun problème identifié par l'IA.");
  return status();
}

// ---------------------------------------------------------------------------
// 2) Correction : l'IA corrige un problème à la fois (pourcentage d'avancement)
// ---------------------------------------------------------------------------
const FIX_SYSTEM_FULL = `Tu es un ingénieur logiciel senior. Tu corriges UN problème précis dans UN fichier d'un projet Node.js/Express.
Tu reçois le contenu ACTUEL COMPLET du fichier et la description du problème.
Réponds STRICTEMENT en JSON : {"changed":true|false,"explanation":"ce que tu as corrigé, en français","content":"contenu COMPLET du fichier corrigé"}
Règles absolues :
- "content" = le fichier ENTIER après correction (jamais un extrait, jamais de "…", jamais de diff).
- Ne casse rien d'autre : garde le style, les commentaires existants et toutes les fonctionnalités.
- Corrige uniquement ce problème. Si aucune correction n'est nécessaire, mets "changed":false et laisse "content" vide.
- Code valide, exécutable tel quel.`;

const FIX_SYSTEM_PATCH = `Tu es un ingénieur logiciel senior. Tu corriges UN problème précis dans un GROS fichier d'un projet Node.js/Express.
Le fichier est trop volumineux pour être réécrit : tu dois donner un remplacement CIBLÉ.
Réponds STRICTEMENT en JSON : {"changed":true|false,"explanation":"ce que tu as corrigé, en français","find":"extrait EXACT du code actuel à remplacer","replace":"nouveau code de remplacement"}
Règles absolues :
- "find" doit être copié CARACTÈRE POUR CARACTÈRE depuis l'extrait fourni (indentation comprise) et apparaître UNE SEULE FOIS dans le fichier ; inclus 2 à 15 lignes pour être unique.
- "replace" = le code corrigé qui prend sa place (code valide).
- Si aucune correction n'est nécessaire : {"changed":false,"explanation":"…"}.`;

function backup(rel, content) {
  try {
    fs.mkdirSync(path.join(BACKUP_DIR, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, `${rel}.${Date.now()}.bak`), content);
  } catch { /* la sauvegarde est un confort, pas un bloquant */ }
}

function syntaxCheck(rel, content) {
  if (/\.js$/i.test(rel)) {
    const tmp = path.join(require('os').tmpdir(), `repair-${Date.now()}-${path.basename(rel)}`);
    fs.writeFileSync(tmp, content);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    catch (e) { return String(e.stderr || e.message).slice(0, 600); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  if (/\.json$/i.test(rel)) {
    try { JSON.parse(content); } catch (e) { return e.message; }
  }
  return null;
}

function recomputePercent() {
  const total = session.problems.length || 1;
  const done = session.problems.filter((p) => p.status !== 'pending').length;
  session.percent = Math.round((done / total) * 100);
  if (session.percent >= 100) session.phase = 'fixed';
  return session.percent;
}

async function fixNext() {
  const problem = session.problems.find((p) => p.status === 'pending');
  if (!problem) { recomputePercent(); return { ...status(), done: true }; }
  session.phase = 'fixing';

  try {
    if (!problem.file) throw new Error("Fichier cible inconnu pour ce problème.");
    const current = readFileSafe(problem.file);
    if (current == null) throw new Error(`Fichier introuvable : ${problem.file}`);

    const head = `PROBLÈME À CORRIGER\nTitre : ${problem.title}\nGravité : ${problem.severity}\nDétail : ${problem.detail}\nPiste de correction : ${problem.fix}\nDemande initiale de l'utilisateur : ${session.message}\n\n`;
    const big = current.length > MAX_FULL_FILE_CHARS;
    const user = big
      ? `${head}FICHIER ${problem.file} (${current.split('\n').length} lignes, extrait pertinent) :\n${excerpt(problem.file, `${problem.title} ${problem.detail} ${problem.fix}`)}`
      : `${head}FICHIER ${problem.file} (contenu actuel complet) :\n${current}`;
    const parsed = extractJson(await groqChat({
      system: big ? FIX_SYSTEM_PATCH : FIX_SYSTEM_FULL,
      user, json: true, timeoutMs: 150000,
    }));

    let next = null;
    if (parsed.changed === false) {
      next = null;
    } else if (big) {
      const find = String(parsed.find || '');
      const replace = String(parsed.replace ?? '');
      if (!find) throw new Error("L'IA n'a pas fourni d'extrait à remplacer.");
      const occurrences = current.split(find).length - 1;
      if (occurrences === 0) throw new Error("L'extrait proposé par l'IA n'existe pas tel quel dans le fichier (correction non appliquée).");
      if (occurrences > 1) throw new Error("L'extrait proposé par l'IA apparaît plusieurs fois (correction ambiguë, non appliquée).");
      next = current.replace(find, replace);
    } else if (String(parsed.content || '').trim()) {
      next = String(parsed.content);
    }

    if (!next || next === current) {
      problem.status = 'skipped';
      problem.note = String(parsed.explanation || "Aucune modification nécessaire selon l'IA.").slice(0, 800);
    } else {
      const syntax = syntaxCheck(problem.file, next);
      if (syntax) throw new Error(`Correction refusée (syntaxe invalide) : ${syntax}`);
      backup(problem.file, current);
      fs.writeFileSync(path.join(ROOT, problem.file), next);
      problem.status = 'fixed';
      problem.note = String(parsed.explanation || 'Corrigé.').slice(0, 800);
    }
  } catch (e) {
    problem.status = 'failed';
    problem.note = e.message.slice(0, 800);
    session.lastError = e.message;
  }

  problem.at = new Date().toISOString();
  log(`${problem.title} → ${problem.status === 'fixed' ? 'corrigé' : problem.status === 'skipped' ? 'rien à corriger' : 'échec'} (${problem.file || '—'})`);
  recomputePercent();
  return { ...status(), problem, done: !session.problems.some((p) => p.status === 'pending') };
}

// ---------------------------------------------------------------------------
// 3) Vérification finale : tout est-il bien corrigé ?
// ---------------------------------------------------------------------------
const VERIFY_SYSTEM = `Tu es relecteur qualité. On te donne la liste des problèmes corrigés et le contenu ACTUEL des fichiers modifiés.
Vérifie si chaque problème est réellement corrigé dans le code fourni.
Réponds STRICTEMENT en JSON : {"allFixed":true|false,"score":0-100,"summary":"verdict court en français","checks":[{"title":"problème","fixed":true|false,"comment":"en français"}]}`;

async function verify() {
  if (!session.problems.length) throw Object.assign(new Error("Lance d'abord un diagnostic."), { code: 'NO_SESSION' });

  // contrôle de syntaxe réel sur tous les fichiers JS/JSON du projet
  const syntaxErrors = [];
  for (const rel of listFiles()) {
    if (!/\.(js|json)$/i.test(rel)) continue;
    const content = readFileSafe(rel);
    if (content == null) continue;
    const err = syntaxCheck(rel, content);
    if (err) syntaxErrors.push({ file: rel, error: err });
  }

  const touched = [...new Set(session.problems.map((p) => p.file).filter(Boolean))];
  const user = `DEMANDE INITIALE : ${session.message}\n\nPROBLÈMES ET CORRECTIONS APPLIQUÉES :\n${session.problems.map((p) => `- [${p.status}] ${p.title} (${p.file}) : ${p.note}`).join('\n')}\n\nCONTRÔLE DE SYNTAXE NODE : ${syntaxErrors.length ? JSON.stringify(syntaxErrors) : 'aucune erreur'}\n\nCODE ACTUEL DES FICHIERS MODIFIÉS (extraits) :\n${codeContext(touched, session.message)}`;

  let parsed;
  try {
    parsed = extractJson(await groqChat({ system: VERIFY_SYSTEM, user, json: true, timeoutMs: 150000 }));
  } catch (e) {
    session.lastError = e.message;
    throw e;
  }

  const checks = (Array.isArray(parsed.checks) ? parsed.checks : []).map((c) => ({
    title: String(c.title || '').slice(0, 160),
    fixed: c.fixed !== false,
    comment: String(c.comment || '').slice(0, 600),
  }));
  const allFixed = parsed.allFixed !== false && !syntaxErrors.length && !session.problems.some((p) => p.status === 'failed');

  session.verification = {
    allFixed,
    score: Math.max(0, Math.min(100, Number(parsed.score) || (allFixed ? 100 : 60))),
    summary: String(parsed.summary || '').slice(0, 800),
    checks,
    syntaxErrors,
    at: new Date().toISOString(),
  };
  session.phase = 'verified';
  log(allFixed ? 'Vérification : tous les problèmes sont corrigés.' : 'Vérification : il reste des points à corriger.');
  return status();
}

// ---------------------------------------------------------------------------
// 4) Création de stratégie : l'IA écrit une NOUVELLE stratégie de prédiction
//    à partir d'une description en langage naturel et l'ajoute directement
//    dans strategies.js. Elle est TOUJOURS créée désactivée (enabled:false) :
//    elle apparaît dans la page Stratégies, à activer manuellement après
//    vérification.
// ---------------------------------------------------------------------------
const strategyCreation = { history: [] }; // { at, key, name, about, explanation }

const CREATE_STRATEGY_SYSTEM = `Tu es un ingénieur logiciel senior. Tu écris UNE NOUVELLE stratégie de prédiction Baccarat pour le fichier strategies.js d'un projet Node.js.
On te donne le contenu actuel de strategies.js (avec plusieurs stratégies déjà écrites, à prendre comme exemples de style) et les clés déjà utilisées.
Réponds STRICTEMENT en JSON :
{"key":"identifiant_court_minuscule_sans_espace","name":"nom affiché court","about":"explication claire en français de la règle, pour un humain","code":"const <key> = { ... };","explanation":"ce que fait la stratégie et pourquoi, en français"}
Règles absolues sur "code" :
- Une SEULE déclaration : const <key> = { key: '<key>', name: '...', about: '...', defaults: { enabled: false, format: 80, maxR: 2, b: 0, lead: 1, template: null, channels: [] /* + réglages spécifiques si besoin */ }, usesB: false, source: 'finished'|'live', detect(game, cfg, ctx) { ... } };
- <key> DOIT être exactement le même texte que le champ JSON "key" et un identifiant JS valide (minuscules, chiffres, sans espace ni accent).
- "defaults.enabled" DOIT rester false (jamais true) : la stratégie doit être créée désactivée.
- "detect" doit suivre EXACTEMENT le style des exemples fournis : renvoie null si rien à prédire, sinon un objet avec au minimum "kind" ('suit' ou 'cards'), "target" (numéro du tour ciblé), "reason" (texte explicatif). Utilise "source: 'finished'" si detect() lit un tour terminé (game.finished, game.playerValue, game.bankerValue, game.playerSuits, game.bankerSuits, game.winner, game.number), ou "source: 'live'" si elle prédit à partir du numéro du tour en cours uniquement.
- N'utilise QUE les propriétés de "game" et les fonctions déjà visibles dans le fichier fourni (ex. normSuit, suitsOf, SUITS, INVERSE) — n'invente aucune fonction ni propriété qui n'existe pas dans les exemples.
- Code JavaScript valide, exécutable tel quel, sans aucun commentaire Markdown ni texte hors du JSON.
- La clé doit être différente de toutes celles déjà utilisées.`;

function existingStrategyKeys() {
  const content = readFileSafe('strategies.js') || '';
  const keys = new Set();
  const re = /key:\s*'([a-zA-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(content))) keys.add(m[1]);
  return keys;
}

function slugifyKey(s) {
  const base = String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return /^[a-z]/.test(base) ? base : `s${base}`;
}

async function createStrategy(description) {
  const demande = String(description || '').trim();
  if (!demande) {
    const e = new Error("Décris d'abord la stratégie que tu veux créer.");
    e.code = 'NO_MESSAGE';
    throw e;
  }
  const current = readFileSafe('strategies.js');
  if (current == null) throw new Error('strategies.js introuvable.');
  const taken = existingStrategyKeys();

  const user = `DEMANDE DE L'UTILISATEUR (nouvelle stratégie à créer) :\n${demande}\n\nCLÉS DÉJÀ UTILISÉES (à éviter) : ${[...taken].join(', ')}\n\nCONTENU ACTUEL DE strategies.js (exemples de style à suivre) :\n${current.slice(0, MAX_FULL_FILE_CHARS)}`;

  const parsed = extractJson(await groqChat({ system: CREATE_STRATEGY_SYSTEM, user, json: true, timeoutMs: 150000 }));

  let code = String(parsed.code || '').trim();
  if (!code) throw new Error("L'IA n'a pas fourni de code pour cette stratégie.");

  const varMatch = code.match(/const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\{/);
  if (!varMatch) throw new Error("Format de code invalide renvoyé par l'IA (déclaration introuvable).");
  const aiVar = varMatch[1];
  const keyFieldMatch = code.match(/key:\s*'([a-zA-Z0-9_]+)'/);
  const aiKeyField = keyFieldMatch ? keyFieldMatch[1] : aiVar;

  let key = slugifyKey(parsed.key || aiKeyField || parsed.name) || 'strategie';
  if (taken.has(key)) {
    let i = 2; const base = key;
    while (taken.has(`${base}${i}`)) i += 1;
    key = `${base}${i}`;
  }

  // aligne le nom de variable ET le champ "key" du code sur la clé finale
  if (aiVar !== key) code = code.replace(new RegExp(`\\b${aiVar}\\b`, 'g'), key);
  code = code.replace(/key:\s*'[a-zA-Z0-9_]+'/, `key: '${key}'`);

  // sécurité absolue : la stratégie est TOUJOURS créée désactivée
  if (/enabled\s*:\s*true/.test(code)) code = code.replace(/enabled\s*:\s*true/, 'enabled: false');
  else if (!/enabled\s*:\s*false/.test(code)) code = code.replace(/defaults\s*:\s*\{/, 'defaults: { enabled: false,');
  if (!/enabled\s*:\s*false/.test(code)) throw new Error("Impossible de garantir que la stratégie serait désactivée par défaut (structure du code inattendue) — création annulée par sécurité.");

  if (!/detect\s*\(/.test(code)) throw new Error("Le code renvoyé par l'IA n'a pas de fonction detect() — création annulée.");

  const listMatch = current.match(/const LIST = \[([^\]]*)\];/);
  if (!listMatch) throw new Error("Impossible de localiser la liste des stratégies (LIST) dans strategies.js.");
  const beforeList = current.slice(0, listMatch.index);
  const afterList = current.slice(listMatch.index + listMatch[0].length);
  const newListLine = `const LIST = [${listMatch[1].trim()}, ${key}];`;
  const newContent = `${beforeList}${code}\n\n${newListLine}${afterList}`;

  const syntaxErr = syntaxCheck('strategies.js', newContent);
  if (syntaxErr) throw new Error(`Code refusé par le contrôle de syntaxe : ${syntaxErr}`);

  backup('strategies.js', current);
  fs.writeFileSync(path.join(ROOT, 'strategies.js'), newContent);

  const name = String(parsed.name || key).slice(0, 120);
  const about = String(parsed.about || '').slice(0, 1500);
  const explanation = String(parsed.explanation || '').slice(0, 1500);
  const entry = { at: new Date().toISOString(), key, name, about, explanation };
  strategyCreation.history.unshift(entry);
  strategyCreation.history = strategyCreation.history.slice(0, 20);
  log(`Nouvelle stratégie créée : « ${name} » (clé ${key}) — désactivée par défaut, à activer depuis la page Stratégies.`);

  return { ok: true, ...entry };
}

function reset() {
  session.message = '';
  session.problems = [];
  session.logs = [];
  session.percent = 0;
  session.phase = 'idle';
  session.verification = null;
  session.lastError = null;
  session.summary = '';
  return status();
}

function status() {
  return {
    configured: Boolean(groqKey()),
    model: config.GROQ.MODEL,
    provider: 'Groq',
    message: session.message,
    startedAt: session.startedAt,
    summary: session.summary || '',
    problems: session.problems,
    logs: session.logs,
    percent: session.percent,
    phase: session.phase,
    verification: session.verification,
    lastError: session.lastError,
    total: session.problems.length,
    fixed: session.problems.filter((p) => p.status === 'fixed').length,
    remaining: session.problems.filter((p) => p.status === 'pending').length,
    createdStrategies: strategyCreation.history,
  };
}

module.exports = { diagnose, fixNext, verify, status, reset, listFiles, createStrategy };
