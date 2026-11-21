// intro.js — écran de démarrage partagé (index.html + login.html).
//
// Animation : un personnage entre en marchant, se penche, ramasse sa mallette
// puis repart (fond orange). Le nom du développeur s'affiche en haut.
//
// Affichée UNIQUEMENT après un redémarrage du serveur : le serveur injecte un
// identifiant de démarrage dans <meta name="boot-id"> (server.js) ; le navigateur
// mémorise le dernier identifiant vu. Même identifiant = pas d'intro (la page
// s'ouvre directement) ; nouvel identifiant (redémarrage / redéploiement) ou
// première visite = intro jouée une fois. Si l'identifiant est indisponible
// (page ouverte comme simple fichier), l'intro est jouée à chaque ouverture.
//
// À la fin, l'événement « baccara-intro-done » est émis ; chaque page ferme alors
// l'écran (index.html attend d'abord son premier chargement de données).
(function () {
  'use strict';
  var KEY = 'baccaraBootSeen';
  var bootId = null;
  try { var m = document.querySelector('meta[name="boot-id"]'); bootId = m && /^\d+$/.test(m.content) ? m.content : null; } catch (e) { /* ignoré */ }
  var skip = false;
  try {
    if (bootId) {
      if (localStorage.getItem(KEY) === bootId) skip = true;
      else localStorage.setItem(KEY, bootId);
    }
  } catch (e) { /* stockage indisponible : on joue l'intro */ }

  function addStyle(css) {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  if (skip) {
    addStyle('#splash{display:none!important}body.no-scroll{overflow:auto!important}');
    return;
  }

  addStyle([
    '#splash{position:fixed;inset:0;z-index:999;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#f6a877 0%,#ef9461 100%)}',
    '#splash.leaving{animation:splashOut 700ms ease forwards}',
    '@keyframes splashOut{to{opacity:0;visibility:hidden;pointer-events:none}}',
    '.walk-intro{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column}',
    '.walk-stage{width:min(100vw,560px)}',
    '.walk-stage svg{display:block;width:100%;height:auto;overflow:hidden}',
    '.walk-name{position:absolute;top:13%;left:0;right:0;text-align:center;opacity:0;animation:walkNameIn 900ms ease 900ms forwards}',
    '.walk-name .dev-name{font-family:Georgia,"Times New Roman",serif;font-size:22px;font-weight:700;color:#3a2010}',
    '.walk-name .dev-role{margin-top:6px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#7a4a2c}',
    '@keyframes walkNameIn{to{opacity:1}}',
    '.walk-skip{position:absolute;bottom:26px;left:0;right:0;text-align:center;color:#5a2f18;font-size:12px;letter-spacing:.04em;opacity:0;animation:walkSkipIn 4000ms ease-in-out 1500ms forwards}',
    '@keyframes walkSkipIn{to{opacity:.75}}',
    'body.no-scroll{overflow:hidden}'
  ].join('\n'));

  var SCENE =
    '<div class="walk-intro">' +
      '<div class="walk-name"><div class="dev-name">Sossou Kouamé Appolinaire</div><div class="dev-role">Développeur</div></div>' +
      '<div class="walk-stage"><svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect x="0" y="250" width="400" height="50" fill="rgba(0,0,0,.07)"/>' +
        '<g id="wk-man">' +
          '<ellipse cx="0" cy="0" rx="24" ry="5" fill="rgba(0,0,0,.2)"/>' +
          '<g id="wk-legB"><rect x="-6" y="-62" width="12" height="56" rx="5" fill="#1f2128"/><rect x="-5" y="-9" width="20" height="9" rx="4.5" fill="#f4f4f4"/></g>' +
          '<g id="wk-legF"><rect x="-6" y="-62" width="12" height="56" rx="5" fill="#2b2d36"/><rect x="-5" y="-9" width="20" height="9" rx="4.5" fill="#ffffff"/></g>' +
          '<g id="wk-upper">' +
            '<g id="wk-armB"><rect x="-5" y="-104" width="10" height="42" rx="5" fill="#a4a7af"/><circle cx="0" cy="-60" r="5.5" fill="#dca989"/></g>' +
            '<rect x="-17" y="-112" width="34" height="54" rx="11" fill="#b8bbc3"/>' +
            '<path d="M-6 -112 L0 -98 L6 -112 Z" fill="#ffffff"/>' +
            '<path d="M0 -98 L0 -68" stroke="#9a9da6" stroke-width="2"/>' +
            '<rect x="-5" y="-120" width="10" height="10" fill="#d9a785"/>' +
            '<circle cx="1" cy="-130" r="13" fill="#eab998"/>' +
            '<path d="M-11 -128 Q-11 -112 1 -111 Q13 -112 13 -128 Q8 -121 1 -121 Q-6 -121 -11 -128Z" fill="#d4a24c"/>' +
            '<path d="M-13 -132 Q-12 -148 2 -146 Q15 -145 14 -131 Q8 -138 -2 -137 Q-9 -136 -13 -132Z" fill="#e0b24f"/>' +
            '<circle cx="7" cy="-131" r="1.6" fill="#2a2a2a"/>' +
            '<g id="wk-armF"><rect x="-5" y="-104" width="10" height="42" rx="5" fill="#b8bbc3"/><circle cx="0" cy="-60" r="5.5" fill="#eab998"/></g>' +
          '</g>' +
        '</g>' +
        '<g id="wk-case"><rect x="-17" y="-13" width="34" height="26" rx="4" fill="#6b3a24"/><rect x="-17" y="-13" width="34" height="5" rx="2" fill="#7d4730"/><rect x="-4" y="-3" width="8" height="5" rx="1" fill="#d9b25a"/><path d="M-7 -13 v-5 h14 v5" fill="none" stroke="#4a2616" stroke-width="2.5"/></g>' +
      '</svg></div>' +
      '<div class="walk-skip">Touchez pour continuer</div>' +
    '</div>';

  // ── chronologie (ms) ───────────────────────────────────────────────────────
  var GROUND = 250, STOP_X = 150, START_X = -60, END_X = 470;
  var T_IN = 2400, T_BEND = 3100, T_LIFT = 3700, T_OUT = 6700, T_END = 7600;
  var CASE_GROUND = { x: STOP_X + 25, y: 237 };   // mallette posée au sol
  var CARRY = { x: 14, y: 206 - GROUND };         // mallette portée (repère de l'homme)
  var W = 2 * Math.PI / 520;                      // un pas ≈ 0,5 s

  function lerp(a, b, p) { return a + (b - a) * p; }
  function ease(p) { return p * p * (3 - 2 * p); }
  function clamp01(p) { return Math.max(0, Math.min(1, p)); }

  function start(splash) {
    splash.innerHTML = SCENE;
    var el = function (id) { return document.getElementById(id); };
    var man = el('wk-man'), legB = el('wk-legB'), legF = el('wk-legF'), upper = el('wk-upper');
    var armB = el('wk-armB'), armF = el('wk-armF'), kase = el('wk-case');
    var t0 = null, finished = false;
    function rot(g, a, cx, cy) { g.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + cx + ' ' + cy + ')'); }

    function frame(now) {
      if (finished) return;
      if (splash.classList.contains('leaving') || splash.style.display === 'none') return;
      if (t0 === null) t0 = now;
      var t = now - t0;
      var x, walking = false, lean = 3, armFa = 0, carrying = false, cx, cy;
      if (t < T_IN) { x = lerp(START_X, STOP_X, t / T_IN); walking = true; }
      else if (t < T_BEND) {
        var pb = ease(clamp01((t - T_IN) / (T_BEND - T_IN)));
        x = STOP_X; lean = lerp(3, 34, pb); armFa = -34 * pb;
      } else if (t < T_LIFT) {
        var pl = ease(clamp01((t - T_BEND) / (T_LIFT - T_BEND)));
        x = STOP_X; lean = lerp(34, 3, pl); armFa = lerp(-34, -18, pl);
        cx = lerp(CASE_GROUND.x, STOP_X + CARRY.x, pl); cy = lerp(CASE_GROUND.y, GROUND + CARRY.y, pl);
      } else if (t < T_OUT) {
        x = lerp(STOP_X, END_X, (t - T_LIFT) / (T_OUT - T_LIFT)); walking = true; carrying = true; armFa = -18;
      } else { x = END_X; carrying = true; armFa = -18; }

      var phase = (walking ? t : 0) * W;
      var sw = walking ? Math.sin(phase) : 0;
      var bob = walking ? Math.abs(Math.sin(phase)) * 2.2 : 0;
      man.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + (GROUND - bob).toFixed(1) + ')');
      rot(legF, 24 * sw, 0, -62);
      rot(legB, -24 * sw, 0, -62);
      rot(upper, lean, 0, -62);
      rot(armB, walking ? 26 * sw : (t < T_BEND ? 0 : 0), 0, -104);
      rot(armF, walking && !carrying ? -26 * sw : armFa, 0, -104);

      if (t < T_BEND) { cx = CASE_GROUND.x; cy = CASE_GROUND.y; }
      else if (t >= T_LIFT) { cx = x + CARRY.x; cy = GROUND + CARRY.y - bob; }
      kase.setAttribute('transform', 'translate(' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ')' + (carrying && walking ? ' rotate(' + (3 * Math.sin(phase + 1)).toFixed(2) + ' 0 -18)' : ''));

      if (t >= T_END) {
        finished = true;
        window.dispatchEvent(new Event('baccara-intro-done'));
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function boot() {
    var splash = document.getElementById('splash');
    if (splash) start(splash);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
