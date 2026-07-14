const axios = require('axios');

const BASE = 'https://backend.insidermemes.com/v1';

async function generateVideoMeme(prompt) {
  const res = await axios.post(
    `${BASE}/generate/`,
    { text: prompt, mediaType: 'videos', count: 1 },
    { headers: authHeaders() }
  );

  const meme = res.data.memes && res.data.memes[0];
  if (!meme) throw new Error('No meme returned from Insider Memes');

  // If file is already populated, we're done (image case / instant video)
  if (meme.file) {
    return { url: meme.file, tagline: meme.tagline };
  }

  // Otherwise it's an async video job — poll until it's ready.
  if (meme.jobInfo && meme.jobInfo.jobId) {
    const url = await pollForVideo(meme);
    return { url, tagline: meme.tagline };
  }

  throw new Error('Meme returned with no file and no jobInfo — check API response shape');
}

// NOTE: Insider Memes' public docs do not publish a job-status endpoint as of
// this writing. This function assumes one exists at GET /v1/jobs/{jobId}/ —
// confirm the real path with Insider Memes support (chief@insidermemes.com)
// and adjust POLL_PATH below before relying on this in production.
const POLL_PATH = (jobId) => `${BASE}/jobs/${jobId}/`;

async function pollForVideo(meme, { intervalMs = 5000, timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await axios.get(POLL_PATH(meme.jobInfo.jobId), { headers: authHeaders() });
    const status = res.data.status || res.data.state;
    if (res.data.file || res.data.fileUrl) {
      return res.data.file || res.data.fileUrl;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error('Video generation job failed');
    }
  }
  throw new Error('Timed out waiting for video generation');
}

function authHeaders() {
  return {
    Authorization: `Token ${process.env.INSIDERMEMES_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { generateVideoMeme };
