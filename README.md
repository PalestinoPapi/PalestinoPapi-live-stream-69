# Your livestream platform

A small, self-hosted livestreaming site: you go live from OBS, your audience
watches and chats from a shared link. Cloudflare Stream does the actual video
work (ingest, transcoding, delivery) — this app is the control panel, the
watch page, and the chat.

There is no content moderation layer built into this app. That's the point —
but see "Know what you're actually exposed to" at the bottom before you go
live publicly.

## 1. One-time Cloudflare setup (~10 minutes)

1. Create a free account at https://dash.cloudflare.com/sign-up if you don't
   have one.
2. Go to **Stream** in the left sidebar and enable it (pay-as-you-go pricing,
   roughly $5/1000 minutes stored + $1/1000 minutes delivered — at under 100
   viewers this will cost you a few dollars a month, not more).
3. Get your **Account ID**: it's in the right sidebar of almost any dashboard
   page, or under Stream → the URL contains it.
4. Create an **API token**: go to
   https://dash.cloudflare.com/profile/api-tokens → "Create Token" → use the
   "Edit Cloudflare Stream" template (or a custom token with Account →
   Stream → Edit permission). Copy the token — you won't see it again.

## 2. Configure the app

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `CF_ACCOUNT_ID` — from step 3 above
- `CF_API_TOKEN` — from step 4 above
- `DASHBOARD_PASSWORD` — make this up. This is what protects *your* control
  panel (where the RTMP key lives), not your Cloudflare login.
- `PUBLIC_BASE_URL` — once deployed, the real URL people will use (e.g.
  `https://stream.yoursite.com`). Leave as localhost while testing locally.

## 3. Run it

```bash
npm install
npm start
```

Visit `http://localhost:3000`, enter your dashboard password, click
"Generate stream". You'll get:
- An RTMP server URL + stream key → paste these into **OBS → Settings →
  Stream → set Service to "Custom", paste Server and Stream Key**
- A watch link → this is what you share with your audience

Click "Start Streaming" in OBS. Within a few seconds the watch page will
pick up the live video automatically (viewers don't need to refresh).

## 4. Deploy it somewhere real

This needs to run on a public server so your audience can reach it — it
can't stay on your laptop. Cheapest reasonable options:
- A $5–6/month VPS (DigitalOcean, Hetzner, Linode) — run `npm start` behind
  a process manager like `pm2`, put Caddy or nginx in front for free HTTPS
- Render.com / Railway / Fly.io — deploy directly from this folder, they
  handle HTTPS and process management for you, free/cheap tier is plenty
  for under 100 viewers

Whichever you pick, set the same `.env` values as environment variables in
that platform's dashboard, and set `PUBLIC_BASE_URL` to your real domain.

## How it works

- `server.js` — Express backend. Creates/reads Cloudflare "Live Inputs" via
  their REST API, serves the two frontend pages, runs a WebSocket chat
  server (one room per stream, in-memory, no persistence).
- `public/index.html` — your private dashboard (password-gated). Shows RTMP
  credentials and live/offline status.
- `public/watch.html` — the public page your audience opens. Plays the HLS
  stream via hls.js and shows live chat.
- `stream-config.json` — auto-created on first "Generate stream", stores
  your current live input ID so it survives server restarts. Don't share
  this file; it doesn't contain secrets you can rotate away, but keep it
  private anyway.

## Notes and rough edges

- **Chat has zero moderation** by design — no word filters, no rate limits
  beyond a message-length cap. If that's not what you want later, the chat
  logic is isolated in `server.js`'s WebSocket section and is easy to extend.
- **No accounts/auth for viewers** — anyone with the link can watch and
  chat under any display name they type. Fine for a small audience; if you
  want to restrict who can join, that's a bigger addition (e.g. a shared
  viewer password, or per-viewer invite links).
- **Single stream at a time** — this is built for one person going live, not
  a multi-streamer platform. Multi-tenant support is a bigger rework
  (per-user accounts, per-user Cloudflare Live Inputs, etc.) — say the word
  if you want that instead.
- **Latency**: standard HLS is usually 6–15 seconds behind real-time, fine
  for most audiences. If you want sub-second interaction, Cloudflare Stream
  also supports WebRTC (WHIP/WHEP) — happy to swap the ingest/playback path
  over to that if low latency matters to you.

## Know what you're actually exposed to

Going self-hosted removes platform-specific moderation (no Twitch/YouTube
ToS to trip over), but it doesn't remove every rule:
- **Cloudflare's own Acceptable Use Policy** still applies to what you push
  through their Stream product.
- **Your hosting provider's ToS** applies to the server itself.
- **Actual law** applies regardless of where you host — this doesn't change
  based on infrastructure.
- If you ever add payments (tips, subscriptions), your payment processor
  will have its own content rules, often stricter than the platforms you're
  trying to get away from.

None of this should stop you from running your own thing — plenty of people
do, for good reasons (creative control, no algorithmic burial, owning your
audience relationship). Just worth knowing where the actual boundaries are
before you're relying on there being none.
