const json = (body, status = 200, origin = '*') => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST,OPTIONS,GET',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  },
});

function normalizeFilters(input = {}) {
  const unit = ['hours','days','weeks','months','years','all'].includes(String(input.createdWithinUnit)) ? String(input.createdWithinUnit) : 'days';
  const num = (value, fallback, min, max) => {
    const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    allGames: Boolean(input.allGames),
    lookupInput: String(input.lookupInput || '').trim().slice(0,500),
    q: String(input.q || '').trim().slice(0,100),
    minCcu: num(input.minCcu, 800, 0, 10_000_000),
    maxCcu: num(input.maxCcu, 3000, 0, 10_000_000),
    createdWithinValue: unit === 'all' ? 1 : num(input.createdWithinValue, 30, 1, 10_000_000),
    createdWithinUnit: unit,
    minVisits: num(input.minVisits, 0, 0, 100_000_000_000),
    creatorType: ['all','User','Group'].includes(String(input.creatorType)) ? String(input.creatorType) : 'all',
    genre: String(input.genre || 'all').slice(0,100),
    verifiedOnly: Boolean(input.verifiedOnly),
  };
}

function githubHeaders(env) {
  return {
    'authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Nichegames-Cloudflare-Trigger',
  };
}

function githubBase(env) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

async function findWorkflowRun(env, scanId) {
  const workflow = env.GITHUB_WORKFLOW || 'scan.yml';
  const url = `${githubBase(env)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=50`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return { error: `GitHub run lookup failed (${response.status}).`, status: response.status };
  const payload = await response.json();
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const wanted = String(scanId || '');
  const run = runs.find((item) => String(item?.display_title || '').includes(wanted)) || null;
  return { run };
}

async function cancelWorkflowRun(env, runId) {
  const base = `${githubBase(env)}/actions/runs/${runId}`;
  let response = await fetch(`${base}/cancel`, { method:'POST', headers:githubHeaders(env) });
  if (response.ok) return { ok:true, forced:false };

  // GitHub documents force-cancel for runs that do not respond to normal
  // cancellation. This also handles workflows that are stuck in cleanup.
  response = await fetch(`${base}/force-cancel`, { method:'POST', headers:githubHeaders(env) });
  if (response.ok) return { ok:true, forced:true };
  return { ok:false, status:response.status, detail:(await response.text()).slice(0,500) };
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || 'https://nichegamesfinder.web.app';
    const origin = request.headers.get('origin') || '';
    const corsOrigin = origin === allowed || origin === 'https://nichegamesfinder.firebaseapp.com' ? origin : allowed;
    if (request.method === 'OPTIONS') return json({ ok:true }, 200, corsOrigin);

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok:true, service:'nichegames-scan-trigger', version:'8.0' }, 200, corsOrigin);
    if (origin && origin !== allowed && origin !== 'https://nichegamesfinder.firebaseapp.com') return json({ error:'Origin not allowed' }, 403, corsOrigin);
    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) return json({ error:'Worker GitHub settings are incomplete.' }, 500, corsOrigin);

    if (request.method === 'GET' && url.pathname === '/status') {
      const scanId = String(url.searchParams.get('scanId') || '').slice(0,100);
      if (!scanId) return json({ error:'scanId is required.' }, 400, corsOrigin);
      const found = await findWorkflowRun(env, scanId);
      if (found.error) return json({ error:found.error }, 502, corsOrigin);
      if (!found.run) return json({ ok:true, found:false, scanId }, 200, corsOrigin);
      return json({
        ok:true,
        found:true,
        scanId,
        runId:found.run.id,
        status:found.run.status,
        conclusion:found.run.conclusion,
        url:found.run.html_url,
      }, 200, corsOrigin);
    }

    if (request.method === 'POST' && url.pathname === '/cancel') {
      let body;
      try { body = await request.json(); } catch { return json({ error:'Invalid JSON body.' }, 400, corsOrigin); }
      const scanId = String(body?.scanId || '').slice(0,100);
      if (!scanId) return json({ error:'scanId is required.' }, 400, corsOrigin);
      const found = await findWorkflowRun(env, scanId);
      if (found.error) return json({ error:found.error }, 502, corsOrigin);
      if (!found.run) return json({ ok:true, found:false, stopped:true, scanId }, 200, corsOrigin);
      if (found.run.status === 'completed') return json({ ok:true, found:true, stopped:true, alreadyCompleted:true, conclusion:found.run.conclusion, scanId }, 200, corsOrigin);
      const cancelled = await cancelWorkflowRun(env, found.run.id);
      if (!cancelled.ok) return json({ error:`GitHub could not cancel the scanner (${cancelled.status}).`, detail:cancelled.detail }, 502, corsOrigin);
      return json({ ok:true, found:true, stopped:true, forced:cancelled.forced, scanId, runId:found.run.id }, 202, corsOrigin);
    }

    if (request.method === 'POST' && url.pathname === '/lookup') {
      let body;
      try { body = await request.json(); } catch { return json({ error:'Invalid JSON body.' }, 400, corsOrigin); }
      const input = String(body?.input || '').trim().slice(0,500);
      if (!input) return json({ error:'A Roblox URL or ID is required.' }, 400, corsOrigin);
      const scanId = `lookup_${Date.now()}_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
      const workflow = env.GITHUB_WORKFLOW || 'scan.yml';
      const ref = env.GITHUB_REF || 'main';
      const filters = normalizeFilters({ allGames:true, lookupInput:input, minCcu:0, maxCcu:10_000_000, createdWithinUnit:'all' });
      const gh = await fetch(`${githubBase(env)}/actions/workflows/${workflow}/dispatches`, {
        method:'POST',
        headers:{ ...githubHeaders(env), 'content-type':'application/json' },
        body:JSON.stringify({ ref, inputs:{ scan_id:scanId, filters_json:JSON.stringify(filters) } }),
      });
      if (!gh.ok) {
        const text = await gh.text();
        return json({ error:`GitHub could not start the game lookup (${gh.status}).`, detail:text.slice(0,500) }, 502, corsOrigin);
      }
      return json({ ok:true, scanId, input }, 202, corsOrigin);
    }

    if (request.method !== 'POST' || url.pathname !== '/scan') return json({ error:'Not found' }, 404, corsOrigin);

    let body;
    try { body = await request.json(); } catch { return json({ error:'Invalid JSON body.' }, 400, corsOrigin); }
    const filters = normalizeFilters(body?.filters || {});
    if (filters.maxCcu < filters.minCcu) return json({ error:'Maximum CCU must be greater than or equal to minimum CCU.' }, 400, corsOrigin);
    const scanId = `scan_${Date.now()}_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
    const workflow = env.GITHUB_WORKFLOW || 'scan.yml';
    const ref = env.GITHUB_REF || 'main';
    const gh = await fetch(`${githubBase(env)}/actions/workflows/${workflow}/dispatches`, {
      method:'POST',
      headers:{ ...githubHeaders(env), 'content-type':'application/json' },
      body:JSON.stringify({ ref, inputs:{ scan_id:scanId, filters_json:JSON.stringify(filters) } }),
    });
    if (!gh.ok) {
      const text = await gh.text();
      return json({ error:`GitHub could not start the scanner (${gh.status}).`, detail:text.slice(0,500) }, 502, corsOrigin);
    }
    return json({ ok:true, scanId, filters }, 202, corsOrigin);
  },
};
