import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const directory = new URL('.', import.meta.url);
const repoDirectory = fileURLToPath(directory);
const moduleName = 'run-staging-topology-workerd.mjs';

async function runImport(moduleUrl, env, timeoutMs) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'await import(process.env.TARGET_MODULE)'], {
    detached: true,
    env: { ...env, TARGET_MODULE: moduleUrl },
    stdio: 'ignore'
  });

  let timer;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timer);

  if (result) return { ...result, timedOut: false };

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
  return { code: null, signal: 'SIGKILL', timedOut: true };
}

test('importing the workerd runner does not start a worker or create persisted state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'topology-workerd-entry-'));
  const bin = join(root, 'bin');
  const isolatedTmp = join(root, 'tmp');
  const marker = join(root, 'npx-invoked');
  const fakeWorkerPid = join(root, 'fake-worker.pid');
  const copiedModule = join(root, moduleName);
  const fakeNpx = join(bin, 'npx');

  try {
    await mkdir(bin);
    await mkdir(isolatedTmp);
    await copyFile(join(repoDirectory, moduleName), copiedModule);
    await copyFile(join(repoDirectory, 'wrangler.topology-test.jsonc'), join(root, 'wrangler.topology-test.jsonc'));
    await writeFile(
      fakeNpx,
      `#!/bin/sh
: > "$TOPOLOGY_FAKE_NPX_MARKER"
echo "$$" > "$TOPOLOGY_FAKE_NPX_PID"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then
    shift
    exec /usr/bin/env node -e 'const http = require("node:http"); const server = http.createServer((request, response) => { response.writeHead(403); response.end(); }); server.listen(Number(process.argv[1]), "127.0.0.1");' "$1"
  fi
  shift
done
exit 97
`
    );
    await chmod(fakeNpx, 0o755);

    const result = await runImport(pathToFileURL(copiedModule).href, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TMPDIR: isolatedTmp,
      TMP: isolatedTmp,
      TEMP: isolatedTmp,
      TOPOLOGY_FAKE_NPX_MARKER: marker,
      TOPOLOGY_FAKE_NPX_PID: fakeWorkerPid
    }, 3000);

    assert.equal(result.timedOut, false, 'module import should finish within the short timeout');
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'module import must not start the worker executable');
    assert.deepEqual(await readdir(isolatedTmp), [], 'module import must not create persisted worker state');
    assert.deepEqual(result, { code: 0, signal: null, timedOut: false });
  } finally {
    try {
      const pid = Number(await readFile(fakeWorkerPid, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
    await rm(root, { recursive: true, force: true });
  }
});
