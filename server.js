require('dotenv').config();
const express = require('express');
const path = require('path');
const { generateVideoMeme } = require('./routes/memes');
const { postToYouTube } = require('./routes/platforms/youtube');
const { postToInstagram } = require('./routes/platforms/instagram');
const { postToTikTok } = require('./routes/platforms/tiktok');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';

app.post('/create', async (req, res) => {
  try {
    if (req.body.secret !== process.env.APP_SECRET) {
      return res.status(401).json({ error: 'Bad secret' });
    }
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const description = (req.body.description || '').trim();
    const hashtags = [DEFAULT_HASHTAGS, (req.body.hashtags || '').trim()].filter(Boolean).join(' ');

    console.log(`[create] generating meme for: "${prompt}"`);
    const meme = await generateVideoMeme(prompt);
    console.log(`[create] video ready: ${meme.url}`);

    // Build the final caption: AI tagline, then your optional description, then hashtags.
    const baseCaption = [meme.tagline, description, hashtags].filter(Boolean).join('\n\n');
    const withTag = (tag) => (baseCaption.includes(tag) ? baseCaption : `${baseCaption}\n\n${tag}`);

    const platforms = (process.env.POST_TO || '').split(',').map((p) => p.trim()).filter(Boolean);
    const results = [];

    for (const platform of platforms) {
      try {
        if (platform === 'youtube') results.push(await postToYouTube(meme.url, withTag('#shorts'), meme.tagline));
        if (platform === 'instagram') results.push(await postToInstagram(meme.url, withTag('#reels')));
        if (platform === 'tiktok') results.push(await postToTikTok(meme.url, withTag('#fyp')));
      } catch (err) {
        console.error(`[create] ${platform} failed:`, err.response?.data || err.message);
        results.push({ platform, error: err.response?.data || err.message });
      }
    }

    res.json({ prompt, videoUrl: meme.url, tagline: meme.tagline, results });
  } catch (err) {
    console.error('[create] fatal:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ClipVault poster listening on :${port}`));
