const { getJSON, setJSON } = require('./upstash-client');

const MANIFEST_KEY = 'clipvault_template_manifest';
const LIST_KEY = 'clipvault_template_list'; // compact array for fast candidate scanning
const DETAIL_PREFIX = 'clipvault_template_detail_'; // one key per template, full record

async function getManifest() {
  return getJSON(MANIFEST_KEY, { cursor: null, indexedCount: 0, total: null, done: false, lastRunAt: null });
}

async function setManifest(manifest) {
  await setJSON(MANIFEST_KEY, manifest);
}

async function getCompactList() {
  return getJSON(LIST_KEY, []);
}

async function appendToCompactList(records) {
  const list = await getCompactList();
  const byId = new Map(list.map((r) => [r.id, r]));
  for (const record of records) byId.set(record.id, record); // upsert — re-indexing an id replaces it cleanly
  const updated = Array.from(byId.values());
  await setJSON(LIST_KEY, updated);
  return updated;
}

async function getTemplateDetail(id) {
  return getJSON(DETAIL_PREFIX + id, null);
}

async function setTemplateDetail(id, record) {
  await setJSON(DETAIL_PREFIX + id, record);
}

async function getRandomVideoTemplate() {
  const list = await getCompactList();
  const videos = list.filter((t) => t.type === 'video' && t.mediaUrl);
  if (videos.length === 0) return null;
  return videos[Math.floor(Math.random() * videos.length)];
}

module.exports = { getManifest, setManifest, getCompactList, appendToCompactList, getTemplateDetail, setTemplateDetail, getRandomVideoTemplate };
