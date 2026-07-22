const fs = require('fs');
const log = require('./logger');
const { generateVideoMemes } = require('./memes');
const { postToAllPlatforms } = require('./platforms/shortsync');
const { postToTikTok } = require('./platforms/tiktok');
const { pickBestTemplate } = require('./template-picker');
const { writeCaptionForTemplate } = require('./caption-writer');
const { downloadToTemp, burnTextOverlay, cleanupFile } = require('./video-processing');

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';

// Mutates `job` in place as it progresses — shared by the manual /create
// endpoint and the autopilot, so both show up identically in /status polling.
//
// Two ways to call this:
//   - prompt (single string): the original single-video flow.
//   - prompts (array of {id, tagline}): batch mode — generates one video per
//     entry, each independently template-matched (with its own Insider Memes
//     fallback), all posted in the same job. Used by the "generate N from
//     saved prompts" flow.
//
// useTemplateIndex: when true, skips Insider Memes' /generate/ entirely —
// instead picks a raw template from our own indexed library (see
// template-picker.js) and burns our own text onto it via ffmpeg. Costs zero
// Insider Memes credits.
// textOptions: { font, fontSize, x, y, width } — only used when useTemplateIndex is true.
// customCaption: if set, used verbatim instead of asking Claude to write one
// (applies to every video when in batch mode).
async function runVideoJob(job, {
  prompt, prompts, description = '', hashtags = '', mediaType = 'videos', count = 1, platforms,
  useTemplateIndex = false, textOptions = {}, customCaption = null,
}) {
  const fullHashtags = [DEFAULT_HASHTAGS, hashtags].filter(Boolean).join(' ');

  let memes = [];
  if (useTemplateIndex && Array.isArray(prompts) && prompts.length > 0) {
    job.status = 'generating';
    log.info('create', `[${job.id}] batch template-index mode for ${prompts.length} prompt(s)`);
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      job.step = `Matching template for prompt ${i + 1}/${prompts.length}: "${p.tagline}"...`;
      try {
        const template = await pickBestTemplate(p.tagline);
        const caption = customCaption || await writeCaptionForTemplate(p.tagline, template.description);
        memes.push({ url: template.mediaUrl, tagline: caption, templateId: template.id, needsTextBurn: true });
        log.info('create', `[${job.id}] (${i + 1}/${prompts.length}) picked template ${template.id}, caption: "${caption}"`);
      } catch (err) {
        log.warn('create', `[${job.id}] template match failed for "${p.tagline}" (${err.message}) — falling back to Insider Memes`);
        try {
          const fallback = await generateVideoMemes(p.tagline, { mediaType: 'videos', count: 1 });
          memes.push(...fallback);
        } catch (err2) {
          log.error('create', `[${job.id}] Insider Memes fallback also failed for "${p.tagline}": ${err2.message} — skipping this one`);
        }
      }
    }
  } else if (useTemplateIndex) {
    job.status = 'generating';
    job.step = 'Picking best-matching template from index...';
    log.info('create', `[${job.id}] template-index mode for: "${prompt}"`);
    try {
      const template = await pickBestTemplate(prompt);
      job.step = 'Writing meme caption...';
      const memeCaption = customCaption || await writeCaptionForTemplate(prompt, template.description);
      memes = [{ url: template.mediaUrl, tagline: memeCaption, templateId: template.id, needsTextBurn: true }];
      log.info('create', `[${job.id}] picked template ${template.id}, caption: "${memeCaption}"`);
    } catch (err) {
      log.warn('create', `[${job.id}] template match failed (${err.message}) — falling back to Insider Memes generation`);
      job.step = `Falling back to Insider Memes for: "${prompt}"...`;
      memes = await generateVideoMemes(prompt, { mediaType: 'videos', count: 1 });
    }
  } else {
    job.status = 'generating';
    job.step = `Generating ${count} video(s) with Insider Memes...`;
    log.info('create', `[${job.id}] generating: "${prompt}" (mediaType=${mediaType}, count=${count})`);
    memes = await generateVideoMemes(prompt, { mediaType, count });
  }
  log.info('create', `[${job.id}] ${memes.length} video(s) ready`);

  if (memes.length === 0) {
    job.status = 'error';
    job.error = 'No videos could be generated (all template matches and Insider Memes fallbacks failed)';
    return job;
  }

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
