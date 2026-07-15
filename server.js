require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { generateVideoMemes } = require('./routes/memes');
const { postToYouTube } = require('./routes/platforms/youtube');
const { postToInstagram } = require('./routes/platforms/instagram');
const { postToTikTok } = require('./routes/platforms/tiktok');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';

// In-memory job store. Resets on redeploy/restart — fine for a single-user tool.
const jobs = {};

function newJob() {
  const id = crypto.randomUUID();
  jobs[id] = {
    id,
    status: 'starting', // starting | generating | posting | done | error
    step: 'Generating video(s)...',
    totalSteps: 1,
    completedSteps: 0,
    videos: [], // { videoUrl, tagline, platforms: { youtube: 'pending'|'done'|'error', ... } }
    error: null,
  };
  return jobs[id];
}

app.post('/create', async (req, res) => {
  if (req.body.secret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Bad secret' });
  }
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  const description = (req.body.description || '').trim();
  const hashtags = [DEFAULT_HASHTAGS, (req.body.hashtags || '').trim()].filter(Boolean).join(' ');
  const mediaType = (req.body.mediaType || 'videos').trim();
  let count = parseInt(req.body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 12) count = 1;

  const job = newJob();
  res.json({ jobId: job.id }); // respond immediately, no waiting on a slow connection

  runJob(job, { prompt, description, hashtags, mediaType, count }).catch((err) => {
    job.status = 'error';
    job.error = err.response?.data || err.message;
  });
});

async function runJob(job, { prompt, description, hashtags, mediaType, count }) {
  const platforms = (process.env.POST_TO || '').split(',').map((p) => p.trim()).filter(Boolean);

  job.status = 'generating';
  job.step = `Generating ${count} video(s) with Insider Memes...`;
  console.log(`[create ${job.id}] generating: "${prompt}" (mediaType=${mediaType}, count=${count})`);

  const memes = await generateVideoMemes(prompt, { mediaType, count });
  console.log(`[create ${job.id}] ${memes.length} video(s) ready`);

  job.totalSteps = memes.length * platforms.length || 1;
  job.videos = memes.map((m) => ({
    videoUrl: m.url,
    tagline: m.tagline,
    platforms: Object.fromEntries(platforms.map((p) => [p, 'pending'])),
  }));
  job.status = 'posting';

  for (let i = 0; i < memes.length; i++) {
    const meme = memes[i];
    const baseCaption = [meme.tagline, description, hashtags].filter(Boolean).join('\n\n');
    const withTag = (tag) => (baseCaption.includes(tag) ? baseCaption : `${baseCaption}\n\n${tag}`);

    for (const platform of platforms) {
      job.step = `Posting video ${i + 1}/${memes.length} to ${platform}...`;
      try {
        if (platform === 'youtube') await postToYouTube(meme.url, withTag('#shorts'), meme.tagline);
        if (platform === 'instagram') await postToInstagram(meme.url, withTag('#reels'));
        if (platform === 'tiktok') await postToTikTok(meme.url, withTag('#fyp'));
        job.videos[i].platforms[platform] = 'done';
      } catch (err) {
        console.error(`[create ${job.id}] ${platform} failed:`, err.response?.data || err.message);
        job.videos[i].platforms[platform] = 'error';
      }
      job.completedSteps += 1;
    }
  }

  job.status = 'done';
  job.step = 'All done!';
}

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job — server may have restarted' });
  res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ClipVault poster listening on :${port}`));
