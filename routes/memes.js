const axios = require('axios');

const BASE = 'https://backend.insidermemes.com/v1';

async function generateVideoMemes(prompt, { mediaType = 'videos', count = 1 } = {}) {
  const res = await axios.post(
    `${BASE}/generate/`,
    { text: prompt, mediaType, count },
    { headers: authHeaders() }
  );

  const memes = res.data.memes || [];
  if (memes.length === 0) throw new Error('No memes returned from Insider Memes');

  const results = [];
  for (const meme of memes) {
    if (meme.file) {
      results.push({ url: meme.file, tagline: meme.tagline });
      continue;
    }
    if (meme.jobInfo && meme.jobInfo.jobId) {
      const url = await pollForVideo(meme);
      results.push({ url, tagline: meme.tagline });
      continue;
    }
    console.error('[memes] skipping meme with no file and no jobInfo:', meme.id);
  }

  if (results.length === 0) throw new Error('None of the returned memes produced a usable file');
  return results;
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

module.exports = { generateVideoMemes };
