const { getJSON, setJSON } = require('./upstash-client');

const KEY = 'clipvault_recent_templates';
const HISTORY_LENGTH = 20; // "if used in the last 20 uploads" per the requirement

async function getRecentTemplateIds() {
  return getJSON(KEY, []);
}

async function recordTemplateUsed(id) {
  const history = await getRecentTemplateIds();
  const updated = [id, ...history.filter((existing) => existing !== id)].slice(0, HISTORY_LENGTH);
  await setJSON(KEY, updated);
}

module.exports = { getRecentTemplateIds, recordTemplateUsed, HISTORY_LENGTH };
