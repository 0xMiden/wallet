// Bread Signal Explorer snapshot.
//
// Sentry already folds events into one report per fingerprint. The crash ledger
// keeps one row per report and only ties reports together when analysis has
// shown they share a cause (fix_group, or duplicate_of). This snapshot adds the
// view on top: a transaction stage or screen surface, then a cluster inside it.

const DONE = new Set(['merged', 'already-fixed', 'not-actionable'])
const OPEN_BUCKETS = new Set(['waiting', 'needs_evidence', 'ready', 'in_progress', 'regressed', 'other'])
const CLOSED_BUCKETS = new Set(['fixed', 'not_actionable'])

const SURFACE_LABELS = {
  os_notification: 'OS notification',
  status_screen: 'Status screen',
  browser_alert: 'Browser alert',
}

const STAGE_LABELS = {
  signing: 'Signing',
  submitting: 'Submitting',
  sending: 'Sending',
  unknown: 'Unknown stage',
  syncing: 'Syncing',
  proving: 'Proving',
  confirming: 'Confirming',
  executing: 'Executing',
}

export function redact(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '…')
    .replace(/0x[0-9a-f]{6,}/gi, '0x…')
    .replace(/\b[0-9a-f]{24,}\b/gi, '…')
    .replace(/https?:\/\/\S+/gi, (url) => {
      try {
        return new URL(url).hostname
      } catch {
        return '…'
      }
    })
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function signature(title) {
  return redact(title)
    .toLowerCase()
    .replace(/0x…/g, '')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function labelize(token) {
  return token.replace(/_/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

export function areaOf(title) {
  const text = String(title || '')
  const stage = text.match(/\bstage[:\s]+([A-Za-z0-9_]+)/)
  if (stage) {
    const token = stage[1].toLowerCase()
    return { id: `stage:${token}`, label: STAGE_LABELS[token] || labelize(token) }
  }
  const surface = text.match(/\bsurface[:\s]+([A-Za-z0-9_]+)/)
  if (surface) {
    const token = surface[1].toLowerCase()
    return { id: `surface:${token}`, label: SURFACE_LABELS[token] || labelize(token) }
  }
  return { id: 'other', label: 'Other' }
}

export function bucketOf(entry) {
  if (!entry) return 'waiting'
  if (entry.regressed) return 'regressed'
  if (entry.status === 'duplicate') return 'duplicate'
  if (entry.status === 'fixing') return 'in_progress'
  if (['implementing', 'reviewing', 'ci'].includes(entry.stage) && !DONE.has(entry.status)) return 'in_progress'
  if (entry.status === 'merged' || entry.status === 'already-fixed') return 'fixed'
  if (entry.status === 'not-actionable') return 'not_actionable'
  if (entry.status === 'blocked') return 'needs_evidence'
  if (entry.status === 'actionable') return 'ready'
  if (entry.status === 'new' || entry.status === 'analysing' || !entry.status) return 'waiting'
  return 'other'
}

function closeTime(entry) {
  if (!entry || entry.regressed || !DONE.has(entry.status)) return null
  if (entry.fixed_at) return entry.fixed_at
  const history = Array.isArray(entry.history) ? entry.history : []
  const hit = [...history].reverse().find((item) => DONE.has(item.status))
  return hit?.at || null
}

function resolveRoot(key, entries, guard = new Set()) {
  if (guard.has(key)) return key
  guard.add(key)
  const next = entries[key]?.duplicate_of
  if (next && entries[next]) return resolveRoot(next, entries, guard)
  return key
}

function shortTitle(title) {
  const text = redact(title)
    .replace(/^WalletTransactionFailure:\s*/i, '')
    .replace(/^WalletUserVisibleError:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = text.split(';').map((part) => part.trim()).filter(Boolean)
  // The shared prefix is long and the distinguishing detail sits at the end.
  const chosen = parts.length > 4 ? `${parts[0]}; ${parts.slice(-3).join('; ')}` : text
  if (chosen.length <= 200) return chosen
  return `${chosen.slice(0, 197).trimEnd()}…`
}

function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function positiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number < 1_000_000 ? number : null
}

function safePermalink(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    if (url.hostname !== 'miden.sentry.io' && url.hostname !== 'de.sentry.io') return ''
    return url.toString()
  } catch {
    return ''
  }
}

function normalizeSentry(raw) {
  const shortId = String(raw.shortId || '')
  if (!shortId) return null
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : null
  return {
    shortId,
    id: String(raw.id || ''),
    title: String(raw.title || '').slice(0, 400),
    culprit: String(raw.culprit || '').slice(0, 200),
    events: asNumber(raw.count ?? raw.events),
    users: asNumber(raw.userCount ?? raw.users),
    firstSeen: raw.firstSeen || raw.first_seen || null,
    lastSeen: raw.lastSeen || raw.last_seen || null,
    level: raw.level || null,
    substatus: raw.substatus || null,
    unhandled: Boolean(raw.isUnhandled ?? raw.unhandled),
    permalink: safePermalink(raw.permalink),
    stats,
  }
}

function weekStart(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const day = date.getUTCDay() || 7
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - day + 1)
  return date.toISOString().slice(0, 10)
}

function rhythmOf(issues) {
  const buckets = new Map()
  for (const issue of issues) {
    const points = issue.stats?.['24h']
    if (!Array.isArray(points)) continue
    for (const pair of points) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      const stamp = Number(pair[0])
      const count = asNumber(pair[1])
      if (!Number.isFinite(stamp)) continue
      buckets.set(stamp, (buckets.get(stamp) || 0) + count)
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, events]) => ({ t, events }))
}

function weeksOf(issues, now) {
  const end = new Date(now)
  if (Number.isNaN(end.getTime())) return []
  const keys = []
  for (let index = 11; index >= 0; index -= 1) {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - index * 7)
    const key = weekStart(date.toISOString())
    if (key && !keys.includes(key)) keys.push(key)
  }
  const counts = new Map(keys.map((key) => [key, { week: key, reports: 0, events: 0 }]))
  for (const issue of issues) {
    const key = issue.lastSeen ? weekStart(issue.lastSeen) : null
    const row = key ? counts.get(key) : null
    if (!row) continue
    row.reports += 1
    row.events += issue.events
  }
  return keys.map((key) => counts.get(key))
}

function releaseWindows(releases) {
  const dated = releases
    .filter((release) => release.created && !Number.isNaN(Date.parse(release.created)))
    .map((release) => ({ version: release.version, created: Date.parse(release.created) }))
    .sort((a, b) => a.created - b.created)
  return dated.map((release, index) => ({
    version: release.version,
    start: release.created,
    end: dated[index + 1]?.created ?? Infinity,
  }))
}

function closedDuring(iso, windows) {
  if (!iso) return null
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  const hit = windows.find((window) => time >= window.start && time < window.end)
  return hit?.version || null
}

function seenIndex(seen) {
  const index = new Map()
  for (const [version, keys] of Object.entries(seen || {})) {
    if (!Array.isArray(keys)) continue
    for (const key of keys) {
      if (!index.has(key)) index.set(key, new Set())
      index.get(key).add(version)
    }
  }
  return index
}

export function buildSnapshot({
  issues = [],
  ledger = { issues: {} },
  releases = [],
  seen = {},
  now = new Date().toISOString(),
  listAt = null,
  fetchedAt = null,
  resolvedHits = null,
  ignoredHits = null,
  orchestrator = null,
} = {}) {
  const entries = ledger.issues || {}
  const ledgerRead = ledger.issues != null
  const sentryByKey = new Map()
  for (const raw of issues) {
    const item = raw && typeof raw === 'object' ? normalizeSentry(raw) : null
    if (item) sentryByKey.set(item.shortId, item)
  }
  const keys = new Set([...sentryByKey.keys(), ...Object.keys(entries)])
  const seenByKey = seenIndex(seen)
  const windows = releaseWindows(releases)
  const knownVersions = new Set(releases.map((release) => release.version))

  const drafts = []
  for (const key of keys) {
    const sentry = sentryByKey.get(key)
    const entry = entries[key]
    const title = sentry?.title || entry?.title || key
    const rootKey = resolveRoot(key, entries)
    const root = entries[rootKey] || entry
    const rootTitle = sentryByKey.get(rootKey)?.title || root?.title || title
    const group = root?.fix_group ? String(root.fix_group) : ''
    const clusterId = group ? `work:${group}` : `sig:${signature(rootTitle)}`
    const area = areaOf(title)
    const events = sentry ? sentry.events : asNumber(entry?.count)
    const versions = new Set(seenByKey.get(key) || [])
    if (entry?.release && knownVersions.has(String(entry.release))) versions.add(String(entry.release))
    const finishedAt = closeTime(entry)
    drafts.push({
      key,
      sentryId: sentry?.id || String(entry?.id || ''),
      title: redact(title).slice(0, 400),
      culprit: redact(sentry?.culprit || '').slice(0, 180),
      permalink: sentry?.permalink || '',
      events,
      users: sentry ? sentry.users : asNumber(entry?.users),
      firstSeen: sentry?.firstSeen || entry?.first_seen || null,
      lastSeen: sentry?.lastSeen || entry?.last_seen || null,
      level: sentry?.level || entry?.level || null,
      substatus: sentry?.substatus || null,
      unhandled: sentry ? sentry.unhandled : Boolean(entry?.unhandled),
      inSentry: Boolean(sentry),
      bucket: bucketOf(entry),
      ledgerStatus: entry?.status || (sentry ? 'new' : ''),
      stage: entry?.stage || '',
      outcome: entry?.outcome || '',
      needs: redact(entry?.needs || '').slice(0, 200),
      pr: positiveInt(entry?.pr),
      githubIssue: positiveInt(entry?.github_issue),
      branch: typeof entry?.branch === 'string' ? entry.branch.slice(0, 120) : '',
      regressed: Boolean(entry?.regressed),
      fresh: entry && entry.reviewed_count != null ? Math.max(0, events - asNumber(entry.reviewed_count)) : null,
      seenIn: [...versions].sort(),
      closedDuring: closedDuring(finishedAt, windows),
      finishedAt,
      areaId: area.id,
      areaLabel: area.label,
      clusterId,
      kind: group ? 'work' : 'message',
      group,
      stats: sentry?.stats || null,
    })
  }

  const rhythm = rhythmOf(drafts.filter((issue) => issue.inSentry))
  const byCluster = new Map()
  for (const issue of drafts) {
    if (!byCluster.has(issue.clusterId)) byCluster.set(issue.clusterId, [])
    byCluster.get(issue.clusterId).push(issue)
  }
  for (const members of byCluster.values()) {
    const heaviest = [...members].sort((a, b) => b.events - a.events || a.key.localeCompare(b.key))[0]
    const label = shortTitle(heaviest.title) || heaviest.group || heaviest.key
    const areaEvents = new Map()
    for (const issue of members) areaEvents.set(issue.areaId, (areaEvents.get(issue.areaId) || 0) + Math.max(issue.events, 1))
    const ranked = [...areaEvents.entries()].sort((a, b) => b[1] - a[1])
    const dominantId = ranked[0][0]
    const dominantLabel = members.find((issue) => issue.areaId === dominantId)?.areaLabel || 'Other'
    const also = ranked
      .slice(1)
      .filter(([, weight]) => weight > 0)
      .map(([id]) => members.find((issue) => issue.areaId === id)?.areaLabel)
      .filter(Boolean)
      .slice(0, 2)
    for (const issue of members) {
      issue.clusterLabel = label
      issue.clusterArea = dominantId
      issue.clusterAreaLabel = dominantLabel
      issue.also = also
      delete issue.stats
    }
  }

  const releaseRows = releases.map((release) => ({
    version: String(release.version),
    created: release.created || null,
    newGroups: asNumber(release.newGroups),
    events: asNumber(release.events),
    seenReports: asNumber(release.seenReports),
    joined: Object.prototype.hasOwnProperty.call(seen || {}, release.version),
  }))
  releaseRows.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))

  const sentryIssues = drafts.filter((issue) => issue.inSentry)
  const closedUnplaced = drafts.filter((issue) => CLOSED_BUCKETS.has(issue.bucket) && !issue.closedDuring).length
  const firstRelease = [...releaseRows].reverse().find((release) => release.created)

  return {
    generatedAt: now,
    period: '90d',
    project: 'bread-wallet',
    meta: {
      listAt,
      ledgerUpdated: ledger.updated || null,
      ledgerRead,
      fetchedAt,
      resolvedHits,
      ignoredHits,
      orchestrator: orchestrator && orchestrator.model ? { model: String(orchestrator.model), active: orchestrator.active || null } : null,
      closedUnplaced,
      oldestRelease: firstRelease?.version || null,
    },
    releases: releaseRows,
    rhythm,
    weeks: weeksOf(sentryIssues, now),
    issues: drafts.sort((a, b) => b.events - a.events || a.key.localeCompare(b.key)),
    counts: {
      sentry: sentryIssues.length,
      ledgerOnly: drafts.length - sentryIssues.length,
      openBuckets: drafts.filter((issue) => OPEN_BUCKETS.has(issue.bucket)).length,
    },
  }
}
