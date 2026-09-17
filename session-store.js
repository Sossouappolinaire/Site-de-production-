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
