import { buildSnapshot } from './snapshot.mjs'

const ORIGINS = new Set(['https://0xmiden.github.io', 'http://127.0.0.1:4737', 'http://localhost:4737'])
const SENTRY = 'https://de.sentry.io'
const CACHE_MS = 15 * 60 * 1000

function cors(response, request) {
  const origin = request.headers.get('Origin') || ''
  const headers = new Headers(response.headers)
  if (ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, headers })
}

function json(body, status, request) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }), request)
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

function authorized(request, env) {
  const header = request.headers.get('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return Boolean(env.SYNC_TOKEN) && sameSecret(token, env.SYNC_TOKEN)
}

function nextUrl(link) {
  if (!link) return null
  for (const part of link.split(',')) {
    if (part.includes('rel="next"') && part.includes('results="true"')) {
      const match = part.match(/<([^>]+)>/)
      return match ? match[1] : null
    }
  }
  return null
}

async function sentry(env, url) {
  const parsed = new URL(url)
  if (parsed.hostname !== 'de.sentry.io' || !parsed.pathname.startsWith('/api/0/')) throw new Error('refusing sentry host')
  const response = await fetch(parsed, {
    headers: { Authorization: `Bearer ${env.SENTRY_TOKEN}`, Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`sentry ${response.status}`)
  return { data: await response.json(), headers: response.headers }
}

function slimIssue(row) {
  const stats = row.stats && typeof row.stats === 'object' ? row.stats : {}
  const day = Array.isArray(stats['24h']) ? stats['24h'] : []
  const permalink = typeof row.permalink === 'string' && row.permalink.startsWith('https://') ? row.permalink : ''
  return {
    id: String(row.id || ''),
    shortId: String(row.shortId || ''),
    title: String(row.title || '').slice(0, 400),
    culprit: String(row.culprit || '').slice(0, 200),
    count: row.count || 0,
    userCount: row.userCount || 0,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    level: row.level,
    substatus: row.substatus,
    status: row.status,
    isUnhandled: Boolean(row.isUnhandled),
    permalink,
    stats: { '24h': day },
  }
}

async function pages(env, first) {
  let url = first
  const out = []
  const seen = new Set()
  while (url && seen.size < 20) {
    if (seen.has(url)) break
    seen.add(url)
    const response = await sentry(env, url)
    if (!Array.isArray(response.data)) throw new Error('expected a list')
    out.push(...response.data)
    url = nextUrl(response.headers.get('link'))
  }
  return out
}

async function refreshSentry(env) {
  if (!env.SENTRY_TOKEN) throw new Error('sentry token is not set')
  const project = await sentry(env, `${SENTRY}/api/0/projects/miden/bread-wallet/`)
  const projectId = String(project.data.id || '')
  if (!/^\d+$/.test(projectId)) throw new Error('sentry project id missing')
  const unresolved = (await pages(env, `${SENTRY}/api/0/organizations/miden/issues/?project=${projectId}&query=${encodeURIComponent('is:unresolved')}&statsPeriod=90d&limit=100`))
    .map(slimIssue)
    .filter((issue) => issue.shortId)
  const releaseRows = await pages(env, `${SENTRY}/api/0/projects/miden/bread-wallet/releases/?per_page=20`)
  const releases = releaseRows
    .filter((row) => /^[0-9A-Za-z.+_-]+$/.test(String(row.version || '')))
    .slice(0, 12)
    .map((row) => ({ version: String(row.version), created: row.dateCreated || null, newGroups: row.newGroups || 0, events: 0, seenReports: 0 }))
  const totals = await sentry(env, `${SENTRY}/api/0/organizations/miden/events/?project=${projectId}&dataset=errors&statsPeriod=90d&per_page=25&query=${encodeURIComponent('is:unresolved')}&field=release&field=count()&field=count_unique(issue)&sort=-count()`)
  const byVersion = new Map()
  for (const row of totals.data?.data || []) {
    if (row && /^[0-9A-Za-z.+_-]+$/.test(String(row.release || ''))) byVersion.set(String(row.release), row)
  }
  for (const release of releases) {
    const extra = byVersion.get(release.version)
    if (!extra) continue
    release.events = extra['count()'] || 0
    release.seenReports = extra['count_unique(issue)'] || 0
  }
  const seen = {}
  for (const release of releases.slice(0, 8)) {
    const rows = await pages(env, `${SENTRY}/api/0/organizations/miden/issues/?project=${projectId}&query=${encodeURIComponent(`is:unresolved release:${release.version}`)}&statsPeriod=90d&limit=100`)
    seen[release.version] = [...new Set(rows.map((row) => String(row.shortId || '')).filter(Boolean))]
  }
  let resolvedHits = null
  let ignoredHits = null
  try {
    const resolved = await sentry(env, `${SENTRY}/api/0/organizations/miden/issues/?project=${projectId}&query=${encodeURIComponent('is:resolved')}&statsPeriod=90d&limit=1`)
    const hits = resolved.headers.get('x-hits')
    resolvedHits = hits && /^\d+$/.test(hits) ? Number(hits) : 0
  } catch { resolvedHits = null }
  try {
    const ignored = await sentry(env, `${SENTRY}/api/0/organizations/miden/issues/?project=${projectId}&query=${encodeURIComponent('is:ignored')}&statsPeriod=90d&limit=1`)
    const hits = ignored.headers.get('x-hits')
    ignoredHits = hits && /^\d+$/.test(hits) ? Number(hits) : 0
  } catch { ignoredHits = null }
  const cache = { fetchedAt: new Date().toISOString(), issues: unresolved, releases, seen, resolvedHits, ignoredHits }
  await env.SIGNAL.put('sentry', JSON.stringify(cache))
  return cache
}

async function cachedSentry(env) {
  const raw = await env.SIGNAL.get('sentry')
  const cache = raw ? JSON.parse(raw) : null
  const fresh = cache?.fetchedAt && Date.now() - Date.parse(cache.fetchedAt) < CACHE_MS
  if (fresh) return cache
  try {
    return await refreshSentry(env)
  } catch (error) {
    if (cache) return cache
    throw error
  }
}

async function snapshot(request, env) {
  const sentryCache = await cachedSentry(env)
  const ledger = JSON.parse(await env.SIGNAL.get('ledger') || '{"issues":null}')
  const posted = JSON.parse(await env.SIGNAL.get('extra') || '{}')
  const seen = Object.keys(sentryCache.seen || {}).length ? sentryCache.seen : (posted.seen || {})
  const body = buildSnapshot({
    issues: sentryCache.issues || [],
    ledger,
    releases: sentryCache.releases || [],
    seen,
    fetchedAt: sentryCache.fetchedAt || null,
    resolvedHits: sentryCache.resolvedHits ?? null,
    ignoredHits: sentryCache.ignoredHits ?? null,
    orchestrator: posted.orchestrator || null,
  })
  return json(body, 200, request)
}

async function store(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401, request)
  const body = await request.json()
  if (!body || typeof body !== 'object' || !body.ledger || typeof body.ledger !== 'object') {
    return json({ error: 'ledger required' }, 400, request)
  }
  await env.SIGNAL.put('ledger', JSON.stringify(body.ledger))
  await env.SIGNAL.put('extra', JSON.stringify({
    orchestrator: body.orchestrator || null,
    seen: body.seen && typeof body.seen === 'object' ? body.seen : {},
  }))
  return json({ ok: true }, 200, request)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request)
      if (url.pathname === '/api/snapshot' && request.method === 'GET') return await snapshot(request, env)
      if (url.pathname === '/api/sync' && request.method === 'POST') return await store(request, env)
      return json({ error: 'not found' }, 404, request)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message.slice(0, 180) : 'failed' }, 500, request)
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshSentry(env))
  },
}
