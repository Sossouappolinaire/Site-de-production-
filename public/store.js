// store.js — persistance simple (token du bot, canaux, seuil B) dans data.json
const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
    return false;
  }
}

function patch(partial) {
  const data = { ...read(), ...partial };
  write(data);
  return data;
}

module.exports = { read, write, patch, FILE };
