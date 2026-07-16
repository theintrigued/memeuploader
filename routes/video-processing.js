const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const log = require('./logger');

const PROCESSED_DIR = path.join(os.tmpdir(), 'clipvault-processed');
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

const FONT_FAMILY = 'Anton'; // must match the font's internal family name for libass to find it
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const OUT_W = 1080;
const OUT_H = 1920;
const HOOK_DURATION_S = 1.2;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20, cwd: PROCESSED_DIR }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${err.message}\n${stderr?.slice(-2000) || ''}`));
      else resolve();
    });
  });
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/[{}\\]/g, '') // these have special meaning inside ASS text
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapText(text, maxCharsPerLine) {
  const words = sanitizeText(text).split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function assTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

// Builds a minimal .ass subtitle file with two styles: a big centered "hook"
// line for the opening window, and a smaller bottom-anchored running caption
// for the whole clip. libass burns this in via the `subtitles=` filter.
function buildAssFile({ hookText, captionText, durationS }) {
  const hookLines = wrapText(hookText, 18).join('\\N');
  const captionLines = wrapText(captionText, 26).join('\\N');

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUT_W}
PlayResY: ${OUT_H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Hook,${FONT_FAMILY},96,&H00FFFFFF,&H00000000,&H99000000,1,3,4,0,5,80,80,0
Style: Caption,${FONT_FAMILY},58,&H00FFFFFF,&H00000000,&H99000000,1,3,3,0,2,60,60,140

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const hookEvent = `Dialogue: 1,${assTimestamp(0)},${assTimestamp(HOOK_DURATION_S)},Hook,,0,0,0,,${hookLines}\n`;
  const captionEvent = `Dialogue: 0,${assTimestamp(0)},${assTimestamp(durationS)},Caption,,0,0,0,,${captionLines}\n`;

  return header + hookEvent + captionEvent;
}

async function downloadToTemp(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_DOWNLOAD_BYTES });
  const inputPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}-in.mp4`);
  fs.writeFileSync(inputPath, Buffer.from(res.data));
  return inputPath;
}

function getDurationSeconds(inputPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', inputPath], { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) return resolve(15); // safe fallback if parsing fails
      const [, h, m, s] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
  });
}

// Normalizes to a 1080x1920 vertical canvas, applies a hard "zoom punch" on
// the opening ~1.2s (scaled 15% in, then snaps to normal framing), then
// burns in a large hook line during that window and a smaller running
// caption for the rest of the clip via libass.
async function burnCaptions(inputPath, { hookText, captionText }) {
  const durationS = await getDurationSeconds(inputPath);
  const outputPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}-out.mp4`);
  const assPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}.ass`);
  fs.writeFileSync(assPath, buildAssFile({ hookText, captionText, durationS }), 'utf8');

  const assPathEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fontsDirEscaped = FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');
  const zoomW = Math.round(OUT_W * 1.15);
  const zoomH = Math.round(OUT_H * 1.15);

  const filterComplex = [
    `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,split=2[base1][base2]`,
    `[base1]trim=0:${HOOK_DURATION_S},setpts=PTS-STARTPTS,scale=${zoomW}:${zoomH},crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})/2:(ih-${OUT_H})/2[zoomseg]`,
    `[base2]trim=${HOOK_DURATION_S},setpts=PTS-STARTPTS[restseg]`,
    `[zoomseg][restseg]concat=n=2:v=1:a=0[vcat]`,
    `[vcat]subtitles='${assPathEscaped}':fontsdir='${fontsDirEscaped}'[vout]`,
  ].join(';');

  const args = [
    '-y', '-i', inputPath,
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  await runFfmpeg(args);
  fs.unlink(assPath, () => {});
  return outputPath;
}

async function processVideoForPosting(videoUrl, { hookText, captionText }) {
  const inputPath = await downloadToTemp(videoUrl);
  try {
    const outputPath = await burnCaptions(inputPath, { hookText, captionText });
    const filename = path.basename(outputPath);
    log.info('video-processing', `Processed video ready: ${filename}`);
    return { localPath: outputPath, filename };
  } finally {
    fs.unlink(inputPath, () => {});
  }
}

function cleanupProcessedFile(localPath) {
  fs.unlink(localPath, (err) => {
    if (err) log.warn('video-processing', `Could not clean up ${localPath}: ${err.message}`);
  });
}

module.exports = { processVideoForPosting, cleanupProcessedFile, PROCESSED_DIR };
