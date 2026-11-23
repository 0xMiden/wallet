// Push the local crash ledger and the last heartbeat to the Signal Worker.
// The Sentry token stays in the Worker. This process never reads it.

import fs from 'node:fs'
import path from 'node:path'
import { lastOrchestrator } from './machine.mjs'

const HOME = process.env.HOME || ''
const STATE = path.join(HOME, '.local', 'state', 'walletsentry')
const LEDGER = process.env.WALLETSENTRY_LEDGER || path.join(STATE, 'ledger.json')
const CACHE = path.join(STATE, 'explorer')

function redact(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '…')
    .replace(/0x[0-9a-f]{6,}/gi, '…')
    .replace(/\b[0-9a-f]{24,}\b/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function slim(entry) {
  const history = Array.isArray(entry.history) ? entry.history : []
  return {
    id: entry.id,
    title: String(entry.title || '').slice(0, 160),
    count: entry.count,
    users: entry.users,
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    level: entry.level,
    unhandled: entry.unhandled,
    in_queue: entry.in_queue,
    status: entry.status,
    stage: entry.stage || '',
    outcome: entry.outcome || '',
    needs: redact(entry.needs),
    pr: entry.pr,
    github_issue: entry.github_issue,
    branch: typeof entry.branch === 'string' ? entry.branch.slice(0, 120) : '',
    fix_group: entry.fix_group,
    duplicate_of: entry.duplicate_of,
    fixed_at: entry.fixed_at,
    release: entry.release,
    reviewed_count: entry.reviewed_count,
    regressed: Boolean(entry.regressed),
    history: history.slice(-8).map((item) => ({ at: item.at, status: item.status })),
  }
}

function endpoint() {
  const fromEnv = process.env.SIGNAL_API || ''
  const file = path.join(CACHE, 'worker-url')
  const fromFile = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  const base = (fromEnv || fromFile).replace(/\/$/, '')
  if (!base.startsWith('https://')) throw new Error('SIGNAL_API must be the https worker URL')
  return base
}

function token() {
  const file = path.join(CACHE, 'sync-token')
  const value = fs.readFileSync(file, 'utf8').trim()
  if (!/^[A-Za-z0-9]{32,}$/.test(value)) throw new Error('sync token file is unusable')
  return value
}

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
const issues = {}
for (const [key, entry] of Object.entries(raw.issues || {})) issues[key] = slim(entry)
let seen = {}
const metaPath = path.join(CACHE, 'meta.json')
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  if (meta.seen && typeof meta.seen === 'object') seen = meta.seen
}
const response = await fetch(`${endpoint()}/api/sync`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ledger: { updated: raw.updated || null, issues },
    orchestrator: lastOrchestrator(),
    seen,
  }),
})
if (!response.ok) throw new Error(`sync failed: ${response.status}`)
const body = await response.json()
process.stdout.write(`${JSON.stringify({ ok: body.ok === true, issues: Object.keys(issues).length })}\n`)
