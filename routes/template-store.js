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
  list.push(...records);
  await setJSON(LIST_KEY, list);
  return list;
}

async function getTemplateDetail(id) {
  return getJSON(DETAIL_PREFIX + id, null);
}

async function setTemplateDetail(id, record) {
  await setJSON(DETAIL_PREFIX + id, record);
}

module.exports = { getManifest, setManifest, getCompactList, appendToCompactList, getTemplateDetail, setTemplateDetail };
