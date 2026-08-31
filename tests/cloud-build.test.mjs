import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [front, rules, firebase, scanWorkflow, catalogWorkflow, socialsWorkflow, refreshWorkflow, assetsWorkflow, scanner, bulk, discover, html, worker] = await Promise.all([
  readFile(new URL('../public/nichegames-v8-3.js', import.meta.url),'utf8'),
  readFile(new URL('../database.rules.json', import.meta.url),'utf8'),
  readFile(new URL('../firebase.json', import.meta.url),'utf8'),
  readFile(new URL('../.github/workflows/scan.yml', import.meta.url),'utf8'),
  readFile(new URL('../.github/workflows/catalog.yml', import.meta.url),'utf8'),
  readFile(new URL('../.github/workflows/socials.yml', import.meta.url),'utf8'),
  readFile(new URL('../.github/workflows/refresh.yml', import.meta.url),'utf8'),
  readFile(new URL('../.github/workflows/assets.yml', import.meta.url),'utf8'),
  readFile(new URL('../scanner/cloud-scan.mjs', import.meta.url),'utf8'),
  readFile(new URL('../scanner/bulk-worker.mjs', import.meta.url),'utf8'),
  readFile(new URL('../scanner/discover-worker.mjs', import.meta.url),'utf8'),
  readFile(new URL('../public/index.html', import.meta.url),'utf8'),
  readFile(new URL('../cloudflare/src/index.js', import.meta.url),'utf8'),
]);

assert.ok(!front.includes('/api/games'));
assert.ok(front.includes('localStorage.setItem(FILTER_STORAGE'));
assert.ok(front.includes("dbGet('catalog/index')"));
assert.ok(front.includes('expected > payload.games.length'), 'full catalog should only be fetched when index is known incomplete');
assert.ok(front.includes('Full records are fetched one-at-a-time'), 'homepage should not eagerly download full catalog');
assert.ok(front.includes('cancelScan'));
assert.ok(front.includes("`${WORKER_BASE}/cancel`"));
assert.ok(front.includes("`${WORKER_BASE}/lookup`"));
assert.ok(front.includes("els.pagination.addEventListener('click'"));

assert.ok(scanner.includes('async function mapPool'));
assert.ok(scanner.includes('mapPool(queue, 8'));
assert.ok(scanner.includes('mapPool(socialTargets, 8'));
assert.ok(scanner.includes('getGameSocials'));
assert.ok(scanner.includes('genreCoverage'));
assert.ok(scanner.includes('process.exit(exitCode)'));

assert.ok(scanWorkflow.includes('SCAN_MODE: user'));
assert.ok(catalogWorkflow.includes('matrix:'));
assert.ok(catalogWorkflow.includes('shard: [0,1,2,3,4,5,6,7]'));
assert.ok(catalogWorkflow.includes('discover-worker.mjs'));
assert.ok(catalogWorkflow.includes('BULK_MODE: resolve'));
assert.ok(catalogWorkflow.includes('BULK_MODE: recount'));
assert.ok(socialsWorkflow.includes('BULK_MODE: socials'));
assert.ok(refreshWorkflow.includes('BULK_MODE: refresh'));
assert.ok(assetsWorkflow.includes('BULK_MODE: assets'));
assert.ok(bulk.includes("mode==='resolve'"));
assert.ok(bulk.includes("mode==='socials'"));
assert.ok(bulk.includes("mode==='refresh'"));
assert.ok(bulk.includes("mode==='assets'"));
assert.ok(discover.includes('Parallel search across'));
assert.ok(discover.includes('pendingPlaceIds'));

assert.ok(worker.includes("url.pathname === '/cancel'"));
assert.ok(worker.includes("url.pathname === '/status'"));
assert.ok(worker.includes("url.pathname === '/lookup'"));
assert.ok(html.includes('/nichegames-v8-3.js'));
assert.ok(html.includes('/nichegames-v8-3.css'));
assert.ok(html.includes('Scan for new games'));
assert.ok(front.includes('loadCoverage'));
assert.ok(front.includes('renderCreatorPage'));
assert.ok(front.includes('startLookup'));
assert.ok(front.includes('hasDiscord'));
assert.ok(front.includes('hasSocials'));
assert.ok(front.includes('modalSocialsHtml'));
assert.ok(front.includes('genreOnlyMode'));
assert.ok(front.includes('gameMatchesGenreClient'));

assert.equal(JSON.parse(rules).rules.nichegames['.write'], false);
assert.ok(!JSON.stringify(JSON.parse(firebase)).includes('functions'));
console.log('Cloud build tests passed: v8.3 parallelizes catalog resolving, socials, CCU refresh, assets, and discovery while keeping homepage reads compact.');
