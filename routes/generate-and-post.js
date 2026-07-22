const fs = require('fs');
const log = require('./logger');
const { generateVideoMemes } = require('./memes');
const { postToAllPlatforms } = require('./platforms/shortsync');
const { postToTikTok } = require('./platforms/tiktok');
const { pickBestTemplate } = require('./template-picker');
const { downloadToTemp, burnTextOverlay, cleanupFile } = require('./video-processing');

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';

// Mutates `job` in place as it progresses — shared by the manual /create
// endpoint and the autopilot, so both show up identically in /status polling.
//
// useTemplateIndex: when true, skips Insider Memes' /generate/ entirely —
// instead picks a raw template from our own indexed library (see
// template-picker.js) and burns our own text onto it via ffmpeg. Costs zero
// Insider Memes credits. Intended for relatable-moment prompts, where we want
// deliberate template matching rather than their keyword-based auto-select.
// textOptions: { font, fontSize, x, y } — only used when useTemplateIndex is true.
async function runVideoJob(job, {
  prompt, description = '', hashtags = '', mediaType = 'videos', count = 1, platforms,
  useTemplateIndex = false, textOptions = {},
}) {
  const fullHashtags = [DEFAULT_HASHTAGS, hashtags].filter(Boolean).join(' ');

  let memes;
  if (useTemplateIndex) {
    job.status = 'generating';
    job.step = 'Picking best-matching template from index...';
    log.info('create', `[${job.id}] template-index mode for: "${prompt}"`);
    const template = await pickBestTemplate(prompt);
    memes = [{ url: template.mediaUrl, tagline: prompt, templateId: template.id, needsTextBurn: true }];
    log.info('create', `[${job.id}] picked template ${template.id}`);
  } else {
    job.status = 'generating';
    job.step = `Generating ${count} video(s) with Insider Memes...`;
    log.info('create', `[${job.id}] generating: "${prompt}" (mediaType=${mediaType}, count=${count})`);
    memes = await generateVideoMemes(prompt, { mediaType, count });
  }
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
    let videoSource = meme.url; // default: post directly from the source URL
    let localProcessedPath = null;

    if (meme.needsTextBurn) {
      job.step = `Adding text overlay to video ${i + 1}/${memes.length}...`;
      log.info('create', `[${job.id}] burning text overlay for video ${i + 1}...`);
      try {
        const inputPath = await downloadToTemp(meme.url);
        try {
          localProcessedPath = await burnTextOverlay(inputPath, { text: meme.tagline, ...textOptions });
        } finally {
          cleanupFile(inputPath);
        }
        videoSource = { localPath: localProcessedPath };
      } catch (err) {
        log.error('create', `[${job.id}] text overlay failed for video ${i + 1}:`, err.message);
        for (const platform of platforms) {
          job.videos[i].platforms[platform] = `error: text overlay failed: ${err.message}`;
          job.completedSteps += 1;
        }
        continue; // can't post this one at all
      }
    }

    const shortSyncPlatforms = platforms.filter((p) => p !== 'tiktok');

    if (shortSyncPlatforms.length > 0) {
      job.step = `Posting video ${i + 1}/${memes.length} to ${shortSyncPlatforms.join(', ')}...`;
      log.info('create', `[${job.id}] posting video ${i + 1} via ShortSync to: ${shortSyncPlatforms.join(', ')}`);
      try {
        const byPlatform = await postToAllPlatforms(
          videoSource,
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
        const result = await postToTikTok(videoSource, baseCaption);
        job.videos[i].platforms.tiktok = 'done';
        log.info('create', `[${job.id}] tiktok publish_id: ${result.publishId}`);
      } catch (err) {
        log.error('create', `[${job.id}] tiktok failed:`, err.message);
        job.videos[i].platforms.tiktok = `error: ${err.message}`;
      }
      job.completedSteps += 1;
    }

    if (localProcessedPath) cleanupFile(localProcessedPath);
  }

  job.status = 'done';
  job.step = 'All done!';
  log.info('create', `[${job.id}] job complete`);
  return job;
}

module.exports = { runVideoJob, DEFAULT_HASHTAGS };
