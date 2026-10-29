import { captionFor } from './labels.mjs'
import { layout } from './layout.mjs'

const API = String(window.SIGNAL_API || '').replace(/\/$/, '')
function api(path) { return `${API}${path}` }

const OPEN = new Set(['waiting', 'needs_evidence', 'ready', 'in_progress', 'regressed', 'other'])
const CLOSED = new Set(['fixed', 'not_actionable'])
const STATUS = [
  ['waiting', 'Waiting for analysis'],
  ['needs_evidence', 'Needs evidence'],
  ['ready', 'Ready to fix'],
  ['in_progress', 'In progress'],
  ['fixed', 'Fixed'],
  ['not_actionable', 'Not actionable'],
  ['duplicate', 'Duplicate'],
  ['regressed', 'Regressed'],
]
const SUBSTATUS = [
  ['new', 'New'],
  ['ongoing', 'Ongoing'],
  ['escalating', 'Escalating'],
]
const AREA_COLOR = {
  'stage:signing': '#e77537',
  'stage:submitting': '#e0c07a',
  'stage:sending': '#d4654e',
  'stage:syncing': '#8aa4b8',
  'stage:proving': '#c48b6a',
  'stage:confirming': '#8eae72',
  'stage:executing': '#d27b66',
  'stage:unknown': '#8d8174',
  other: '#6f655c',
}
const nf = new Intl.NumberFormat('en-GB')
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const state = {
  snap: null,
  error: '',
  release: null,
  bucket: null,
  substatus: null,
  level: null,
  query: '',
  showClosed: false,
  area: null,
  cluster: null,
  issue: null,
  size: 'events',
  expand: new Set(),
  refreshing: false,
  animatedFor: '',
  heroKey: '',
  statusKey: '',
  chartsKey: '',
}

const isOpen = (issue) => OPEN.has(issue.bucket)
const isClosed = (issue) => CLOSED.has(issue.bucket)

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function day(iso, withYear = true) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  }).format(date)
}

function clock(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'no heartbeat yet'
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(date)
  return `${day(iso)}, ${time} UTC`
}

function ago(iso) {
  if (!iso) return ''
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

function areaColor(id) {
  if (AREA_COLOR[id]) return AREA_COLOR[id]
  const palette = ['#c4b08a', '#a89070', '#b7a08a', '#9aaa8a', '#d2b48c']
  let hash = 0
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

function tally(issues, key) {
  const counts = new Map()
  for (const issue of issues) {
    const name = issue[key] || 'unspecified'
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return counts
}

function eventsOf(issues, key, value) {
  return issues.filter((issue) => (issue[key] || 'unspecified') === value).reduce((sum, issue) => sum + issue.events, 0)
}

function buildClusters(issues) {
  const map = new Map()
  for (const issue of issues) {
    let cluster = map.get(issue.clusterId)
    if (!cluster) {
      cluster = {
        id: issue.clusterId,
        label: issue.clusterLabel,
        area: issue.clusterArea,
        areaLabel: issue.clusterAreaLabel,
        group: issue.group,
        also: issue.also || [],
        kind: issue.kind,
        issues: [],
      }
      map.set(issue.clusterId, cluster)
    }
    cluster.issues.push(issue)
  }
  for (const cluster of map.values()) {
    cluster.events = cluster.issues.reduce((sum, issue) => sum + issue.events, 0)
    cluster.reports = cluster.issues.length
    cluster.openReports = cluster.issues.filter(isOpen).length
    cluster.open = cluster.openReports > 0
  }
  return [...map.values()].sort((a, b) => b.events - a.events || b.reports - a.reports)
}

function buildAreas(clusters) {
  const map = new Map()
  for (const cluster of clusters) {
    let area = map.get(cluster.area)
    if (!area) {
      area = { id: cluster.area, label: cluster.areaLabel, clusters: [], events: 0, reports: 0 }
      map.set(cluster.area, area)
    }
    area.clusters.push(cluster)
    area.events += cluster.events
    area.reports += cluster.reports
  }
  return [...map.values()].sort((a, b) => b.events - a.events || a.label.localeCompare(b.label))
}

function baseIssues(snap) {
  if (!state.release) return snap.issues
  return snap.issues.filter((issue) => issue.seenIn.includes(state.release) || issue.closedDuring === state.release)
}

function faceted(issues) {
  const query = state.query.trim().toLowerCase()
  return issues.filter((issue) => {
    if (state.bucket && issue.bucket !== state.bucket) return false
    if (state.substatus && issue.substatus !== state.substatus) return false
    if (state.level && issue.level !== state.level) return false
    if (!query) return true
    return `${issue.key} ${issue.title} ${issue.areaLabel} ${issue.clusterLabel} ${issue.group} ${issue.culprit}`
      .toLowerCase()
      .includes(query)
  })
}

function releaseStats(snap, release) {
  const seen = snap.issues.filter((issue) => issue.seenIn.includes(release.version))
  const open = seen.filter(isOpen).length
  const closed = seen.filter(isClosed).length
  if (release.joined) return { open, closed, seen: seen.length, split: true }
  return { open: null, closed: null, seen: release.seenReports || seen.length, split: false }
}

function fill(id, html) {
  const node = document.getElementById(id)
  if (!node) return
  const active = document.activeElement
  const keep = active && node.contains(active) && active.id
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
    : null
  node.innerHTML = html
  if (!keep) return
  const field = document.getElementById(keep.id)
  if (!field) return
  field.focus()
  if (typeof keep.start === 'number' && field.setSelectionRange) field.setSelectionRange(keep.start, keep.end)
}

function armBars() {
  const apply = () => {
    document.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.dataset.w })
    document.querySelectorAll('[data-h]').forEach((el) => { el.style.height = el.dataset.h })
  }
  if (reduce) apply()
  else requestAnimationFrame(apply)
}

function animate(node, target) {
  if (reduce) {
    node.textContent = nf.format(target)
    return
  }
  const started = performance.now()
  const frame = (now) => {
    const progress = Math.min(1, (now - started) / 700)
    const eased = 1 - (1 - progress) ** 3
    node.textContent = nf.format(Math.round(target * eased))
    if (progress < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function bar(segments, thin = false) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  if (!total) return '<div class="bar"></div>'
  const spans = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => `<span class="seg seg-${esc(segment.id)}" data-w="${(segment.value / total) * 100}%"></span>`)
    .join('')
  return `<div class="bar${thin ? ' thin' : ''}" role="img">${spans}</div>`
}

function legend(items, action, selected) {
  return `<div class="legend">${items.map((item) => `
    <button type="button" data-act="${action}" data-${action}="${esc(item.id)}" class="${selected === item.id ? 'is-on' : ''}" aria-pressed="${selected === item.id}">
      <i class="dot ${esc(item.id)}"></i>
      <span>${esc(item.label)}</span>
      <strong>${nf.format(item.reports)}</strong>
      <span>${nf.format(item.events)} events</span>
    </button>`).join('')}</div>`
}

function switcherHtml(snap) {
  const nowOn = state.release == null
  const chips = [`<button type="button" class="chip${nowOn ? ' is-on' : ''}" role="tab" aria-selected="${nowOn}" data-act="release" data-release="now">
      <span class="chip-kicker">Now</span>
      <span class="chip-version">Open</span>
      <span class="chip-counts">${nf.format(snap.counts.sentry)} reports</span>
    </button>`]
  for (const release of snap.releases) {
    const stats = releaseStats(snap, release)
    const on = state.release === release.version
    const counts = stats.split
      ? `${nf.format(stats.open)} open${stats.closed ? ` · ${nf.format(stats.closed)} closed` : ''}`
      : (stats.seen ? `${nf.format(stats.seen)} seen` : 'Not loaded')
    chips.push(`<button type="button" class="chip${on ? ' is-on' : ''}" role="tab" aria-selected="${on}" data-act="release" data-release="${esc(release.version)}">
      <span class="chip-kicker">${esc(day(release.created, false) || 'Release')}</span>
      <span class="chip-version">${esc(release.version)}</span>
      <span class="chip-counts">${counts}</span>
    </button>`)
  }
  const resolved = snap.meta.resolvedHits
  const resolvedLine = resolved === 0
    ? 'Sentry has not resolved any report in this window.'
    : resolved > 0
      ? `Sentry has ${nf.format(resolved)} resolved reports in this window.`
      : 'Closed, on this page, is the crash ledger.'
  const archived = snap.meta.ignoredHits > 0 ? ` ${nf.format(snap.meta.ignoredHits)} archived reports are outside this queue.` : ''
  const note = snap.releases.length
    ? `A report seen in several releases is counted in each. ${resolvedLine}${archived}`
    : 'Refresh to load releases and split what is still open from what the ledger has closed.'
  return `<div class="switcher-row" role="tablist">${chips.join('')}</div><p class="switch-note">${esc(note)}</p>`
}

function heroHtml(snap) {
  const population = state.release
    ? snap.issues.filter((issue) => issue.seenIn.includes(state.release))
    : snap.issues.filter((issue) => issue.inSentry)
  const reports = population.length
  const events = population.reduce((sum, issue) => sum + issue.events, 0)
  const subCounts = tally(population, 'substatus')
  const segments = SUBSTATUS.map(([id, label]) => ({
    id,
    label,
    reports: subCounts.get(id) || 0,
    events: eventsOf(population, 'substatus', id),
  })).filter((segment) => segment.reports)
  for (const [id, reportsOf] of subCounts) {
    if (!SUBSTATUS.some(([known]) => known === id) && reportsOf) {
      segments.push({ id, label: id, reports: reportsOf, events: eventsOf(population, 'substatus', id) })
    }
  }
  const levels = tally(population, 'level')
  const release = snap.releases.find((item) => item.version === state.release)
  const stats = release ? releaseStats(snap, release) : null
  const during = state.release ? snap.issues.filter((issue) => issue.closedDuring === state.release).length : 0
  const heroKey = state.release || 'now'
  const figures = state.release && stats?.split
    ? `<div class="pair">
        <div><p class="figure" data-hero="${esc(heroKey)}-open" data-n="${stats.open}">0</p><p class="figure-label">Still open</p></div>
        <div><p class="figure figure-dim" data-hero="${esc(heroKey)}-closed" data-n="${stats.closed}">0</p><p class="figure-label">Closed</p></div>
      </div>
      <p class="events-line"><b>${nf.format(reports)}</b> seen in ${esc(state.release)}${release?.events ? ` · <b>${nf.format(release.events)}</b> events` : ''}</p>`
    : state.release
    ? `<p class="figure" data-hero="${esc(heroKey)}" data-n="${stats?.seen || reports}">0</p>
      <p class="figure-label">Seen in ${esc(state.release)}</p>
      <p class="events-line">${release?.events ? `<b>${nf.format(release.events)}</b> events` : 'Release membership is not loaded yet. Refresh.'}</p>`
    : `<p class="figure" data-hero="now" data-n="${reports}">0</p>
      <p class="figure-label">Open reports</p>
      <p class="events-line"><b>${nf.format(events)}</b> events on these reports${population.filter((issue) => issue.unhandled).length ? ` · ${nf.format(population.filter((issue) => issue.unhandled).length)} unhandled` : ''}</p>`
  const side = state.release
    ? `<div class="side-stack">
        <p class="side-stat"><b>${nf.format(release?.newGroups || 0)}</b><span>new fingerprints</span></p>
        <p class="side-stat"><b>${nf.format(during)}</b><span>finished while it was newest</span></p>
        <p class="side-stat"><b>${nf.format(levels.get('error') || 0)}</b><span>errors</span></p>
      </div>`
    : `<div class="side-stack">
        <button type="button" class="side-stat${state.level === 'error' ? ' is-on' : ''}" data-act="level" data-level="error"><b>${nf.format(levels.get('error') || 0)}</b><span>errors</span></button>
        <button type="button" class="side-stat${state.level === 'warning' ? ' is-on' : ''}" data-act="level" data-level="warning"><b>${nf.format(levels.get('warning') || 0)}</b><span>warnings</span></button>
        <p class="side-stat"><b>${nf.format(population.filter((issue) => issue.unhandled).length)}</b><span>unhandled</span></p>
      </div>`
  const reportSegments = segments.map((segment) => ({ ...segment, value: segment.reports }))
  const eventSegments = segments.map((segment) => ({ ...segment, value: segment.events }))
  return `<div class="panel">
    <p class="kicker">${state.release ? 'This release' : 'Sentry, open queue'}</p>
    <div class="hero-grid">
      <div>${figures}
        ${bar(reportSegments)}
        ${bar(eventSegments, true)}
        ${legend(segments, 'substatus', state.substatus)}
        <p class="caption">Top bar sized by reports. Lower bar sized by events. Last 90 days, bread-wallet.${snap.meta.listAt ? ` List read ${esc(ago(snap.meta.listAt))}.` : ''}</p>
      </div>
      ${side}
    </div>
  </div>`
}

function statusHtml(snap) {
  const population = state.release
    ? snap.issues.filter((issue) => issue.seenIn.includes(state.release))
    : snap.issues
  const counts = tally(population, 'bucket')
  const rows = STATUS.map(([id, label]) => ({
    id,
    label,
    reports: counts.get(id) || 0,
    events: eventsOf(population, 'bucket', id),
  })).filter((row) => row.reports || ['waiting', 'needs_evidence', 'in_progress', 'fixed', 'not_actionable'].includes(row.id))
  const waiting = counts.get('waiting') || 0
  const analysed = population.length - waiting
  const fresh = population.reduce((sum, issue) => sum + (issue.fresh || 0), 0)
  const working = population.filter((issue) => issue.bucket === 'in_progress')
  const stages = ['implementing', 'reviewing', 'ci']
    .map((stage) => [stage, working.filter((issue) => issue.stage === stage).length])
    .filter(([, count]) => count)
  const unplaced = !state.release && snap.meta.closedUnplaced
    ? ` ${nf.format(snap.meta.closedUnplaced)} finished outside the release dates shown here${snap.meta.oldestRelease ? `, before or apart from ${snap.meta.oldestRelease}` : ''}.`
    : ''
  return `<div class="panel">
    <p class="kicker">Where the work stands</p>
    <div class="section-head">
      <h2>${nf.format(analysed)} of ${nf.format(population.length)} have a verdict</h2>
    </div>
    <p class="caption" style="margin-top:0">${nf.format(waiting)} still waiting for analysis.${fresh ? ` ${nf.format(fresh)} events arrived after a report was last reviewed.` : ''}${stages.length ? ` In progress: ${stages.map(([stage, count]) => `${count} ${stage}`).join(', ')}.` : ''}${unplaced}${snap.meta.ledgerRead ? '' : ' The crash ledger was not found, so reports with no verdict are shown as waiting.'}</p>
    ${bar(rows.map((row) => ({ ...row, value: row.reports })))}
    ${legend(rows, 'bucket', state.bucket)}
  </div>`
}

function clusterBlock(areas, { closed = false } = {}) {
  if (!areas.length) return closed ? '<p class="empty">No closed clusters in this view.</p>' : '<p class="empty">No open clusters in this view.</p>'
  return areas.map((area) => {
    const limit = state.expand.has(area.id) ? area.clusters.length : 5
    const rows = area.clusters.slice(0, limit).map((cluster) => {
      const meta = [
        cluster.kind === 'work' ? 'Same cause' : 'Same message',
        cluster.also.length ? `also ${cluster.also.join(', ')}` : '',
        cluster.open && cluster.openReports !== cluster.reports ? `${cluster.openReports} of ${cluster.reports} still open` : '',
      ].filter(Boolean).join(' · ')
      return `<button type="button" class="cluster" data-act="open-cluster" data-area="${esc(cluster.area)}" data-id="${esc(cluster.id)}">
        <span><span class="cluster-label">${esc(cluster.label)}</span><span class="cluster-meta">${esc(meta)}</span></span>
        <span class="cluster-stat"><b>${nf.format(cluster.events)}</b><small>events</small></span>
        <span class="cluster-stat"><b>${nf.format(cluster.reports)}</b><small>reports</small></span>
        <span class="pill ${cluster.open ? 'pill-open' : 'pill-closed'}">${cluster.open ? 'Open' : 'Closed'}</span>
      </button>`
    }).join('')
    const more = area.clusters.length > limit
      ? `<button type="button" class="more" data-act="expand" data-area="${esc(area.id)}">Show ${area.clusters.length - limit} more in ${esc(area.label)}</button>`
      : ''
    return `<section class="area">
      <header><h3>${esc(area.label)}</h3><p>${nf.format(area.clusters.length)} · ${nf.format(area.events)} events</p></header>
      ${rows}${more}
    </section>`
  }).join('')
}

function clustersHtml(snap) {
  const base = baseIssues(snap)
  const filtered = state.bucket || state.substatus || state.level || state.query.trim()
  const openAll = buildClusters(base.filter(isOpen))
  const shown = buildClusters(faceted(base))
  const openShown = shown.filter((cluster) => cluster.open)
  const closedShown = shown.filter((cluster) => !cluster.open)
  const chips = buildAreas(openShown).map((area) => `
    <button type="button" data-act="zoom-area" data-area="${esc(area.id)}">
      <i class="swatch" style="background:${areaColor(area.id)}"></i>${esc(area.label)} <b>${area.clusters.length}</b>
    </button>`).join('')
  const tools = `<div class="tools">
      <input id="q" type="search" placeholder="Filter reports" value="${esc(state.query)}" aria-label="Filter reports" />
      ${filtered ? '<button type="button" class="tool" data-act="clear">Clear</button>' : ''}
      ${state.release ? '' : `<button type="button" class="tool${state.showClosed ? ' is-on' : ''}" data-act="toggle-closed">${state.showClosed ? 'Hide closed' : `Show closed (${buildClusters(base).filter((cluster) => !cluster.open).length})`}</button>`}
    </div>`
  const matchLine = filtered ? `<p class="caption">${nf.format(openShown.length)} open match this filter, of ${nf.format(openAll.length)}.</p>` : ''
  const closedBlock = state.release || state.showClosed
    ? `<h2 style="margin-top:28px">${state.release ? 'Closed' : 'Closed clusters'}</h2>${clusterBlock(buildAreas(closedShown), { closed: true })}`
    : ''
  return `<div class="panel">
    <div class="section-head">
      <div>
        <p class="kicker">Open clusters</p>
        <h2>${nf.format(openAll.length)} open</h2>
      </div>
      ${tools}
    </div>
    ${matchLine}
    <div class="area-chips">${chips}</div>
    ${clusterBlock(buildAreas(openShown))}
    ${closedBlock}
  </div>`
}

function releasesHtml(snap) {
  const rows = snap.releases.filter((release) => release.events > 0)
  if (!rows.length) return ''
  const max = Math.max(...rows.map((release) => release.events), 1)
  return `<div class="panel"><div class="chart-block">
      <h2>Events by release</h2>
      <p class="caption" style="margin-top:0">Last 90 days, from reports that are still unresolved. An event is counted in the release that produced it.</p>
      ${rows.map((release) => `<button type="button" class="rel-row${state.release === release.version ? ' is-on' : ''}" data-act="release" data-release="${esc(release.version)}">
        <span class="rel-name">${esc(release.version)}</span>
        <span class="rel-track"><span class="rel-fill" data-w="${(release.events / max) * 100}%"></span></span>
        <span class="rel-value">${nf.format(release.events)}</span>
      </button>`).join('')}
    </div></div>`
}

function chartsHtml(snap) {
  const rhythm = snap.rhythm || []
  const rhythmMax = Math.max(...rhythm.map((point) => point.events), 1)
  let rhythmSvg = ''
  if (rhythm.length > 1) {
    const width = 640
    const height = 180
    const pad = 16
    const coords = rhythm.map((point, index) => {
      const x = pad + (index * (width - pad * 2)) / (rhythm.length - 1)
      const y = height - pad - (point.events / rhythmMax) * (height - pad * 2)
      return [x, y]
    })
    const line = coords.map((pair) => pair.join(',')).join(' ')
    const area = `${pad},${height - pad} ${line} ${coords.at(-1)[0]},${height - pad}`
    const first = new Date(rhythm[0].t * 1000)
    const last = new Date(rhythm.at(-1).t * 1000)
    const hour = (date) => `${String(date.getUTCHours()).padStart(2, '0')}:00`
    rhythmSvg = `<div class="chart-block">
      <h2>Events per hour</h2>
      <p class="caption" style="margin-top:0">Last 24 hours, summed across open reports. ${hour(first)}–${hour(last)} UTC.</p>
      <svg class="rhythm" viewBox="0 0 ${width} ${height}" role="img" aria-label="Events per hour, last 24 hours">
        <polygon class="rhythm-area" points="${area}"></polygon>
        <polyline class="rhythm-line" points="${line}"></polyline>
      </svg>
    </div>`
  }
  const weeks = (snap.weeks || []).filter((week) => snap.weeks.some((item) => item.reports))
  const weekMax = Math.max(...weeks.map((week) => week.reports), 1)
  const weekChart = weeks.some((week) => week.reports) ? `<div class="chart-block">
      <h2>Last seen by week</h2>
      <p class="caption" style="margin-top:0">Open reports, by the week of their latest event. This is recency, not a close-out.</p>
      <div class="weeks">${weeks.map((week) => `<div class="week" title="${nf.format(week.reports)} reports, ${nf.format(week.events)} events">
        <span class="week-fill" data-h="${week.reports ? Math.max(8, (week.reports / weekMax) * 100) : 0}%"></span>
        <span class="week-label">${esc(day(week.week, false))}</span>
      </div>`).join('')}</div>
    </div>` : ''
  if (!rhythmSvg && !weekChart) return ''
  return `<div class="panel"><div class="chart-grid">${rhythmSvg}${weekChart}</div></div>`
}

function mapModel(snap) {
  const base = faceted(baseIssues(snap))
  let clusters = buildClusters(base)
  if (!state.release && !state.showClosed) clusters = clusters.filter((cluster) => cluster.open)
  const areas = buildAreas(clusters)
  const area = areas.some((item) => item.id === state.area) ? state.area : null
  const cluster = clusters.some((item) => item.id === state.cluster) ? clusters.find((item) => item.id === state.cluster) : null
  if (!area) {
    return {
      area: null,
      cluster: null,
      items: areas.map((item) => ({
        id: item.id,
        label: item.label,
        value: state.size === 'reports' ? item.reports : Math.max(item.events, 1),
        stat: `${nf.format(item.clusters.length)} clusters`,
        color: areaColor(item.id),
        open: item.clusters.some((entry) => entry.open),
        act: 'zoom-area',
        area: item.id,
      })),
    }
  }
  if (!cluster || cluster.area !== area) {
    const local = clusters.filter((item) => item.area === area)
    return {
      area,
      areaLabel: areas.find((item) => item.id === area)?.label || '',
      cluster: null,
      items: local.map((item) => ({
        id: item.id,
        label: clusterTitle(item),
        value: state.size === 'reports' ? item.reports : Math.max(item.events, 1),
        stat: `${nf.format(item.reports)} reports`,
        color: areaColor(area),
        open: item.open,
        act: 'open-cluster',
        area,
        cluster: item.id,
      })),
    }
  }
  return {
    area,
    areaLabel: cluster.areaLabel,
    cluster,
    items: cluster.issues.map((issue) => ({
      id: issue.key,
      label: issue.key,
      value: Math.max(issue.events, 1),
      stat: issue.bucket.replaceAll('_', ' '),
      color: areaColor(area),
      open: isOpen(issue),
      act: 'zoom-issue',
      area,
      cluster: cluster.id,
      issue: issue.key,
    })),
  }
}

function renderMap(snap) {
  const host = document.getElementById('map')
  const model = mapModel(snap)
  const crumbs = ['<button type="button" class="crumb" data-act="crumb" data-level="all">All areas</button>']
  if (model.area) crumbs.push(`<span>/</span><button type="button" class="crumb" data-act="crumb" data-level="area" data-area="${esc(model.area)}">${esc(model.areaLabel)}</button>`)
  if (model.cluster) crumbs.push(`<span>/</span><span>${esc(model.cluster.label)}</span>`)
  host.innerHTML = `<div class="panel">
      <div class="section-head">
        <div><p class="kicker">Map</p><h2>Zoom into an area</h2></div>
        <div class="tools">
          <button type="button" class="tool${state.size === 'events' ? ' is-on' : ''}" data-act="size" data-size="events">Events</button>
          <button type="button" class="tool${state.size === 'reports' ? ' is-on' : ''}" data-act="size" data-size="reports">Reports</button>
        </div>
      </div>
      <p class="crumbs">${crumbs.join(' ')}</p>
      <div class="map-frame" id="map-frame"></div>
      <p class="map-legend"><span class="pill pill-open">Open</span><span class="pill pill-closed">Closed</span> Click a block to zoom. Esc steps out.</p>
    </div>`
  const frame = document.getElementById('map-frame')
  const width = Math.max(frame.clientWidth, 280)
  const height = width < 700 ? 420 : 540
  frame.style.height = `${height}px`
  if (!model.items.length) {
    const note = document.createElement('p')
    note.className = 'empty'
    note.textContent = 'Nothing in this view.'
    frame.append(note)
    return
  }
  const gap = 5
  const tip = document.createElement('div')
  tip.className = 'map-tip'
  tip.hidden = true
  frame.append(tip)
  const hideTip = () => { tip.hidden = true }
  frame.addEventListener('pointerleave', hideTip)
  frame.addEventListener('pointermove', (event) => {
    const cell = event.target.closest('.map-cell')
    if (!cell || !cell.dataset.full) {
      hideTip()
      return
    }
    tip.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = cell.dataset.full
    tip.append(title)
    if (cell.dataset.stat) {
      const stat = document.createElement('span')
      stat.textContent = cell.dataset.stat
      tip.append(stat)
    }
    tip.hidden = false
    const pad = 12
    const box = tip.getBoundingClientRect()
    let x = event.clientX + 14
    let y = event.clientY + 16
    if (x + box.width > window.innerWidth - pad) x = event.clientX - box.width - 14
    if (y + box.height > window.innerHeight - pad) y = event.clientY - box.height - 12
    tip.style.left = `${Math.max(pad, x)}px`
    tip.style.top = `${Math.max(pad, y)}px`
  })
  for (const rect of layout(model.items, width, height)) {
    const button = document.createElement('button')
    const boxW = Math.max(rect.w - gap, 0)
    const boxH = Math.max(rect.h - gap, 0)
    const fitted = fitTile(rect.label, boxW, boxH)
    const caption = captionFor(rect.label)
    button.type = 'button'
    button.className = `map-cell${rect.open ? '' : ' is-closed'}${fitted.text ? '' : ' is-quiet'}`
    button.style.left = `${rect.x + gap / 2}px`
    button.style.top = `${rect.y + gap / 2}px`
    button.style.width = `${boxW}px`
    button.style.height = `${boxH}px`
    button.style.background = rect.color
    button.dataset.act = rect.act
    button.dataset.area = rect.area || ''
    button.dataset.id = rect.cluster || rect.id || ''
    button.dataset.full = [caption.kicker, caption.text].filter(Boolean).join(' — ') || rect.label
    button.dataset.stat = rect.stat
    if (rect.issue) button.dataset.issue = rect.issue
    if (fitted.kicker) {
      const kicker = document.createElement('span')
      kicker.className = 'map-kicker'
      kicker.textContent = fitted.kicker
      button.append(kicker)
    }
    if (fitted.text) {
      const name = document.createElement('span')
      name.className = 'map-name'
      name.style.webkitLineClamp = String(fitted.lines)
      name.style.fontSize = `${fitted.font}px`
      name.textContent = fitted.text
      button.append(name)
    }
    if (fitted.stat) {
      const stat = document.createElement('span')
      stat.className = 'map-stat'
      stat.textContent = rect.stat
      button.append(stat)
    }
    frame.append(button)
  }
}

function clusterTitle(cluster) {
  const heaviest = cluster.issues.reduce((best, issue) => (issue.events > best.events ? issue : best), cluster.issues[0])
  return heaviest?.title || cluster.label
}

function fitTile(label, width, height) {
  const caption = captionFor(label)
  const innerW = width - 20
  const innerH = height - 16
  if (innerW < 56 || innerH < 22) return { kicker: '', text: '', stat: false, lines: 0, font: 13 }
  const lines = innerH >= 120 ? 3 : innerH >= 64 ? 2 : 1
  const showKicker = Boolean(caption.kicker) && lines >= 2 && innerW >= 100 && innerH >= 64
  const textLines = showKicker ? Math.max(1, lines - 1) : lines
  const font = innerW >= 280 && innerH >= 160 ? 32 : innerW >= 160 && innerH >= 90 ? 18 : 13
  const chars = Math.max(10, Math.floor(innerW / (font * 0.55)) * textLines)
  return {
    kicker: showKicker ? clipWords(caption.kicker, Math.floor(innerW / (font * 0.62))) : '',
    text: clipWords(caption.text, chars),
    stat: innerH >= (showKicker ? 78 : 46) && innerW >= 70,
    lines: textLines,
    font,
  }
}

function clipWords(value, max) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function drawerHtml(snap) {
  const cluster = buildClusters(baseIssues(snap)).find((item) => item.id === state.cluster)
  if (!cluster) return ''
  const issues = [...cluster.issues].sort((a, b) => b.events - a.events)
  const rows = issues.map((issue) => {
    const links = []
    if (issue.permalink) links.push(`<a href="${esc(issue.permalink)}" target="_blank" rel="noreferrer">Sentry</a>`)
    if (issue.pr) links.push(`<a href="https://github.com/0xMiden/wallet/pull/${issue.pr}" target="_blank" rel="noreferrer">Pull request ${issue.pr}</a>`)
    if (issue.githubIssue) links.push(`<a href="https://github.com/0xMiden/wallet/issues/${issue.githubIssue}" target="_blank" rel="noreferrer">Issue ${issue.githubIssue}</a>`)
    return `<article class="issue${state.issue === issue.key ? ' is-on' : ''}" id="issue-${esc(issue.key)}">
      <span class="issue-key">${esc(issue.key)}</span>
      <span class="pill ${isOpen(issue) ? 'pill-open' : 'pill-closed'}">${esc(issue.bucket.replaceAll('_', ' '))}</span>
      <p>${esc(issue.title)}</p>
      <p class="cluster-meta">${nf.format(issue.events)} events · last ${esc(day(issue.lastSeen) || 'unknown')}${issue.substatus ? ` · ${esc(issue.substatus)}` : ''}${issue.level ? ` · ${esc(issue.level)}` : ''}</p>
      ${issue.needs ? `<p>${esc(issue.needs)}</p>` : ''}
      ${issue.culprit ? `<p class="cluster-meta">${esc(issue.culprit)}</p>` : ''}
      ${links.length ? `<p class="issue-links">${links.join('')}</p>` : ''}
    </article>`
  }).join('')
  return `<button type="button" class="close-drawer" data-act="close">Close</button>
    <p class="drawer-kicker">${esc(cluster.areaLabel)}${cluster.kind === 'work' ? ' · same cause' : ''}</p>
    <h2>${esc(cluster.label)}</h2>
    <p class="caption">${nf.format(cluster.events)} events · ${nf.format(cluster.reports)} reports · ${cluster.open ? 'open' : 'closed'}${cluster.group ? ` · ${esc(cluster.group)}` : ''}</p>
    ${rows}`
}

function renderDrawer(snap) {
  const drawer = document.getElementById('drawer')
  const scrim = document.getElementById('scrim')
  const open = Boolean(state.cluster)
  drawer.hidden = !open
  scrim.hidden = !open
  if (!open) {
    drawer.innerHTML = ''
    return
  }
  drawer.innerHTML = drawerHtml(snap)
  if (state.issue) document.getElementById(`issue-${state.issue}`)?.scrollIntoView({ block: 'nearest' })
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
}

function exportMarkdown(snap) {
  const issues = snap.issues
  const sentry = issues.filter((issue) => issue.inSentry)
  const events = sentry.reduce((sum, issue) => sum + issue.events, 0)
  const buckets = tally(issues, 'bucket')
  const lines = [
    '# Bread Signal Explorer',
    '',
    `Generated ${snap.generatedAt}. Period ${snap.period}. Project ${snap.project}.`,
    '',
    'Sentry folds events into one report. Reports that share a proven cause are one cluster. A cluster is open while any report is still waiting, missing evidence, ready, in progress, or regressed. Closed means the crash ledger finished with it. Sentry may still list that report as unresolved.',
    '',
    '## Queue',
    '',
    `- Open reports: ${sentry.length}`,
    `- Events: ${events}`,
    `- Ledger-only reports: ${snap.counts.ledgerOnly}`,
  ]
  if (snap.meta.orchestrator?.model) {
    lines.push(`- Last logged in orchestrator: ${snap.meta.orchestrator.model} (last active: ${snap.meta.orchestrator.active || 'unknown'})`)
  }
  lines.push('', '## Where the work stands', '')
  for (const [id, label] of STATUS) {
    if (!buckets.get(id)) continue
    lines.push(`- ${label}: ${buckets.get(id)}`)
  }
  lines.push('', '## Releases', '', '| Release | Events | Seen | Still open | Closed | Introduced |', '| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const release of snap.releases) {
    const stats = releaseStats(snap, release)
    lines.push(`| ${mdCell(release.version)} | ${release.events || 0} | ${stats.seen || 0} | ${stats.split ? stats.open : ''} | ${stats.split ? stats.closed : ''} | ${release.newGroups || 0} |`)
  }
  const clusters = buildClusters(issues)
  lines.push('', '## Clusters', '')
  for (const area of buildAreas(clusters)) {
    lines.push(`### ${area.label}`, '')
    lines.push('| Cluster | Events | Reports | Open | Kind |', '| --- | ---: | ---: | --- | --- |')
    for (const cluster of area.clusters) {
      const caption = captionFor(cluster.label)
      const name = [caption.kicker, caption.text].filter(Boolean).join(' — ') || cluster.label
      lines.push(`| ${mdCell(name)} | ${cluster.events} | ${cluster.reports} | ${cluster.open ? 'yes' : 'no'} | ${cluster.kind === 'work' ? 'same cause' : 'same message'} |`)
    }
    lines.push('')
  }
  lines.push('## Reports', '', '| Key | Area | What | Events | Status | Seen in | Closed during |', '| --- | --- | --- | ---: | --- | --- | --- |')
  for (const issue of issues) {
    const caption = captionFor(issue.title)
    const what = [caption.kicker, caption.text].filter(Boolean).join(' — ')
    lines.push(`| ${mdCell(issue.key)} | ${mdCell(issue.areaLabel)} | ${mdCell(what)} | ${issue.events} | ${mdCell(issue.bucket)} | ${mdCell(issue.seenIn.join(', '))} | ${mdCell(issue.closedDuring || '')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function downloadMarkdown(snap) {
  const text = exportMarkdown(snap)
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const day = String(snap.generatedAt || '').slice(0, 10) || 'export'
  link.href = url
  link.download = `bread-signal-${day}.md`
  link.click()
  URL.revokeObjectURL(url)
}

function renderScope(snap) {
  const button = document.getElementById('refresh')
  button.disabled = state.refreshing
  button.textContent = state.refreshing ? 'Refreshing' : 'Refresh'
  const scope = document.getElementById('scope')
  const exportButton = document.getElementById('export')
  if (exportButton) exportButton.hidden = !snap
  if (!snap) {
    scope.textContent = 'Reading the queue'
    return
  }
  const when = snap.meta.ledgerUpdated ? `ledger ${ago(snap.meta.ledgerUpdated)}` : 'ledger unavailable'
  const orchestrator = snap.meta.orchestrator
  const active = orchestrator?.active ? clock(orchestrator.active) : 'no heartbeat yet'
  const who = orchestrator?.model || 'none logged in'
  scope.textContent = `bread-wallet · last 90 days · ${when} · last logged in orchestrator: ${who} (last active: ${active})`
  const open = state.release
    ? releaseStats(snap, snap.releases.find((release) => release.version === state.release) || { version: state.release, joined: false, seenReports: 0 }).open
    : snap.counts.sentry
  document.title = `Bread Signal Explorer · ${state.release || nf.format(open)}`
}

function renderDynamic() {
  if (!state.snap) return
  fill('clusters', clustersHtml(state.snap))
  renderMap(state.snap)
  renderDrawer(state.snap)
}

function renderAll() {
  const snap = state.snap
  renderScope(snap)
  fill('banner', state.error && snap ? `<p class="banner">${esc(state.error)}</p>` : '')
  if (!snap) {
    fill('hero', `<p class="loading">${esc(state.error || 'Reading the queue…')}</p>`)
    return
  }
  fill('switcher', switcherHtml(snap))
  const heroKey = `${state.release}|${snap.generatedAt}|${snap.counts.sentry}`
  if (heroKey !== state.heroKey) {
    state.heroKey = heroKey
    fill('hero', heroHtml(snap))
    document.querySelectorAll('[data-n]').forEach((node) => animate(node, Number(node.dataset.n)))
  }
  const statusKey = `${state.release}|${snap.generatedAt}|${snap.issues.length}`
  if (statusKey !== state.statusKey) {
    state.statusKey = statusKey
    fill('status', statusHtml(snap))
  }
  const chartsKey = `${state.release}|${snap.generatedAt}|${snap.releases.length}`
  if (chartsKey !== state.chartsKey) {
    state.chartsKey = chartsKey
    fill('releases', releasesHtml(snap))
    fill('charts', chartsHtml(snap))
    const line = document.querySelector('.rhythm-line')
    if (line && !reduce && line.getTotalLength) {
      const length = line.getTotalLength()
      line.style.strokeDasharray = String(length)
      line.style.strokeDashoffset = String(length)
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 1.1s ease'
        line.style.strokeDashoffset = '0'
      })
    }
  }
  renderDynamic()
  armBars()
}

function selectRelease(version) {
  state.release = version === 'now' ? null : version
  state.area = null
  state.cluster = null
  state.issue = null
  renderAll()
}

document.body.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]')
  if (!el) return
  const act = el.dataset.act
  if (act === 'release') selectRelease(el.dataset.release)
  else if (act === 'bucket') {
    state.bucket = state.bucket === el.dataset.bucket ? null : el.dataset.bucket
    renderDynamic()
    document.querySelectorAll('[data-act="bucket"]').forEach((button) => {
      const on = button.dataset.bucket === state.bucket
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
    })
  } else if (act === 'substatus') {
    state.substatus = state.substatus === el.dataset.substatus ? null : el.dataset.substatus
    renderDynamic()
    document.querySelectorAll('[data-act="substatus"]').forEach((button) => {
      const on = button.dataset.substatus === state.substatus
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
    })
  } else if (act === 'level') {
    state.level = state.level === el.dataset.level ? null : el.dataset.level
    renderDynamic()
    document.querySelectorAll('[data-act="level"]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.level === state.level)
    })
  } else if (act === 'clear') {
    state.bucket = null
    state.substatus = null
    state.level = null
    state.query = ''
    state.heroKey = ''
    state.statusKey = ''
    renderAll()
  } else if (act === 'toggle-closed') {
    state.showClosed = !state.showClosed
    renderDynamic()
  } else if (act === 'expand') {
    state.expand.add(el.dataset.area)
    renderDynamic()
  } else if (act === 'zoom-area') {
    state.area = el.dataset.area
    state.cluster = null
    state.issue = null
    renderMap(state.snap)
    renderDrawer(state.snap)
    document.getElementById('map')?.scrollIntoView({ block: 'start' })
  } else if (act === 'open-cluster') {
    state.area = el.dataset.area
    state.cluster = el.dataset.id
    state.issue = el.dataset.issue || null
    renderMap(state.snap)
    renderDrawer(state.snap)
  } else if (act === 'zoom-issue') {
    state.issue = el.dataset.issue
    renderDrawer(state.snap)
  } else if (act === 'crumb') {
    if (el.dataset.level === 'all') {
      state.area = null
      state.cluster = null
    } else {
      state.cluster = null
    }
    state.issue = null
    renderMap(state.snap)
    renderDrawer(state.snap)
  } else if (act === 'close') {
    state.cluster = null
    state.issue = null
    renderDrawer(state.snap)
  } else if (act === 'size') {
    state.size = el.dataset.size
    renderMap(state.snap)
  }
})

document.body.addEventListener('input', (event) => {
  if (event.target.id !== 'q') return
  state.query = event.target.value
  renderDynamic()
})

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement?.id !== 'q' && document.activeElement?.tagName !== 'INPUT') {
    event.preventDefault()
    document.getElementById('q')?.focus()
  }
  if (event.key !== 'Escape') return
  if (state.issue) state.issue = null
  else if (state.cluster) state.cluster = null
  else if (state.area) state.area = null
  else return
  renderMap(state.snap)
  renderDrawer(state.snap)
})

document.getElementById('scrim').addEventListener('click', () => {
  state.cluster = null
  state.issue = null
  renderDrawer(state.snap)
})

document.getElementById('export').addEventListener('click', () => {
  if (state.snap) downloadMarkdown(state.snap)
})

document.getElementById('refresh').addEventListener('click', async () => {
  state.refreshing = true
  state.error = ''
  renderScope(state.snap)
  try {
    const response = await fetch(api(API ? '/api/snapshot' : '/api/refresh'), { method: API ? 'GET' : 'POST' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Refresh failed')
    state.snap = body
    state.heroKey = ''
    state.statusKey = ''
    state.chartsKey = ''
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Refresh failed'
  } finally {
    state.refreshing = false
    renderAll()
  }
})

async function load() {
  try {
    const response = await fetch(api('/api/snapshot'))
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not read the queue')
    state.snap = body
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Could not read the queue'
  }
  renderAll()
}

load()
