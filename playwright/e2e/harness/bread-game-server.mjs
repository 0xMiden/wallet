import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

export async function loadGameFixture(gameRoot) {
  const bytes = await readFile(join(gameRoot, 'viewer/public/generated/match.json'));
  const document = JSON.parse(bytes);
  const me = JSON.parse(await readFile(join(gameRoot, 'fixtures/management-current/me-complete.json'), 'utf8'));
  const { recordingArchiveFixture } = await import(
    pathToFileURL(join(gameRoot, 'viewer/tests/recording-archive-fixture.mjs')).href
  );
  const archive = await recordingArchiveFixture(bytes, join(gameRoot, 'viewer/public/generated/match-recording'));
  const id = 'fixture_match';
  const identity = team => ({ id: team.id, name: team.name, kit_colors: team.kit, badge: team.badge });
  const head = { user_id: me.user_id, server_time_ms: me.server_time_ms, head: '0', read_head: '0', unread: 0 };
  return new Map([
    ['/api/me', { json: me }],
    [
      `/api/public/matches/${id}/summary`,
      {
        json: {
          match_id: id,
          server_time_ms: me.server_time_ms,
          created_at_ms: me.server_time_ms,
          home: identity(document.teams[0]),
          away: identity(document.teams[1]),
          result: document.result,
          replay_available: true,
          replay_expires_at_ms: null
        }
      }
    ],
    [`/api/public/matches/${id}`, { json: { match_id: id, document } }],
    [
      `/api/public/matches/${id}/recording`,
      {
        bytes: Buffer.concat([archive.header, ...archive.members.map(member => member.compressed)]),
        type: 'application/octet-stream'
      }
    ],
    ['/api/chat/head', { json: head }],
    ['/api/chat/read', { json: head }],
    ['/api/chat/messages', { json: { ...head, messages: [], next_before: null } }],
    [
      '/api/chat/events',
      { bytes: Buffer.from(`event: head\ndata: ${JSON.stringify(head)}\n\n`), type: 'text/event-stream' }
    ]
  ]);
}

export async function startCompiledGameServer({ compiledRoot, api = new Map(), port = 0 }) {
  const root = await realpath(compiledRoot);
  const holds = new Map();
  const reports = new Map();
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://fixture.local').pathname);
      if (pathname === '/__qa/report' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16384) {
            res.writeHead(413);
            res.end();
            return;
          }
        }
        const report = JSON.parse(body);
        if (typeof report.key !== 'string') {
          res.writeHead(400);
          res.end();
          return;
        }
        reports.set(report.key, report.value);
        res.writeHead(204);
        res.end();
        return;
      }
      if (pathname === '/__fixture') {
        const mode = new URL(req.url, 'http://fixture.local').searchParams.get('mode') ?? 'ordinary';
        const fullscreen = mode !== 'ordinary';
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${fullscreen ? '<meta name="bread-display" content="fullscreen">' : ''}${mode === 'manual' ? '<meta name="bread-ready" content="manual">' : ''}<meta name="theme-color" content="#123456"><title>Presentation fixture</title><style>html,body{margin:0;background:#157447;color:white;font:24px system-ui;height:100%}main{padding:calc(var(--bread-control-inset-top,0px) + 20px) 20px}input,button{font:inherit;padding:12px}</style><main>Presentation fixture<input aria-label="Fixture text"><button onclick="bread.presentation.ready()">Ready</button><button onclick="bread.presentation.close()">Close</button><iframe srcdoc="<p>Child frame</p>"></iframe></main>`
        );
        return;
      }
      if (holds.has(pathname)) await holds.get(pathname).promise;
      const response = api.get(pathname);
      if (response) {
        res.writeHead(200, { 'content-type': response.type ?? 'application/json', 'cache-control': 'no-store' });
        res.end(response.bytes ?? JSON.stringify(response.json));
        return;
      }
      if (pathname.startsWith('/api/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      let file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep) && file !== root) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!extname(pathname)) file = join(root, 'index.html');
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const info = await stat(canonical);
      if (!info.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store'
      });
      createReadStream(canonical)
        .on('error', () => res.destroy())
        .pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not obtain a TCP port');
  return {
    port: address.port,
    reports,
    origin: `http://127.0.0.1:${address.port}`,
    hold(pathname) {
      if (holds.has(pathname)) throw new Error('Response already held');
      let release;
      const promise = new Promise(done => {
        release = done;
      });
      holds.set(pathname, { promise, release });
    },
    release(pathname) {
      holds.get(pathname)?.release();
      holds.delete(pathname);
    },
    async stop() {
      for (const hold of holds.values()) hold.release();
      holds.clear();
      server.closeAllConnections();
      await new Promise((done, reject) => server.close(error => (error ? reject(error) : done())));
    }
  };
}
