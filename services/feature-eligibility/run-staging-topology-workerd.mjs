import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const bearer = 'synthetic-test-only-bearer';

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function waitUntilReady(child, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`workerd exited before readiness (${child.exitCode ?? child.signalCode})`);
    try {
      const response = await fetch(url);
      if (response.status === 403) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('workerd did not become ready within 45 seconds');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (!(await waitForExit(child, 5000))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (!(await waitForExit(child, 5000))) throw new Error('workerd did not stop after SIGKILL');
  }
}

const port = await availablePort();
const endpoint = `http://127.0.0.1:${port}`;
const persisted = await mkdtemp(path.join(os.tmpdir(), 'feature-eligibility-topology-'));
const now = Date.now();
const runUntil = now + 8 * 60_000;
const args = [
  '--yes',
  'wrangler@4.151.3',
  'dev',
  '--config',
  path.join(directory, 'wrangler.topology-test.jsonc'),
  '--local',
  '--ip',
  '127.0.0.1',
  '--port',
  String(port),
  '--persist-to',
  persisted,
  '--var',
  `TOPOLOGY_RUN_UNTIL:${runUntil}`
];
const worker = spawn('npx', args, { cwd: directory, detached: true, stdio: 'inherit' });
let result = 1;

try {
  await waitUntilReady(worker, endpoint);
  const files = (await readdir(directory)).filter(name => name.startsWith('staging-topology') && name.endsWith('.test.mjs') && !name.endsWith('-workerd.test.mjs'));
  const unit = await run(process.execPath, ['--test', ...files.map(name => path.join(directory, name))], { cwd: directory });
  if (unit.code !== 0) throw new Error(`staging topology unit tests failed with exit ${unit.code}`);

  const integration = await run(process.execPath, ['--test', path.join(directory, 'staging-topology-workerd.test.mjs')], {
    cwd: directory,
    env: { ...process.env, TOPOLOGY_TEST_URL: endpoint, TOPOLOGY_TEST_BEARER: bearer }
  });
  result = integration.code;
} finally {
  await stop(worker);
  await rm(persisted, { recursive: true, force: true });
}

process.exitCode = result;
