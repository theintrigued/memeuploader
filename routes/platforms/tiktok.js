const axios = require('axios');

// TikTok access tokens expire in ~24h. The refresh token lasts much longer
// (~1 year), so we exchange it for a fresh access token before every post
// rather than relying on a manually-pasted access token going stale.
// TikTok may also rotate the refresh token itself on each use — we track
// that in memory for the life of this process and log if it changes.
let currentRefreshToken = (process.env.TIKTOK_REFRESH_TOKEN || '').trim();

async function getFreshAccessToken() {
  const res = await axios.post(
    'https://open.tiktokapis.com/v2/oauth/token/',
    new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (res.data.refresh_token && res.data.refresh_token !== currentRefreshToken) {
    console.warn(
      '[tiktok] TikTok issued a NEW refresh token. Update TIKTOK_REFRESH_TOKEN in Render to this value ' +
      'or it will stop working after the next server restart:',
      res.data.refresh_token
    );
    currentRefreshToken = res.data.refresh_token;
  }

  return res.data.access_token;
}

// IMPORTANT: Until your TikTok app passes audit, TikTok only allows
// "inbox" (draft) uploads — the video lands in your TikTok inbox and you
// still have to tap Post inside the TikTok app. Direct auto-publish
// requires TikTok's Content Posting API audit approval.
//
// We use FILE_UPLOAD (not PULL_FROM_URL) because pull-from-url requires
// verifying ownership of the source domain, which we don't control since
// videos are hosted on Insider Memes' domain.
async function postToTikTok(videoUrl, caption) {
  const token = await getFreshAccessToken();

  const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  const videoBuffer = Buffer.from(videoRes.data);
  const videoSize = videoBuffer.length;

  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: videoSize,
        total_chunk_count: 1,
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  const { publish_id, upload_url } = initRes.data.data;

  await axios.put(upload_url, videoBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return { platform: 'tiktok', publishId: publish_id, note: 'Sent to TikTok inbox — open the TikTok app to finish posting until your app is audited for direct publish.' };
}

module.exports = { postToTikTok };
