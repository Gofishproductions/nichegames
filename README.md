# Nichegames v8.3 — Performance build

v8.3 changes the cloud architecture so expensive work is no longer one giant sequential GitHub Action.

## What is faster

- The website loads `catalog/index` first and **does not download every full game description/social record on normal page load**.
- Full game data is fetched only when Details is opened. If Firebase metadata proves the compact index is incomplete, the site can still repair/fall back.
- User **Scan for new games** remains separate from background maintenance.
- Roblox Explore sorts, recommendations, genre aliases, place-ID conversion, icons, votes, and social lookups use controlled concurrency instead of mostly one-at-a-time requests.
- The background catalog is split across **8 GitHub Actions shards**.
- Social enrichment is a separate 8-shard workflow, so Discord/social checks cannot block catalog resolving.
- CCU/visits refresh is a separate 8-shard workflow.
- Artwork/ratings are a separate 8-shard workflow.
- Discovery runs independently and feeds `knownIds` / `pendingPlaceIds` for the resolver workers.

This does not make Roblox itself unlimited: Roblox rate limiting and GitHub runner startup time still exist. The workers retry 429/5xx responses rather than hammering indefinitely.

## GitHub files to update

Your repo currently uses `Nichegames-v7-Cloud` as the project folder. Keep that folder name if your workflows already use it.

Copy these v8.3 files into that existing GitHub folder:

```text
Nichegames-v7-Cloud/scanner/cloud-scan.mjs
Nichegames-v7-Cloud/scanner/bulk-worker.mjs
Nichegames-v7-Cloud/scanner/discover-worker.mjs
Nichegames-v7-Cloud/scanner/mark-scan-stopped.mjs
Nichegames-v7-Cloud/package.json
```

At the **root of the GitHub repository**, replace/add:

```text
.github/workflows/scan.yml
.github/workflows/catalog.yml
.github/workflows/socials.yml
.github/workflows/refresh.yml
.github/workflows/assets.yml
```

Do not put `.github/workflows` inside `Nichegames-v7-Cloud`.

After committing, GitHub → Actions should show separate workflows for:

```text
Nichegames cloud scan
Nichegames parallel catalog
Nichegames parallel socials
Nichegames parallel CCU refresh
Nichegames parallel artwork and ratings
```

`Nichegames parallel catalog` first discovers IDs, then launches 8 resolver jobs at once, then recounts Firebase coverage.

## Run everything once now

After the files are committed, manually run these from GitHub → Actions once:

1. `Nichegames parallel catalog`
2. `Nichegames parallel socials`
3. `Nichegames parallel CCU refresh`
4. `Nichegames parallel artwork and ratings`

They are independent, so socials/assets/refresh do not need to wait for each other. Avoid manually starting the *same* workflow repeatedly; its concurrency rule replaces an older run with the newer one.

## Automatic schedules

- Catalog discovery + resolve: every 30 minutes
- CCU/visits refresh: every 30 minutes
- Social enrichment: hourly
- Artwork/ratings: every 4 hours

## Firebase job progress

Parallel workers write progress under paths such as:

```text
/nichegames/jobs/resolve/shards/0
/nichegames/jobs/resolve/shards/1
...
/nichegames/jobs/socials/shards/0
/nichegames/jobs/refresh/shards/0
/nichegames/jobs/assets/shards/0
/nichegames/jobs/discovery
```

So one slow shard does not hide the progress of the others.

## Deploy website

```bash
cd ~/Downloads/Nichegames-v8.3-Cloud
npx firebase-tools use nichegamesfinder
npm test
npm run deploy:site
```

Safari Console should show:

```text
Nichegames build: performance-v8.3
```

No Cloudflare redeploy is required for v8.3 because the Worker routes did not change.

## Existing features kept

- saved filters
- All games mode
- deep genre scan
- direct Roblox URL / place ID / universe ID lookup
- catalog coverage
- creator pages
- Discord/social filters and game social links
- scan cancellation and GitHub status detection
- pagination
- persistent Firebase catalog
