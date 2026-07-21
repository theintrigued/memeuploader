# ClipVault Poster — full setup guide (phone-friendly)

## Part 1 — Get the code onto GitHub
1. On your phone, go to github.com and create a free account if you don't have one.
2. Install the **GitHub** mobile app (optional but easier for uploading files) or just use Safari/Chrome.
3. Create a new repository, e.g. `clipvault-poster`. Keep it **Private**.
4. Upload every file from this project into the repo root (use "Add file → Upload files" in the GitHub web UI — you can multi-select from your phone's downloads).

## Part 2 — Deploy to Render
1. Go to render.com, sign up free with your GitHub account (no card needed).
2. Dashboard → **New → Web Service**.
3. Connect your `clipvault-poster` repo.
4. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
5. Under **Environment**, add every variable from `.env.example` (you'll fill in real values as you complete Parts 3-5 below). Set `APP_SECRET` to any long random string now — you'll type this into the phone form later.
6. Click **Create Web Service**. Render gives you a live URL like `https://clipvault-poster.onrender.com`.
7. Visit that URL — you should see the ClipVault input form.

## Part 3 — Insider Memes credentials
1. Log in at insidermemes.com on a paid plan with video access.
2. Go to `dashboard/profile?tab=api` → Reveal API Key.
3. Paste it into Render's `INSIDERMEMES_API_TOKEN` env var.
4. **Known gap**: the public API docs don't list a job-status endpoint for polling async video jobs. Email chief@insidermemes.com and ask for the correct polling endpoint (or a webhook option), then update the `POLL_PATH` in `routes/memes.js` to match. Until this is confirmed, video generation may fail after the initial request.

## Part 4 — YouTube Shorts
1. Go to console.cloud.google.com → create a new project.
2. Enable the **YouTube Data API v3** (APIs & Services → Library).
3. APIs & Services → OAuth consent screen → set up as "External," add your own Google account as a test user.
4. Credentials → Create Credentials → OAuth client ID → type "Web application" → add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
5. Go to developers.google.com/oauthplayground → gear icon (top right) → check "Use your own OAuth credentials" → paste your client ID/secret.
6. In the left panel, find **YouTube Data API v3**, select the `youtube.upload` scope → Authorize → sign in with the YouTube channel's Google account.
7. Click "Exchange authorization code for tokens" → copy the **refresh token**.
8. Put client ID, client secret, and refresh token into Render's env vars.

## Part 5 — Instagram Reels
1. You need an Instagram **Business or Creator** account linked to a Facebook Page.
2. Go to developers.facebook.com → create an App (type: Business).
3. Add the **Instagram Graph API** product.
4. Under App Roles, add yourself as Admin (this lets you use the API on your own account without full App Review).
5. Use Graph API Explorer (developers.facebook.com/tools/explorer) to generate a User Access Token with `instagram_basic`, `instagram_content_publish`, and `pages_show_list` permissions, selecting your app.
6. Exchange it for a long-lived token (Graph API Explorer has a button for this, or call `/oauth/access_token?grant_type=fb_exchange_token`).
7. Find your Instagram Business Account ID: call `GET /me/accounts` then `GET /{page-id}?fields=instagram_business_account`.
8. Put the long-lived token and IG business account ID into Render's env vars.

## Part 6 — TikTok
1. Go to developers.tiktok.com → register a developer account and create an app.
2. Add the **Content Posting API** product.
3. Complete the login flow (TikTok's OAuth) to get an access token for your own account — TikTok's docs walk through this with your app's client key/secret.
4. Put the access token into Render's env var.
5. Note: until TikTok audits your app, uploads land in your TikTok inbox as a draft, not a live public post — you'll tap "Post" manually in the TikTok app. Apply for audit from your TikTok developer dashboard once you're ready for full automation.

## Part 7 — Test it
1. Open your Render URL on your phone.
2. Type your `APP_SECRET` and a prompt like "streamer rage quits after losing to a bot."
3. Tap **Generate & Post**. Watch the response — it'll show the video URL and the result (success or error) for each platform.
4. Add the Render URL to your phone's home screen (Share → Add to Home Screen) so it feels like a native app.

## Costs to expect once this is real
- Render: free tier works, ~$7/mo removes the cold-start delay
- Insider Memes: needs a paid plan for video generation (Basic $/mo+)
- YouTube/Instagram/TikTok APIs: free, but TikTok direct-publish requires audit approval

## Autopilot (fully autonomous posting)
1. Create a free database at upstash.com → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into Render (required — this is where the daily schedule and learnings live).
2. Set `AUTOPILOT_TZ_OFFSET_HOURS` to your timezone's UTC offset (e.g. `4` for Gulf Standard Time) so the daily schedule lines up with your actual day.
3. `AUTOPILOT_POSTS_PER_DAY` (default 20) and `AUTOPILOT_WINDOW_HOURS` (default 2) control the schedule shape — posts are split as evenly as possible across the day's windows, randomly timed within each.
4. **Set up an external pinger** — Render's free tier has no cron and sleeps when idle, so something needs to hit the server periodically. Go to cron-job.org (free) → create a job hitting `https://your-render-url.onrender.com/cron/tick?secret=YOUR_APP_SECRET` every 5 minutes.
5. Open the app → flip the **🤖 Autopilot** switch on. That's the only place enable/disable actually lives — it's stored, not an env var, so it takes effect instantly with no redeploy.

What it does each day: runs one web search per mode (viral + relatable) the first time it wakes up that day, generates a day's worth of distinct taglines "branching" from that single search (no repeated searching = fewer tokens), spreads them randomly across the day per the schedule, and posts each one when its time arrives. At the end of each day it reviews what performed well (via ShortSync analytics) and writes itself a short note that biases tomorrow's search and topic choices.

The switch never removes the manual flow above — Trending topics / Relatable moments / Saved prompts / Generate & Post all keep working exactly as before regardless of whether autopilot is on, so you can always fall back to doing it by hand.

## Diagnosing problems
- Visit `https://your-render-url.onrender.com/health` any time — it reports which env vars are
  missing for your configured `POST_TO` platforms, without ever exposing the actual secret values.
- Render → your service → **Logs** tab shows a timestamped, leveled log line (`INFO`/`WARN`/`ERROR`)
  for every step: generation start, each platform attempt, and any failure with the real error message.
- Every job is tracked in memory for 2 hours after creation — `/status/:jobId` returns 404 past that
  window, or immediately after a server restart (Render redeploys kill in-flight jobs; the frontend
  will show this as an error rather than hanging silently).
