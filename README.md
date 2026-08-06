# Pageview Analytics

Lightweight analytics dashboard for personal blogs. Tracks pageviews, visitor geography, browser/device stats, and bot detection — all on Cloudflare Free plan.

## Stack

- **Hono** — Worker routing
- **D1** — SQLite database
- **Chart.js** — Frontend charts
- **request.cf** — Geo/bot data (no third-party IP DB needed)

## Deploy

```bash
# 1. Create D1 database in CF Dashboard, copy ID
# 2. Update database_id in wrangler.jsonc + set ADMIN_PASSWORD

npm install
npx wrangler d1 migrations apply analytics-db --remote
npx wrangler deploy
```

## Add to your site

```html
<script src="https://your-worker.workers.dev/track.js" data-host="https://your-worker.workers.dev" defer></script>
```

## Dashboard

```
https://your-worker.workers.dev/admin?pw=your-password
```
