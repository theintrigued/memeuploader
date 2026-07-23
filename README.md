# ClipVault Poster

A meme-video pipeline that researches trending/relatable topics, generates or assembles
short vertical videos, and posts them across YouTube Shorts, Instagram Reels, and TikTok —
manually or fully autonomously. Runs on Render's free tier, controlled from a phone browser.

This README reflects the system as of the v2.0.0 baseline — everything here is working and
tested. Treat this as the reference point for future development.

## Two ways a video gets made

**1. Insider Memes mode** — you type a prompt, Insider Memes' own AI picks a template from
their library and writes the on-screen caption. Costs one Insider Memes credit per video.

**2. Template match mode** — no free-text prompt. Consumes N saved prompts (oldest-unused
first), and for each one: our own indexed template library gets searched (free local
keyword narrowing, then one cheap Claude call to pick the best match), Claude writes a real
meme-format caption (POV:, "me when...", etc.), and our own ffmpeg pipeline burns that text
onto the raw template video. **Zero Insider Memes credits.** Falls back to Insider Memes
generation automatically if no good template match is found.

Both modes post through the same pipeline afterward: YouTube + Instagram via ShortSync
(one API, one upload, both platforms), TikTok via its own direct Content Posting API
(lands as an inbox draft until your TikTok app passes audit for direct publish).

## Autopilot

A fully autonomous mode, toggled live from the frontend (stored in Upstash, not an env
var — flips instantly, no redeploy). When on:
- Posts a configurable number/day (default 20), spread randomly across 2-hour windows
- Draws from the same unused-saved-prompts pool the manual buttons use — **only runs a
  real web search when that pool is completely empty**, to minimize search/token spend
- Defaults to template-match mode using your saved font/size/position settings
- Reviews each day's performance (via ShortSync analytics) and writes itself a short note
  that biases tomorrow's research and topic choices

Needs an external pinger hitting `/cron/tick` every ~5 minutes (Render's free tier has no
cron and sleeps when idle) — see Setup below.

## Setup

### Required for any posting at all
| Env var | What it's for |
|---|---|
| `APP_SECRET` | Protects every endpoint — pick a long random string |
| `INSIDERMEMES_API_TOKEN` | Insider Memes API — needed even in template-match mode, since it still browses `/v1/templates/` (free) |
| `POST_TO` | Comma-separated: `youtube,instagram,tiktok` |

### Posting platforms
| Env var | What it's for |
|---|---|
| `SHORTSYNC_API_KEY` | Powers YouTube + Instagram — connect both at shortsync.app/settings?section=connections first |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` / `TIKTOK_REFRESH_TOKEN` | Direct TikTok posting — get the refresh token via `/tiktok/login?secret=YOUR_APP_SECRET` |

### Powers search, template matching, captions, autopilot
| Env var | What it's for |
|---|---|
| `ANTHROPIC_API_KEY` | Trending/relatable research, template picking, meme caption writing, end-of-day analysis |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Free Upstash Redis — saved prompts, autopilot state, template index. **Nothing persists across a restart without this.** |

### Autopilot tuning (all optional, sane defaults)
`AUTOPILOT_POSTS_PER_DAY` (20), `AUTOPILOT_WINDOW_HOURS` (2), `AUTOPILOT_TZ_OFFSET_HOURS` (0 — set to your UTC offset), `AUTOPILOT_PLATFORMS` (defaults to `POST_TO`)

Full template with comments: see `.env.example`.

### One-time setup steps
1. Deploy to Render (free tier), set the env vars above
2. Set up a free cron-job.org job hitting `https://your-app.onrender.com/cron/tick?secret=YOUR_APP_SECRET` every 5 minutes — this also keeps the free instance awake
3. Open the app, check `/health` to confirm every subsystem is green
4. Template indexing runs automatically in the background on every tick (regardless of autopilot on/off) — check progress at `/admin/template-index-status`. ~2,000 templates takes roughly a day of ticks to fully index.
5. In the 🎯 Our templates tab, dial in font/size/position/video-crop with the **real preview**
   button (actually renders on a real template via ffmpeg — not a CSS approximation), then
   save. Autopilot uses these same saved settings.

## Endpoint reference

| Endpoint | Purpose |
|---|---|
| `POST /create` | Insider Memes mode — single prompt |
| `POST /create-from-saved` | Template match mode — batch of N saved prompts |
| `POST /auto-pick` | Grabs the single oldest unused prompt, posts via Insider Memes mode |
| `GET /status/:jobId` | Poll job progress |
| `GET /trending?mode=viral\|relatable` | Runs research, saves results to the prompt pool |
| `GET /prompts`, `GET /prompts/unused-count` | Browse/count the saved prompt pool |
| `GET/POST /autopilot/status`, `/autopilot/toggle` | Autopilot control |
| `GET/POST /settings/template-match` | Font/size/position/video-crop defaults |
| `POST /preview-render` | Real ffmpeg render on a random real template — accurate preview |
| `GET /admin/template-index-status` | Indexing progress |
| `GET /fonts` | Available bundled fonts |
| `GET /health` | Full subsystem status — check this first when debugging |

## Architecture

- `server.js` — routes only; business logic lives in `routes/`
- `routes/generate-and-post.js` — the shared job runner both `/create` variants and autopilot use
- `routes/memes.js` — Insider Memes API client (retries, polling)
- `routes/template-store.js` / `template-indexer.js` / `template-picker.js` — our own template
  library: discovery, per-template Claude vision description, keyword-narrowed matching
- `routes/video-processing.js` — ffmpeg: crop-to-cover video sizing, libass text burn-in
  (real font metrics for wrapping, not a guessed heuristic)
- `routes/trending.js` / `caption-writer.js` — Claude-powered research and meme captioning
- `routes/autopilot.js` / `autopilot-store.js` — the scheduler and its persisted state
- `routes/prompt-store.js` — the shared unused/used prompt pool (FIFO)
- `routes/platforms/shortsync.js` / `tiktok.js` — the two posting integrations
- `routes/upstash-client.js` — tiny shared Redis REST helper, everything else builds on it
- `routes/job-store.js` — in-memory job tracking (2hr TTL, swept automatically)
- `routes/logger.js` — structured, leveled logging used everywhere (no stray `console.log`)

## Known things to keep in mind

- **TikTok won't auto-publish** until the app passes TikTok's audit — posts land as inbox
  drafts, one tap to finish. This isn't fixable from our side.
- **Job state is in-memory** — a Render restart mid-job loses progress tracking (the job
  itself may have completed server-side, just not visible in `/status` anymore).
- **Template indexing takes real wall-clock time** (~a day) since it's deliberately spread
  across ticks rather than done in one blocking burst, to keep each tick fast and cheap.
- **`generateBranchedTaglines`** in `trending.js` is a working, tested, currently-unused
  utility (superseded by drawing from the saved-prompt pool) — kept because it's a
  legitimate alternative strategy worth having available, not dead weight to be confused by.

## Diagnosing problems
- `/health` first — reports on posting, persistence, and AI-feature subsystems separately
- Render → Logs — every line is timestamped and leveled (`INFO`/`WARN`/`ERROR`)
- `/admin/template-index-status` and `/autopilot/status` for those specific subsystems
