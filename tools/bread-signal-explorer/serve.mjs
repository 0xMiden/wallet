// Bread Signal Explorer. Local only.
// node tools/bread-signal-explorer/serve.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastOrchestrator } from './machine.mjs'
import { buildSnapshot } from './snapshot.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATIC = path.join(ROOT, 'static')
const HOME = process.env.HOME || ''
const LEDGER = process.env.WALLETSENTRY_LEDGER || path.join(HOME, '.local', 'state', 'walletsentry', 'ledger.json')
const STATE = path.dirname(LEDGER)
const DISCOVER = path.join(STATE, 'discover')
const CACHE = path.join(STATE, 'explorer')
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT) || 4737

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

let refreshing = null

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function newest(dir, prefix) {
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort()
  return names.length ? path.join(dir, names.at(-1)) : null
}

function loadIssues() {
  const cached = path.join(CACHE, 'unresolved.json')
  const candidates = [cached, newest(DISCOVER, 'issues-')].filter((file) => file && fs.existsSync(file))
  if (!candidates.length) return { issues: [], at: null }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const file = candidates[0]
  const stat = fs.statSync(file)
  const payload = readJson(file)
  return { issues: Array.isArray(payload) ? payload : [], at: stat.mtime.toISOString() }
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { issues: null }
  return readJson(LEDGER)
}

function loadMeta() {
  const file = path.join(CACHE, 'meta.json')
  if (!fs.existsSync(file)) return { releases: [], seen: {}, resolvedHits: null, ignoredHits: null, fetchedAt: null }
  const payload = readJson(file)
  return {
    releases: Array.isArray(payload.releases) ? payload.releases : [],
    seen: payload.seen && typeof payload.seen === 'object' ? payload.seen : {},
    resolvedHits: payload.resolvedHits ?? null,
    ignoredHits: payload.ignoredHits ?? null,
    fetchedAt: fs.statSync(file).mtime.toISOString(),
  }
}

function snapshot() {
  const issues = loadIssues()
  const meta = loadMeta()
  return buildSnapshot({
    issues: issues.issues,
    ledger: loadLedger(),
    releases: meta.releases,
    seen: meta.seen,
    listAt: issues.at,
    fetchedAt: meta.fetchedAt,
    resolvedHits: meta.resolvedHits,
    ignoredHits: meta.ignoredHits,
    orchestrator: lastOrchestrator(),
  })
}

function refresh() {
  if (refreshing) return refreshing
  refreshing = new Promise((resolve, reject) => {
    const child = spawn('python3', ['-B', path.join(ROOT, 'fetch.py'), '--cache', CACHE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Refresh took too long'))
    }, 240000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      refreshing = null
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      refreshing = null
      if (code !== 0) {
        const safe = /^[\w .:'-]{0,180}$/.test(err.trim()) ? err.trim() : 'Sentry refresh failed'
        reject(new Error(safe || 'Sentry refresh failed'))
        return
      }
      resolve(out.trim())
    })
  })
  return refreshing
}

function staticFile(urlPath) {
  const requested = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '')
  if (requested.includes('\0')) return null
  const file = path.normalize(path.join(STATIC, requested))
  if (file !== STATIC && !file.startsWith(`${STATIC}${path.sep}`)) return null
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
  return file
}

function send(response, status, body, type) {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${HOST}`)
  try {
    if (request.method === 'GET' && url.pathname === '/api/snapshot') {
      send(response, 200, JSON.stringify(snapshot()), 'application/json; charset=utf-8')
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/refresh') {
      await refresh()
      send(response, 200, JSON.stringify(snapshot()), 'application/json; charset=utf-8')
      return
    }
    if (request.method === 'GET') {
      const file = staticFile(url.pathname)
      if (!file) {
        send(response, 404, 'Not found', 'text/plain; charset=utf-8')
        return
      }
      send(response, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
      return
    }
    send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed'
    send(response, 500, JSON.stringify({ error: message.slice(0, 180) }), 'application/json; charset=utf-8')
  }
})

server.on('error', (error) => {
  process.stderr.write(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.\n` : `${error.message}\n`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`Bread Signal Explorer at http://${HOST}:${PORT}\n`)
})
