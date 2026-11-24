import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { startCompiledGameServer } from './bread-game-server.mjs';

test('serves exact compiled entry/assets and fixture APIs without altering the native contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bread-game-server-'));
  const html = '<html><meta name="bread-display" content="fullscreen"><script src="/assets/entry.js"></script></html>';
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'assets/entry.js'), 'window.actualGame = true;');
  const server = await startCompiledGameServer({
    compiledRoot: root,
    api: new Map([['/api/me', { json: { ready: true } }]])
  });
  try {
    assert.equal(await (await fetch(server.origin + '/matches/fixture_match')).text(), html);
    assert.equal(await (await fetch(server.origin + '/assets/entry.js')).text(), 'window.actualGame = true;');
    assert.deepEqual(await (await fetch(server.origin + '/api/me')).json(), { ready: true });
    assert.equal((await fetch(server.origin + '/assets/missing.js')).status, 404);
    assert.equal((await fetch(server.origin + '/api/missing')).status, 404);
    server.hold('/assets/entry.js');
    let settled = false;
    const pending = fetch(server.origin + '/assets/entry.js').then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false);
    server.release('/assets/entry.js');
    await pending;
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses decoded traversal and symlinks outside the supplied compiled root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bread-game-server-'));
  const compiled = join(root, 'compiled');
  await mkdir(join(compiled, 'assets'), { recursive: true });
  await writeFile(join(compiled, 'index.html'), '<html>Compiled game</html>');
  await writeFile(join(root, 'outside.js'), 'outside bytes');
  await symlink(join(root, 'outside.js'), join(compiled, 'assets/escape.js'));
  const server = await startCompiledGameServer({ compiledRoot: compiled });
  try {
    assert.equal((await fetch(server.origin + '/..%2foutside.js')).status, 403);
    assert.equal((await fetch(server.origin + '/assets/escape.js')).status, 403);
    assert.equal((await fetch(server.origin + '/assets/%E0%A4%A.js')).status, 404);
    assert.equal(await (await fetch(server.origin + '/matches/fixture_match')).text(), '<html>Compiled game</html>');
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('stops its held response without stopping an independently owned server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bread-game-server-'));
  await writeFile(join(root, 'index.html'), '<html>Compiled game</html>');
  await writeFile(join(root, 'entry.js'), 'compiled bytes');
  const server = await startCompiledGameServer({ compiledRoot: root });
  const independent = await startCompiledGameServer({ compiledRoot: root });
  let stopped = false;
  try {
    server.hold('/entry.js');
    let settled = false;
    const held = fetch(server.origin + '/entry.js').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false);
    await server.stop();
    stopped = true;
    await held;
    assert.equal(await (await fetch(independent.origin + '/entry.js')).text(), 'compiled bytes');
  } finally {
    if (!stopped) await server.stop();
    await independent.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps ordinary fixture metadata distinct from explicit manual fullscreen readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bread-game-server-'));
  const server = await startCompiledGameServer({ compiledRoot: root });
  try {
    const ordinary = await (await fetch(server.origin + '/__fixture')).text();
    assert.equal(ordinary.includes('name="bread-display"'), false);
    assert.equal(ordinary.includes('name="bread-ready"'), false);
    const manual = await (await fetch(server.origin + '/__fixture?mode=manual')).text();
    assert.equal(manual.includes('<meta name="bread-display" content="fullscreen">'), true);
    assert.equal(manual.includes('<meta name="bread-ready" content="manual">'), true);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
