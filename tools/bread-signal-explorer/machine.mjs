import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.HOME || ''

function field(text, name) {
  const match = String(text || '').match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim().replace(/^"|"$/g, '') : ''
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const read = fs.readSync(fd, buf, 0, length, start)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function modelFrom(dbPath) {
  const text = fs.readFileSync(dbPath)
  const key = Buffer.from('"lastUsedModel":"').toString('hex')
  const at = text.indexOf(key)
  if (at < 0) return null
  const rest = text.subarray(at + key.length).toString('utf8')
  const end = rest.indexOf('22')
  if (end < 0 || end > 160 || end % 2) return null
  const model = Buffer.from(rest.slice(0, end), 'hex').toString('utf8')
  return /^[A-Za-z0-9._-]{1,80}$/.test(model) ? model : null
}

export function lastOrchestrator() {
  const chats = path.join(HOME, '.cursor', 'chats')
  let model = null
  let updated = 0
  if (fs.existsSync(chats)) {
    for (const bucket of fs.readdirSync(chats)) {
      const bucketDir = path.join(chats, bucket)
      let ids = []
      try {
        ids = fs.readdirSync(bucketDir)
      } catch {
        continue
      }
      for (const id of ids) {
        const dir = path.join(bucketDir, id)
        const metaPath = path.join(dir, 'meta.json')
        const dbPath = path.join(dir, 'store.db')
        if (!fs.existsSync(metaPath) || !fs.existsSync(dbPath)) continue
        let stamp = 0
        try {
          stamp = Number(JSON.parse(fs.readFileSync(metaPath, 'utf8')).updatedAtMs) || 0
        } catch {
          continue
        }
        if (stamp < updated) continue
        const next = modelFrom(dbPath)
        if (!next) continue
        updated = stamp
        model = next
      }
    }
  }
  const projects = path.join(HOME, '.cursor', 'projects')
  let ended = null
  let started = null
  if (fs.existsSync(projects)) {
    for (const project of fs.readdirSync(projects)) {
      const terminals = path.join(projects, project, 'terminals')
      if (!fs.existsSync(terminals)) continue
      for (const name of fs.readdirSync(terminals)) {
        if (!name.endsWith('.txt')) continue
        const file = path.join(terminals, name)
        let head = ''
        try {
          head = readSlice(file, 0, 600)
        } catch {
          continue
        }
        if (!/heartbeat/i.test(head)) continue
        let tail = head
        try {
          const size = fs.statSync(file).size
          if (size > 600) tail = readSlice(file, Math.max(0, size - 400), 400)
        } catch {
          tail = head
        }
        const end = field(tail, 'ended_at')
        const start = field(head, 'started_at')
        if (end && (!ended || end > ended)) ended = end
        if (start && (!started || start > started)) started = start
      }
    }
  }
  return { model, active: ended || started }
}
