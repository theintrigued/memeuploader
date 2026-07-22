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

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');

// Maps a frontend-facing font name to its bundled file + the family name
// libass needs to actually select it (must match the font's internal name).
const FONTS = {
  anton: { file: 'Anton-Regular.ttf', family: 'Anton', label: 'Anton (Impact-style)' },
  bangers: { file: 'Bangers-Regular.ttf', family: 'Bangers', label: 'Bangers (comic)' },
  bebasneue: { file: 'BebasNeue-Regular.ttf', family: 'Bebas Neue', label: 'Bebas Neue (tall/clean)' },
  oswald: { file: 'Oswald-Bold.ttf', family: 'Oswald', label: 'Oswald (condensed bold)' },
};
const DEFAULT_FONT = 'anton';

const OUT_W = 1080;
const OUT_H = 1920;
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
    .replace(/[{}\\]/g, '') // special meaning inside ASS text
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
  return lines.join('\\N');
}

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

// Builds a minimal .ass file with ONE static text block, positioned with an
// explicit {\pos(x,y)} override so it lands at an exact pixel spot regardless
// of style alignment/margins. No animation, no timing splits.
function buildAssFile({ text, fontFamily, fontSize, xPct, yPct, durationS }) {
  const x = Math.round((xPct / 100) * OUT_W);
  const y = Math.round((yPct / 100) * OUT_H);
  const lines = wrapText(text, 22);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUT_W}
PlayResY: ${OUT_H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Caption,${fontFamily},${fontSize},&H00FFFFFF,&H00000000,&H99000000,1,3,4,0,8,20,20,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const event = `Dialogue: 0,0:00:00.00,${formatAssTime(durationS)},Caption,,0,0,0,,{\\pos(${x},${y})}${lines}\n`;
  return header + event;
}

async function downloadToTemp(url) {
  const inputPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}-in.mp4`);
  const res = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(inputPath);
    let bytesWritten = 0;
    res.data.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_DOWNLOAD_BYTES) {
        writer.destroy();
        res.data.destroy();
        reject(new Error(`Source video exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB safety cap`));
      }
    });
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
  return inputPath;
}

function getDurationSeconds(inputPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', inputPath], { maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!match) return resolve(15);
      const [, h, m, s] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
  });
}

// Extracts a single representative frame — used by the template indexer for
// vision-based description, and safe to call on any local video file.
async function extractFrame(inputPath, atSeconds = 0.5) {
  const outPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}-frame.jpg`);
  await runFfmpeg(['-y', '-ss', String(atSeconds), '-i', inputPath, '-frames:v', '1', '-q:v', '3', outPath]);
  return outPath;
}

// Takes an already-downloaded LOCAL video file and burns ONE static text
// block onto it — no zoom, no animation, no hook/caption split. Normalizes
// to a 1080x1920 vertical canvas first. Returns the output file path.
// options: { text, font, fontSize, x (0-100 %), y (0-100 %) }
async function burnTextOverlay(inputPath, { text, font = DEFAULT_FONT, fontSize = 64, x = 50, y = 8 } = {}) {
  const fontDef = FONTS[font] || FONTS[DEFAULT_FONT];
  const durationS = await getDurationSeconds(inputPath);
  const outputPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}-out.mp4`);
  const assPath = path.join(PROCESSED_DIR, `${crypto.randomUUID()}.ass`);
  fs.writeFileSync(assPath, buildAssFile({ text, fontFamily: fontDef.family, fontSize, xPct: x, yPct: y, durationS }), 'utf8');

  const assPathEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const fontsDirEscaped = FONTS_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');

  const vf = [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease`,
    `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `subtitles='${assPathEscaped}':fontsdir='${fontsDirEscaped}'`,
  ].join(',');

  const args = [
    '-y', '-i', inputPath,
    '-vf', vf,
    '-threads', '1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  await runFfmpeg(args);
  fs.unlink(assPath, () => {});
  log.info('video-processing', `Text overlay render ready: ${path.basename(outputPath)}`);
  return outputPath;
}

function cleanupFile(localPath) {
  fs.unlink(localPath, (err) => {
    if (err) log.warn('video-processing', `Could not clean up ${localPath}: ${err.message}`);
  });
}

module.exports = { burnTextOverlay, extractFrame, downloadToTemp, cleanupFile, PROCESSED_DIR, FONTS };
