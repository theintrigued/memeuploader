const { google } = require('googleapis');
const fs = require('fs');
const log = require('../logger');

async function postToYouTube(localVideoPath, caption, title) {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET || !process.env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error('YouTube env vars are not fully set (YOUTUBE_CLIENT_ID / SECRET / REFRESH_TOKEN)');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN.trim() });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  try {
    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: (title || caption).slice(0, 90) || 'ClipVault',
          description: caption.slice(0, 4900), // YouTube description cap is 5000 chars
          categoryId: '23', // Comedy
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(localVideoPath) },
    });
    log.info('youtube', `Uploaded, video id=${res.data.id}`);
    return { platform: 'youtube', id: res.data.id, url: `https://youtube.com/shorts/${res.data.id}` };
  } catch (err) {
    const reason = err.errors?.[0]?.reason || err.code;
    if (reason === 'quotaExceeded') {
      throw new Error('YouTube daily upload quota exceeded — try again tomorrow, or request a quota increase from Google Cloud Console.');
    }
    if (err.code === 401 || reason === 'authError') {
      throw new Error('YouTube auth failed — refresh token may have been revoked. Regenerate it via OAuth Playground.');
    }
    throw err;
  }
}

module.exports = { postToYouTube };
