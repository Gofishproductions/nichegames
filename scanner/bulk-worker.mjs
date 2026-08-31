import admin from 'firebase-admin';

const PROJECT_ID = 'nichegamesfinder';
const DATABASE_URL = 'https://nichegamesfinder-default-rtdb.firebaseio.com';
const mode = String(process.env.BULK_MODE || 'resolve').toLowerCase();
const shardIndex = Number(process.env.SHARD_INDEX || 0);
const shardCount = Math.max(1, Number(process.env.SHARD_COUNT || 8));
const concurrency = Math.max(1, Math.min(12, Number(process.env.WORKER_CONCURRENCY || 4)));
const bulkLimit = Math.max(1, Number(process.env.BULK_LIMIT || 10000));
const refreshStaleMs = Math.max(60_000, Number(process.env.REFRESH_STALE_MS || 20 * 60 * 1000));
const socialsFreshMs = 7 * 24 * 60 * 60 * 1000;
const ratingFreshMs = 24 * 60 * 60 * 1000;

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON.');
  const value = JSON.parse(raw);
  if (!value.project_id || !value.private_key || !value.client_email) throw new Error('Invalid Firebase service account JSON.');
  return value;
}
if (!admin.apps.length) admin.initializeApp({ credential:admin.credential.cert(serviceAccount()), databaseURL:DATABASE_URL, projectId:PROJECT_ID });
const db = admin.database();
const root = db.ref('nichegames');
const log = (m) => console.log(`[Nichegames ${mode} ${shardIndex + 1}/${shardCount}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunks(array, size) { const out=[]; for (let i=0;i<array.length;i+=size) out.push(array.slice(i,i+size)); return out; }
async function pool(items, limit, fn) {
  const source=[...items]; let cursor=0; const workers=[];
  for (let i=0;i<Math.min(limit, source.length || 1);i++) workers.push((async()=>{ while (true) { const n=cursor++; if (n>=source.length) return; await fn(source[n], n); } })());
  await Promise.all(workers);
}
function belongs(id) { return Math.abs(Number(id)) % shardCount === shardIndex; }
function iso() { return new Date().toISOString(); }
async function fetchJson(url, optional=false) {
  let last;
  for (let attempt=0; attempt<4; attempt++) {
    try {
      const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(), 20_000);
      const res=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Nichegames/8.3-bulk'},signal:controller.signal}); clearTimeout(timer);
      if ([401,403,404].includes(res.status) && optional) return null;
      if (res.status===429 || res.status>=500) { const retry=Number(res.headers.get('retry-after')); await sleep(Number.isFinite(retry)?retry*1000:500*(attempt+1)); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) { last=e; await sleep(400*(attempt+1)); }
  }
  if (optional) return null;
  throw last || new Error(`Request failed: ${url}`);
}
async function updateChunked(path, object, size=250) {
  const rows=Object.entries(object); for (let i=0;i<rows.length;i+=size) await root.child(path).update(Object.fromEntries(rows.slice(i,i+size)));
}
function normalizeSocialUrl(raw='') {
  let s=String(raw||'').trim().replace(/[),.;!?]+$/g,''); if (!s) return '';
  if (!/^https?:\/\//i.test(s) && /^(discord\.gg|discord\.com\/invite|youtube\.com|youtu\.be|x\.com|twitter\.com|twitch\.tv|guilded\.gg|tiktok\.com)\//i.test(s)) s=`https://${s}`;
  try { const u=new URL(s); return ['http:','https:'].includes(u.protocol)?u.href:''; } catch { return ''; }
}
function socialType(url='') { let host=''; try { host=new URL(url).hostname.toLowerCase().replace(/^www\./,''); } catch {}
  if (host==='discord.gg'||host.endsWith('.discord.gg')||host==='discord.com'||host.endsWith('.discord.com')) return 'Discord';
  if (host==='youtube.com'||host.endsWith('.youtube.com')||host==='youtu.be') return 'YouTube';
  if (host==='x.com'||host.endsWith('.x.com')||host==='twitter.com'||host.endsWith('.twitter.com')) return 'X';
  if (host==='twitch.tv'||host.endsWith('.twitch.tv')) return 'Twitch';
  if (host==='guilded.gg'||host.endsWith('.guilded.gg')) return 'Guilded';
  if (host==='tiktok.com'||host.endsWith('.tiktok.com')) return 'TikTok'; return 'Website'; }
function descriptionSocials(text='') {
  const out=[]; const input=String(text||'');
  const re=/(?:https?:\/\/)?(?:discord\.gg|discord\.com\/invite|youtube\.com|youtu\.be|x\.com|twitter\.com|twitch\.tv|guilded\.gg|tiktok\.com)\/[^\s<>"']+/gi;
  for (const m of input.match(re)||[]) { const url=normalizeSocialUrl(m); if (url) out.push({type:socialType(url),title:socialType(url),url,source:'description'}); }
  return out;
}
function payloadSocials(payload, source) {
  const rows=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:[]; const out=[];
  for (const x of rows) { const url=normalizeSocialUrl(x?.url||x?.link||x?.href||''); if (url) out.push({type:socialType(url),title:String(x?.title||x?.name||socialType(url)).slice(0,100),url,source}); }
  return out;
}
function dedupeSocials(rows) { const seen=new Set(),out=[]; for (const x of rows) { const url=normalizeSocialUrl(x?.url); const k=url.toLowerCase().replace(/\/$/,''); if (!url||seen.has(k)) continue; seen.add(k); out.push({...x,url}); } return out.slice(0,20); }
function compact(game={}) { return { id:Number(game.id||0), rootPlaceId:Number(game.rootPlaceId||0), name:String(game.name||'Untitled Experience'), creator:game.creator||{id:0,name:'Unknown',type:'Unknown',verified:false}, playing:Number(game.playing||0), ccuDelta:Number(game.ccuDelta||0), visits:Number(game.visits||0), favorites:Number(game.favorites||0), maxPlayers:Number(game.maxPlayers||0), created:game.created||null, updated:game.updated||null, genre:String(game.genre||'Unknown'), subgenre:String(game.subgenre||''), genreTags:Array.isArray(game.genreTags)?game.genreTags:[], rating:game.rating==null?null:Number(game.rating), voteCount:Number(game.voteCount||0), icon:String(game.icon||''), robloxUrl:String(game.robloxUrl||''), lastCheckedAt:game.lastCheckedAt||null, lastRatingCheckedAt:game.lastRatingCheckedAt||null, hasSocials:Boolean(game.hasSocials), hasDiscord:Boolean(game.hasDiscord), socialTypes:Array.isArray(game.socialTypes)?game.socialTypes:[], socialsCheckedAt:game.socialsCheckedAt||null }; }
function fromDetail(d, old={}) { const now=iso(); const playing=Number(d.playing??old.playing??0); return {...old,id:Number(d.id),rootPlaceId:Number(d.rootPlaceId||old.rootPlaceId||0),name:String(d.name||old.name||'Untitled Experience'),description:String(d.description??old.description??''),creator:{id:Number(d.creator?.id||old.creator?.id||0),name:String(d.creator?.name||old.creator?.name||'Unknown'),type:String(d.creator?.type||old.creator?.type||'Unknown'),verified:Boolean(d.creator?.hasVerifiedBadge??old.creator?.verified)},playing,ccuDelta:playing-Number(old.playing??playing),visits:Number(d.visits??old.visits??0),favorites:Number(d.favoritedCount??old.favorites??0),maxPlayers:Number(d.maxPlayers??old.maxPlayers??0),created:d.created||old.created||null,updated:d.updated||old.updated||null,genre:String(d.genre_l1||d.genre||old.genre||'Unknown'),subgenre:String(d.genre_l2||old.subgenre||''),robloxUrl:(d.rootPlaceId||old.rootPlaceId)?`https://www.roblox.com/games/${d.rootPlaceId||old.rootPlaceId}`:`https://www.roblox.com/games/?universeId=${Number(d.id)}`,lastCheckedAt:now,lastSeenAt:now}; }
async function detailBatch(ids) { const p=await fetchJson(`https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`); return Array.isArray(p?.data)?p.data:[]; }
async function placeToUniverse(placeId) { const p=await fetchJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`,true); const id=Number(p?.universeId); return Number.isSafeInteger(id)&&id>0?id:null; }
async function jobPatch(patch) { await root.child(`jobs/${mode}/shards/${shardIndex}`).update({...patch,shardIndex,shardCount,updatedAt:iso()}); }

async function resolveMode() {
  const [knownSnap,indexSnap,pendingSnap]=await Promise.all([root.child('knownIds').once('value'),root.child('catalog/index').once('value'),root.child('pendingPlaceIds').once('value')]);
  const known=Object.keys(knownSnap.val()||{}).map(Number).filter(Number.isSafeInteger);
  const index=indexSnap.val()||{};
  const pendingPlaces=Object.keys(pendingSnap.val()||{}).map(Number).filter(Number.isSafeInteger).filter(belongs).slice(0,2000);
  const mapped=[]; const placeUpdates={}; const knownUpdates={};
  await pool(pendingPlaces, Math.min(concurrency,6), async (placeId)=>{ const uid=await placeToUniverse(placeId); if (uid) { mapped.push(uid); placeUpdates[String(placeId)]=uid; knownUpdates[String(uid)]=true; } });
  if (Object.keys(placeUpdates).length) await Promise.all([updateChunked('placeToUniverse',placeUpdates,500),updateChunked('knownIds',knownUpdates,1000)]);
  const ids=[...new Set([...known,...mapped])].filter((id)=>belongs(id)&&!index[String(id)]).slice(0,bulkLimit);
  log(`Resolving ${ids.length.toLocaleString()} unloaded IDs with ${concurrency} parallel batch workers.`);
  await jobPatch({status:'processing',total:ids.length,processed:0});
  let processed=0,added=0; const batches=chunks(ids,50);
  await pool(batches,concurrency,async (batch)=>{
    let details=[]; try { details=await detailBatch(batch); } catch (e) { log(`detail batch retry later: ${e.message}`); processed+=batch.length; return; }
    const returned=new Set(details.map(x=>Number(x.id))); const full={},small={};
    for (const d of details) { const g=fromDetail(d,{}); full[String(g.id)]=g; small[String(g.id)]=compact(g); added++; }
    if (Object.keys(full).length) await Promise.all([root.child('catalog/games').update(full),root.child('catalog/index').update(small)]);
    const missing={}; for (const id of batch) if (!returned.has(id)) missing[String(id)]={checkedAt:Date.now(),source:'bulk-resolve'};
    if (Object.keys(missing).length) await root.child('missingIds').update(missing);
    processed+=batch.length; if (processed%500<50 || processed===ids.length) { log(`${Math.min(processed,ids.length).toLocaleString()} / ${ids.length.toLocaleString()} checked · ${added.toLocaleString()} added`); await jobPatch({status:'processing',total:ids.length,processed:Math.min(processed,ids.length),added}); }
  });
  await root.child('meta').update({lastParallelResolveAt:iso(),workerArchitecture:'parallel-v8.3'});
  await jobPatch({status:'complete',total:ids.length,processed:ids.length,added,completedAt:iso()});
}

async function refreshMode() {
  const index=(await root.child('catalog/index').once('value')).val()||{}; const now=Date.now();
  const rows=Object.values(index).filter(Boolean).filter((g)=>belongs(Number(g.id))).filter((g)=>now-new Date(g.lastCheckedAt||0).getTime()>refreshStaleMs).slice(0,bulkLimit);
  const ids=rows.map(g=>Number(g.id)); const oldMap=new Map(rows.map(g=>[Number(g.id),g])); let processed=0,updated=0;
  await jobPatch({status:'processing',total:ids.length,processed:0}); log(`Refreshing ${ids.length.toLocaleString()} stale games.`);
  await pool(chunks(ids,50),concurrency,async(batch)=>{ let details=[]; try { details=await detailBatch(batch); } catch { processed+=batch.length; return; } const full={},small={};
    for (const d of details) { const id=Number(d.id); const old=oldMap.get(id)||{}; const g=fromDetail(d,old); full[String(id)]=g; small[String(id)]={...old,...compact(g)}; updated++; }
    if (Object.keys(full).length) {
      const fullPatch={};
      const fields=['rootPlaceId','name','creator','playing','ccuDelta','visits','favorites','maxPlayers','created','updated','genre','subgenre','robloxUrl','lastCheckedAt','lastSeenAt'];
      for (const [id,g] of Object.entries(full)) for (const field of fields) fullPatch[`${id}/${field}`]=g[field] ?? null;
      await Promise.all([root.child('catalog/games').update(fullPatch),root.child('catalog/index').update(small)]);
    }
    processed+=batch.length; if (processed%500<50||processed===ids.length) await jobPatch({status:'processing',total:ids.length,processed:Math.min(processed,ids.length),updated});
  });
  await root.child('meta').update({lastParallelRefreshAt:iso()}); await jobPatch({status:'complete',total:ids.length,processed:ids.length,updated,completedAt:iso()});
}

async function socialsMode() {
  const raw=(await root.child('catalog/games').once('value')).val()||{}; const now=Date.now();
  const games=Object.values(raw).filter(Boolean).filter(g=>belongs(Number(g.id))).filter(g=>now-new Date(g.socialsCheckedAt||0).getTime()>socialsFreshMs).slice(0,bulkLimit);
  const groupCache=new Map(); let processed=0,withSocials=0;
  async function groupSocials(groupId) { if (!groupId) return []; if (!groupCache.has(groupId)) groupCache.set(groupId,(async()=>payloadSocials(await fetchJson(`https://groups.roblox.com/v1/groups/${groupId}/social-links`,true),'creator'))()); return groupCache.get(groupId); }
  await jobPatch({status:'processing',total:games.length,processed:0}); log(`Enriching socials for ${games.length.toLocaleString()} games.`);
  await pool(games,concurrency,async(g)=>{ const rows=[...descriptionSocials(g.description)]; const gp=await fetchJson(`https://games.roblox.com/v1/games/${Number(g.id)}/social-links/list`,true); rows.push(...payloadSocials(gp,'game')); if (g.creator?.type==='Group') rows.push(...await groupSocials(Number(g.creator.id||0))); const socials=dedupeSocials(rows); const types=[...new Set(socials.map(s=>s.type))]; const patch={socials,socialTypes:types,hasSocials:socials.length>0,hasDiscord:types.includes('Discord'),socialsCheckedAt:iso()}; await Promise.all([root.child(`catalog/games/${g.id}`).update(patch),root.child(`catalog/index/${g.id}`).update({socialTypes:types,hasSocials:patch.hasSocials,hasDiscord:patch.hasDiscord,socialsCheckedAt:patch.socialsCheckedAt})]); if (socials.length) withSocials++; processed++; if (processed%100===0||processed===games.length) await jobPatch({status:'processing',total:games.length,processed,withSocials}); });
  await root.child('meta').update({lastParallelSocialsAt:iso()}); await jobPatch({status:'complete',total:games.length,processed:games.length,withSocials,completedAt:iso()});
}

async function assetsMode() {
  const index=(await root.child('catalog/index').once('value')).val()||{}; const now=Date.now();
  const games=Object.values(index).filter(Boolean).filter(g=>belongs(Number(g.id))).filter(g=>!g.icon || !g.lastRatingCheckedAt || now-new Date(g.lastRatingCheckedAt||0).getTime()>ratingFreshMs).slice(0,bulkLimit);
  let processed=0; await jobPatch({status:'processing',total:games.length,processed:0}); log(`Updating artwork/ratings for ${games.length.toLocaleString()} games.`);
  await pool(chunks(games,50),concurrency,async(group)=>{ const ids=group.map(g=>Number(g.id)); const [thumb,votes]=await Promise.all([fetchJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`,true),fetchJson(`https://games.roblox.com/v1/games/votes?universeIds=${ids.join(',')}`,true)]); const iconMap=new Map((thumb?.data||[]).map(x=>[Number(x.targetId),x.imageUrl])); const voteMap=new Map((votes?.data||[]).map(x=>[Number(x.id),x])); const small={},full={}; for (const g of group) { const id=Number(g.id),v=voteMap.get(id); const up=Number(v?.upVotes||0),down=Number(v?.downVotes||0),count=up+down; const patch={}; if (iconMap.get(id)) patch.icon=iconMap.get(id); if (v) { patch.rating=count?(up/count)*100:null; patch.voteCount=count; patch.votes={up,down}; patch.lastRatingCheckedAt=iso(); } if (Object.keys(patch).length) { small[String(id)]={...patch}; full[String(id)]={...patch}; } } if (Object.keys(small).length) {
      const fullPatch={};
      for (const [id,patch] of Object.entries(full)) for (const [field,value] of Object.entries(patch)) fullPatch[`${id}/${field}`]=value;
      await Promise.all([root.child('catalog/index').update(small),root.child('catalog/games').update(fullPatch)]);
    } processed+=group.length; if (processed%500<50||processed===games.length) await jobPatch({status:'processing',total:games.length,processed:Math.min(processed,games.length)}); });
  await root.child('meta').update({lastParallelAssetsAt:iso()}); await jobPatch({status:'complete',total:games.length,processed:games.length,completedAt:iso()});
}

async function recountMode() {
  const [known,index,pending]=await Promise.all([root.child('knownIds').once('value'),root.child('catalog/index').once('value'),root.child('pendingPlaceIds').once('value')]);
  const knownCount=Object.keys(known.val()||{}).length,indexCount=Object.keys(index.val()||{}).length,pendingCount=Object.keys(pending.val()||{}).length;
  await root.child('meta').update({knownUniverseIds:knownCount,catalogGames:indexCount,catalogBacklog:Math.max(0,knownCount-indexCount),pendingPlaceIds:pendingCount,lastCatalogBuildAt:iso(),workerArchitecture:'parallel-v8.3'});
  log(`${indexCount.toLocaleString()} resolved / ${knownCount.toLocaleString()} known · ${Math.max(0,knownCount-indexCount).toLocaleString()} unresolved.`);
}

let code=0;
try { if (mode==='resolve') await resolveMode(); else if (mode==='refresh') await refreshMode(); else if (mode==='socials') await socialsMode(); else if (mode==='assets') await assetsMode(); else if (mode==='recount') await recountMode(); else throw new Error(`Unknown BULK_MODE ${mode}`); }
catch(e){ code=1; console.error(e?.stack||e); try{await jobPatch({status:'error',error:String(e?.message||e),completedAt:iso()});}catch{} }
try{db.goOffline();await admin.app().delete();}catch{}
process.exit(code);
