# Particle Studio

A browser particle toy **and** an embeddable component factory. Drop a `.glb`/`.gltf`
model (or pick a generated parametric shape) and it's sampled into ~6–9k particles
with cursor parallax and selectable hover animations. Any cloud can be dropped into
another page with a one-line `<script>` tag.

No build step for the front-end — it's plain HTML/CSS/ES-modules + three.js from a CDN.
An optional Vercel backend (Blob storage + serverless functions) powers model uploads
and shareable saved scenes.

## Features

- **Studio** (`index.html`) — drop a model, tune particle count / size / density /
  parallax / colours, pick a hover effect, export.
- **Factory** (`factory.html`) — pick a preset, tweak sliders, copy a ready-to-paste
  embed tag. Live preview runs in an isolated iframe.
- **Embed** (`embed.js`) — one classic `<script>` tag that injects the three.js import
  map, creates a container, and boots the engine.
- **Hover effects** — Supernova (`explode_on_hover`), Bulge (`dent_out_on_hover`),
  Dimple (`dent_at_cursor`), shape-shift morphing, plus an idle drift.

## Quick start (static only)

ES-module imports need a real HTTP server — `file://` will break them.

```bash
python3 -m http.server 8080
# studio:  http://localhost:8080/index.html
# factory: http://localhost:8080/factory.html
```

## With the backend (uploads + saved scenes)

The backend is **optional**. Without it, the studio still runs locally; only model
upload and shareable `?s=<id>` scene links need it.

```bash
npm install
npm i -g vercel       # one-time
vercel link           # link to your own Vercel project
# create a Blob store in the Vercel dashboard (injects BLOB_READ_WRITE_TOKEN)
vercel env pull       # writes .env.local  (gitignored — never commit it)
vercel dev            # static files + /api/scene + /api/upload
```

Deploy: `vercel deploy --prod` ships the static front-end and the `/api/*` functions
together.

## Embed usage

```html
<!-- a built-in preset -->
<script src="https://YOUR-DEPLOYMENT/embed.js?preset=explode_on_hover&accent=electric_blue&density=0.8"></script>

<!-- a saved scene (needs the backend) -->
<script src="https://YOUR-DEPLOYMENT/embed.js?s=AbC12345"></script>

<!-- render into a specific element instead of full-viewport -->
<script src="https://YOUR-DEPLOYMENT/embed.js?preset=idle&target=%23hero"></script>
```

Param aliases: `count`→`particleCount`, `parallax`→`parallaxStrength`,
`density`→`densBias`. One embed tag per page (MVP assumption).

## Layout

| Path | Purpose |
|------|---------|
| `index.html` | Studio UI |
| `factory.html` | Template / embed builder |
| `embed.js` | The one-line embed loader |
| `js/engine.js` | Config-driven rendering / sampling / animation core |
| `js/app.js` | Studio glue (controls, drag-drop, export, library) |
| `config.json` | Built-in presets |
| `api/scene.js` | Serverless: create / read saved scenes (Vercel Blob) |
| `api/upload.js` | Serverless: mint Blob client-upload tokens |

## Security & self-hosting notes

The backend uses an **unguessable-capability** model (no auth, no enumeration): scenes
are read by exact 8-char id only, there is no list route, and model files live at
random Blob paths. That protects *content* but the **write** endpoints
(`/api/scene` POST and `/api/upload`) are intentionally open so the public studio can
save without login.

This repo ships **best-effort hardening** on those routes:

- `model_url` on saved scenes is validated to your Vercel Blob host only.
- Scene `config` payloads are size-capped.
- A lightweight per-instance IP rate limiter throttles both write routes.

**If you deploy this publicly, treat the rate limiter as best-effort only** (serverless
instances don't share memory). For real abuse protection put a durable limiter
(e.g. Vercel KV + `@upstash/ratelimit`) or Vercel's WAF / auth in front of `/api/*`,
and watch your Blob storage usage. Secrets (`BLOB_READ_WRITE_TOKEN`) live in Vercel env
vars only — never in the repo; `.env.local` is gitignored.

## License

[MIT](LICENSE) © 2026 Aniket Budhwani
