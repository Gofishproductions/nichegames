import admin from 'firebase-admin';

const PROJECT_ID = 'nichegamesfinder';
const DATABASE_URL = 'https://nichegamesfinder-default-rtdb.firebaseio.com';
const requestId = String(process.env.VERIFICATION_ID || `verify_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
const rawPayload = process.env.VERIFICATION_PAYLOAD_JSON || '{}';

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON.');
  const value = JSON.parse(raw);
  if (!value.project_id || !value.private_key || !value.client_email) throw new Error('Invalid Firebase service account JSON.');
  return value;
}

if (!admin.apps.length) admin.initializeApp({
  credential: admin.credential.cert(serviceAccount()),
  databaseURL: DATABASE_URL,
  projectId: PROJECT_ID,
});

const db = admin.database();
const root = db.ref('nichegames');
const requestRef = root.child(`socialVerificationRequests/${requestId}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
const log = (message) => console.log(`[Nichegames verify] ${message}`);

const ALLOWED_HOSTS = {
  Discord: ['discord.gg', 'discord.com', 'discordapp.com'],
  YouTube: ['youtube.com', 'youtu.be'],
  X: ['x.com', 'twitter.com'],
  Twitch: ['twitch.tv'],
  Guilded: ['guilded.gg'],
  TikTok: ['tiktok.com'],
};

function normalizeSocialUrl(raw = '', requestedType = '') {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let type = String(requestedType || '').trim();
    if (!ALLOWED_HOSTS[type]) {
      type = Object.entries(ALLOWED_HOSTS).find(([, hosts]) => hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))?.[0] || '';
    }
    if (!type) return null;
    if (!ALLOWED_HOSTS[type].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    url.hash = '';
    return { type, title:type, url:url.href, source:'verified_creator', verified:true };
  } catch {
    return null;
  }
}

function normalizeSubmittedSocials(input = {}) {
  const rows = [];
  const source = Array.isArray(input) ? input : Object.entries(input).map(([type, url]) => ({ type, url }));
  for (const item of source) {
    const normalized = normalizeSocialUrl(item?.url || '', item?.type || '');
    if (normalized) rows.push(normalized);
  }
  const seen = new Set();
  return rows.filter((item) => {
    const key = item.url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function fetchJson(url, optional = false) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(url, {
        headers:{ Accept:'application/json', 'User-Agent':'Nichegames/8.4-verification' },
        signal:controller.signal,
      });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        if (optional) return null;
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(450 * (attempt + 1));
    }
  }
  if (optional) return null;
  throw lastError || new Error(`Request failed: ${url}`);
}

function parseGameInput(raw = '') {
  const value = String(raw || '').trim();
  const urlMatch = value.match(/roblox\.com\/games\/(\d+)/i);
  if (urlMatch) return { placeId:Number(urlMatch[1]), universeId:null };
  const id = Number(value.match(/\d+/)?.[0] || 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Roblox game URL or ID.');
  return { placeId:null, universeId:id };
}

async function gameDetails(universeId) {
  const payload = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`, true);
  const row = Array.isArray(payload?.data) ? payload.data.find((item) => Number(item?.id) === Number(universeId)) : null;
  return row || null;
}

async function resolveUniverse(rawInput) {
  const parsed = parseGameInput(rawInput);
  if (parsed.placeId) {
    const mapped = await fetchJson(`https://apis.roblox.com/universes/v1/places/${parsed.placeId}/universe`, true);
    const universeId = Number(mapped?.universeId || 0);
    if (!Number.isSafeInteger(universeId) || universeId <= 0) throw new Error('Could not resolve that Roblox place ID.');
    return { universeId, placeId:parsed.placeId };
  }
  const direct = await gameDetails(parsed.universeId);
  if (direct) return { universeId:parsed.universeId, placeId:Number(direct.rootPlaceId || 0) || null, details:direct };
  const mapped = await fetchJson(`https://apis.roblox.com/universes/v1/places/${parsed.universeId}/universe`, true);
  const universeId = Number(mapped?.universeId || 0);
  if (!Number.isSafeInteger(universeId) || universeId <= 0) throw new Error('Could not resolve that Roblox ID as a universe or place.');
  return { universeId, placeId:parsed.universeId };
}

function mergeSocials(existing = [], verified = []) {
  const result = [];
  const seen = new Set();
  for (const item of [...verified, ...(Array.isArray(existing) ? existing : [])]) {
    let url = '';
    try { url = new URL(String(item?.url || '')).href; } catch { continue; }
    const key = url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      type:String(item?.type || 'Website').slice(0, 40),
      title:String(item?.title || item?.type || 'Website').slice(0, 100),
      url,
      source:item?.verified || item?.source === 'verified_creator' ? 'verified_creator' : String(item?.source || 'game'),
      verified:Boolean(item?.verified || item?.source === 'verified_creator'),
      verifiedAt:item?.verifiedAt || null,
    });
  }
  return result.slice(0, 20);
}

function compactFromDetail(detail, old = {}, patch = {}) {
  return {
    id:Number(detail.id || old.id || 0),
    rootPlaceId:Number(detail.rootPlaceId || old.rootPlaceId || 0),
    name:String(detail.name || old.name || 'Untitled Experience'),
    creator:{
      id:Number(detail.creator?.id || old.creator?.id || 0),
      name:String(detail.creator?.name || old.creator?.name || 'Unknown'),
      type:String(detail.creator?.type || old.creator?.type || 'Unknown'),
      verified:Boolean(detail.creator?.hasVerifiedBadge ?? old.creator?.verified),
    },
    playing:Number(detail.playing ?? old.playing ?? 0),
    ccuDelta:Number(old.ccuDelta || 0),
    visits:Number(detail.visits ?? old.visits ?? 0),
    favorites:Number(detail.favoritedCount ?? old.favorites ?? 0),
    maxPlayers:Number(detail.maxPlayers ?? old.maxPlayers ?? 0),
    created:detail.created || old.created || null,
    updated:detail.updated || old.updated || null,
    genre:String(detail.genre_l1 || detail.genre || old.genre || 'Unknown'),
    subgenre:String(detail.genre_l2 || old.subgenre || ''),
    genreTags:Array.isArray(old.genreTags) ? old.genreTags : [],
    rating:old.rating == null ? null : Number(old.rating),
    voteCount:Number(old.voteCount || 0),
    icon:String(old.icon || ''),
    robloxUrl:Number(detail.rootPlaceId || old.rootPlaceId || 0) ? `https://www.roblox.com/games/${detail.rootPlaceId || old.rootPlaceId}` : String(old.robloxUrl || ''),
    lastCheckedAt:old.lastCheckedAt || iso(),
    lastRatingCheckedAt:old.lastRatingCheckedAt || null,
    hasSocials:Boolean(patch.hasSocials),
    hasDiscord:Boolean(patch.hasDiscord),
    socialTypes:Array.isArray(patch.socialTypes) ? patch.socialTypes : [],
    socialsCheckedAt:patch.socialsCheckedAt || old.socialsCheckedAt || null,
    creatorSocialsVerified:Boolean(patch.creatorSocialsVerified),
    creatorSocialsVerifiedAt:patch.creatorSocialsVerifiedAt || null,
  };
}

async function updateStatus(patch) {
  await requestRef.update({ ...patch, updatedAt:iso() });
}

let exitCode = 0;
try {
  const payload = JSON.parse(rawPayload);
  const verificationCode = String(payload.verificationCode || '').trim().toUpperCase();
  if (!/^NG-[A-Z0-9]{6,12}$/.test(verificationCode)) throw new Error('Invalid verification code.');
  const submittedSocials = normalizeSubmittedSocials(payload.socials || {});
  if (!submittedSocials.length) throw new Error('Add at least one supported social link before verifying.');

  await updateStatus({ status:'processing', phase:'resolving', label:'Resolving Roblox game', requestedAt:iso() });
  const resolved = await resolveUniverse(payload.gameInput || payload.universeId || '');
  const detail = resolved.details || await gameDetails(resolved.universeId);
  if (!detail) throw new Error('Roblox returned no game details for that experience.');

  await updateStatus({
    phase:'checking_code',
    label:'Checking game description for verification code',
    universeId:resolved.universeId,
    rootPlaceId:Number(detail.rootPlaceId || resolved.placeId || 0) || null,
    gameName:String(detail.name || ''),
  });

  // Retry briefly because Roblox game-description changes can take a moment to
  // propagate through the public game-details endpoint.
  let verifiedDetail = detail;
  let codeFound = String(detail.description || '').toUpperCase().includes(verificationCode);
  for (let attempt = 0; !codeFound && attempt < 3; attempt += 1) {
    await sleep(2500);
    verifiedDetail = await gameDetails(resolved.universeId) || verifiedDetail;
    codeFound = String(verifiedDetail.description || '').toUpperCase().includes(verificationCode);
  }

  if (!codeFound) {
    await updateStatus({
      status:'failed',
      phase:'code_not_found',
      reason:'code_not_found',
      label:'Verification code was not found in the Roblox game description',
      universeId:resolved.universeId,
      gameName:String(verifiedDetail.name || ''),
      completedAt:iso(),
    });
    log(`Code not found for universe ${resolved.universeId}.`);
  } else {
    const now = iso();
    const fullRef = root.child(`catalog/games/${resolved.universeId}`);
    const indexRef = root.child(`catalog/index/${resolved.universeId}`);
    const [oldFullSnap, oldIndexSnap] = await Promise.all([fullRef.once('value'), indexRef.once('value')]);
    const oldFull = oldFullSnap.val() || {};
    const oldIndex = oldIndexSnap.val() || {};
    const baseOld = { ...oldIndex, ...oldFull };
    const verifiedRows = submittedSocials.map((item) => ({ ...item, verifiedAt:now, verificationId:requestId }));
    const socials = mergeSocials(baseOld.socials || [], verifiedRows);
    const socialTypes = [...new Set(socials.map((item) => String(item.type || '')).filter(Boolean))];
    const socialPatch = {
      socials,
      socialTypes,
      hasSocials:socials.length > 0,
      hasDiscord:socialTypes.some((type) => type.toLowerCase() === 'discord'),
      socialsCheckedAt:now,
      creatorSocialsVerified:true,
      creatorSocialsVerifiedAt:now,
      socialVerification:{ verified:true, method:'description_code', verifiedAt:now, verificationId:requestId },
    };
    const fullGame = {
      ...baseOld,
      id:Number(verifiedDetail.id),
      rootPlaceId:Number(verifiedDetail.rootPlaceId || baseOld.rootPlaceId || 0),
      name:String(verifiedDetail.name || baseOld.name || 'Untitled Experience'),
      description:String(verifiedDetail.description ?? baseOld.description ?? ''),
      creator:{
        id:Number(verifiedDetail.creator?.id || baseOld.creator?.id || 0),
        name:String(verifiedDetail.creator?.name || baseOld.creator?.name || 'Unknown'),
        type:String(verifiedDetail.creator?.type || baseOld.creator?.type || 'Unknown'),
        verified:Boolean(verifiedDetail.creator?.hasVerifiedBadge ?? baseOld.creator?.verified),
      },
      playing:Number(verifiedDetail.playing ?? baseOld.playing ?? 0),
      visits:Number(verifiedDetail.visits ?? baseOld.visits ?? 0),
      favorites:Number(verifiedDetail.favoritedCount ?? baseOld.favorites ?? 0),
      maxPlayers:Number(verifiedDetail.maxPlayers ?? baseOld.maxPlayers ?? 0),
      created:verifiedDetail.created || baseOld.created || null,
      updated:verifiedDetail.updated || baseOld.updated || null,
      genre:String(verifiedDetail.genre_l1 || verifiedDetail.genre || baseOld.genre || 'Unknown'),
      subgenre:String(verifiedDetail.genre_l2 || baseOld.subgenre || ''),
      robloxUrl:Number(verifiedDetail.rootPlaceId || baseOld.rootPlaceId || 0) ? `https://www.roblox.com/games/${verifiedDetail.rootPlaceId || baseOld.rootPlaceId}` : baseOld.robloxUrl || '',
      ...socialPatch,
    };
    const compact = { ...oldIndex, ...compactFromDetail(verifiedDetail, oldIndex, socialPatch) };

    await Promise.all([
      fullRef.set(fullGame),
      indexRef.set(compact),
      root.child(`knownIds/${resolved.universeId}`).set(true),
      root.child(`verifiedSocials/${resolved.universeId}`).set({
        verified:true,
        method:'description_code',
        verifiedAt:now,
        verificationId:requestId,
        gameName:String(verifiedDetail.name || ''),
        socials:verifiedRows,
      }),
      resolved.placeId ? root.child(`placeToUniverse/${resolved.placeId}`).set(resolved.universeId) : Promise.resolve(),
    ]);

    await updateStatus({
      status:'complete',
      phase:'complete',
      label:'Creator socials verified',
      universeId:resolved.universeId,
      gameName:String(verifiedDetail.name || ''),
      verifiedAt:now,
      socialCount:verifiedRows.length,
      completedAt:now,
    });
    log(`Verified ${verifiedRows.length} social link(s) for ${verifiedDetail.name} (${resolved.universeId}).`);
  }
} catch (error) {
  exitCode = 1;
  console.error(error?.stack || error);
  try {
    await updateStatus({ status:'error', phase:'error', reason:'worker_error', error:String(error?.message || error), completedAt:iso() });
  } catch {}
}

try { db.goOffline(); await admin.app().delete(); } catch {}
process.exit(exitCode);
