import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] ?? 'miden-wallet-backend:local';
const name = `miden-backend-smoke-${process.pid}`;
const volume = `${name}-data`;
const environment = [
  '-e',
  'TRANSAK_API_KEY=smoke-test',
  '-e',
  'TRANSAK_API_SECRET=smoke-test',
  '-e',
  `RELAYER_PRIVATE_KEY=0x${'11'.repeat(32)}`
];

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function start() {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    ...environment,
    image
  ]);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = docker(['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', name]);
    if (state === 'running healthy') return;
    assert.ok(state.startsWith('running '), docker(['logs', name]));
    await setTimeout(1000);
  }
  throw new Error(`Health check failed: ${docker(['logs', name])}`);
}

function assertStoredOrder() {
  docker([
    'exec',
    name,
    'node',
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const response = await fetch('http://127.0.0.1:8787/orders/0123456789abcdef0123456789abcdef');
    assert.equal(response.status, 200);
    const order = await response.json();
    assert.equal(order.state, 'cancelled');
  `
  ]);
}

docker(['volume', 'create', volume]);
try {
  start();
  await waitForHealth();
  assert.equal(docker(['exec', name, 'id', '-u']), '1000');
  docker([
    'exec',
    name,
    'node',
    '--input-type=module',
    '-e',
    `
    import { openDatabase, OrderStore } from './dist/orders/store.js';
    const database = openDatabase(process.env.DB_PATH);
    const store = new OrderStore(database, Date.now);
    store.createCheckout({
      id: '0123456789abcdef0123456789abcdef', evmAddress: '0x' + '22'.repeat(20),
      midenAccountHex: '0x' + '0a'.repeat(15), fiatAmount: '10',
      tokenAddress: '0x' + '33'.repeat(20), tokenDecimals: 18
    });
    store.transition('0123456789abcdef0123456789abcdef', 'checkout', 'cancelled', {}, 'smoke test');
    database.close();
  `
  ]);
  assertStoredOrder();

  const second = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      `${name}-second`,
      '--network',
      'none',
      '--mount',
      `type=volume,source=${volume},target=/data`,
      ...environment,
      image
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /Cannot lock the backend database/);

  docker(['stop', '--time', '40', name]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]), '0');
  assert.match(docker(['logs', name]), /shutdown_complete/);
  docker(['rm', name]);
  start();
  await waitForHealth();
  assertStoredOrder();

  docker(['kill', '--signal', 'KILL', name]);
  docker(['rm', name]);
  start();
  await waitForHealth();
  assertStoredOrder();
  docker(['stop', '--time', '40', name]);
  console.log('Passed: health, non-root user, single instance, graceful stop, volume persistence, crash recovery.');
} finally {
  // Remove only the container and volume created by this test.
  spawnSync('docker', ['rm', '-f', name, `${name}-second`], { stdio: 'ignore', timeout: 30_000 });
  docker(['volume', 'rm', volume]);
}
