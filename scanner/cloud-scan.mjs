import { randomUUID } from 'node:crypto';
import admin from 'firebase-admin';

const PROJECT_ID = 'nichegamesfinder';
const DATABASE_URL = 'https://nichegamesfinder-default-rtdb.firebaseio.com';
const REQUEST_GAP_MS = 0;
const MAX_RETRIES = 4;
const DETAIL_BATCH = 50;
const USER_SEARCH_PAGES = 1;
const GENRE_PRIMARY_SEARCH_PAGES = 30;
const GENRE_ALIAS_SEARCH_PAGES = 6;
const GENRE_RECOMMENDATION_SEEDS = 120;
const GENRE_EXISTING_RECHECK_LIMIT = 2000;
const CATALOG_SEARCH_PAGES = 6;
const USER_QUERY_BATCH = 2;
const USER_RECOMMENDATION_SEEDS = 8;
const CATALOG_RECOMMENDATION_SEEDS = 300;
const EXISTING_REFRESH_AGE_MS = 6 * 60 * 60 * 1000;
const CATALOG_EXISTING_REFRESH_LIMIT = 1000;
const CATALOG_RESOLVE_LIMIT = 100_000;
const PLACE_REPAIR_LIMIT = 5_000;
const RATING_FRESH_MS = 24 * 60 * 60 * 1000;
const MISSING_FRESH_MS = 12 * 60 * 60 * 1000;
const SOCIALS_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_SOCIAL_ENRICH_LIMIT = 500;
const DISCOVERY_CONTEXTS = [
  { device: 'computer', country: 'all' },
  { device: 'phone', country: 'all' },
  { device: 'tablet', country: 'all' },
];
const BASE_SEARCH_QUERIES = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  'obby','simulator','tycoon','horror','survival','rpg','roleplay','fighting','shooter','adventure','sports','racing','anime','tower','defense','sandbox','social','hangout','strategy','puzzle','story','escape','battle','city','school','life','meme','rng','clicker','incremental','building','zombie','parkour','driving','football','basketball','soccer','chill','open world','pvp','pve',
];

let lastRobloxRequestAt = 0;
let lastProgressAt = 0;
let heartbeatTimer = null;
let discoveredPlaceIds = new Set();
const groupSocialCache = new Map();
const gameSocialCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`[Nichegames cloud] ${message}\n`);

function cleanServiceAccount(raw) {
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON GitHub secret.');
  const parsed = JSON.parse(raw);
  if (!parsed.project_id || !parsed.private_key || !parsed.client_email) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not a complete service-account JSON object.');
  return parsed;
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(cleanServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), databaseURL: DATABASE_URL, projectId: PROJECT_ID });
}
const db = admin.database();
const root = db.ref('nichegames');

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function normalizeFilters(input = {}) {
  const units = ['hours','days','weeks','months','years','all'];
  const unit = units.includes(String(input.createdWithinUnit)) ? String(input.createdWithinUnit) : 'days';
  return {
    allGames: Boolean(input.allGames),
    genreOnly: Boolean(input.genreOnly) && String(input.genre || 'all') !== 'all',
    lookupInput: String(input.lookupInput || '').trim().slice(0, 500),
    q: String(input.q || '').trim().slice(0, 100),
    minCcu: clampNumber(input.minCcu, 800, 0, 10_000_000),
    maxCcu: clampNumber(input.maxCcu, 3000, 0, 10_000_000),
    createdWithinValue: unit === 'all' ? 1 : clampNumber(input.createdWithinValue, 30, 1, 10_000_000),
    createdWithinUnit: unit,
    minVisits: clampNumber(input.minVisits, 0, 0, 100_000_000_000),
    creatorType: ['all','User','Group'].includes(String(input.creatorType)) ? String(input.creatorType) : 'all',
    genre: String(input.genre || 'all').slice(0, 100),
    verifiedOnly: Boolean(input.verifiedOnly),
    hasSocials: Boolean(input.hasSocials),
    hasDiscord: Boolean(input.hasDiscord),
  };
}


const GENRE_SEARCH_TERMS = {
  'horror': ['horror','scary','survival horror','psychological horror','horror story'],
  'action': ['action','fighting','battlegrounds','combat'],
  'adventure': ['adventure','exploration','story adventure'],
  'education': ['education','learning'],
  'entertainment': ['entertainment','showcase','music','video'],
  'obby platformer': ['obby','platformer','tower obby','runner'],
  'party casual': ['party','casual','minigame','quiz'],
  'puzzle': ['puzzle','escape room','word game'],
  'rpg': ['rpg','action rpg','roleplaying game'],
  'roleplay avatar sim': ['roleplay','avatar sim','life roleplay','dress up'],
  'shooter': ['shooter','fps','deathmatch','pve shooter'],
  'shopping': ['shopping','avatar shopping'],
  'simulation': ['simulation','simulator','tycoon','sandbox','vehicle simulator'],
  'social': ['social','hangout'],
  'sports racing': ['sports','racing','football','basketball','soccer'],
  'strategy': ['strategy','tower defense','board game'],
  'survival': ['survival','escape','1 vs all'],
  'utility other': ['utility']
};
function normalizeGenreKey(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function genreTerms(genre) {
  const key = normalizeGenreKey(genre);
  return [...new Set([genre, ...(GENRE_SEARCH_TERMS[key] || [genre])].map((v) => String(v).trim()).filter(Boolean))];
}
function deriveGenreTags(game = {}) {
  const tags = new Set();
  for (const value of [game.genre_l1, game.genre_l2, game.genre, game.genre, game.subgenre]) {
    const key = normalizeGenreKey(value);
    if (key) tags.add(key);
  }
  const haystack = normalizeGenreKey(`${game.name || ''} ${game.description || ''} ${game.genre_l1 || ''} ${game.genre_l2 || ''} ${game.genre || ''}`);
  for (const [key, terms] of Object.entries(GENRE_SEARCH_TERMS)) {
    if (terms.some((term) => haystack.includes(normalizeGenreKey(term)))) tags.add(key);
  }
  return [...tags];
}
function gameMatchesGenre(game = {}, genre = 'all') {
  const wanted = normalizeGenreKey(genre);
  if (!wanted || wanted === 'all') return true;
  const structured = [game.genre, game.subgenre, ...(Array.isArray(game.genreTags) ? game.genreTags : [])]
    .map(normalizeGenreKey).filter(Boolean);
  if (structured.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value))) return true;
  const haystack = normalizeGenreKey(`${game.name || ''} ${game.description || ''} ${game.genre || ''} ${game.subgenre || ''}`);
  return genreTerms(genre).some((term) => haystack.includes(normalizeGenreKey(term)));
}
function createdWindowMs(filters) {
  if (filters.createdWithinUnit === 'all') return Number.POSITIVE_INFINITY;
  const units = { hours:3_600_000, days:86_400_000, weeks:604_800_000, months:2_629_746_000, years:31_556_952_000 };
  return Number(filters.createdWithinValue) * (units[filters.createdWithinUnit] || units.days);
}
function createdMatches(game, filters, now = Date.now()) {
  const createdAt = new Date(game?.created || 0).getTime();
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  const age = now - createdAt;
  return age >= 0 && (filters.createdWithinUnit === 'all' || age <= createdWindowMs(filters));
}
function gameMatches(game, filters, now = Date.now()) {
  if (filters.allGames) return true;
  if (filters.genreOnly && filters.genre !== 'all') return gameMatchesGenre(game, filters.genre);
  if (!createdMatches(game, filters, now)) return false;
  const playing = Number(game.playing || 0);
  if (playing < filters.minCcu || playing > filters.maxCcu) return false;
  if (Number(game.visits || 0) < filters.minVisits) return false;
  if (filters.creatorType !== 'all' && String(game.creator?.type || '') !== filters.creatorType) return false;
  if (filters.genre !== 'all' && !gameMatchesGenre(game, filters.genre)) return false;
  if (filters.verifiedOnly && !game.creator?.verified) return false;
  if (filters.hasSocials && !game.hasSocials) return false;
  if (filters.hasDiscord && !game.hasDiscord) return false;
  if (filters.q) {
    const haystack = `${game.name || ''} ${game.creator?.name || ''} ${game.description || ''}`.toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) return false;
  }
  return true;
}
function chunks(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
async function mapPool(items, concurrency, worker) {
  const source = [...items];
  const results = new Array(source.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, source.length || 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= source.length) return;
      results[index] = await worker(source[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
async function robloxFetch(url) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const response = await fetch(url, { headers: { Accept:'application/json', 'User-Agent':'Nichegames/8.3' }, signal:controller.signal });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 850 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(650 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Roblox request failed: ${url}`);
}


async function optionalRobloxFetch(url) {
  const cached = gameSocialCache.get(url);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  try {
    if (REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, { headers:{ Accept:'application/json', 'User-Agent':'Nichegames/8.3' }, signal:controller.signal });
    clearTimeout(timer);
    if ([401, 403, 404].includes(response.status)) {
      gameSocialCache.set(url, { at:Date.now(), value:null });
      return null;
    }
    if (!response.ok) return null;
    const value = await response.json();
    gameSocialCache.set(url, { at:Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

function socialTypeFromUrl(rawUrl = '', fallback = '') {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch {}
  if (host === 'discord.gg' || host.endsWith('.discord.gg') || host === 'discord.com' || host.endsWith('.discord.com')) return 'Discord';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'YouTube';
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'X';
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'Twitch';
  if (host === 'guilded.gg' || host.endsWith('.guilded.gg')) return 'Guilded';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok';
  if (host === 'facebook.com' || host.endsWith('.facebook.com')) return 'Facebook';
  const clean = String(fallback || '').trim();
  return clean || 'Website';
}

function normalizeSocialUrl(raw = '') {
  let value = String(raw || '').trim().replace(/[),.;!?]+$/g, '');
  if (!value) return '';
  if (!/^https?:\/\//i.test(value) && /^(discord\.gg|discord\.com\/invite|youtube\.com|youtu\.be|x\.com|twitter\.com|twitch\.tv|guilded\.gg|tiktok\.com)\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch { return ''; }
}

function extractSocialsFromText(text = '', source = 'description') {
  const input = String(text || '');
  const patterns = [
    /https?:\/\/[^\s<>"']+/gi,
    /(?:discord\.gg|discord\.com\/invite|youtube\.com|youtu\.be|x\.com|twitter\.com|twitch\.tv|guilded\.gg|tiktok\.com)\/[^\s<>"']+/gi,
  ];
  const out = [];
  for (const pattern of patterns) {
    for (const match of input.match(pattern) || []) {
      const url = normalizeSocialUrl(match);
      if (!url) continue;
      const type = socialTypeFromUrl(url);
      if (type === 'Website' && source === 'description') continue;
      out.push({ type, title:type, url, source });
    }
  }
  return out;
}

function normalizeSocialPayload(payload, source) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const item of rows) {
    const url = normalizeSocialUrl(item?.url || item?.link || item?.href || '');
    if (!url) continue;
    const fallback = item?.type || item?.title || item?.name || '';
    const type = socialTypeFromUrl(url, fallback);
    out.push({ type, title:String(item?.title || item?.name || type).slice(0, 100), url, source });
  }
  return out;
}

function dedupeSocials(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const url = normalizeSocialUrl(row?.url || '');
    if (!url) continue;
    const key = url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type:socialTypeFromUrl(url, row?.type), title:String(row?.title || row?.type || 'Website').slice(0,100), url, source:String(row?.source || 'game') });
  }
  return out.slice(0, 20);
}

async function getGameSocials(game, old = {}) {
  const id = Number(game?.id || old?.id || 0);
  const creator = game?.creator || old?.creator || {};
  const rows = [...extractSocialsFromText(game?.description ?? old?.description ?? '', 'description')];

  if (Number.isSafeInteger(id) && id > 0) {
    const payload = await optionalRobloxFetch(`https://games.roblox.com/v1/games/${id}/social-links/list`);
    rows.push(...normalizeSocialPayload(payload, 'game'));
  }

  if (String(creator?.type || '') === 'Group' && Number(creator?.id) > 0) {
    const groupId = Number(creator.id);
    let payload = groupSocialCache.get(groupId);
    if (payload === undefined) {
      payload = await optionalRobloxFetch(`https://groups.roblox.com/v1/groups/${groupId}/social-links`);
      groupSocialCache.set(groupId, payload || null);
    }
    rows.push(...normalizeSocialPayload(payload, 'creator'));
  }

  const socials = dedupeSocials(rows);
  return { socials, checkedAt:new Date().toISOString() };
}

function socialsNeedRefresh(old = {}, now = Date.now()) {
  const checked = new Date(old.socialsCheckedAt || 0).getTime();
  return !Number.isFinite(checked) || checked <= 0 || now - checked > SOCIALS_FRESH_MS;
}

function firstFinite(obj, keys) {
  for (const key of keys) {
    const value = Number(obj?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
function extractCandidateRecords(payload) {
  const map = new Map();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }

    // Roblox surfaces are inconsistent: some return a universeId, while
    // others only expose the root/place ID. Universe IDs are what the games
    // metadata endpoint accepts, so remember place IDs for a conversion pass.
    const rawPlaceId = value.placeId ?? value.placeID ?? value.place_id ?? value.rootPlaceId ?? value.rootPlaceID ?? value.root_place_id;
    const placeId = Number(rawPlaceId);
    if (Number.isSafeInteger(placeId) && placeId > 0) discoveredPlaceIds.add(placeId);

    const rawId = value.universeId ?? value.universeID ?? value.universe_id;
    const id = Number(rawId);
    if (Number.isSafeInteger(id) && id > 0) {
      const previous = map.get(id) || {};
      const playing = firstFinite(value, ['playerCount','playing','concurrentPlayers','ccu','totalPlayerCount','numberOfPlayers']);
      const visits = firstFinite(value, ['visits','visitCount','totalVisits']);
      const created = firstString(value, ['created','createdAt','createdUtc','createdDate']);
      const name = firstString(value, ['name','gameName','title']);
      map.set(id, {
        id,
        playing: playing ?? previous.playing ?? null,
        visits: visits ?? previous.visits ?? null,
        created: created || previous.created || '',
        name: name || previous.name || '',
      });
    }
    Object.values(value).forEach(walk);
  };
  walk(payload);
  return map;
}
function mergeCandidatePayload(payload, candidates, hints) {
  for (const [id, hint] of extractCandidateRecords(payload)) {
    candidates.add(id);
    const old = hints.get(id) || {};
    hints.set(id, {
      ...old,
      ...Object.fromEntries(Object.entries(hint).filter(([, value]) => value !== null && value !== '')),
    });
  }
}
function extractSortIds(payload) {
  const ids = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key,nested] of Object.entries(value)) {
      if (/^sortId$/i.test(key) && (typeof nested === 'string' || typeof nested === 'number')) ids.add(String(nested));
      if (nested && typeof nested === 'object') walk(nested);
    }
  };
  walk(payload);
  return [...ids];
}
function hintCouldMatch(hint = {}, filters, now = Date.now()) {
  if (filters.allGames) return true;
  if (Number.isFinite(hint.playing) && (hint.playing < filters.minCcu || hint.playing > filters.maxCcu)) return false;
  if (Number.isFinite(hint.visits) && hint.visits < filters.minVisits) return false;
  if (hint.created) {
    const createdAt = new Date(hint.created).getTime();
    if (Number.isFinite(createdAt) && createdAt > 0) {
      const age = now - createdAt;
      if (age < 0) return false;
      if (filters.createdWithinUnit !== 'all' && age > createdWindowMs(filters)) return false;
    }
  }
  return true;
}
function userHintCouldMatch(hint = {}, filters, now = Date.now()) {
  if (filters.allGames || filters.genreOnly) return true;
  // A user-triggered scan should not spend minutes resolving random universe IDs.
  // Only verify newly discovered games when Roblox discovery already told us the
  // live player count and that count is inside the requested CCU window.
  if (!Number.isFinite(hint.playing)) return false;
  return hintCouldMatch(hint, filters, now);
}

async function writeScan(scanId, patch, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 1100) return;
  lastProgressAt = now;
  await root.child(`scans/${scanId}`).update({ ...patch, updatedAt:new Date().toISOString() });
}
async function phase(scanId, phaseName, label, processed = 0, total = 0, extra = {}, force = false) {
  log(label);
  await writeScan(scanId, { status:'processing', phase:phaseName, label, processed, total, ...extra }, force);
}
function startHeartbeat(scanId, mode) {
  stopHeartbeat();
  const beat = () => {
    const now = new Date().toISOString();
    root.child(`scans/${scanId}`).update({ heartbeatAt:now, updatedAt:now }).catch(() => {});
    if (mode === 'user') root.child('meta').update({ scanHeartbeatAt:now }).catch(() => {});
  };
  beat();
  heartbeatTimer = setInterval(beat, 15_000);
  heartbeatTimer.unref?.();
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
async function updateInChunks(refPath, object, chunkSize = 400) {
  const entries = Object.entries(object);
  for (let i = 0; i < entries.length; i += chunkSize) await root.child(refPath).update(Object.fromEntries(entries.slice(i, i + chunkSize)));
}

async function discoverExplore(scanId, candidates, hints, mode) {
  const contexts = mode === 'catalog' ? DISCOVERY_CONTEXTS : DISCOVERY_CONTEXTS.slice(0,1);
  await mapPool(contexts, Math.min(3, contexts.length), async (context, contextIndex) => {
    const sessionId = randomUUID();
    try {
      const sorts = await robloxFetch(`https://apis.roblox.com/explore-api/v1/get-sorts?${new URLSearchParams({ sessionId, device:context.device, country:context.country })}`);
      mergeCandidatePayload(sorts, candidates, hints);
      const sortIds = extractSortIds(sorts);
      let done = 0;
      await mapPool(sortIds, 8, async (sortId) => {
        try {
          const payload = await robloxFetch(`https://apis.roblox.com/explore-api/v1/get-sort-content?${new URLSearchParams({ sessionId, sortId, device:context.device, country:context.country })}`);
          mergeCandidatePayload(payload, candidates, hints);
        } catch {}
        done += 1;
        if (done % 12 === 0 || done === sortIds.length) await phase(scanId, 'discover', `Finding possible new matches · ${candidates.size.toLocaleString()} candidates`, done, sortIds.length, { discovered:candidates.size, context:contextIndex + 1 });
      });
    } catch {}
  });
}

function rotatingQueries(filters, mode, cursor = 0) {
  if (filters.q) return [filters.q];
  if (mode === 'catalog') return [...BASE_SEARCH_QUERIES];
  const queries = [];
  for (let i = 0; i < USER_QUERY_BATCH; i += 1) queries.push(BASE_SEARCH_QUERIES[(cursor + i) % BASE_SEARCH_QUERIES.length]);
  return [...new Set(queries)];
}

async function discoverGenreSearch(scanId, filters, candidates, hints) {
  const terms = genreTerms(filters.genre);
  let queryDone = 0;
  await mapPool(terms, 4, async (query, qi) => {
    const pages = qi === 0 ? GENRE_PRIMARY_SEARCH_PAGES : GENRE_ALIAS_SEARCH_PAGES;
    const sessionId = randomUUID();
    let pageToken = '';
    for (let page = 0; page < pages; page += 1) {
      try {
        const params = new URLSearchParams({ searchQuery:query, sessionId, pageType:'all' });
        if (pageToken) params.set('pageToken', pageToken);
        const payload = await robloxFetch(`https://apis.roblox.com/search-api/omni-search?${params}`);
        mergeCandidatePayload(payload, candidates, hints);
        pageToken = String(payload?.nextPageToken || '');
        if (!pageToken) break;
      } catch { break; }
      if ((page + 1) % 8 === 0) await phase(scanId, 'genre-search', `Scanning ${filters.genre} · ${candidates.size.toLocaleString()} candidates`, page + 1, pages, { discovered:candidates.size, genre:filters.genre });
    }
    queryDone += 1;
    await phase(scanId, 'genre-search', `Scanning ${filters.genre} · ${candidates.size.toLocaleString()} candidates`, queryDone, terms.length, { discovered:candidates.size, genre:filters.genre });
  });
  return candidates.size;
}

async function expandGenreRecommendations(scanId, candidates, hints, genre) {
  const queue = [...candidates].slice(0, GENRE_RECOMMENDATION_SEEDS);
  let done = 0;
  await mapPool(queue, 8, async (seed) => {
    try {
      const payload = await robloxFetch(`https://games.roblox.com/v1/games/recommendations/game/${seed}?maxRows=50`);
      mergeCandidatePayload(payload, candidates, hints);
    } catch {}
    done += 1;
    if (done % 24 === 0 || done === queue.length) await phase(scanId, 'genre-recommend', `Expanding ${genre} · ${candidates.size.toLocaleString()} candidates`, done, queue.length, { discovered:candidates.size, genre });
  });
}

async function discoverSearch(scanId, filters, candidates, hints, mode, cursor = 0) {
  const queries = rotatingQueries(filters, mode, cursor);
  const pages = mode === 'catalog' ? CATALOG_SEARCH_PAGES : (filters.q ? 5 : USER_SEARCH_PAGES);
  let queryDone = 0;
  await mapPool(queries, Math.min(6, queries.length), async (query) => {
    const sessionId = randomUUID();
    let pageToken = '';
    for (let page = 0; page < pages; page += 1) {
      try {
        const params = new URLSearchParams({ searchQuery:query, sessionId, pageType:'all' });
        if (pageToken) params.set('pageToken', pageToken);
        const payload = await robloxFetch(`https://apis.roblox.com/search-api/omni-search?${params}`);
        mergeCandidatePayload(payload, candidates, hints);
        pageToken = String(payload?.nextPageToken || '');
        if (!pageToken) break;
      } catch { break; }
    }
    queryDone += 1;
    if (queryDone % 6 === 0 || queryDone === queries.length) await phase(scanId, 'search', `Searching for unloaded games · ${candidates.size.toLocaleString()} candidates`, queryDone, queries.length, { discovered:candidates.size });
  });
  return (cursor + queries.length) % BASE_SEARCH_QUERIES.length;
}

async function expandRecommendations(scanId, seeds, candidates, hints, mode) {
  const limit = mode === 'catalog' ? CATALOG_RECOMMENDATION_SEEDS : USER_RECOMMENDATION_SEEDS;
  const queue = [...new Set(seeds)].slice(0, limit);
  let done = 0;
  await mapPool(queue, 8, async (seed) => {
    try {
      const payload = await robloxFetch(`https://games.roblox.com/v1/games/recommendations/game/${seed}?maxRows=50`);
      mergeCandidatePayload(payload, candidates, hints);
    } catch {}
    done += 1;
    if (done % 16 === 0 || done === queue.length) await phase(scanId, 'recommend', `Finding related unloaded games · ${candidates.size.toLocaleString()} candidates`, done, queue.length, { discovered:candidates.size });
  });
}

async function getDetails(ids) {
  if (!ids.length) return [];
  const payload = await robloxFetch(`https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`);
  return Array.isArray(payload?.data) ? payload.data : [];
}
async function resolvePlaceId(placeId) {
  try {
    const payload = await robloxFetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    const universeId = Number(payload?.universeId ?? payload?.universeID ?? payload?.universe_id);
    return Number.isSafeInteger(universeId) && universeId > 0 ? universeId : null;
  } catch {
    return null;
  }
}

function parseLookupInput(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Paste a Roblox game URL, place ID, or universe ID.');
  if (/^\d{1,20}$/.test(input)) {
    const id = Number(input);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('That Roblox ID is not valid.');
    return { kind:'auto', id, raw:input };
  }
  let url;
  try { url = new URL(input); } catch { throw new Error('That does not look like a Roblox game URL or numeric ID.'); }
  if (!/(^|\.)roblox\.com$/i.test(url.hostname)) throw new Error('Use a roblox.com game URL.');
  const universeParam = Number(url.searchParams.get('universeId') || url.searchParams.get('universeid') || 0);
  if (Number.isSafeInteger(universeParam) && universeParam > 0) return { kind:'universe', id:universeParam, raw:input };
  const placeParam = Number(url.searchParams.get('placeId') || url.searchParams.get('placeid') || 0);
  if (Number.isSafeInteger(placeParam) && placeParam > 0) return { kind:'place', id:placeParam, raw:input };
  const match = url.pathname.match(/\/games\/(\d+)/i);
  if (match) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) return { kind:'place', id, raw:input };
  }
  throw new Error('Could not find a Roblox game ID in that URL.');
}

async function runDirectLookup(scanId, rawInput) {
  const parsed = parseLookupInput(rawInput);
  await phase(scanId, 'lookup', 'Resolving Roblox game ID', 0, 3, { lookupInput:rawInput }, true);

  let universeId = null;
  let sourcePlaceId = null;
  let details = [];
  if (parsed.kind === 'universe') {
    universeId = parsed.id;
  } else if (parsed.kind === 'place') {
    sourcePlaceId = parsed.id;
    universeId = await resolvePlaceId(parsed.id);
    if (!universeId) throw new Error('Roblox could not map that place ID to an experience.');
  } else {
    // A bare number can be either a universe ID or a place ID. Try universe
    // details first; if Roblox returns nothing, treat it as a place ID.
    try { details = await getDetails([parsed.id]); } catch { details = []; }
    if (details.some((item) => Number(item?.id) === parsed.id)) {
      universeId = parsed.id;
    } else {
      sourcePlaceId = parsed.id;
      universeId = await resolvePlaceId(parsed.id);
      if (!universeId) throw new Error('That ID is not a public Roblox universe or place that Nichegames can resolve.');
    }
  }

  await phase(scanId, 'lookup', `Loading universe ${universeId}`, 1, 3, { lookupUniverseId:universeId, lookupPlaceId:sourcePlaceId }, true);
  if (!details.length || !details.some((item) => Number(item?.id) === universeId)) details = await getDetails([universeId]);
  const detail = details.find((item) => Number(item?.id) === universeId);
  if (!detail) throw new Error('Roblox did not return public game details for that experience.');

  const [iconMap, voteMap, fullSnap, indexSnap, legacySnap, knownSnap] = await Promise.all([
    getIcons([universeId]),
    getVotes([universeId]),
    root.child(`catalog/games/${universeId}`).once('value'),
    root.child(`catalog/index/${universeId}`).once('value'),
    root.child(`games/${universeId}`).once('value'),
    root.child(`knownIds/${universeId}`).once('value'),
  ]);
  const old = fullSnap.val() || indexSnap.val() || legacySnap.val() || {};
  const socialResult = await getGameSocials(detail, old);
  const game = normalizeGame(detail, old, iconMap.get(universeId) || '', voteMap.get(universeId) || null, socialResult);
  const compact = compactGame(game);
  const mapUpdates = {};
  const rootPlaceId = Number(game.rootPlaceId || detail.rootPlaceId || 0);
  if (Number.isSafeInteger(rootPlaceId) && rootPlaceId > 0) mapUpdates[String(rootPlaceId)] = universeId;
  if (sourcePlaceId) mapUpdates[String(sourcePlaceId)] = universeId;

  await phase(scanId, 'lookup', `Saving ${game.name}`, 2, 3, { lookupUniverseId:universeId, lookupGameName:game.name }, true);
  await Promise.all([
    root.child(`catalog/games/${universeId}`).set(game),
    root.child(`catalog/index/${universeId}`).set(compact),
    root.child(`knownIds/${universeId}`).set(true),
    Object.keys(mapUpdates).length ? root.child('placeToUniverse').update(mapUpdates) : Promise.resolve(),
  ]);

  const completedAt = new Date().toISOString();
  if (!fullSnap.exists() && !indexSnap.exists() && !legacySnap.exists()) {
    await root.child('meta/catalogGames').transaction((value) => Math.max(0, Number(value || 0)) + 1);
  }
  if (!knownSnap.exists()) {
    await root.child('meta/knownUniverseIds').transaction((value) => Math.max(0, Number(value || 0)) + 1);
  }
  await root.child('meta').update({ lastLookupAt:completedAt, lastLookupGameId:universeId, lastLookupGameName:game.name, workerMode:'github-actions' });
  await root.child(`scans/${scanId}`).update({
    status:'complete', phase:'complete', label:`Found ${game.name}`, mode:'lookup', completedAt,
    lookupInput:rawInput, lookupGameId:universeId, lookupUniverseId:universeId, lookupRootPlaceId:rootPlaceId || sourcePlaceId || null,
    lookupGameName:game.name, processed:3, total:3, gamesLoaded:1, gamesToLoad:1, matchedCount:1,
  });
  return game;
}

async function repairPlaceIds(scanId, placeIds, placeMapRaw, candidates, mode) {
  const placeMapUpdates = {};
  const knownUniverseUpdates = {};
  const limit = mode === 'catalog' ? PLACE_REPAIR_LIMIT : Math.min(500, PLACE_REPAIR_LIMIT);
  const ids = [...new Set(placeIds)].filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, limit);
  let processed = 0;
  let resolved = 0;
  await mapPool(ids, 10, async (placeId) => {
    let universeId = Number(placeMapRaw?.[String(placeId)] || 0);
    if (!Number.isSafeInteger(universeId) || universeId <= 0) {
      universeId = await resolvePlaceId(placeId);
      if (universeId) placeMapUpdates[String(placeId)] = universeId;
    }
    if (universeId) {
      candidates.add(universeId);
      knownUniverseUpdates[String(universeId)] = true;
      resolved += 1;
    }
    processed += 1;
    if (processed % 100 === 0 || processed === ids.length) {
      await phase(scanId, 'place-map', `Resolving Roblox place IDs · ${processed.toLocaleString()} / ${ids.length.toLocaleString()}`, processed, ids.length, { placeIdsResolved:resolved, placeIdsSeen:ids.length });
    }
  });
  if (Object.keys(placeMapUpdates).length) await updateInChunks('placeToUniverse', placeMapUpdates, 500);
  if (Object.keys(knownUniverseUpdates).length) await updateInChunks('knownIds', knownUniverseUpdates, 1000);
  return { processed, resolved };
}
async function getIcons(ids) {
  const map = new Map();
  await mapPool(chunks(ids, 100), 4, async (batch) => {
    try {
      const payload = await robloxFetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${batch.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`);
      for (const item of payload?.data || []) if (item?.targetId && item?.imageUrl) map.set(Number(item.targetId), item.imageUrl);
    } catch {}
  });
  return map;
}
async function getVotes(ids) {
  const map = new Map();
  await mapPool(chunks(ids, 50), 4, async (batch) => {
    try {
      const payload = await robloxFetch(`https://games.roblox.com/v1/games/votes?universeIds=${batch.join(',')}`);
      for (const item of payload?.data || []) if (item?.id) map.set(Number(item.id), item);
    } catch {}
  });
  return map;
}
function normalizeGame(game, old = {}, icon = '', vote = null, socialResult = null) {
  const id = Number(game.id);
  const now = new Date().toISOString();
  const oldVoteCount = Number(old.voteCount || 0);
  const oldRating = old.rating == null ? null : Number(old.rating);
  const up = Number(vote?.upVotes ?? old.votes?.up ?? (oldRating != null ? Math.round(oldVoteCount * oldRating / 100) : 0));
  const down = Number(vote?.downVotes ?? old.votes?.down ?? Math.max(0, oldVoteCount - up));
  const playing = Number(game.playing ?? old.playing ?? 0);
  const oldPlaying = Number(old.playing ?? playing);
  const socials = socialResult?.socials ?? (Array.isArray(old.socials) ? old.socials : []);
  const socialTypes = [...new Set(socials.map((item) => String(item?.type || '')).filter(Boolean))];
  return {
    ...old,
    id,
    rootPlaceId:Number(game.rootPlaceId || old.rootPlaceId || 0),
    name:String(game.name || old.name || 'Untitled Experience'),
    description:String(game.description ?? old.description ?? ''),
    creator:{ id:Number(game.creator?.id || old.creator?.id || 0), name:String(game.creator?.name || old.creator?.name || 'Unknown'), type:String(game.creator?.type || old.creator?.type || 'Unknown'), verified:Boolean(game.creator?.hasVerifiedBadge ?? old.creator?.verified) },
    playing,
    ccuDelta:playing-oldPlaying,
    visits:Number(game.visits ?? old.visits ?? 0),
    favorites:Number(game.favoritedCount ?? old.favorites ?? 0),
    maxPlayers:Number(game.maxPlayers ?? old.maxPlayers ?? 0),
    created:game.created || old.created || null,
    updated:game.updated || old.updated || null,
    genre:String(game.genre_l1 || game.genre || old.genre || 'Unknown'),
    subgenre:String(game.genre_l2 || old.subgenre || ''),
    genreTags:deriveGenreTags({ ...old, ...game, genre:String(game.genre_l1 || game.genre || old.genre || 'Unknown'), subgenre:String(game.genre_l2 || old.subgenre || '') }),
    rating:up+down ? (up/(up+down))*100 : oldRating,
    votes:{ up, down },
    voteCount:up+down,
    icon:icon || old.icon || '',
    robloxUrl:(game.rootPlaceId || old.rootPlaceId) ? `https://www.roblox.com/games/${game.rootPlaceId || old.rootPlaceId}` : `https://www.roblox.com/games/?universeId=${id}`,
    lastCheckedAt:now,
    lastSeenAt:now,
    lastRatingCheckedAt:vote ? now : (old.lastRatingCheckedAt || null),
    socials,
    socialTypes,
    hasSocials:socials.length > 0,
    hasDiscord:socialTypes.some((type) => type.toLowerCase() === 'discord'),
    socialsCheckedAt:socialResult?.checkedAt || old.socialsCheckedAt || null,
  };
}
function compactGame(game = {}) {
  return {
    id:Number(game.id || 0), rootPlaceId:Number(game.rootPlaceId || 0), name:String(game.name || 'Untitled Experience'),
    creator:game.creator || { id:0, name:'Unknown', type:'Unknown', verified:false }, playing:Number(game.playing || 0), ccuDelta:Number(game.ccuDelta || 0),
    visits:Number(game.visits || 0), favorites:Number(game.favorites || 0), maxPlayers:Number(game.maxPlayers || 0), created:game.created || null, updated:game.updated || null,
    genre:String(game.genre || 'Unknown'), subgenre:String(game.subgenre || ''), genreTags:Array.isArray(game.genreTags) ? game.genreTags : [], rating:game.rating == null ? null : Number(game.rating),
    voteCount:Number(game.voteCount || 0) || Number(game.votes?.up || 0) + Number(game.votes?.down || 0), icon:String(game.icon || ''), robloxUrl:String(game.robloxUrl || ''),
    lastCheckedAt:game.lastCheckedAt || null, lastRatingCheckedAt:game.lastRatingCheckedAt || null,
    hasSocials:Boolean(game.hasSocials || (Array.isArray(game.socials) && game.socials.length)), hasDiscord:Boolean(game.hasDiscord),
    socialTypes:Array.isArray(game.socialTypes) ? game.socialTypes : [], socialsCheckedAt:game.socialsCheckedAt || null,
  };
}

async function main() {
  const scanId = String(process.env.SCAN_ID || `scan_${Date.now()}_${randomUUID()}`).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100);
  const requestedMode = String(process.env.SCAN_MODE || 'user').toLowerCase();
  const mode = (requestedMode === 'catalog' || requestedMode === 'background') ? 'catalog' : 'user';
  const filters = normalizeFilters(JSON.parse(process.env.FILTERS_JSON || '{}'));
  const startedAt = new Date().toISOString();
  const isLookup = Boolean(filters.lookupInput);

  if (mode === 'user' && !isLookup) {
    await root.child('meta').update({ activeScanId:scanId, scanning:true, scanStartedAt:startedAt, workerMode:'github-actions', scanHeartbeatAt:startedAt });
  }
  await root.child(`scans/${scanId}`).set({
    status:'processing', phase:'starting', label:isLookup ? 'Finding Roblox game' : (mode === 'catalog' ? 'Building persistent catalog' : 'Loading existing matches'),
    filters, mode:isLookup ? 'lookup' : mode, startedAt, requestedAt:Date.now(), heartbeatAt:startedAt, updatedAt:startedAt,
    processed:0, total:isLookup ? 3 : 0, gamesLoaded:0, gamesToLoad:isLookup ? 1 : 0,
  });
  startHeartbeat(scanId, isLookup ? 'lookup' : mode);

  try {
    if (isLookup) {
      await runDirectLookup(scanId, filters.lookupInput);
      stopHeartbeat();
      return 0;
    }
    const [indexSnap, fullCatalogSnap, metaSnap, missingSnap, knownSnap, legacyGamesSnap, placeMapSnap] = await Promise.all([
      root.child('catalog/index').once('value'),
      root.child('catalog/games').once('value'),
      root.child('meta').once('value'),
      root.child('missingIds').once('value'),
      root.child('knownIds').once('value'),
      root.child('games').once('value'), // legacy v6/v7 data is still valuable; do not re-scan it
      root.child('placeToUniverse').once('value'),
    ]);

    const indexRaw = indexSnap.val() || {};
    const fullCatalogRaw = fullCatalogSnap.val() || {};
    const fullRecords = new Map();
    for (const game of Object.values(fullCatalogRaw).filter(Boolean)) {
      const id = Number(game.id);
      if (Number.isSafeInteger(id) && id > 0) fullRecords.set(id, game);
    }
    const catalog = new Map();
    const mergeCatalogSource = (raw) => {
      for (const game of Object.values(raw || {}).filter(Boolean)) {
        const id = Number(game.id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const compact = compactGame(game);
        const previous = catalog.get(id);
        const prevChecked = new Date(previous?.lastCheckedAt || 0).getTime() || 0;
        const nextChecked = new Date(compact.lastCheckedAt || 0).getTime() || 0;
        if (!previous || nextChecked >= prevChecked) catalog.set(id, compact);
      }
    };
    // IMPORTANT: the compact index and the full catalog can drift apart after
    // older deployments or interrupted writes. Always union them.
    mergeCatalogSource(fullCatalogRaw);
    mergeCatalogSource(indexRaw);

    // Backfill compact index rows that already exist in catalog/games. These
    // are stored games and must never be hidden just because index is incomplete.
    const indexBackfill = {};
    for (const [id, compact] of catalog) {
      if (!indexRaw[String(id)]) indexBackfill[String(id)] = compact;
    }
    if (Object.keys(indexBackfill).length) {
      await updateInChunks('catalog/index', indexBackfill, 500);
      await root.child('meta').update({ indexBackfilled: Object.keys(indexBackfill).length, indexBackfilledAt:new Date().toISOString() });
    }
    const metaBefore = metaSnap.val() || {};
    const missingRaw = missingSnap.val() || {};
    const knownRaw = knownSnap.val() || {};
    const placeMapRaw = placeMapSnap.val() || {};
    const knownIds = new Set(Object.keys(knownRaw).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
    const legacyRaw = legacyGamesSnap.val() || {};
    const now = Date.now();

    // Import old /nichegames/games records into the compact index once, instead
    // of making Roblox requests for games Firebase already knows about.
    const legacyIndexChanges = {};
    let legacyMerged = 0;
    for (const game of Object.values(legacyRaw).filter(Boolean)) {
      const id = Number(game.id);
      if (!Number.isSafeInteger(id) || id <= 0 || catalog.has(id)) continue;
      const compact = compactGame(game);
      catalog.set(id, compact);
      if (!fullRecords.has(id)) fullRecords.set(id, game);
      legacyIndexChanges[String(id)] = compact;
      knownIds.add(id);
      legacyMerged += 1;
    }
    if (legacyMerged) {
      await updateInChunks('catalog/index', legacyIndexChanges, 500);
      await root.child('meta').update({ legacyGamesMerged:legacyMerged, legacyMigrationAt:new Date().toISOString(), catalogGames:catalog.size });
    }

    // Treat every catalog record as known so it never gets re-resolved as a
    // supposedly "new" universe on later user scans.
    for (const id of catalog.keys()) knownIds.add(id);

    const cachedMatches = [...catalog.values()].filter((game) => gameMatches(game, filters, now));
    await phase(scanId, 'cache', `${cachedMatches.length.toLocaleString()} existing matches ready`, 0, 0, {
      catalogBefore:catalog.size, cachedGames:catalog.size, cachedMatches:cachedMatches.length, matchedCount:cachedMatches.length,
      gamesLoaded:cachedMatches.length, gamesToLoad:cachedMatches.length, legacyMerged,
    }, true);

    const candidates = new Set();
    const hints = new Map();
    discoveredPlaceIds = new Set();
    const genreOnly = mode === 'user' && filters.genreOnly && filters.genre !== 'all';
    const cursor = Number(metaBefore.discoveryCursor || 0) % BASE_SEARCH_QUERIES.length;
    let nextCursor = cursor;
    if (genreOnly) {
      await phase(scanId, 'genre-start', `Genre-only scan · ${filters.genre}`, 0, 0, { genre:filters.genre }, true);
      await discoverGenreSearch(scanId, filters, candidates, hints);
      await expandGenreRecommendations(scanId, candidates, hints, filters.genre);
    } else {
      await discoverExplore(scanId, candidates, hints, mode);
      nextCursor = await discoverSearch(scanId, filters, candidates, hints, mode, cursor);
      await expandRecommendations(scanId, [...candidates], candidates, hints, mode);
    }

    // Convert place-only discovery records into universe IDs before filtering.
    // This fixes games that are visible on roblox.com under a place ID but were
    // previously invisible to Nichegames because /v1/games accepts universe IDs.
    const placeRepair = await repairPlaceIds(scanId, discoveredPlaceIds, placeMapRaw, candidates, mode);

    const isRecentlyMissing = (id) => {
      const value = missingRaw[String(id)];
      const checkedAt = typeof value === 'number' ? value : new Date(value?.checkedAt || value || 0).getTime();
      return Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt < MISSING_FRESH_MS;
    };

    const discoveredUnknown = [...candidates]
      .filter((id) => !catalog.has(id))
      .filter((id) => !isRecentlyMissing(id));

    // USER SCAN: filters only affect the visitor's view. Existing catalog rows
    // are reused instantly. We only resolve truly new discoveries when Roblox
    // discovery already exposes enough CCU information to make them plausible
    // matches, so a user never waits for the whole catalog to rebuild.
    const allKnownForCatalog = new Set([...knownIds, ...candidates]);

    // Normal user scans stay narrow and fast. All-games mode is intentionally
    // different: it is a user-requested catalog catch-up, so every unresolved
    // known universe can be resolved and streamed into Firebase while the
    // already-stored catalog remains visible immediately.
    const userNewCandidates = filters.allGames
      ? [...allKnownForCatalog]
          .filter((id) => !catalog.has(id))
          .slice(0, CATALOG_RESOLVE_LIMIT)
      : genreOnly
        ? discoveredUnknown.slice(0, CATALOG_RESOLVE_LIMIT)
        : discoveredUnknown
            .filter((id) => !knownIds.has(id))
            .filter((id) => userHintCouldMatch(hints.get(id), filters, now));

    // Genre-only scans also recheck search hits already in the catalog when they
    // do not yet carry enough genre/theme metadata. This lets old records gain
    // genreTags without refreshing the entire database.
    const genreExistingToRecheck = genreOnly
      ? [...candidates]
          .filter((id) => catalog.has(id))
          .filter((id) => !gameMatchesGenre(catalog.get(id), filters.genre))
          .slice(0, GENRE_EXISTING_RECHECK_LIMIT)
      : [];

    // CATALOG BUILDER: this is intentionally filter-independent. Every known ID
    // without a catalog record is backlog, whether or not it matches the current
    // user's filters. This is the key separation between indexing and searching.
    const unresolvedKnown = mode === 'catalog'
      ? [...allKnownForCatalog]
          .filter((id) => !catalog.has(id))
          .filter((id) => !isRecentlyMissing(id))
          .slice(0, CATALOG_RESOLVE_LIMIT)
      : [];

    // Refreshing old live counts is maintenance only. It never blocks a visitor.
    const staleExisting = mode === 'catalog'
      ? [...catalog.values()]
          .filter((game) => now - new Date(game.lastCheckedAt || 0).getTime() > EXISTING_REFRESH_AGE_MS)
          .sort((a,b) => new Date(a.lastCheckedAt || 0).getTime() - new Date(b.lastCheckedAt || 0).getTime())
          .slice(0, CATALOG_EXISTING_REFRESH_LIMIT)
          .map((g) => Number(g.id))
      : [];

    const newCandidates = mode === 'user' ? userNewCandidates : unresolvedKnown;
    const idsToCheck = mode === 'user'
      ? [...new Set([...userNewCandidates, ...genreExistingToRecheck])]
      : [...new Set([...unresolvedKnown, ...staleExisting])];

    const unresolvedTotalBefore = [...allKnownForCatalog].filter((id) => !catalog.has(id)).length;
    await phase(scanId, 'verify', mode === 'user'
      ? (genreOnly ? `${filters.genre} scan · checking ${idsToCheck.length.toLocaleString()} candidate games` : (filters.allGames ? `All games · resolving ${idsToCheck.length.toLocaleString()} unloaded known IDs` : `Checking ${idsToCheck.length.toLocaleString()} genuinely new games`))
      : `Catalog builder · resolving ${unresolvedKnown.length.toLocaleString()} unloaded IDs`, 0, idsToCheck.length, {
      candidateCount:candidates.size, placeIdsSeen:placeRepair.processed, placeIdsResolved:placeRepair.resolved,
      filteredCandidateCount:newCandidates.length,
      reused:cachedMatches.length,
      existingRefresh:staleExisting.length,
      unresolvedKnown:unresolvedKnown.length,
      unresolvedTotalBefore,
      uncachedCandidates:newCandidates.length,
      gamesLoaded:cachedMatches.length,
      gamesToLoad:cachedMatches.length + userNewCandidates.length,
      gamesScanned:0,
      gamesToScan:idsToCheck.length,
      matchedCount:cachedMatches.length,
      catalogBacklog:unresolvedTotalBefore,
    }, true);

    // Remember all discoveries immediately. If Roblox omits metadata, user scans
    // won't hammer the same ID again; the scheduled maintenance job repairs it.
    const knownUpdates = Object.fromEntries([...candidates].map((id) => [String(id), true]));
    await updateInChunks('knownIds', knownUpdates, 1000);

    let processed = 0;
    let newGamesAdded = 0;
    let updatedGames = 0;
    let newMatchesAdded = 0;
    let lastCatalogUpdatedAt = '';
    const missingUpdates = {};

    for (const batch of chunks(idsToCheck, DETAIL_BATCH)) {
      let details = [];
      let detailRequestSucceeded = false;
      try {
        details = await getDetails(batch);
        detailRequestSucceeded = true;
      } catch (error) {
        log(`Detail batch failed; leaving ${batch.length} IDs pending for the next catalog run: ${error?.message || error}`);
      }
      const returned = new Set(details.map((game) => Number(game.id)));

      // Older Nichegames builds could accidentally place Roblox place IDs into
      // knownIds. If an ID fails as a universe during the background catalog
      // build, try it once as a place ID before declaring it missing. When it
      // resolves, migrate knownIds to the real universe ID so the backlog
      // permanently shrinks instead of retrying the wrong identifier forever.
      const migratedPlaceIds = new Set();
      if (detailRequestSucceeded && mode === 'catalog') {
        const failedAsUniverse = batch.filter((id) => !returned.has(id) && !catalog.has(id));
        const remappedUniverses = [];
        const knownCorrections = {};
        const placeCorrections = {};
        for (const possiblePlaceId of failedAsUniverse) {
          let universeId = Number(placeMapRaw?.[String(possiblePlaceId)] || 0);
          if (!Number.isSafeInteger(universeId) || universeId <= 0) universeId = await resolvePlaceId(possiblePlaceId);
          if (!universeId) continue;
          migratedPlaceIds.add(possiblePlaceId);
          remappedUniverses.push(universeId);
          candidates.add(universeId);
          knownIds.delete(possiblePlaceId);
          knownIds.add(universeId);
          knownCorrections[String(possiblePlaceId)] = null;
          knownCorrections[String(universeId)] = true;
          placeCorrections[String(possiblePlaceId)] = universeId;
          placeMapRaw[String(possiblePlaceId)] = universeId;
        }
        if (Object.keys(knownCorrections).length) await updateInChunks('knownIds', knownCorrections, 500);
        if (Object.keys(placeCorrections).length) await updateInChunks('placeToUniverse', placeCorrections, 500);
        if (remappedUniverses.length) {
          try {
            const mappedDetails = await getDetails([...new Set(remappedUniverses)]);
            for (const game of mappedDetails) {
              const id = Number(game.id);
              if (!returned.has(id)) {
                details.push(game);
                returned.add(id);
              }
            }
            log(`Repaired ${migratedPlaceIds.size} old knownIds that were actually place IDs.`);
          } catch (error) {
            log(`Place-ID migration detail lookup failed; mappings stay cached for the next catalog run: ${error?.message || error}`);
          }
        }
      }

      if (detailRequestSucceeded) {
        for (const id of batch) {
          if (!returned.has(id) && !catalog.has(id) && !migratedPlaceIds.has(id)) missingUpdates[String(id)] = { checkedAt:Date.now() };
        }
      }

      const socialResults = new Map();
      const socialTargets = details.filter((game) => {
        const id = Number(game.id);
        const old = fullRecords.get(id) || catalog.get(id) || {};
        if (!socialsNeedRefresh(old, now)) return false;
        if (mode === 'catalog') return false; // catalog socials are enriched in a separate bounded pass below
        return filters.hasSocials || filters.hasDiscord || !catalog.has(id);
      });
      await mapPool(socialTargets, 8, async (game) => {
        const id = Number(game.id);
        socialResults.set(id, await getGameSocials(game, fullRecords.get(id) || catalog.get(id) || {}));
      });

      const ratingIds = [];
      const iconIds = [];
      for (const game of details) {
        const id = Number(game.id);
        const old = fullRecords.get(id) || catalog.get(id) || {};
        const base = normalizeGame(game, old, '', null, socialResults.get(id) || null);
        if (mode === 'catalog' || filters.allGames) {
          // Catalog building prioritizes getting every valid universe into the
          // database quickly. Artwork is useful; vote data can be filled later.
          if (!old.icon) iconIds.push(id);
        } else if (gameMatches(base, filters, now)) {
          if (!old.icon) iconIds.push(id);
          const ratingChecked = new Date(old.lastRatingCheckedAt || 0).getTime();
          if (!old.rating || !Number.isFinite(ratingChecked) || now - ratingChecked > RATING_FRESH_MS) ratingIds.push(id);
        }
      }

      const [icons, votes] = await Promise.all([getIcons(iconIds), getVotes(ratingIds)]);
      const fullChanges = {};
      const compactChanges = {};
      let batchAddedMatch = false;

      for (const game of details) {
        const id = Number(game.id);
        const wasKnown = catalog.has(id);
        const old = fullRecords.get(id) || catalog.get(id) || {};
        const next = normalizeGame(game, old, icons.get(id) || '', votes.get(id) || null, socialResults.get(id) || null);
        const wasMatch = wasKnown && gameMatches(old, filters, now);
        const isMatch = gameMatches(next, filters, now);
        if (!wasKnown) newGamesAdded += 1;
        if (!wasKnown && isMatch) { newMatchesAdded += 1; batchAddedMatch = true; }
        if (wasKnown && !wasMatch && isMatch) batchAddedMatch = true;
        catalog.set(id, compactGame(next));
        fullRecords.set(id, next);
        fullChanges[String(id)] = next;
        compactChanges[String(id)] = compactGame(next);
        updatedGames += 1;
      }

      if (Object.keys(fullChanges).length) {
        await Promise.all([
          root.child('catalog/games').update(fullChanges),
          root.child('catalog/index').update(compactChanges),
        ]);
      }

      processed += batch.length;
      if (batchAddedMatch || Object.keys(compactChanges).length) lastCatalogUpdatedAt = new Date().toISOString();
      const liveMatches = [...catalog.values()].filter((game) => gameMatches(game, filters, now)).length;
      await writeScan(scanId, {
        status:'processing', phase:'verify',
        label:mode === 'user' ? (filters.allGames ? `All games · ${liveMatches.toLocaleString()} ready` : `Loaded games · ${liveMatches.toLocaleString()} matches ready`) : `Catalog builder · ${processed.toLocaleString()} / ${idsToCheck.length.toLocaleString()} checked`,
        processed:Math.min(processed, idsToCheck.length), total:idsToCheck.length,
        gamesLoaded:liveMatches,
        gamesToLoad:Math.max(liveMatches, cachedMatches.length + userNewCandidates.length),
        gamesScanned:Math.min(processed, idsToCheck.length), gamesToScan:idsToCheck.length,
        matchedCount:liveMatches, newMatchesAdded, catalogBacklog:Math.max(0, unresolvedTotalBefore - newGamesAdded), catalogUpdatedAt:lastCatalogUpdatedAt || undefined,
      }, true);
    }


    if (mode === 'catalog') {
      const socialBacklog = [...fullRecords.values()]
        .filter((game) => socialsNeedRefresh(game, now))
        .sort((a,b) => new Date(a.socialsCheckedAt || 0).getTime() - new Date(b.socialsCheckedAt || 0).getTime())
        .slice(0, CATALOG_SOCIAL_ENRICH_LIMIT);
      if (socialBacklog.length) {
        await phase(scanId, 'socials', `Checking game socials · 0 / ${socialBacklog.length.toLocaleString()}`, 0, socialBacklog.length, { socialsToCheck:socialBacklog.length }, true);
        let socialDone = 0;
        for (const group of chunks(socialBacklog, 10)) {
          const fullChanges = {};
          const compactChanges = {};
          await mapPool(group, 8, async (old) => {
            const id = Number(old.id);
            const socialResult = await getGameSocials(old, old);
            const next = normalizeGame(old, old, old.icon || '', null, socialResult);
            fullRecords.set(id, next);
            catalog.set(id, compactGame(next));
            fullChanges[String(id)] = next;
            compactChanges[String(id)] = compactGame(next);
          });
          if (Object.keys(fullChanges).length) await Promise.all([
            root.child('catalog/games').update(fullChanges),
            root.child('catalog/index').update(compactChanges),
          ]);
          socialDone += group.length;
          await phase(scanId, 'socials', `Checking game socials · ${socialDone.toLocaleString()} / ${socialBacklog.length.toLocaleString()}`, socialDone, socialBacklog.length, { socialsChecked:socialDone, socialsToCheck:socialBacklog.length }, true);
        }
      }
    }

    await updateInChunks('missingIds', missingUpdates, 1000);

    const finalMatches = [...catalog.values()].filter((game) => gameMatches(game, filters, now));
    const completedAt = new Date().toISOString();
    stopHeartbeat();

    const metaPatch = {
      latestScanId:scanId,
      lastScanAt:completedAt,
      lastDiscoveryAt:completedAt,
      catalogGames:catalog.size,
      knownUniverseIds:new Set([...knownIds, ...candidates]).size,
      lastNewGames:newGamesAdded,
      lastMatchedCount:finalMatches.length,
      workerMode:'github-actions',
      lastFilters:filters,
      indexVersion:6,
      catalogBacklog:Math.max(0, new Set([...knownIds, ...candidates]).size - catalog.size),
      discoveryCursor:nextCursor,
    };
    if (mode === 'user') Object.assign(metaPatch, { activeScanId:null, scanning:false });
    else Object.assign(metaPatch, { lastCatalogBuildAt:completedAt });
    await root.child('meta').update(metaPatch);
    if (genreOnly) {
      const genreKey = normalizeGenreKey(filters.genre).replace(/\s+/g, '-').slice(0,80) || 'unknown';
      await root.child(`genreCoverage/${genreKey}`).set({
        genre:filters.genre, lastScanAt:completedAt, candidates:candidates.size, matches:finalMatches.length,
        checked:idsToCheck.length, catalogGames:catalog.size, scanId
      });
    }

    await root.child(`scans/${scanId}`).update({
      status:'complete', phase:'complete', label:genreOnly ? `${filters.genre} scan complete · ${finalMatches.length.toLocaleString()} games` : (filters.allGames ? `All games ready · ${finalMatches.length.toLocaleString()} stored games` : `Scan complete · ${finalMatches.length.toLocaleString()} matches`), filters, mode,
      catalogGames:catalog.size, discovered:candidates.size, filteredCandidates:newCandidates.length,
      newDiscovered:newGamesAdded, newMatchesAdded, updatedGames, matchedCount:finalMatches.length,
      processed:idsToCheck.length, total:idsToCheck.length, gamesLoaded:finalMatches.length, gamesToLoad:finalMatches.length,
      gamesScanned:idsToCheck.length, gamesToScan:idsToCheck.length, catalogBacklog:Math.max(0, new Set([...knownIds, ...candidates]).size - catalog.size), completedAt,
    });

    log(`Complete: ${catalog.size} catalog games, ${newGamesAdded} new games added, ${Math.max(0, new Set([...knownIds, ...candidates]).size - catalog.size)} unresolved known IDs remain, ${finalMatches.length} current matches.`);
    return 0;
  } catch (error) {
    stopHeartbeat();
    console.error(error?.stack || error?.message || String(error));
    try {
      if (mode === 'user' && !filters.lookupInput) await root.child('meta').update({ activeScanId:null, scanning:false, lastError:String(error?.message || error), workerMode:'github-actions' });
      await root.child(`scans/${scanId}`).update({ status:'error', phase:'error', label:'Scan failed', error:String(error?.message || error), completedAt:new Date().toISOString() });
    } catch {}
    return 1;
  }
}

let exitCode = 1;
try { exitCode = await main(); }
catch (error) { console.error(error?.stack || error?.message || String(error)); exitCode = 1; }
stopHeartbeat();
try { db.goOffline(); } catch {}
try { await admin.app().delete(); } catch {}
await new Promise((resolve) => setTimeout(resolve, 25));
process.exit(exitCode);
