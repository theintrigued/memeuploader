const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v20.0';

async function postToInstagram(videoUrl, caption) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;

  // Step 1: create a media container pointing at the (publicly reachable) video URL
  const createRes = await axios.post(`${GRAPH}/${igId}/media`, null, {
    params: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: token,
    },
  });
  const creationId = createRes.data.id;

  // Step 2: poll container status until it's FINISHED (Instagram has to download/process it)
  await waitUntilReady(creationId, token);

  // Step 3: publish
  const publishRes = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: token },
  });

  return { platform: 'instagram', id: publishRes.data.id };
}

async function waitUntilReady(creationId, token, { intervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await axios.get(`${GRAPH}/${creationId}`, {
      params: { fields: 'status_code', access_token: token },
    });
    if (statusRes.data.status_code === 'FINISHED') return;
    if (statusRes.data.status_code === 'ERROR') throw new Error('Instagram container processing failed');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Instagram container to finish processing');
}

module.exports = { postToInstagram };
