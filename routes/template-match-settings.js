const { getJSON, setJSON } = require('./upstash-client');

const KEY = 'clipvault_template_match_defaults';

const HARD_DEFAULTS = { font: 'anton', fontSize: 64, x: 50, y: 8, width: 80 };

async function getDefaults() {
  const saved = await getJSON(KEY, null);
  return saved ? { ...HARD_DEFAULTS, ...saved } : HARD_DEFAULTS;
}

async function setDefaults(partial) {
  const current = await getDefaults();
  const merged = { ...current, ...partial };
  await setJSON(KEY, merged);
  return merged;
}

module.exports = { getDefaults, setDefaults, HARD_DEFAULTS };
