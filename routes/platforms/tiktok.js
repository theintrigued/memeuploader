const axios = require('axios');

// IMPORTANT: Until your TikTok app passes audit, TikTok only allows
// "inbox" (draft) uploads — the video lands in your TikTok inbox and you
// still have to tap Post inside the TikTok app. Direct auto-publish
// requires TikTok's Content Posting API audit approval.
async function postToTikTok(videoUrl, caption) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;

  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  return { platform: 'tiktok', publishId: initRes.data.data.publish_id, note: 'Sent to TikTok inbox — open the TikTok app to finish posting until your app is audited for direct publish.' };
}

module.exports = { postToTikTok };
