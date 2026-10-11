/**
 * Test-only: e2e-real.test.ts preloads this with `node --import`, so a run meets canned answers and never reaches the
 * network, a cargo install, a build or Playwright. E2E_REAL_FETCH_STUB carries `{ document, log, answers }`: the config
 * document to serve as `<network>.json`; a file each request is appended to (`<url>`, `<url> <body>` for any other
 * request with a body, `<url> <method> <params>` for JSON-RPC, `native asset <rpc>` for the native-asset discovery and
 * `SPAWN <json>` for the CLI install and each child run() starts); and overrides of ANSWERS, which hold what live
 * testnet answered, so a usdcx preflight passes on the defaults.
 */
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const { document, log, answers: overrides = {} } = JSON.parse(process.env.E2E_REAL_FETCH_STUB ?? '{}');

const REMOTE_TOKEN = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';
const ANSWERS = {
  arcChainId: '0x4cef52',
  // Arc hosts whose every request fails as a network error.
  arcDown: [],
  // `{ <method>: n }`: the first n Arc calls of that method answer HTTP 429 with Retry-After 0.
  rateLimited: {},
  rawTransaction: { code: -32602, message: 'failed to decode signed transaction' },
  registered: true,
  paused: false,
  depositsPaused: false,
  withdrawalsPaused: false,
  remoteToken: REMOTE_TOKEN,
  gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  usdcBalance: '10000000',
  circleInfo: {
    sourceDomains: [{ chain: 'Arc', domain: 26, contractAddress: '0x008888878f94c0d87defdf0b07f46b93c1934442' }],
    remoteDomains: [
      { chain: 'Miden', domain: 10007, tokens: [{ remoteToken: 'USDCx', remoteTokenIdentifier: REMOTE_TOKEN }] }
    ]
  },
  faucet: {
    version: 'stub',
    decimals: 6,
    base_amount: 100000000,
    token_amounts: [1, 10, 100],
    balance: 999444411348973
  },
  guardianStatus: { status: 'ok', version: '0.18.0', git_commit: 'fab5f5cb2c3f', environment: 'testnet' },
  guardianPubkey: {
    commitment: '0x6b3e7eda3e144c8f58980385492da4cc1e474a691771704b8f99da441609990f',
    pubkey: '0x02d2190fce12065f8e0d4933cd84687e68a644a5e5d39e497a65b7b1a769f5c11e'
  },
  // `{ error: '<stderr>' }` makes the discovery fail.
  nativeAsset: { id: '0x4cbdcaffe75f0a317482224dae6436', bytes32: REMOTE_TOKEN },
  cliInstall: { status: 0, stdout: 'Installed package `miden-client-cli`\n/stub/cli/bin/miden-client\n' },
  exitCodes: { build: 0, test: 0 }
};
const answers = { ...ANSWERS, ...overrides };

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const RPC_RESULTS = {
  eth_chainId: '0xaa36a7',
  eth_blockNumber: '0x1',
  eth_getCode: '0x6080',
  eth_getBalance: '0xde0b6b3a7640000',
  eth_call: '0x0'
};

const word = hex => `0x${hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
const flag = value => word(value ? '1' : '0');
const servedArcCalls = {};

function arcAnswer({ method, params }) {
  switch (method) {
    case 'eth_chainId':
      return { result: answers.arcChainId };
    case 'eth_blockNumber':
      return { result: '0x1' };
    case 'eth_getCode':
      return { result: '0x6080' };
    case 'eth_sendRawTransaction':
      return { error: answers.rawTransaction };
    case 'eth_call': {
      const views = {
        '0xf54a69c3': flag(answers.registered),
        '0x5c975abb': flag(answers.paused),
        '0x4a1b13ea': flag(answers.depositsPaused),
        '0xe9cafc83': flag(answers.withdrawalsPaused),
        '0xb3467549': word(answers.remoteToken),
        '0x0f41efea': word(answers.gatewayMinter),
        '0x70a08231': word(BigInt(answers.usdcBalance).toString(16))
      };
      const selector = params[0].data.slice(0, 10);
      return Object.hasOwn(views, selector) ? { result: views[selector] } : { error: { code: 3, message: 'reverted' } };
    }
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
  }
}

const isArc = host => host.endsWith('.arc.io') || host.startsWith('arc-rpc.');

global.fetch = async (input, init = {}) => {
  const url = String(input);
  const call = typeof init.body === 'string' && init.body.includes('"jsonrpc"') ? JSON.parse(init.body) : null;
  const body = typeof init.body === 'string' ? ` ${init.body}` : '';
  appendFileSync(log, call ? `${url} ${call.method} ${JSON.stringify(call.params)}\n` : `${url}${body}\n`);
  const { host } = new URL(url);
  if (call && isArc(host)) {
    if (answers.arcDown.includes(host)) throw new TypeError('fetch failed');
    servedArcCalls[call.method] = (servedArcCalls[call.method] ?? 0) + 1;
    if (servedArcCalls[call.method] <= (answers.rateLimited[call.method] ?? 0)) {
      return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });
    }
    return json({ jsonrpc: '2.0', id: call.id, ...arcAnswer(call) });
  }
  if (call) return json({ jsonrpc: '2.0', id: call.id, result: RPC_RESULTS[call.method] });
  if (url.endsWith('.json')) return json(document);
  if (url.endsWith('/health')) return json({ status: 'healthy', allocatorAddresses: { 999999999: '0xa110c' } });
  if (url.endsWith('/checkIfDepositNeeded')) {
    return json({ success: true, path: [[[{}, [{ name: 'stub solver' }], [{}, { token: { amount: '1' } }]]]] });
  }
  if (url.endsWith('/gasless-status')) return json({ enabled: false });
  if (url.endsWith('/get_metadata')) return json(answers.faucet);
  if (url.endsWith('/v1/info')) return json(answers.circleInfo);
  if (url.endsWith('/status')) return json(answers.guardianStatus);
  if (url.endsWith('/pubkey?scheme=ecdsa')) return json(answers.guardianPubkey);
  // Miden exit 0 as the live AggLayer indexer files it.
  if (url.includes('/bridge?')) return json({ deposit: { deposit_cnt: 0, network_id: 73, dest_net: 0 } });
  return new Response('ok');
};

// The CLI install and the native-asset discovery answer from ANSWERS. run()'s children log their command and the
// environment names a usdcx phase sets or unsets, then close. Every other child (the ts-node reader of the config
// document) runs for real. syncBuiltinESMExports carries the swap into the runner's named imports.
const childProcess = createRequire(import.meta.url)('node:child_process');
const realSpawnSync = childProcess.spawnSync;
const WATCHED_ENV = [
  'E2E_NETWORK',
  'E2E_REAL_USDCX',
  'E2E_REAL_EPOCH',
  'E2E_SEPOLIA_RPC_URL',
  'E2E_SEPOLIA_PRIVATE_KEY',
  'E2E_ARC_RPC_URL',
  'E2E_ARC_PRIVATE_KEY',
  'E2E_ARC_KEY_ROLE',
  'E2E_HEADLESS',
  'MIDEN_CLIENT_BIN'
];
childProcess.spawnSync = (command, args = [], options = {}) => {
  const line = args.join(' ');
  if (line.includes('install-pinned-miden-cli.cjs')) {
    appendFileSync(log, `SPAWN ${JSON.stringify({ command: 'install-pinned-miden-cli', args })}\n`);
    return { status: answers.cliInstall.status, stdout: answers.cliInstall.stdout, stderr: '' };
  }
  if (line.includes('discoverFeeFaucetId')) {
    appendFileSync(log, `native asset ${args[args.length - 1]}\n`);
    const { error } = answers.nativeAsset;
    return error === undefined
      ? { status: 0, stdout: JSON.stringify(answers.nativeAsset), stderr: '' }
      : { status: 1, stdout: '', stderr: error };
  }
  return realSpawnSync(command, args, options);
};
childProcess.spawn = (command, args = [], options = {}) => {
  const env = options.env ?? {};
  const watched = Object.fromEntries(
    WATCHED_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]])
  );
  appendFileSync(log, `SPAWN ${JSON.stringify({ command, args, env: watched })}\n`);
  const child = new EventEmitter();
  setImmediate(() => child.emit('close', answers.exitCodes[args[0] === 'playwright' ? 'test' : 'build']));
  return child;
};
syncBuiltinESMExports();
// A swap that did not reach the named exports would let a test start a real build, so it stops the run here.
const linked = await import('node:child_process');
if (linked.spawn !== childProcess.spawn || linked.spawnSync !== childProcess.spawnSync) {
  throw new Error('e2e-real.fetch-stub: the node:child_process named exports kept the real spawn');
}
