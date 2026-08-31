import { isWithinCreatedWindow } from './filter-utils.js';

console.info('Nichegames build: performance-v8.3');

const DATABASE_ROOT = 'https://nichegamesfinder-default-rtdb.firebaseio.com/nichegames';
const SCAN_ENDPOINT = String(window.NICHEGAMES_SCAN_ENDPOINT || '').trim();
const WORKER_BASE = SCAN_ENDPOINT.replace(/\/scan\/?$/, '');
const CANCEL_ENDPOINT = WORKER_BASE ? `${WORKER_BASE}/cancel` : '';
const STATUS_ENDPOINT = WORKER_BASE ? `${WORKER_BASE}/status` : '';
const LOOKUP_ENDPOINT = WORKER_BASE ? `${WORKER_BASE}/lookup` : '';
const FILTER_STORAGE = 'nichegames:filters:v8.2';
const SCAN_STALE_MS = 180_000; // heartbeat missing for 3 minutes => cloud run stopped/died
const QUEUE_STALE_MS = 600_000; // GitHub never started the runner within 10 minutes
const $ = (id) => document.getElementById(id);
const ids = [
  'q','minCcu','maxCcu','createdWithinValue','createdWithinUnit','minVisits','creatorType','genre','genreModeNote','verifiedOnly','hasSocials','hasDiscord','savedOnly',
  'sort','orderBtn','cards','tableBody','tableWrap','loading','loadingTitle','loadingText','skeletons','empty','loadError','loadErrorText','retryBtn',
  'scanBtn','cancelBtn','allGamesBtn','resetBtn','scanCaption','scanCounter','scanProgress','scanProgressBar','resultLabel','resultRange','matchCount','totalCcu',
  'medianCcu','indexedCount','toast','pageSize','pagination','detailsModal','modalBackdrop','modalClose','modalContent',
  'gamesView','catalogView','creatorView','catalogRefreshBtn','coverageKnown','coverageResolved','coverageUnresolved','coveragePlaces','coverageProgressText','coverageProgressBar','coverageLastBuild','coverageNote',
  'lookupForm','lookupInput','lookupBtn','lookupStatus','creatorBackBtn','creatorAvatar','creatorTypeLabel','creatorTitle','creatorSubtitle','creatorGameCount','creatorTotalCcu','creatorTotalVisits','creatorRange','creatorCards','creatorPagination','creatorEmpty'
];
const els = Object.fromEntries(ids.map((id) => [id, $(id)]));

const nf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en-US');
let order = localStorage.getItem('nichegames:order') === 'asc' ? 'asc' : 'desc';
let currentView = localStorage.getItem('nichegames:view') || 'cards';
let saved = new Set(JSON.parse(localStorage.getItem('nichegames:saved') || '[]').map(Number));
let pageSize = Number(localStorage.getItem('nichegames:pageSize') || 24);
let currentPage = 1;
let allGamesMode = false;
let genreOnlyMode = false;
let currentRoute = 'games';
let creatorState = null;
let creatorPage = 1;
let lookupPollTimer = null;
let lookupScanId = null;
let lastPayload = null;
let currentScanId = null;
let pollTimer = null;
let pollStartedAt = 0;
let lastCatalogUpdateSeen = '';
let lastLiveReloadAt = 0;
let lastCloudStatusAt = 0;
let cloudRunSeen = false;
let legacyGamesCache = null;
let legacyGamesLoaded = false;
let filteredCache = [];
let filteredCacheSignature = '';
let statsCacheSignature = '';
let statsCache = { count:0, total:0, median:0 };
let lastRenderedTotal = 0;
const detailsCache = new Map();

if (![12, 24, 48, 96].includes(pageSize)) pageSize = 24;
els.pageSize.value = String(pageSize);
els.orderBtn.textContent = order === 'desc' ? '↓' : '↑';
els.orderBtn.title = order === 'desc' ? 'Sort descending' : 'Sort ascending';

function toWellFormedText(value = '') {
  const input = String(value);
  if (typeof input.toWellFormed === 'function') return input.toWellFormed();
  let output = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += input[i] + input[i + 1];
        i += 1;
      } else {
        output += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      output += '\uFFFD';
    } else {
      output += input[i];
    }
  }
  return output;
}

function safeEncodeURIComponent(value = '') {
  return encodeURIComponent(toWellFormedText(value));
}

function escapeHtml(value = '') {
  return toWellFormedText(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}


const GENRE_ALIASES = {
  'horror': ['horror','scary','survival horror','psychological horror'],
  'action': ['action','fighting','battlegrounds'],
  'adventure': ['adventure','exploration','story'],
  'obby & platformer': ['obby','platformer','tower obby','runner'],
  'party & casual': ['party','casual','minigame','quiz'],
  'rpg': ['rpg','roleplaying game','action rpg'],
  'roleplay & avatar sim': ['roleplay','avatar sim','life','dress up'],
  'shooter': ['shooter','fps','pve shooter','deathmatch'],
  'simulation': ['simulation','simulator','tycoon','sandbox','vehicle sim'],
  'sports & racing': ['sports','racing','football','basketball','soccer'],
  'strategy': ['strategy','tower defense','board game'],
  'survival': ['survival','escape','1 vs all']
};
function normalizedGenre(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function gameMatchesGenreClient(game, genre) {
  const wanted = normalizedGenre(genre);
  if (!wanted || wanted === 'all') return true;
  const tags = Array.isArray(game.genreTags) ? game.genreTags.map(normalizedGenre) : [];
  const structured = [game.genre, game.subgenre, ...tags].map(normalizedGenre).filter(Boolean);
  if (structured.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value))) return true;
  const terms = GENRE_ALIASES[wanted] || [wanted];
  const haystack = normalizedGenre(`${game.name || ''} ${game.genre || ''} ${game.subgenre || ''}`);
  return terms.some((term) => haystack.includes(normalizedGenre(term)));
}
function syncGenreOnlyUi() {
  const selected = String(els.genre.value || 'all');
  const active = genreOnlyMode && selected !== 'all';
  const locked = ['q','minCcu','maxCcu','createdWithinValue','createdWithinUnit','minVisits','creatorType','verifiedOnly','hasSocials','hasDiscord','savedOnly'];
  for (const id of locked) if (els[id]) els[id].disabled = active;
  els.genre.classList.toggle('genre-active', active);
  if (els.genreModeNote) els.genreModeNote.textContent = active
    ? `${selected} only · CCU, date, visits, creator, search, and saved filters are ignored.`
    : 'Choose a genre to enter genre-only mode. Other filters are ignored so the scan focuses on that category.';
  const label = els.scanBtn?.querySelector('.button-label');
  if (label && !els.scanBtn.classList.contains('scanning')) label.textContent = active ? `Scan ${selected} games` : 'Scan for new games';
  if (!els.scanBtn.classList.contains('scanning')) {
    els.scanCaption.textContent = active ? `${selected} genre-only mode · existing matches load instantly` : (allGamesMode ? 'All games mode · shows full stored catalog + resolves unloaded known IDs' : 'Uses the filters shown below');
  }
}
function enableGenreOnlyMode() {
  if (els.genre.value === 'all') { genreOnlyMode = false; syncGenreOnlyUi(); return; }
  allGamesMode = false;
  genreOnlyMode = true;
  syncAllGamesUi();
  syncGenreOnlyUi();
}

function placeholder(name = 'Game') {
  const initials = toWellFormedText(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'G';
  const safeInitials = escapeHtml(initials);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#171a21"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#4c5360" font-family="Arial" font-size="104" font-weight="700">${safeInitials}</text></svg>`;
  return `data:image/svg+xml,${safeEncodeURIComponent(svg)}`;
}

function relativeCreated(created) {
  if (!created) return 'Unknown';
  const createdAt = new Date(created).getTime();
  if (!Number.isFinite(createdAt)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks}w ago`;
  const months = Math.floor(days / 30.4375);
  if (days < 730) return `${months}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

function fullCreated(created) {
  if (!created) return 'Unknown creation date';
  const date = new Date(created);
  return Number.isNaN(date.getTime()) ? 'Unknown creation date' : date.toLocaleString();
}

function ratingLabel(game) { return game.rating == null ? '—' : `${Math.round(game.rating)}%`; }
function deltaText(delta = 0) {
  const value = Number(delta || 0);
  if (value > 0) return { cls: 'up', text: `+${exact.format(value)}` };
  if (value < 0) return { cls: 'down', text: exact.format(value) };
  return { cls: '', text: 'No change' };
}

function socialBadgeHtml(game) {
  const types = Array.isArray(game.socialTypes) ? game.socialTypes : [];
  if (game.hasDiscord) return '<span class="social-chip discord">Discord</span>';
  if (game.hasSocials) return `<span class="social-chip">${types.length ? escapeHtml(types[0]) : 'Socials'}</span>`;
  return '';
}

function safeExternalUrl(raw = '') {
  try {
    const url = new URL(String(raw || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function modalSocialsHtml(game) {
  const socials = Array.isArray(game.socials) ? game.socials : [];
  if (!socials.length) {
    const label = game.socialsCheckedAt ? 'No public socials found.' : 'Social links have not been checked yet.';
    return `<div class="modal-socials"><span>Socials</span><p class="social-empty">${label}</p></div>`;
  }
  const links = socials.map((item) => {
    const href = safeExternalUrl(item.url);
    if (!href) return '';
    const source = item.source === 'creator' ? 'Creator' : item.source === 'description' ? 'About' : 'Game';
    return `<a class="social-link ${String(item.type || '').toLowerCase() === 'discord' ? 'discord' : ''}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><b>${escapeHtml(item.type || item.title || 'Social')}</b><small>${source}</small></a>`;
  }).filter(Boolean).join('');
  return `<div class="modal-socials"><span>Socials</span><div class="social-link-grid">${links}</div></div>`;
}

function gameCard(game) {
  const isSaved = saved.has(Number(game.id));
  const delta = deltaText(game.ccuDelta);
  const creator = game.creator || { name: 'Unknown', verified: false };
  return `<article class="game-card" data-id="${game.id}">
    <div class="thumb-wrap"><img src="${game.icon || placeholder(game.name)}" onerror="this.src='${placeholder(game.name)}'" alt="" loading="lazy" /><span class="live-count">${exact.format(game.playing || 0)} playing</span><button class="save-btn ${isSaved ? 'saved' : ''}" data-save="${game.id}" type="button" aria-label="${isSaved ? 'Unsave' : 'Save'} ${escapeHtml(game.name)}">${isSaved ? '★' : '☆'}</button></div>
    <div class="game-body"><div class="game-heading"><div><h3 title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</h3><p title="${escapeHtml(creator.name)}"><button class="creator-link" type="button" data-creator-id="${Number(creator.id || 0)}" data-creator-type="${escapeHtml(creator.type || 'Unknown')}" data-creator-name="${escapeHtml(creator.name || 'Unknown')}">${escapeHtml(creator.name)}${creator.verified ? ' · Verified' : ''}</button></p></div><div class="ccu-block"><strong>${nf.format(game.playing || 0)}</strong><span class="ccu-change ${delta.cls}">${delta.text}</span></div></div>${socialBadgeHtml(game)}
    <div class="game-meta"><div><span>Created</span><b title="${escapeHtml(fullCreated(game.created))}">${relativeCreated(game.created)}</b></div><div><span>Visits</span><b>${nf.format(game.visits || 0)}</b></div><div><span>Rating</span><b>${ratingLabel(game)}</b></div></div>
    <div class="card-actions"><button class="open-btn" data-open="${escapeHtml(game.robloxUrl || '')}" type="button">Open on Roblox</button><button class="details-btn" data-details="${game.id}" type="button">Details</button></div></div>
  </article>`;
}

function gameRow(game) {
  const creator = game.creator || { name: 'Unknown', verified: false };
  const delta = deltaText(game.ccuDelta);
  return `<tr><td><div class="table-game"><img src="${game.icon || placeholder(game.name)}" onerror="this.src='${placeholder(game.name)}'" alt="" loading="lazy"/><div><b>${escapeHtml(game.name)}</b><small><button class="creator-link table-creator-link" type="button" data-creator-id="${Number(creator.id || 0)}" data-creator-type="${escapeHtml(creator.type || 'Unknown')}" data-creator-name="${escapeHtml(creator.name || 'Unknown')}">${escapeHtml(creator.name)}${creator.verified ? ' · Verified' : ''}</button></small></div></div></td><td><strong>${exact.format(game.playing || 0)}</strong> <span class="ccu-change ${delta.cls}">${delta.text}</span></td><td title="${escapeHtml(fullCreated(game.created))}">${relativeCreated(game.created)}</td><td>${nf.format(game.visits || 0)}</td><td>${ratingLabel(game)}</td><td><button class="creator-link table-creator-link" type="button" data-creator-id="${Number(creator.id || 0)}" data-creator-type="${escapeHtml(creator.type || 'Unknown')}" data-creator-name="${escapeHtml(creator.name || 'Unknown')}">${escapeHtml(creator.name)}</button></td><td><button class="table-action" data-details="${game.id}" type="button">Details</button></td></tr>`;
}

function renderSkeletons(count = 9) {
  els.skeletons.innerHTML = Array.from({ length: count }, () => `<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line short"></div><div class="skeleton-line"></div></div></div>`).join('');
}
renderSkeletons();

function activeFilters() {
  return {
    allGames: allGamesMode,
    genreOnly: genreOnlyMode && els.genre.value !== 'all',
    q: els.q.value.trim(),
    minCcu: Number(els.minCcu.value || 0),
    maxCcu: Number(els.maxCcu.value || Number.MAX_SAFE_INTEGER),
    createdWithinValue: Math.max(1, Number(els.createdWithinValue.value || 30)),
    createdWithinUnit: els.createdWithinUnit.value || 'days',
    minVisits: Number(els.minVisits.value || 0),
    creatorType: els.creatorType.value,
    genre: els.genre.value,
    verifiedOnly: els.verifiedOnly.checked,
    hasSocials: els.hasSocials.checked,
    hasDiscord: els.hasDiscord.checked,
  };
}
function saveFilters() {
  const data = { ...activeFilters(), savedOnly: els.savedOnly.checked, sort: els.sort.value };
  localStorage.setItem(FILTER_STORAGE, JSON.stringify(data));
}
let restoredGenre = 'all';
function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_STORAGE) || '{}');
    allGamesMode = Boolean(f.allGames);
    genreOnlyMode = Boolean(f.genreOnly);
    if (typeof f.q === 'string') els.q.value = f.q;
    if (Number.isFinite(Number(f.minCcu))) els.minCcu.value = Number(f.minCcu);
    if (Number.isFinite(Number(f.maxCcu))) els.maxCcu.value = Number(f.maxCcu);
    if (Number.isFinite(Number(f.createdWithinValue))) els.createdWithinValue.value = Math.max(1, Number(f.createdWithinValue));
    if (['hours','days','weeks','months','years','all'].includes(f.createdWithinUnit)) els.createdWithinUnit.value = f.createdWithinUnit;
    if (Number.isFinite(Number(f.minVisits))) els.minVisits.value = Number(f.minVisits);
    if (['all','User','Group'].includes(f.creatorType)) els.creatorType.value = f.creatorType;
    restoredGenre = typeof f.genre === 'string' ? f.genre : 'all';
    els.verifiedOnly.checked = Boolean(f.verifiedOnly);
    els.hasSocials.checked = Boolean(f.hasSocials);
    els.hasDiscord.checked = Boolean(f.hasDiscord);
    els.savedOnly.checked = Boolean(f.savedOnly);
    if ([...els.sort.options].some((o) => o.value === f.sort)) els.sort.value = f.sort;
  } catch {}
  syncCreatedPreset();
  syncCreatedInput();
  syncAllGamesUi();
  if (restoredGenre === 'all') genreOnlyMode = false;
  syncGenreOnlyUi();
}
function syncCreatedInput() {
  const allTime = els.createdWithinUnit.value === 'all';
  els.createdWithinValue.disabled = allTime;
  els.createdWithinValue.setAttribute('aria-disabled', allTime ? 'true' : 'false');
}

function filterSignature(payload) {
  const f = activeFilters();
  return JSON.stringify({
    scan: payload?.meta?.latestScanId || '',
    count: payload?.games?.length || 0,
    allGames: f.allGames,
    genreOnly: f.genreOnly,
    q: f.q,
    minCcu: f.minCcu,
    maxCcu: f.maxCcu,
    createdWithinValue: f.createdWithinValue,
    createdWithinUnit: f.createdWithinUnit,
    minVisits: f.minVisits,
    creatorType: f.creatorType,
    genre: f.genre,
    verifiedOnly: f.verifiedOnly,
    hasSocials: f.hasSocials,
    hasDiscord: f.hasDiscord,
    savedOnly: els.savedOnly.checked,
    saved: els.savedOnly.checked ? [...saved].sort((a,b) => a-b) : [],
    sort: els.sort.value,
    order,
  });
}

function invalidateFilterCache() {
  filteredCacheSignature = '';
  statsCacheSignature = '';
}

function filteredGames(payload) {
  const signature = filterSignature(payload);
  if (signature === filteredCacheSignature) return filteredCache;

  let games = Array.isArray(payload?.games) ? [...payload.games] : [];
  const f = activeFilters();
  const q = f.q.toLowerCase();
  if (f.genreOnly && f.genre !== 'all') {
    games = games.filter((game) => gameMatchesGenreClient(game, f.genre));
  } else if (!f.allGames) games = games.filter((game) => {
    const playing = Number(game.playing || 0);
    if (playing < f.minCcu || playing > f.maxCcu) return false;
    if (Number(game.visits || 0) < f.minVisits) return false;
    if (!isWithinCreatedWindow(game.created, f.createdWithinValue, f.createdWithinUnit)) return false;
    if (f.creatorType !== 'all' && String(game.creator?.type || '') !== f.creatorType) return false;
    if (f.genre !== 'all' && !gameMatchesGenreClient(game, f.genre)) return false;
    if (f.verifiedOnly && !game.creator?.verified) return false;
    if (f.hasSocials && !game.hasSocials) return false;
    if (f.hasDiscord && !game.hasDiscord) return false;
    if (els.savedOnly.checked && !saved.has(Number(game.id))) return false;
    if (q) {
      // The compact v7.2 index intentionally omits descriptions for speed.
      const haystack = `${game.name || ''} ${game.creator?.name || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const getters = {
    playing: (g) => Number(g.playing || 0),
    created: (g) => new Date(g.created || 0).getTime(),
    delta: (g) => Number(g.ccuDelta || 0),
    visits: (g) => Number(g.visits || 0),
    favorites: (g) => Number(g.favorites || 0),
    rating: (g) => g.rating == null ? -1 : Number(g.rating),
    name: (g) => String(g.name || '').toLowerCase(),
  };
  const getter = getters[els.sort.value] || getters.playing;
  const direction = order === 'asc' ? 1 : -1;
  games.sort((a, b) => {
    const av = getter(a), bv = getter(b);
    if (typeof av === 'string') return av.localeCompare(bv) * direction;
    return (av - bv) * direction;
  });

  filteredCache = games;
  filteredCacheSignature = signature;
  return games;
}

function localStats(games) {
  const signature = filteredCacheSignature;
  if (signature && signature === statsCacheSignature) return statsCache;
  const ccu = games.map((g) => Number(g.playing || 0)).sort((a, b) => a - b);
  const middle = Math.floor(ccu.length / 2);
  const median = !ccu.length ? 0 : ccu.length % 2 ? ccu[middle] : Math.round((ccu[middle - 1] + ccu[middle]) / 2);
  statsCache = { count: games.length, total: ccu.reduce((a, b) => a + b, 0), median };
  statsCacheSignature = signature;
  return statsCache;
}

function updateGenreOptions(genres = []) {
  const current = els.genre.value;
  const values = new Set([...els.genre.options].map((o) => o.value));
  for (const genre of genres) {
    if (!genre || values.has(genre)) continue;
    const option = document.createElement('option'); option.value = genre; option.textContent = genre; els.genre.append(option); values.add(genre);
  }
  const wanted = restoredGenre !== 'all' ? restoredGenre : current;
  if ([...els.genre.options].some((option) => option.value === wanted)) els.genre.value = wanted;
  if (els.genre.value === 'all') genreOnlyMode = false;
  syncGenreOnlyUi();
}

function paginationItems(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((v) => v >= 1 && v <= pages));
  const values = [...keep].sort((a, b) => a - b), out = [];
  for (let i = 0; i < values.length; i += 1) { if (i && values[i] - values[i - 1] > 1) out.push('…'); out.push(values[i]); }
  return out;
}

function renderPagination(total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.max(1, Math.min(currentPage, pages));
  if (total <= pageSize) { els.pagination.classList.add('hidden'); els.pagination.innerHTML = ''; return; }
  const items = paginationItems(currentPage, pages);
  els.pagination.innerHTML = `<span class="page-summary">Page ${currentPage} of ${pages}</span><div class="page-buttons"><button type="button" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>${items.map((item) => item === '…' ? '<span class="page-ellipsis">…</span>' : `<button type="button" class="page-number ${item === currentPage ? 'active' : ''}" data-page="${item}">${item}</button>`).join('')}<button type="button" data-page="${currentPage + 1}" ${currentPage === pages ? 'disabled' : ''}>Next</button></div>`;
  els.pagination.classList.remove('hidden');
}

function render(payload) {
  if (payload !== lastPayload) {
    lastPayload = payload;
    invalidateFilterCache();
  }
  const all = filteredGames(payload);
  const stats = localStats(all);
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  currentPage = Math.max(1, Math.min(currentPage, pages));
  const start = (currentPage - 1) * pageSize;
  const pageGames = all.slice(start, start + pageSize);
  const end = start + pageGames.length;

  els.cards.innerHTML = pageGames.map(gameCard).join('');
  els.tableBody.innerHTML = pageGames.map(gameRow).join('');
  els.resultLabel.textContent = exact.format(all.length);
  els.resultRange.textContent = all.length ? `${exact.format(start + 1)}–${exact.format(end)} of ${exact.format(all.length)}` : 'No matches in this scan';
  els.matchCount.textContent = exact.format(stats.count);
  els.totalCcu.textContent = nf.format(stats.total);
  els.medianCcu.textContent = nf.format(stats.median);
  els.indexedCount.textContent = exact.format(payload.meta?.candidateCount || payload.games?.length || 0);
  updateGenreOptions(payload.genres || []);
  renderPagination(all.length);

  const hasGames = all.length > 0;
  lastRenderedTotal = all.length;
  els.empty.classList.toggle('hidden', hasGames);
  if (!hasGames) {
    els.empty.querySelector('strong').textContent = payload.games?.length ? 'No matching games' : 'No games in this scan';
    els.empty.querySelector('span').textContent = payload.games?.length ? 'Broaden the filters or run another scan to grow/update the persistent catalog.' : 'Run a scan to build the Roblox catalog.';
  }
  els.loadError.classList.add('hidden');
  els.loading.classList.add('hidden');
  els.skeletons.classList.add('hidden');
  setView(currentView);
  if (currentRoute === 'creator') renderCreatorPage();
}

function setView(view) {
  currentView = view === 'table' ? 'table' : 'cards';
  localStorage.setItem('nichegames:view', currentView);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === currentView));
  const has = lastRenderedTotal > 0;
  els.cards.classList.toggle('hidden', currentView !== 'cards' || !has);
  els.tableWrap.classList.toggle('hidden', currentView !== 'table' || !has);
}

function showError(error) {
  els.loading.classList.add('hidden'); els.skeletons.classList.add('hidden');
  els.loadErrorText.textContent = error?.message || 'Nichegames could not load the current scan.';
  els.loadError.classList.remove('hidden');
}

function setScanUi(scanning, label = '') {
  els.scanBtn.disabled = scanning;
  els.scanBtn.classList.toggle('scanning', scanning);
  const selectedGenre = String(els.genre.value || 'all');
  els.scanBtn.querySelector('.button-label').textContent = scanning ? 'Scanning…' : (genreOnlyMode && selectedGenre !== 'all' ? `Scan ${selectedGenre} games` : 'Scan for new games');
  els.cancelBtn.classList.toggle('hidden', !scanning);
  els.cancelBtn.disabled = false;
  if (scanning) {
    els.scanCaption.textContent = label || 'Starting scan…';
    els.scanCounter.classList.remove('hidden');
    els.scanCounter.textContent = 'Preparing scan…';
    els.scanProgress.classList.remove('hidden');
  } else {
    els.scanCaption.textContent = genreOnlyMode && selectedGenre !== 'all' ? `${selectedGenre} genre-only mode · existing matches load instantly` : (allGamesMode ? 'All games mode · shows full stored catalog + resolves unloaded known IDs' : 'Uses the filters shown below');
    els.scanCounter.classList.add('hidden');
    els.scanCounter.textContent = '';
    els.scanProgress.classList.add('hidden');
    els.scanProgressBar.style.width = '0%';
  }
}

function progressUi(scan) {
  const phaseProcessed = Math.max(0, Number(scan.processed || 0));
  const phaseTotal = Math.max(0, Number(scan.total || 0));
  const checked = Math.max(0, Number(scan.gamesScanned || phaseProcessed || 0));
  const toCheck = Math.max(0, Number(scan.gamesToScan || phaseTotal || 0));
  const cachedMatches = Math.max(0, Number(scan.cachedMatches || 0));
  const matchedCount = Math.max(0, Number(scan.matchedCount || cachedMatches || 0));

  const pct = toCheck > 0
    ? Math.min(100, Math.max(2, (checked / toCheck) * 100))
    : phaseTotal > 0
      ? Math.min(100, Math.max(2, (phaseProcessed / phaseTotal) * 100))
      : 8;

  els.scanProgressBar.style.width = `${pct}%`;
  els.scanCaption.textContent = scan.label || 'Scanning for new games…';
  els.loadingTitle.textContent = 'Scanning for new games';
  els.loadingText.textContent = scan.label || 'Looking for new matching games…';
  els.scanCounter.classList.remove('hidden');

  if (toCheck > 0) {
    const done = Math.min(checked, toCheck);
    const percent = Math.round((done / toCheck) * 100);
    els.scanCounter.textContent = scan.filters?.allGames ? `${exact.format(matchedCount)} games ready · resolved ${exact.format(done)} / ${exact.format(toCheck)} unloaded known IDs · ${percent}%` : `${exact.format(matchedCount)} matches ready · loaded ${exact.format(done)} / ${exact.format(toCheck)} new matching candidates · ${percent}%`;
  } else if (cachedMatches > 0) {
    els.scanCounter.textContent = `${exact.format(cachedMatches)} existing matches ready · looking only for new matching games`;
  } else if (Number(scan.discovered || 0) > 0) {
    els.scanCounter.textContent = `${exact.format(Number(scan.discovered || 0))} possible new games found so far`;
  } else if (Number(scan.cachedGames || scan.catalogBefore || 0) > 0) {
    els.scanCounter.textContent = `${exact.format(Number(scan.cachedGames || scan.catalogBefore || 0))} catalog games already available`;
  } else {
    els.scanCounter.textContent = 'Looking for matching games…';
  }
}

function dbUrl(path = '') {
  const clean = String(path).split('/').filter(Boolean).map(safeEncodeURIComponent).join('/');
  return `${DATABASE_ROOT}${clean ? `/${clean}` : ''}.json`;
}

async function dbGet(path = '') {
  let response;
  try { response = await fetch(dbUrl(path), { cache: 'no-store' }); }
  catch { throw new Error('Could not reach Firebase Realtime Database.'); }
  if (!response.ok) throw new Error(`Realtime Database request failed (${response.status})`);
  return await response.json();
}

async function dbGetShallow(path = '') {
  let response;
  try { response = await fetch(`${dbUrl(path)}?shallow=true`, { cache:'no-store' }); }
  catch { throw new Error('Could not reach Firebase Realtime Database.'); }
  if (!response.ok) throw new Error(`Realtime Database request failed (${response.status})`);
  return await response.json();
}

function routeUrl(route, creator = null) {
  const url = new URL(window.location.href);
  url.search = '';
  if (route === 'catalog') url.searchParams.set('view', 'catalog');
  if (route === 'creator' && creator) {
    url.searchParams.set('creatorId', String(Number(creator.id || 0)));
    url.searchParams.set('creatorType', String(creator.type || 'Unknown'));
    url.searchParams.set('creatorName', String(creator.name || 'Unknown'));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function setRoute(route, { creator = null, push = true } = {}) {
  currentRoute = route === 'catalog' ? 'catalog' : route === 'creator' ? 'creator' : 'games';
  if (creator) creatorState = creator;
  els.gamesView.classList.toggle('hidden', currentRoute !== 'games');
  els.catalogView.classList.toggle('hidden', currentRoute !== 'catalog');
  els.creatorView.classList.toggle('hidden', currentRoute !== 'creator');
  document.querySelectorAll('[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === currentRoute || (currentRoute === 'creator' && button.dataset.route === 'games')));
  if (push) history.pushState({ route:currentRoute }, '', routeUrl(currentRoute, creatorState));
  if (currentRoute === 'catalog') loadCoverage();
  if (currentRoute === 'creator') renderCreatorPage();
  window.scrollTo({ top:0, behavior:'smooth' });
}

function routeFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('creatorName') || params.get('creatorId')) {
    creatorState = {
      id:Number(params.get('creatorId') || 0),
      type:String(params.get('creatorType') || 'Unknown'),
      name:String(params.get('creatorName') || 'Unknown'),
    };
    setRoute('creator', { creator:creatorState, push:false });
  } else if (params.get('view') === 'catalog') {
    setRoute('catalog', { push:false });
  } else {
    setRoute('games', { push:false });
  }
}

function creatorMatches(game, creator) {
  if (!creator) return false;
  const value = game.creator || {};
  const wantedId = Number(creator.id || 0);
  if (wantedId > 0 && Number(value.id || 0) > 0) return Number(value.id) === wantedId && String(value.type || '') === String(creator.type || '');
  return String(value.name || '').toLowerCase() === String(creator.name || '').toLowerCase() && String(value.type || '') === String(creator.type || '');
}

function renderCreatorPagination(total) {
  const size = 24;
  const pages = Math.max(1, Math.ceil(total / size));
  creatorPage = Math.max(1, Math.min(creatorPage, pages));
  if (total <= size) { els.creatorPagination.classList.add('hidden'); els.creatorPagination.innerHTML = ''; return; }
  const items = paginationItems(creatorPage, pages);
  els.creatorPagination.innerHTML = `<span class="page-summary">Page ${creatorPage} of ${pages}</span><div class="page-buttons"><button type="button" data-creator-page="${creatorPage - 1}" ${creatorPage === 1 ? 'disabled' : ''}>Previous</button>${items.map((item) => item === '…' ? '<span class="page-ellipsis">…</span>' : `<button type="button" class="page-number ${item === creatorPage ? 'active' : ''}" data-creator-page="${item}">${item}</button>`).join('')}<button type="button" data-creator-page="${creatorPage + 1}" ${creatorPage === pages ? 'disabled' : ''}>Next</button></div>`;
  els.creatorPagination.classList.remove('hidden');
}

function renderCreatorPage() {
  if (!creatorState || !lastPayload) return;
  const games = (lastPayload.games || []).filter((game) => creatorMatches(game, creatorState)).sort((a,b) => Number(b.playing || 0) - Number(a.playing || 0));
  const size = 24;
  const pages = Math.max(1, Math.ceil(games.length / size));
  creatorPage = Math.max(1, Math.min(creatorPage, pages));
  const start = (creatorPage - 1) * size;
  const visible = games.slice(start, start + size);
  const totalCcu = games.reduce((sum, game) => sum + Number(game.playing || 0), 0);
  const totalVisits = games.reduce((sum, game) => sum + Number(game.visits || 0), 0);
  const initials = String(creatorState.name || '?').split(/\s+/).filter(Boolean).slice(0,2).map((part) => part[0]).join('').toUpperCase() || '?';
  els.creatorAvatar.textContent = initials;
  els.creatorTypeLabel.textContent = creatorState.type && creatorState.type !== 'Unknown' ? `${creatorState.type} creator` : 'Creator';
  els.creatorTitle.textContent = creatorState.name || 'Unknown creator';
  els.creatorSubtitle.textContent = creatorState.id ? `Creator ID ${creatorState.id} · games known to Nichegames` : 'Games known to Nichegames';
  els.creatorGameCount.textContent = exact.format(games.length);
  els.creatorTotalCcu.textContent = nf.format(totalCcu);
  els.creatorTotalVisits.textContent = nf.format(totalVisits);
  els.creatorRange.textContent = games.length ? `${exact.format(start + 1)}–${exact.format(start + visible.length)} of ${exact.format(games.length)}` : '';
  els.creatorCards.innerHTML = visible.map(gameCard).join('');
  els.creatorCards.classList.toggle('hidden', !games.length);
  els.creatorEmpty.classList.toggle('hidden', Boolean(games.length));
  renderCreatorPagination(games.length);
}

function openCreatorPage(creator) {
  if (!creator || (!Number(creator.id || 0) && !creator.name)) return;
  creatorPage = 1;
  setRoute('creator', { creator:{ id:Number(creator.id || 0), type:String(creator.type || 'Unknown'), name:String(creator.name || 'Unknown') } });
}

async function loadCoverage() {
  els.coverageNote.textContent = 'Reading catalog coverage from Realtime Database…';
  try {
    const [meta, knownRaw, indexKeys, fullKeys, legacyKeys, placeMapRaw] = await Promise.all([
      dbGet('meta'), dbGet('knownIds'), dbGetShallow('catalog/index'), dbGetShallow('catalog/games'), dbGetShallow('games'), dbGet('placeToUniverse'),
    ]);
    const resolved = new Set([...Object.keys(indexKeys || {}), ...Object.keys(fullKeys || {}), ...Object.keys(legacyKeys || {})].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
    const known = new Set(Object.keys(knownRaw || {}).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
    for (const id of resolved) known.add(id);
    for (const [place, universe] of Object.entries(placeMapRaw || {})) {
      const placeId = Number(place), universeId = Number(universe);
      if (known.has(placeId) && Number.isSafeInteger(universeId) && universeId > 0) { known.delete(placeId); known.add(universeId); }
    }
    const unresolved = [...known].filter((id) => !resolved.has(id)).length;
    const resolvedCount = resolved.size;
    const knownCount = Math.max(known.size, resolvedCount);
    const pct = knownCount ? Math.min(100, (resolvedCount / knownCount) * 100) : 0;
    els.coverageKnown.textContent = exact.format(knownCount);
    els.coverageResolved.textContent = exact.format(resolvedCount);
    els.coverageUnresolved.textContent = exact.format(unresolved);
    els.coveragePlaces.textContent = exact.format(Object.keys(placeMapRaw || {}).length);
    els.coverageProgressText.textContent = `${exact.format(resolvedCount)} / ${exact.format(knownCount)} resolved · ${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
    els.coverageProgressBar.style.width = `${pct}%`;
    els.coverageProgressBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(pct)));
    els.coverageLastBuild.textContent = meta?.lastCatalogBuildAt ? relativeCreated(meta.lastCatalogBuildAt) : 'Not run yet';
    els.coverageLastBuild.title = meta?.lastCatalogBuildAt ? fullCreated(meta.lastCatalogBuildAt) : '';
    els.coverageNote.textContent = unresolved ? `${exact.format(unresolved)} discovered IDs still need Roblox metadata. The catalog builder works through that backlog separately from user searches.` : 'Every currently known ID has a resolved catalog record.';
  } catch (error) {
    els.coverageNote.textContent = error?.message || 'Could not load catalog coverage.';
  }
}

function setLookupStatus(message, type = '') {
  els.lookupStatus.textContent = message;
  els.lookupStatus.className = `lookup-status${type ? ` ${type}` : ''}`;
  els.lookupStatus.classList.toggle('hidden', !message);
}

async function pollLookup(scanId, startedAt = Date.now()) {
  clearTimeout(lookupPollTimer);
  try {
    const scan = await dbGet(`scans/${scanId}`);
    if (!scan) {
      if (Date.now() - startedAt > QUEUE_STALE_MS) throw new Error('The cloud lookup did not start.');
      setLookupStatus('Cloud lookup is starting…', 'loading');
      lookupPollTimer = setTimeout(() => pollLookup(scanId, startedAt), 1500);
      return;
    }
    if (scan.status === 'complete' && scan.lookupGameId) {
      lookupScanId = null;
      els.lookupBtn.disabled = false;
      els.lookupBtn.textContent = 'Find game';
      setLookupStatus(`${scan.lookupGameName || 'Game'} added to the catalog.`, 'success');
      await loadGames({ preserveActiveScan:true });
      setRoute('games', { push:true });
      await showDetails(Number(scan.lookupGameId));
      return;
    }
    if (scan.status === 'error') throw new Error(scan.error || 'Could not resolve that Roblox game.');
    if (scan.status === 'cancelled' || scan.status === 'stopped') throw new Error('Game lookup stopped.');
    setLookupStatus(scan.label || 'Resolving Roblox game…', 'loading');
    lookupPollTimer = setTimeout(() => pollLookup(scanId, startedAt), 1400);
  } catch (error) {
    lookupScanId = null;
    els.lookupBtn.disabled = false;
    els.lookupBtn.textContent = 'Find game';
    setLookupStatus(error?.message || 'Could not find that game.', 'error');
  }
}

async function startLookup(event) {
  event?.preventDefault?.();
  const input = els.lookupInput.value.trim();
  if (!input) { setLookupStatus('Paste a Roblox game URL, place ID, or universe ID first.', 'error'); return; }
  if (!LOOKUP_ENDPOINT) { setLookupStatus('Direct lookup is not configured yet. Redeploy the Cloudflare Worker from this version.', 'error'); return; }
  els.lookupBtn.disabled = true;
  els.lookupBtn.textContent = 'Finding…';
  setLookupStatus('Sending the game to the cloud resolver…', 'loading');
  try {
    const response = await fetch(LOOKUP_ENDPOINT, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ input }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.scanId) throw new Error(data.error || `Could not start lookup (${response.status})`);
    lookupScanId = String(data.scanId);
    pollLookup(lookupScanId, Date.now());
  } catch (error) {
    els.lookupBtn.disabled = false;
    els.lookupBtn.textContent = 'Find game';
    setLookupStatus(error?.message || 'Could not start game lookup.', 'error');
  }
}

function compactForClient(value = {}) {
  const creator = value.creator || {};
  return {
    id:Number(value.id || 0),
    rootPlaceId:Number(value.rootPlaceId || 0),
    name:String(value.name || 'Untitled Experience'),
    creator:{ id:Number(creator.id || 0), name:String(creator.name || 'Unknown'), type:String(creator.type || 'Unknown'), verified:Boolean(creator.verified ?? creator.hasVerifiedBadge) },
    playing:Number(value.playing || 0),
    ccuDelta:Number(value.ccuDelta || 0),
    visits:Number(value.visits || 0),
    favorites:Number(value.favorites ?? value.favoritedCount ?? 0),
    maxPlayers:Number(value.maxPlayers || 0),
    created:value.created || null,
    updated:value.updated || null,
    genre:String(value.genre || value.genre_l1 || 'Unknown'),
    subgenre:String(value.subgenre || value.genre_l2 || ''),
    rating:value.rating == null ? null : Number(value.rating),
    voteCount:Number(value.voteCount || 0) || Number(value.votes?.up || 0) + Number(value.votes?.down || 0),
    icon:String(value.icon || ''),
    robloxUrl:String(value.robloxUrl || (value.rootPlaceId ? `https://www.roblox.com/games/${value.rootPlaceId}` : '')),
    lastCheckedAt:value.lastCheckedAt || null,
  };
}

function rawGameMap(...sources) {
  const map = new Map();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const value of Object.values(source)) {
      if (!value || typeof value !== 'object') continue;
      const id = Number(value.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      map.set(id, compactForClient(value));
    }
  }
  return map;
}

function catalogPayload(meta, ...rawSources) {
  const map = rawGameMap(...rawSources);
  const games = [...map.values()];
  return {
    games,
    genres: [...new Set(games.map((game) => game.genre).filter(Boolean))].sort(),
    meta: { ...(meta || {}), candidateCount: games.length, catalogGames: games.length },
  };
}

let fullCatalogCache = null;
let fullCatalogLoaded = false;

async function loadGames({ preserveActiveScan = false } = {}) {
  const [meta, index] = await Promise.all([dbGet('meta'), dbGet('catalog/index')]);
  const source = (index && typeof index === 'object') ? index : {};

  // Performance v8.3: the compact index is the homepage data source. Do NOT
  // eagerly download /catalog/games (descriptions + socials) for every visitor.
  // Full records are fetched one-at-a-time only when Details is opened.
  let payload = catalogPayload(meta || {}, source);
  if (!preserveActiveScan) currentScanId = String(meta?.latestScanId || '');
  render(payload);

  // Older deployments could leave catalog/index behind catalog/games. Only pay
  // the cost of loading the full tree when meta proves the compact index is short.
  // Once the catalog builder repairs the index, normal page loads stay tiny.
  const expected = Number(meta?.catalogGames || 0);
  if (expected > payload.games.length && !fullCatalogLoaded) {
    fullCatalogLoaded = true;
    try {
      fullCatalogCache = await dbGet('catalog/games') || {};
      payload = catalogPayload(meta || {}, fullCatalogCache, source);
      render(payload);
    } catch { fullCatalogCache = {}; }
  }

  // Legacy /games is now migration-only. Pull it only when the server says a
  // migration is still pending instead of downloading it on every browser load.
  const legacyExpected = Number(meta?.legacyGamesPending || 0);
  if (legacyExpected > 0 && !legacyGamesLoaded) {
    legacyGamesLoaded = true;
    try {
      legacyGamesCache = await dbGet('games') || {};
      payload = catalogPayload(meta || {}, legacyGamesCache, fullCatalogCache || {}, source);
      render(payload);
    } catch { legacyGamesCache = {}; }
  }

  return payload;
}

async function loadLatest({ quiet = false } = {}) {
  if (!quiet) {
    els.loading.classList.remove('hidden');
    els.loadingTitle.textContent = 'Loading games';
    els.loadingText.textContent = 'Reading the last completed scan from Realtime Database…';
  }
  try {
    const payload = await loadGames();
    if (!payload) {
      els.loading.classList.add('hidden');
      els.loadError.classList.add('hidden');
      els.skeletons.classList.add('hidden');
      els.empty.classList.remove('hidden');
      els.empty.querySelector('strong').textContent = 'No completed scan yet';
      els.empty.querySelector('span').textContent = 'Press Scan for new games to grow the cloud catalog.';
    }
  } catch (error) {
    if (!quiet) showError(error);
  }
}

async function cloudRunStatus(scanId) {
  if (!STATUS_ENDPOINT || !scanId) return null;
  try {
    const response = await fetch(`${STATUS_ENDPOINT}?scanId=${safeEncodeURIComponent(scanId)}`, { cache:'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function cloudRunIsStopped(status) {
  if (!status) return false;
  if (!status.found) return cloudRunSeen;
  cloudRunSeen = true;
  if (status.status !== 'completed') return false;
  return ['cancelled','failure','timed_out','stale','action_required'].includes(String(status.conclusion || ''));
}

async function cancelScan() {
  if (!currentScanId || !CANCEL_ENDPOINT) return;
  els.cancelBtn.disabled = true;
  els.cancelBtn.textContent = 'Cancelling…';
  clearTimeout(pollTimer);
  try {
    const response = await fetch(CANCEL_ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ scanId:currentScanId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not cancel scan (${response.status})`);
    localStorage.setItem(`nichegames:cancelled:${currentScanId}`, String(Date.now()));
    currentScanId = null;
    setScanUi(false);
    els.loading.classList.add('hidden');
    toast(data.forced ? 'Scan force-cancelled' : 'Scan cancelled');
  } catch (error) {
    els.cancelBtn.disabled = false;
    els.cancelBtn.textContent = 'Cancel';
    toast(error?.message || 'Could not cancel scan');
    if (currentScanId) pollScan(currentScanId);
  }
}

async function pollScan(scanId) {
  clearTimeout(pollTimer);
  try {
    const scan = await dbGet(`scans/${scanId}`);

    // Firebase can remain stuck on "processing" if a workflow is cancelled or
    // deleted before its cleanup step writes back. Ask the Worker/GitHub for the
    // real run state every few seconds so the website stops immediately too.
    if (STATUS_ENDPOINT && Date.now() - lastCloudStatusAt > 7000) {
      lastCloudStatusAt = Date.now();
      const cloud = await cloudRunStatus(scanId);
      if (cloud?.found) cloudRunSeen = true;
      const deletedAfterStart = cloud && !cloud.found && (cloudRunSeen || Boolean(scan));
      if (cloudRunIsStopped(cloud) || deletedAfterStart) {
        setScanUi(false);
        els.loading.classList.add('hidden');
        currentScanId = null;
        toast(deletedAfterStart ? 'Scan stopped · GitHub run was removed' : 'Scan stopped in GitHub');
        return;
      }
    }

    if (!scan) {
      if (pollStartedAt && Date.now() - pollStartedAt > QUEUE_STALE_MS) {
        setScanUi(false);
        els.loading.classList.add('hidden');
        toast('Scan stopped before the cloud runner started');
        return;
      }
      setScanUi(true, 'Cloud runner is starting…');
      els.loadingTitle.textContent = 'Scan queued';
      els.loadingText.textContent = 'GitHub Actions is starting the scanner.';
      els.scanCounter.classList.remove('hidden');
      els.scanCounter.textContent = 'Waiting for cloud runner…';
      pollTimer = setTimeout(() => pollScan(scanId), 2200);
      return;
    }

    const heartbeatMs = new Date(scan.heartbeatAt || scan.updatedAt || scan.startedAt || 0).getTime();
    const isRunning = scan.status === 'processing' || scan.status === 'queued';
    if (isRunning && Number.isFinite(heartbeatMs) && heartbeatMs > 0 && Date.now() - heartbeatMs > SCAN_STALE_MS) {
      setScanUi(false);
      els.loading.classList.add('hidden');
      toast('Scan stopped · cloud runner is no longer active');
      return;
    }

    progressUi(scan);

    // New matching games are written to the persistent catalog as each Roblox
    // batch finishes. Pull those updates into the page without hiding the
    // existing results or waiting for the entire scan to finish.
    const catalogUpdate = String(scan.catalogUpdatedAt || '');
    if (catalogUpdate && catalogUpdate !== lastCatalogUpdateSeen && Date.now() - lastLiveReloadAt > 8000) {
      lastCatalogUpdateSeen = catalogUpdate;
      lastLiveReloadAt = Date.now();
      try { await loadGames({ preserveActiveScan:true }); } catch {}
      setScanUi(true, scan.label || 'Scanning for new games…');
      progressUi(scan);
    }

    if (scan.status === 'complete') {
      setScanUi(false); els.loading.classList.add('hidden');
      await loadGames();
      toast(`Scan complete · ${exact.format(scan.matchedCount || 0)} matches · ${exact.format(scan.newMatchesAdded || 0)} new matches`);
      return;
    }
    if (scan.status === 'cancelled' || scan.status === 'stopped') {
      setScanUi(false);
      els.loading.classList.add('hidden');
      toast('Scan stopped');
      return;
    }
    if (scan.status === 'error') { setScanUi(false); showError(new Error(scan.error || 'The Roblox scan failed.')); return; }
    pollTimer = setTimeout(() => pollScan(scanId), 1800);
  } catch (error) { setScanUi(false); showError(error); }
}

function newScanId() {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `scan_${Date.now()}_${random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
}

async function startScan() {
  if (els.scanBtn.disabled) return;
  if (!SCAN_ENDPOINT || SCAN_ENDPOINT.includes('REPLACE-WITH-YOUR-WORKER')) {
    showError(new Error('Cloud scanner is not configured yet. Paste your Cloudflare Worker URL into public/runtime-config.js and redeploy Hosting.'));
    return;
  }
  saveFilters();
  const existingMatches = lastPayload ? filteredGames(lastPayload).length : 0;
  const genreScan = genreOnlyMode && els.genre.value !== 'all';
  setScanUi(true, genreScan ? `${exact.format(existingMatches)} ${els.genre.value} games ready · deep-scanning this genre…` : (allGamesMode ? `${exact.format(existingMatches)} stored games ready · resolving the rest of knownIds…` : (existingMatches ? `${exact.format(existingMatches)} existing matches ready · looking for new matches…` : 'Sending filters to cloud scanner…')));
  els.loadError.classList.add('hidden');
  if (!lastPayload || !lastPayload.games?.length) {
    els.loading.classList.remove('hidden');
    els.loadingTitle.textContent = 'Starting cloud scan';
    els.loadingText.textContent = genreScan ? `Existing ${els.genre.value} games are already visible. The cloud scan is searching that genre deeply and adding newly found matches live.` : (allGamesMode ? 'All stored games are already visible. The cloud scan is resolving unloaded known IDs and adding them to the catalog live.' : 'Existing Firebase games are reused immediately. Roblox is only checked for newly discovered games that fit your filters.');
  } else {
    // Keep the current result cards visible while the cloud scan runs.
    els.loading.classList.add('hidden');
  }
  try {
    const response = await fetch(SCAN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ filters: activeFilters() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.scanId) throw new Error(data.error || `Could not start scan (${response.status})`);
    currentScanId = String(data.scanId);
    cloudRunSeen = false;
    lastCloudStatusAt = 0;
    els.cancelBtn.textContent = 'Cancel';
    pollStartedAt = Date.now();
    pollScan(currentScanId);
  } catch (error) { setScanUi(false); showError(error); }
}
async function resumeActiveScan() {
  try {
    const meta = await dbGet('meta');
    if (!meta?.activeScanId) return;
    const candidate = String(meta.activeScanId);
    if (localStorage.getItem(`nichegames:cancelled:${candidate}`)) return;
    const cloud = await cloudRunStatus(candidate);
    if (cloud && (!cloud.found || (cloud.status === 'completed' && cloud.conclusion !== 'success'))) return;
    currentScanId = candidate;
    cloudRunSeen = Boolean(cloud?.found);
    lastCloudStatusAt = Date.now();
    pollStartedAt = Date.now();
    setScanUi(true, 'Resuming active cloud scan…');
    pollScan(currentScanId);
  } catch {}
}

function goToPage(page) {
  if (!lastPayload) return;
  const total = filteredGames(lastPayload).length, pages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.max(1, Math.min(Number(page) || 1, pages)); render(lastPayload);
  document.querySelector('.results-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toast(message) { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200); }
function syncCreatedPreset() { const key = els.createdWithinUnit.value === 'all' ? '1|all' : `${els.createdWithinValue.value}|${els.createdWithinUnit.value}`; document.querySelectorAll('[data-created-preset]').forEach((b) => b.classList.toggle('active', b.dataset.createdPreset === key)); }

async function showDetails(id) {
  const numericId = Number(id);
  let game = detailsCache.get(numericId) || lastPayload?.games?.find((item) => Number(item.id) === numericId);
  if (!game) return;

  // Open immediately with the compact card data, then fetch the full record
  // only for this one game. This keeps initial page loads small and fast.
  const renderModal = (value) => {
    const isSaved = saved.has(Number(value.id));
    const creator = value.creator || { name: 'Unknown', verified: false };
    const votes = Number(value.votes?.up || 0) + Number(value.votes?.down || value.voteCount || 0);
    const delta = deltaText(value.ccuDelta);
    els.modalContent.innerHTML = `<div class="modal-hero"><img src="${value.icon || placeholder(value.name)}" onerror="this.src='${placeholder(value.name)}'" alt="" /></div><div class="modal-body"><div class="modal-title-row"><div><h2>${escapeHtml(value.name)}</h2><p>by <button class="creator-link" type="button" data-creator-id="${Number(creator.id || 0)}" data-creator-type="${escapeHtml(creator.type || 'Unknown')}" data-creator-name="${escapeHtml(creator.name || 'Unknown')}">${escapeHtml(creator.name)}${creator.verified ? ' · Verified' : ''}</button></p></div><button class="modal-save ${isSaved ? 'saved' : ''}" data-save="${value.id}" type="button">${isSaved ? '★ Saved' : '☆ Save'}</button></div><div class="modal-stats"><div><span>CCU</span><b>${exact.format(value.playing || 0)}</b><small class="ccu-change ${delta.cls}">${delta.text}</small></div><div><span>Created</span><b>${relativeCreated(value.created)}</b><small>${escapeHtml(fullCreated(value.created))}</small></div><div><span>Visits</span><b>${nf.format(value.visits || 0)}</b><small>${exact.format(value.visits || 0)} total</small></div><div><span>Rating</span><b>${ratingLabel(value)}</b><small>${exact.format(votes)} votes</small></div></div><div class="modal-info-grid"><div><span>Genre</span><b>${escapeHtml(value.genre || 'Unknown')}${value.subgenre ? ` · ${escapeHtml(value.subgenre)}` : ''}</b></div><div><span>Max server size</span><b>${exact.format(value.maxPlayers || 0)}</b></div><div><span>Favorites</span><b>${nf.format(value.favorites || 0)}</b></div><div><span>Universe ID</span><b>${value.id}</b></div></div>${modalSocialsHtml(value)}<div class="modal-description"><span>Description</span><p>${escapeHtml(value.description || 'Loading full game details…')}</p></div><div class="modal-actions"><button class="copy-btn" data-copy="${value.id}" type="button">Copy universe ID</button><button class="open-btn" data-open="${escapeHtml(value.robloxUrl || '')}" type="button">Open on Roblox</button></div></div>`;
  };

  renderModal(game);
  els.detailsModal.classList.add('show');
  els.detailsModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-opened');

  if (!detailsCache.has(numericId) || !Object.prototype.hasOwnProperty.call(game, 'description')) {
    try {
      let full = await dbGet(`catalog/games/${numericId}`);
      if (!full) full = await dbGet(`games/${numericId}`);
      if (full) {
        detailsCache.set(numericId, full);
        game = full;
        if (els.detailsModal.classList.contains('show')) renderModal(game);
      }
    } catch {}
  }
}
function closeModal() { els.detailsModal.classList.remove('show'); els.detailsModal.setAttribute('aria-hidden', 'true'); document.body.classList.remove('modal-opened'); }


function syncAllGamesUi() {
  els.allGamesBtn.classList.toggle('active', allGamesMode);
  els.allGamesBtn.setAttribute('aria-pressed', allGamesMode ? 'true' : 'false');
  els.allGamesBtn.textContent = allGamesMode ? 'All games ✓' : 'All games';
  if (allGamesMode) {
    els.scanCaption.textContent = 'All games mode · shows full stored catalog + resolves unloaded known IDs';
  }
}

function enableAllGamesMode() {
  allGamesMode = true;
  genreOnlyMode = false;
  els.q.value = '';
  els.minCcu.value = 0;
  els.maxCcu.value = 10000000;
  els.createdWithinValue.value = 1;
  els.createdWithinUnit.value = 'all';
  els.minVisits.value = 0;
  els.creatorType.value = 'all';
  els.genre.value = 'all';
  restoredGenre = 'all';
  els.verifiedOnly.checked = false;
  els.hasSocials.checked = false;
  els.hasDiscord.checked = false;
  els.savedOnly.checked = false;
  syncCreatedInput();
  syncCreatedPreset();
  syncAllGamesUi();
  syncGenreOnlyUi();
  rerender();
}

function disableAllGamesMode() {
  if (!allGamesMode) return;
  allGamesMode = false;
  syncAllGamesUi();
}

const rerender = () => {
  currentPage = 1;
  invalidateFilterCache();
  saveFilters();
  if (lastPayload) render(lastPayload);
};
let rerenderTimer = null;
const rerenderDebounced = () => {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(rerender, 120);
};
['q','minCcu','maxCcu','minVisits'].forEach((id) => els[id].addEventListener('input', () => { disableAllGamesMode(); rerenderDebounced(); }));
['creatorType','verifiedOnly','hasSocials','hasDiscord','savedOnly','sort'].forEach((id) => els[id].addEventListener('change', () => { if (id !== 'sort') disableAllGamesMode(); rerender(); }));
els.genre.addEventListener('change', () => {
  disableAllGamesMode();
  if (els.genre.value === 'all') genreOnlyMode = false; else enableGenreOnlyMode();
  syncGenreOnlyUi();
  rerender();
});
els.createdWithinValue.addEventListener('input', () => { disableAllGamesMode(); syncCreatedPreset(); rerenderDebounced(); });
els.createdWithinUnit.addEventListener('change', () => { disableAllGamesMode(); syncCreatedInput(); syncCreatedPreset(); rerender(); });
for (const button of document.querySelectorAll('[data-created-preset]')) button.addEventListener('click', () => { disableAllGamesMode(); const [value, unit] = button.dataset.createdPreset.split('|'); els.createdWithinValue.value = value; els.createdWithinUnit.value = unit; syncCreatedInput(); syncCreatedPreset(); rerender(); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));

els.orderBtn.addEventListener('click', () => { order = order === 'desc' ? 'asc' : 'desc'; localStorage.setItem('nichegames:order', order); els.orderBtn.textContent = order === 'desc' ? '↓' : '↑'; els.orderBtn.title = order === 'desc' ? 'Sort descending' : 'Sort ascending'; rerender(); });
els.pageSize.addEventListener('change', () => { pageSize = Number(els.pageSize.value); localStorage.setItem('nichegames:pageSize', String(pageSize)); rerender(); });
els.allGamesBtn.addEventListener('click', () => { if (allGamesMode) { allGamesMode = false; syncAllGamesUi(); rerender(); } else enableAllGamesMode(); });
els.resetBtn.addEventListener('click', () => { allGamesMode=false; genreOnlyMode=false; syncAllGamesUi(); els.q.value=''; els.minCcu.value=800; els.maxCcu.value=3000; els.createdWithinValue.value=30; els.createdWithinUnit.value='days'; els.minVisits.value=0; els.creatorType.value='all'; els.genre.value='all'; restoredGenre='all'; syncGenreOnlyUi(); els.verifiedOnly.checked=false; els.hasSocials.checked=false; els.hasDiscord.checked=false; els.savedOnly.checked=false; els.sort.value='playing'; order='desc'; localStorage.setItem('nichegames:order',order); els.orderBtn.textContent='↓'; syncCreatedInput(); syncCreatedPreset(); rerender(); });
els.scanBtn.addEventListener('click', startScan);
els.cancelBtn.addEventListener('click', cancelScan);
els.retryBtn.addEventListener('click', () => loadLatest());
els.lookupForm.addEventListener('submit', startLookup);
els.catalogRefreshBtn.addEventListener('click', loadCoverage);
els.creatorBackBtn.addEventListener('click', () => setRoute('games'));
els.pagination.addEventListener('click', (event) => { const b = event.target.closest('[data-page]'); if (b && !b.disabled) goToPage(b.dataset.page); });
els.creatorPagination.addEventListener('click', (event) => { const b = event.target.closest('[data-creator-page]'); if (!b || b.disabled) return; creatorPage = Math.max(1, Number(b.dataset.creatorPage) || 1); renderCreatorPage(); document.querySelector('#creatorView')?.scrollIntoView({ behavior:'smooth', block:'start' }); });
els.modalBackdrop.addEventListener('click', closeModal); els.modalClose.addEventListener('click', closeModal);
for (const routeButton of document.querySelectorAll('[data-route]')) routeButton.addEventListener('click', () => setRoute(routeButton.dataset.route));
for (const routeLink of document.querySelectorAll('[data-route-link]')) routeLink.addEventListener('click', (event) => { event.preventDefault(); setRoute(routeLink.dataset.routeLink || 'games'); });
window.addEventListener('popstate', routeFromLocation);

document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && els.detailsModal.classList.contains('show')) { closeModal(); return; } const tag = document.activeElement?.tagName; if (['INPUT','SELECT','TEXTAREA'].includes(tag) || els.detailsModal.classList.contains('show')) return; if (event.key === 'ArrowRight') goToPage(currentPage + 1); if (event.key === 'ArrowLeft') goToPage(currentPage - 1); });
document.addEventListener('click', async (event) => {
  const creatorButton = event.target.closest('[data-creator-id]'); if (creatorButton) { event.preventDefault(); closeModal(); openCreatorPage({ id:Number(creatorButton.dataset.creatorId || 0), type:String(creatorButton.dataset.creatorType || 'Unknown'), name:String(creatorButton.dataset.creatorName || 'Unknown') }); return; }
  const saveButton = event.target.closest('[data-save]'); if (saveButton) { const id = Number(saveButton.dataset.save); saved.has(id) ? saved.delete(id) : saved.add(id); localStorage.setItem('nichegames:saved', JSON.stringify([...saved])); if (lastPayload) render(lastPayload); if (els.detailsModal.classList.contains('show')) showDetails(id); return; }
  const details = event.target.closest('[data-details]'); if (details) { showDetails(details.dataset.details); return; }
  const open = event.target.closest('[data-open]'); if (open?.dataset.open) { window.open(open.dataset.open, '_blank', 'noopener,noreferrer'); return; }
  const copy = event.target.closest('[data-copy]'); if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Universe ID copied'); } catch { toast(`Universe ID: ${copy.dataset.copy}`); } }
});

restoreFilters();
syncGenreOnlyUi();
setView(currentView);
routeFromLocation();
loadLatest().finally(() => { routeFromLocation(); resumeActiveScan(); });
