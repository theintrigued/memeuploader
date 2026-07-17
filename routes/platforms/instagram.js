const axios = require('axios');
const log = require('../logger');

// Uses ShortSync (shortsync.app) instead of calling Meta's Graph API directly.
// You connect Instagram once through ShortSync's dashboard (Settings ->
// Connections) — no Meta developer-account verification required on our end.
const BASE = 'https://api.shortsync.app/v1';

let connectionCache = { id: null, fetchedAt: 0 };
const CONNECTION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function headers() {
  const apiKey = (process.env.SHORTSYNC_API_KEY || '').trim();
  if (!apiKey) throw new Error('SHORTSYNC_API_KEY is not set — connect Instagram at shortsync.app and add the API key to Render');
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function getInstagramConnectionId() {
  if (connectionCache.id && Date.now() - connectionCache.fetchedAt < CONNECTION_CACHE_TTL_MS) {
    return connectionCache.id;
  }
  const res = await axios.get(`${BASE}/connections`, { headers: headers(), timeout: 20000 });
  const conns = res.data.data || res.data;
  const ig = conns.find((c) => c.platform === 'instagram' && c.status === 'active') || conns.find((c) => c.platform === 'instagram');
  if (!ig) throw new Error('No Instagram connection found on ShortSync — connect it at shortsync.app/settings?section=connections');
  connectionCache = { id: ig.id, fetchedAt: Date.now() };
  return ig.id;
}

async function postToInstagram(videoUrl, caption) {
  // 1. Reserve an upload slot
  const uploadRes = await axios.post(`${BASE}/uploads`, {}, { headers: headers(), timeout: 20000 });
  const { upload_id, presigned_url, required_headers } = uploadRes.data;

  // 2. Download the source video, then PUT it to the presigned URL. We buffer
  // rather than stream because presigned upload URLs (S3-style) generally
  // require a known Content-Length and reject chunked/streamed bodies.
  let videoBuffer;
  try {
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    videoBuffer = Buffer.from(videoRes.data);
  } catch (err) {
    throw new Error(`Could not download source video for ShortSync upload: ${err.message}`);
  }

  try {
    await axios.put(presigned_url, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.length,
        ...(required_headers || {}),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });
  } catch (err) {
    throw new Error(`ShortSync upload PUT failed: ${err.message}`);
  }

  // 3. Find the connected Instagram account
  const connectionId = await getInstagramConnectionId();

  // 4. Publish
  let postRes;
  try {
    postRes = await axios.post(
      `${BASE}/posts`,
      {
        upload_id,
        publish_mode: 'immediate',
        targets: [
          {
            connection_id: connectionId,
            caption,
            platform_options: { instagram: { share_to_feed: true } },
          },
        ],
      },
      { headers: headers(), timeout: 60000 }
    );
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`ShortSync publish failed: ${msg}`);
  }

  const result = (postRes.data.data || postRes.data)[0];
  if (result?.status === 'failed') {
    throw new Error(`ShortSync reported a failure: ${result.error?.message || JSON.stringify(result.error)}`);
  }

  log.info('instagram', `Published via ShortSync, post id=${result?.id}`);
  return { platform: 'instagram', id: result?.id };
}

module.exports = { postToInstagram };
