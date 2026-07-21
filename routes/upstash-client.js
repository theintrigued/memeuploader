const axios = require('axios');

// Thin shared client for Upstash Redis's REST API. Used by both prompt-store
// (generated prompts) and autopilot-store (scheduling state) so persistence
// survives Render restarts/redeploys, which wipe local disk.
function config() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — create a free database at upstash.com and add both to Render.');
  }
  return { url, token };
}

async function getJSON(key, fallback) {
  const { url, token } = config();
  const res = await axios.get(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
  if (!res.data.result) return fallback;
  try {
    return JSON.parse(res.data.result);
  } catch (e) {
    return fallback;
  }
}

async function setJSON(key, value) {
  const { url, token } = config();
  await axios.post(`${url}/set/${key}`, JSON.stringify(value), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    timeout: 15000,
  });
}

module.exports = { getJSON, setJSON };
