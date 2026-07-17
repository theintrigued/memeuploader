const axios = require('axios');
const log = require('../logger');

const BASE = 'https://api.shortsync.app/v1';

let connectionCache = { list: null, fetchedAt: 0 };
const CONNECTION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function headers() {
  const apiKey = (process.env.SHORTSYNC_API_KEY || '').trim();
  if (!apiKey) throw new Error('SHORTSYNC_API_KEY is not set — connect your platforms at shortsync.app and add the API key to Render');
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function getConnections() {
  if (connectionCache.list && Date.now() - connectionCache.fetchedAt < CONNECTION_CACHE_TTL_MS) {
    return connectionCache.list;
  }
  const res = await axios.get(`${BASE}/connections`, { headers: headers(), timeout: 20000 });
  const list = res.data.data || res.data;
  connectionCache = { list, fetchedAt: Date.now() };
  return list;
}

function findConnectionId(connections, platform) {
  const match = connections.find((c) => c.platform === platform && c.status === 'active')
    || connections.find((c) => c.platform === platform);
  if (!match) throw new Error(`No ${platform} connection found on ShortSync — connect it at shortsync.app/settings?section=connections`);
  return match.id;
}

// Uploads once, then fans out to every requested platform in a single POST /posts
// call. Replaces separate YouTube/TikTok/Instagram integrations — one service,
// one upload, consistent error handling and analytics across all three.
//
// captionParts: { hookTagline, description, hashtags } — hashtags go in
// first_comment (not the caption body) so the visible caption stays clean.
async function postToAllPlatforms(videoUrl, captionParts, platforms) {
  const { hookTagline, description, hashtags } = captionParts;
  const caption = [hookTagline, description, hashtags].filter(Boolean).join('\n\n');

  // 1. Reserve an upload slot
  const uploadRes = await axios.post(`${BASE}/uploads`, {}, { headers: headers(), timeout: 20000 });
  const { upload_id, presigned_url, required_headers } = uploadRes.data;

  // 2. Download the source video, then PUT it — buffered (not streamed) because
  // presigned upload URLs generally require a known Content-Length.
  let videoBuffer;
  try {
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    videoBuffer = Buffer.from(videoRes.data);
  } catch (err) {
    throw new Error(`Could not download source video for ShortSync upload: ${err.message}`);
  }

  try {
    await axios.put(presigned_url, videoBuffer, {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': videoBuffer.length, ...(required_headers || {}) },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });
  } catch (err) {
    throw new Error(`ShortSync upload PUT failed: ${err.message}`);
  }

  // 3. Resolve connection IDs for whichever platforms we're posting to
  const connections = await getConnections();
  const targets = [];
  const skipped = [];
  for (const platform of platforms) {
    try {
      const connection_id = findConnectionId(connections, platform);
      if (platform === 'youtube') {
        targets.push({
          connection_id,
          title: (hookTagline || 'ClipVault').slice(0, 90),
          description: caption.slice(0, 4900),
          platform_options: { youtube: { privacy_status: 'public', made_for_kids: false } },
        });
      } else if (platform === 'instagram') {
        targets.push({
          connection_id,
          caption,
          first_comment: hashtags || undefined,
          platform_options: { instagram: { share_to_feed: true } },
        });
      } else if (platform === 'tiktok') {
        targets.push({
          connection_id,
          caption,
          first_comment: hashtags || undefined,
        });
      }
    } catch (err) {
      skipped.push({ platform, error: err.message });
    }
  }

  if (targets.length === 0) {
    throw new Error(`No valid ShortSync connections for any of: ${platforms.join(', ')}`);
  }

  // 4. Publish to everything in one call
  let postRes;
  try {
    postRes = await axios.post(
      `${BASE}/posts`,
      { upload_id, publish_mode: 'immediate', targets },
      { headers: headers(), timeout: 60000 }
    );
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`ShortSync publish failed: ${msg}`);
  }

  const results = postRes.data.data || postRes.data;
  const byPlatform = {};
  for (const skip of skipped) {
    byPlatform[skip.platform] = { status: 'error', error: skip.error };
  }
  for (const target of targets) {
    const conn = connections.find((c) => c.id === target.connection_id);
    const platform = conn?.platform || 'unknown';
    const result = results.find((r) => r.target?.connection_id === target.connection_id) || results[targets.indexOf(target)];
    if (result?.status === 'failed') {
      byPlatform[platform] = { status: 'error', error: result.error?.message || 'ShortSync reported failure' };
    } else {
      byPlatform[platform] = { status: 'done', id: result?.id };
      log.info('shortsync', `Published to ${platform}, post id=${result?.id}`);
    }
  }

  return byPlatform;
}

module.exports = { postToAllPlatforms, getConnections };
