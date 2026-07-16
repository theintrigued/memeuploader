const axios = require('axios');
const log = require('../logger');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function postToInstagram(videoUrl, caption) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = (process.env.IG_ACCESS_TOKEN || '').trim();

  if (!igId || !token) {
    throw new Error('Instagram env vars are not fully set (IG_ACCESS_TOKEN / IG_BUSINESS_ACCOUNT_ID)');
  }

  let creationId;
  try {
    const createRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption, access_token: token },
      timeout: 30000,
    });
    creationId = createRes.data.id;
  } catch (err) {
    throw friendlyInstagramError(err, 'creating media container');
  }

  try {
    await waitUntilReady(creationId, token);
  } catch (err) {
    throw friendlyInstagramError(err, 'processing the uploaded video');
  }

  try {
    const publishRes = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: token },
      timeout: 30000,
    });
    log.info('instagram', `Published, media id=${publishRes.data.id}`);
    return { platform: 'instagram', id: publishRes.data.id };
  } catch (err) {
    throw friendlyInstagramError(err, 'publishing');
  }
}

async function waitUntilReady(creationId, token, { intervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await axios.get(`${GRAPH}/${creationId}`, {
      params: { fields: 'status_code', access_token: token },
      timeout: 30000,
    });
    if (statusRes.data.status_code === 'FINISHED') return;
    if (statusRes.data.status_code === 'ERROR') throw new Error('Instagram reported an error processing the video container');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Instagram to finish processing the video');
}

function friendlyInstagramError(err, stage) {
  const meta = err.response?.data?.error;
  if (meta?.code === 190) {
    return new Error(`Instagram token invalid/expired while ${stage} — regenerate IG_ACCESS_TOKEN (see setup guide).`);
  }
  if (meta?.message) {
    return new Error(`Instagram error while ${stage}: ${meta.message}`);
  }
  return new Error(`Instagram request failed while ${stage}: ${err.message}`);
}

module.exports = { postToInstagram };
