const log = require('./logger');
const { generateVideoMemes } = require('./memes');
const { postToAllPlatforms } = require('./platforms/shortsync');
const { postToTikTok } = require('./platforms/tiktok');

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';

// Mutates `job` in place as it progresses — shared by the manual /create
// endpoint and the autopilot, so both show up identically in /status polling.
async function runVideoJob(job, { prompt, description = '', hashtags = '', mediaType = 'videos', count = 1, platforms }) {
  const fullHashtags = [DEFAULT_HASHTAGS, hashtags].filter(Boolean).join(' ');

  job.status = 'generating';
  job.step = `Generating ${count} video(s) with Insider Memes...`;
  log.info('create', `[${job.id}] generating: "${prompt}" (mediaType=${mediaType}, count=${count})`);

  const memes = await generateVideoMemes(prompt, { mediaType, count });
  log.info('create', `[${job.id}] ${memes.length} video(s) ready`);

  job.totalSteps = memes.length * (platforms.length || 1);
  job.videos = memes.map((m) => ({
    videoUrl: m.url,
    tagline: m.tagline,
    platforms: Object.fromEntries(platforms.map((p) => [p, 'pending'])),
  }));
  job.status = 'posting';

  for (let i = 0; i < memes.length; i++) {
    const meme = memes[i];
    const shortSyncPlatforms = platforms.filter((p) => p !== 'tiktok');

    if (shortSyncPlatforms.length > 0) {
      job.step = `Posting video ${i + 1}/${memes.length} to ${shortSyncPlatforms.join(', ')}...`;
      log.info('create', `[${job.id}] posting video ${i + 1} via ShortSync to: ${shortSyncPlatforms.join(', ')}`);
      try {
        const byPlatform = await postToAllPlatforms(
          meme.url,
          { hookTagline: meme.tagline, description, hashtags: fullHashtags },
          shortSyncPlatforms
        );
        for (const platform of shortSyncPlatforms) {
          const result = byPlatform[platform];
          job.videos[i].platforms[platform] = result?.status === 'done' ? 'done' : `error: ${result?.error || 'unknown error'}`;
          job.completedSteps += 1;
        }
      } catch (err) {
        log.error('create', `[${job.id}] ShortSync post failed for video ${i + 1}:`, err.message);
        for (const platform of shortSyncPlatforms) {
          job.videos[i].platforms[platform] = `error: ${err.message}`;
          job.completedSteps += 1;
        }
      }
    }

    if (platforms.includes('tiktok')) {
      job.step = `Posting video ${i + 1}/${memes.length} to tiktok...`;
      log.info('create', `[${job.id}] attempting tiktok for video ${i + 1}...`);
      try {
        const baseCaption = [meme.tagline, description, fullHashtags].filter(Boolean).join('\n\n');
        const result = await postToTikTok(meme.url, baseCaption);
        job.videos[i].platforms.tiktok = 'done';
        log.info('create', `[${job.id}] tiktok publish_id: ${result.publishId}`);
      } catch (err) {
        log.error('create', `[${job.id}] tiktok failed:`, err.message);
        job.videos[i].platforms.tiktok = `error: ${err.message}`;
      }
      job.completedSteps += 1;
    }
  }

  job.status = 'done';
  job.step = 'All done!';
  log.info('create', `[${job.id}] job complete`);
  return job;
}

module.exports = { runVideoJob, DEFAULT_HASHTAGS };
