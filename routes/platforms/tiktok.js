const axios = require('axios');
const log = require('../logger');

// TikTok access tokens expire in ~24h. The refresh token lasts much longer
// (~1 year) and TikTok may rotate it on each use, so we track the current
// value in memory and warn if it changes.
let currentRefreshToken = (process.env.TIKTOK_REFRESH_TOKEN || '').trim();

async function getFreshAccessToken() {
  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET || !currentRefreshToken) {
    throw new Error('TikTok env vars are not fully set (TIKTOK_CLIENT_KEY / SECRET / REFRESH_TOKEN)');
  }

  let res;
  try {
    res = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    throw new Error(`TikTok token refresh failed (refresh token may be expired — redo /tiktok/login): ${msg}`);
  }

  if (res.data.refresh_token && res.data.refresh_token !== currentRefreshToken) {
    log.warn('tiktok', `TikTok issued a NEW refresh token. Update TIKTOK_REFRESH_TOKEN in Render or it will stop working after a restart: ${res.data.refresh_token}`);
    currentRefreshToken = res.data.refresh_token;
  }

  return res.data.access_token;
}

// IMPORTANT: Until your TikTok app passes audit, TikTok only allows "inbox"
// (draft) uploads — the video lands in your TikTok inbox and you still have
// to tap Post inside the TikTok app. Direct auto-publish requires TikTok's
// Content Posting API audit approval.
//
// We use FILE_UPLOAD (not PULL_FROM_URL) because pull-from-url requires
// verifying ownership of the source domain, which we don't control since
// videos are hosted on Insider Memes' domain.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB safety cap, well under TikTok's own limit

async function postToTikTok(videoUrl, caption) {
  const token = await getFreshAccessToken();

  let videoBuffer;
  try {
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_UPLOAD_BYTES });
    videoBuffer = Buffer.from(videoRes.data);
  } catch (err) {
    throw new Error(`Could not download source video for TikTok upload: ${err.message}`);
  }

  const videoSize = videoBuffer.length;
  if (videoSize === 0) throw new Error('Downloaded video is empty (0 bytes) — Insider Memes may have returned a broken link');

  let initRes;
  try {
    initRes = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      { source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: videoSize, total_chunk_count: 1 } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
  } catch (err) {
    const meta = err.response?.data?.error;
    throw new Error(`TikTok upload init failed: ${meta?.message || err.message}`);
  }

  const { publish_id, upload_url } = initRes.data.data;

  try {
    await axios.put(upload_url, videoBuffer, {
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });
  } catch (err) {
    throw new Error(`TikTok file upload failed after init succeeded (publish_id=${publish_id}): ${err.message}`);
  }

  log.info('tiktok', `Uploaded to inbox, publish_id=${publish_id}`);
  return { platform: 'tiktok', publishId: publish_id, note: 'Sent to TikTok inbox — open the TikTok app to finish posting until your app is audited for direct publish.' };
}

module.exports = { postToTikTok };
