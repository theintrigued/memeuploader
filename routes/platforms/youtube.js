const { google } = require('googleapis');
const axios = require('axios');
const stream = require('stream');

async function postToYouTube(videoUrl, caption) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Stream the video file straight from Insider Memes into the YouTube upload
  const videoRes = await axios.get(videoUrl, { responseType: 'stream' });

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: caption.slice(0, 90) || 'ClipVault',
        description: `${caption}\n\n#shorts`,
        categoryId: '23', // Comedy
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: videoRes.data },
  });

  return { platform: 'youtube', id: res.data.id, url: `https://youtube.com/shorts/${res.data.id}` };
}

module.exports = { postToYouTube };
