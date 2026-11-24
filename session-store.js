// session-store.js — stockage des sessions « base de données + mémoire ».
//
// Avant, les sessions vivaient uniquement dans PostgreSQL (connect-pg-simple).
// Conséquence : si la base n'était pas joignable, même l'administrateur ne
// pouvait plus se connecter au tableau de bord (l'enregistrement de la session
// échouait). On garde donc PostgreSQL comme stockage durable, avec un repli
// automatique en mémoire quand la base ne répond pas : la connexion admit de
// secours (voir auth.js) fonctionne alors normalement.
'use strict';

const session = require('express-session');

module.exports = function hybridStore(pgStore) {
  const mem = new session.MemoryStore();

  // Les sessions gardées en mémoire (repli) n'étaient jamais purgées : on retire celles dont le cookie est expiré.
  const sweep = setInterval(() => {
    try {
      mem.all((_e, all) => {
        const now = Date.now();
        for (const sid of Object.keys(all || {})) {
          const exp = all[sid] && all[sid].cookie && all[sid].cookie.expires;
          if (exp && new Date(exp).getTime() < now) mem.destroy(sid, () => {});
        }
      });
    } catch (_) { /* balayage facultatif */ }
  }, 30 * 60 * 1000);
  if (sweep.unref) sweep.unref();
  const store = new session.Store();

  const safe = (fn) => {
    try { fn(); } catch (e) { console.error('Session (base) indisponible :', e.message); }
  };

  store.get = (sid, cb) => {
    mem.get(sid, (_e, sess) => {
      if (sess) return cb(null, sess);
      let answered = false;
      const done = (err, res) => { if (!answered) { answered = true; cb(err || null, res); } };
      safe(() => pgStore.get(sid, (err, res) => done(err ? null : null, err ? undefined : res)));
      setTimeout(() => done(null, undefined), 5000); // base muette → pas de session
    });
  };

  store.set = (sid, sess, cb) => {
    mem.set(sid, sess, () => {});
    safe(() => pgStore.set(sid, sess, () => {})); // durable si la base répond
    cb && cb(null);
  };

  store.destroy = (sid, cb) => {
    mem.destroy(sid, () => {});
    safe(() => pgStore.destroy(sid, () => {}));
    cb && cb(null);
  };

  store.touch = (sid, sess, cb) => {
    mem.touch ? mem.touch(sid, sess, () => {}) : mem.set(sid, sess, () => {});
    safe(() => pgStore.touch && pgStore.touch(sid, sess, () => {}));
    cb && cb(null);
  };

  return store;
};
