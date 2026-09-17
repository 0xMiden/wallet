#!/usr/bin/env node
/**
 * Run the bridge E2E suites against the REAL external services — the hosted
 * Epoch allocator/solver, the real AggLayer bridge, and real Sepolia — instead
 * of the hermetic doubles the PR gates use.
 *
 * Most Epoch/AggLayer coverage runs against `FakeEpochAllocator` + an Anvil
 * chain carrying `anvil_setCode` stubs at the real addresses. That double
 * quotes unconditionally and settles instantly, so it cannot catch a service
 * that stops quoting, reprices, or never fills — which is exactly the class of
 * failure that took `bridge-out-epoch.spec.ts` down for a month (#627).
 *
 * Every external dependency is probed BEFORE the build, because the build plus
 * a bridge run is ~20 minutes and a dead solver or an unfunded key should cost
 * seconds to find. The preflight is the point of this script; the spawn of
 * `playwright test` underneath it is the easy part.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_EPOCH_URL = 'https://testnet-dev.epochprotocol.xyz';
const DEFAULT_EPOCH_POSITIONS_URL = 'https://positions-testnet-dev.epochprotocol.xyz';
const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const SEPOLIA_CHAIN_ID = 11155111;
/** Epoch's virtual chain id for a Miden leg — src/lib/epoch/config.ts. */
const MIDEN_CHAIN_ID = 999999999;

/** Kept in sync with src/lib/epoch/bridgeable-token.ts and helpers/sepolia.ts. */
const SEPOLIA_USDC = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
/** The Compact and the AggLayer bridge, at the addresses the wallet hardcodes. */
const SEPOLIA_COMPACT = '0x00000000000000171ede64904551eeDF3C6C9788';
const SEPOLIA_AGGLAYER_BRIDGE = '0x1348947e282138d8f377b467f7d9c2eb0f335d1f';

const MIDEN_RPC = {
  testnet: 'https://rpc.testnet.miden.io',
  devnet: 'https://rpc.devnet.miden.io'
};
const MIDEN_FAUCET_API = {
  testnet: 'https://faucet-api.testnet.miden.io',
  devnet: 'https://faucet-api.devnet.miden.io'
};

/**
 * `needsEvmKey` marks a suite whose EVM leg is SIGNED by the test (a Compact
 * deposit, a 7702 delegation). Bridge-out is solver-fulfilled — the wallet
 * signs nothing on EVM — so those suites need no key and no gas at all.
 */
const SUITES = {
  'bridge-out-epoch': {
    config: 'playwright.bridge.config.ts',
    grep: 'Fast Epoch',
    needsEvmKey: false,
    describe: 'Miden testnet -> hosted Epoch solver -> real Sepolia USDC'
  },
  'bridge-out-agglayer': {
    config: 'playwright.bridge.config.ts',
    grep: 'Slow AggLayer',
    needsEvmKey: false,
    describe: 'Miden testnet -> real AggLayer bridge (Miden leg asserted)'
  },
  'bridge-out': {
    config: 'playwright.bridge.config.ts',
    grep: undefined,
    needsEvmKey: false,
    describe: 'both bridge-out routes'
  }
};

const USAGE = `
Run the wallet's bridge E2E against real Epoch / AggLayer / Sepolia endpoints.

  yarn e2e:real --suite <name> [options]

Suites
${Object.entries(SUITES)
  .map(([name, s]) => `  ${name.padEnd(21)} ${s.describe}${s.needsEvmKey ? '  [needs --sepolia-key]' : ''}`)
  .join('\n')}

Options
  --suite <name>            which suite to run (required)
  --network <net>           testnet | devnet            (default: testnet)
  --epoch-url <url>         Epoch allocator base URL    (default: hosted testnet-dev)
  --epoch-positions-url <u> Epoch positions base URL    (default: hosted testnet-dev)
  --sepolia-rpc <url>       Sepolia RPC                 (default: a public node)
  --sepolia-key <0x...>     funded Sepolia EOA key, for suites with a signed EVM leg
                            (env: E2E_SEPOLIA_PRIVATE_KEY)
  --min-eth <amount>        preflight gas floor in ether (default: 0.02)
  --mint-usdc <amount>      top the key's test USDC up to this, in whole USDC
                            (default: 100; the token mints permissionlessly)
  --preflight-only          probe the services and exit; build and run nothing
  --skip-build              reuse the existing dist/ (it must match --network)
  --headed                  run the browser headed
  --grep <pattern>          further narrow the tests within the suite
  -h, --help                this message

Nothing here is secret-gated: bridge-out needs no EVM key, and the Sepolia test
USDC mints permissionlessly, so the only scarce input is Sepolia gas — and only
for suites whose EVM leg is signed.
`;

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    suite: undefined,
    network: 'testnet',
    epochUrl: process.env.EPOCH_ALLOCATOR_URL ?? DEFAULT_EPOCH_URL,
    epochPositionsUrl: process.env.EPOCH_POSITIONS_URL ?? DEFAULT_EPOCH_POSITIONS_URL,
    sepoliaRpc: process.env.E2E_SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC,
    sepoliaKey: process.env.E2E_SEPOLIA_PRIVATE_KEY,
    minEth: '0.02',
    mintUsdc: '100',
    preflightOnly: false,
    skipBuild: false,
    headed: false,
    grep: undefined
  };
  const takesValue = {
    '--suite': 'suite',
    '--network': 'network',
    '--epoch-url': 'epochUrl',
    '--epoch-positions-url': 'epochPositionsUrl',
    '--sepolia-rpc': 'sepoliaRpc',
    '--sepolia-key': 'sepoliaKey',
    '--min-eth': 'minEth',
    '--mint-usdc': 'mintUsdc',
    '--grep': 'grep'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--preflight-only') opts.preflightOnly = true;
    else if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--headed') opts.headed = true;
    else if (takesValue[arg]) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      opts[takesValue[arg]] = value;
    } else fail(`unknown argument: ${arg}`);
  }
  return opts;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ── preflight ───────────────────────────────────────────────────────────────

const results = [];

function record(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(34)} ${detail}`);
  return ok;
}

/**
 * A browser-ish UA on every probe: the Epoch host sits behind Cloudflare, which
 * answers a default agent UA with 403 "error code: 1010". That reads exactly
 * like the service being down, so it is worth not tripping.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 miden-wallet-e2e';

async function getJson(url, init = {}, timeoutMs = 20_000) {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function rpc(url, method, params, timeoutMs = 20_000) {
  const { body } = await getJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    },
    timeoutMs
  );
  if (body?.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body?.result;
}

async function probeMidenNode(network) {
  const url = MIDEN_RPC[network];
  if (!url) return record(false, 'Miden RPC', `no endpoint known for network "${network}"`);
  try {
    // The node speaks gRPC, not JSON-RPC; reachability is all we can cheaply
    // assert here, and it is what distinguishes "DNS/host is gone" from a real
    // protocol error the suite will report properly.
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    return record(true, 'Miden RPC', `${url} reachable (HTTP ${res.status})`);
  } catch (err) {
    return record(false, 'Miden RPC', `${url} unreachable: ${err.message}`);
  }
}

async function probeMidenFaucet(network) {
  const base = MIDEN_FAUCET_API[network];
  if (!base) return record(false, 'Miden faucet API', `no endpoint known for network "${network}"`);
  try {
    const { status, body } = await getJson(`${base}/get_metadata`);
    if (status !== 200) return record(false, 'Miden faucet API', `${base} answered HTTP ${status}`);
    // Every fresh E2E account needs a native-MIDEN grant before its first fee-charged
    // transaction, so a dead faucet fails the run at funding, not at the assertion.
    return record(true, 'Miden faucet API', `node ${body.version}, grants ${body.base_amount} base units`);
  } catch (err) {
    return record(false, 'Miden faucet API', `${base} unreachable: ${err.message}`);
  }
}

async function probeEpochHealth(epochUrl) {
  try {
    const { status, body } = await getJson(`${epochUrl}/health`);
    if (status !== 200) return record(false, 'Epoch allocator', `${epochUrl} answered HTTP ${status}`);
    const midenAllocator = body?.allocatorAddresses?.[String(MIDEN_CHAIN_ID)];
    if (!midenAllocator) {
      return record(false, 'Epoch allocator', `healthy but no allocator for chain ${MIDEN_CHAIN_ID}`);
    }
    return record(true, 'Epoch allocator', `${body.status}, Miden allocator ${midenAllocator}`);
  } catch (err) {
    return record(false, 'Epoch allocator', `${epochUrl} unreachable: ${err.message}`);
  }
}

async function probeEpochGasless(epochUrl) {
  try {
    const { body } = await getJson(`${epochUrl}/gasless-status`);
    const chains = body?.supportedChainIds ?? [];
    const ok = body?.enabled === true && chains.includes(SEPOLIA_CHAIN_ID);
    // Informational: only the signed-EVM-leg suites care, and they can still run
    // by paying their own gas.
    return record(
      true,
      'Epoch gasless relayer',
      ok ? `enabled for Sepolia (${body.relayerAddress})` : 'not available for Sepolia'
    );
  } catch (err) {
    return record(true, 'Epoch gasless relayer', `unknown: ${err.message}`);
  }
}

/**
 * The check that matters. Ask the live solver for the same quote the Fast route
 * asks for and require a priced route back.
 *
 * `/checkIfDepositNeeded` prices the intent from its MANDATE; the surrounding
 * compact (nonce, id, lockTag) is not read for a quote — the request carries
 * `sponsorSignature: "0x"` and `isRegisteredOnchain: false`. So this mirrors the
 * mandate `buildEpochTaskDataParams` produces and leaves the rest well-formed
 * but nominal, which keeps the probe free of the SDK (whose ESM entry needs a
 * bundler) without weakening what is being asserted.
 */
async function probeEpochQuote(epochUrl, faucetId) {
  const { ARBITER_ADDRESS } = require('@epoch-protocol/epoch-commons-sdk/dist/constants/contractAddresses.js');
  const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
  const ZERO_HASH = `0x${'0'.repeat(64)}`;
  const NOMINAL_EOA = `0x${'1'.repeat(40)}`;
  const amountIn = '1000000'; // 1 token at the 6dp Miden convention

  const witnessTypeString =
    'address tokenIn,uint256 tokenInAmount,address tokenOut,uint256 minTokenOut,uint256 destinationChainId,' +
    'bytes4 taskType,bytes32 protocolHashIdentifier,address recipient,uint256 midenReclaimHeight,' +
    'string midenSourceAccount,string midenFaucetId,string midenNoteType,string midenNoteId';

  const body = {
    chainId: String(MIDEN_CHAIN_ID),
    compact: {
      arbiter: ARBITER_ADDRESS[MIDEN_CHAIN_ID],
      sponsor: NOMINAL_EOA,
      nonce: '1',
      expires: String(Math.floor(Date.now() / 1000) + 3600),
      id: '1',
      lockTag: `0x${'0'.repeat(24)}`,
      token: ZERO_ADDRESS,
      amount: amountIn,
      mandate: {
        tokenIn: ZERO_ADDRESS,
        tokenInAmount: amountIn,
        tokenOut: SEPOLIA_USDC,
        minTokenOut: '0',
        destinationChainId: String(SEPOLIA_CHAIN_ID),
        taskType: '0xb492b7f5', // keccak256('gettokenout').slice(0, 10)
        protocolHashIdentifier: ZERO_HASH,
        recipient: NOMINAL_EOA,
        midenSourceAccount: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8',
        midenFaucetId: faucetId,
        midenNoteType: 'P2IDE',
        midenNoteId: '',
        midenReclaimHeight: '9000000'
      }
    },
    witnessTypeString,
    sponsorSignature: '0x',
    isRegisteredOnchain: false
  };

  try {
    const { status, body: res } = await getJson(
      `${epochUrl}/checkIfDepositNeeded`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      30_000
    );
    if (res?.success !== true) {
      // The #627 shape: 200 OK carrying a refusal. Name it, because it is the
      // difference between "the service is down" and "it will not price this".
      return record(
        false,
        'Epoch live quote',
        `declined (HTTP ${status}): ${res?.code ?? ''} ${res?.error ?? JSON.stringify(res).slice(0, 160)}`
      );
    }
    const leg = res?.path?.[0]?.[0]?.[2];
    const out = leg?.[1]?.token?.amount;
    const filler = res?.path?.[0]?.[0]?.[1]?.[0]?.name;
    return record(true, 'Epoch live quote', `1.0 in -> ${formatUnits(out, 18)} USDC out via ${filler ?? 'solver'}`);
  } catch (err) {
    return record(false, 'Epoch live quote', `request failed: ${err.message}`);
  }
}

async function probeSepolia(sepoliaRpc) {
  try {
    const chainId = Number(await rpc(sepoliaRpc, 'eth_chainId', []));
    if (chainId !== SEPOLIA_CHAIN_ID) {
      return record(false, 'Sepolia RPC', `${sepoliaRpc} reports chain ${chainId}, expected ${SEPOLIA_CHAIN_ID}`);
    }
    const block = Number(await rpc(sepoliaRpc, 'eth_blockNumber', []));
    return record(true, 'Sepolia RPC', `chain ${chainId}, head #${block}`);
  } catch (err) {
    return record(false, 'Sepolia RPC', `${sepoliaRpc} unreachable: ${err.message}`);
  }
}

/**
 * The three contracts the wallet hardcodes. On Anvil they are `anvil_setCode`
 * stubs; a real run needs the genuine deployments, and an empty address would
 * otherwise surface as an opaque revert deep inside a 15-minute test.
 */
async function probeSepoliaContracts(sepoliaRpc) {
  const targets = [
    ['USDC', SEPOLIA_USDC],
    ['The Compact', SEPOLIA_COMPACT],
    ['AggLayer bridge', SEPOLIA_AGGLAYER_BRIDGE]
  ];
  const sizes = [];
  for (const [name, address] of targets) {
    try {
      const code = await rpc(sepoliaRpc, 'eth_getCode', [address, 'latest']);
      const bytes = Math.max(0, (String(code).length - 2) / 2);
      if (bytes === 0) return record(false, 'Sepolia contracts', `${name} at ${address} has no code`);
      sizes.push(`${name} ${bytes}B`);
    } catch (err) {
      return record(false, 'Sepolia contracts', `${name}: ${err.message}`);
    }
  }
  return record(true, 'Sepolia contracts', sizes.join(', '));
}

async function probeFundedKey(sepoliaRpc, privateKey, minEth, mintUsdcTarget) {
  let viem;
  let accounts;
  try {
    viem = require('viem');
    accounts = require('viem/accounts');
  } catch (err) {
    return record(false, 'Sepolia funded key', `viem not resolvable: ${err.message}`);
  }

  let account;
  try {
    account = accounts.privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  } catch {
    return record(false, 'Sepolia funded key', 'not a valid private key (expect 32 bytes hex)');
  }

  const wei = BigInt(await rpc(sepoliaRpc, 'eth_getBalance', [account.address, 'latest']));
  const floor = viem.parseEther(minEth);
  if (wei < floor) {
    return record(
      false,
      'Sepolia gas',
      `${account.address} holds ${formatUnits(wei, 18)} ETH, below the ${minEth} ETH floor — fund it from a Sepolia faucet`
    );
  }
  record(true, 'Sepolia gas', `${account.address} holds ${formatUnits(wei, 18)} ETH`);

  // The route's USDC mints permissionlessly, so a low balance is a top-up, not
  // a blocker — top up rather than telling the operator to go and find some.
  const balance = BigInt(
    await rpc(sepoliaRpc, 'eth_call', [
      { to: SEPOLIA_USDC, data: `0x70a08231${account.address.slice(2).padStart(64, '0')}` },
      'latest'
    ])
  );
  const target = viem.parseUnits(mintUsdcTarget, 18);
  if (balance >= target) {
    return record(true, 'Sepolia test USDC', `${formatUnits(balance, 18)} USDC (target ${mintUsdcTarget})`);
  }

  try {
    const wallet = viem.createWalletClient({
      account,
      chain: { ...require('viem/chains').sepolia, rpcUrls: { default: { http: [sepoliaRpc] } } },
      transport: viem.http(sepoliaRpc)
    });
    const hash = await wallet.writeContract({
      address: SEPOLIA_USDC,
      abi: [
        {
          type: 'function',
          name: 'mint',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: []
        }
      ],
      functionName: 'mint',
      args: [account.address, target - balance]
    });
    return record(true, 'Sepolia test USDC', `minted up to ${mintUsdcTarget} USDC (tx ${hash.slice(0, 12)}…)`);
  } catch (err) {
    return record(false, 'Sepolia test USDC', `mint failed: ${String(err.message).split('\n')[0]}`);
  }
}

function formatUnits(value, decimals) {
  if (value === undefined || value === null) return '?';
  const raw = BigInt(value)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const frac = raw.slice(-decimals).replace(/0+$/, '').slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}

// ── run ─────────────────────────────────────────────────────────────────────

function run(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('close', code => resolve(code ?? 1));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.suite) fail(`--suite is required. One of: ${Object.keys(SUITES).join(', ')}${USAGE}`);
  const suite = SUITES[opts.suite];
  if (!suite) fail(`unknown suite "${opts.suite}". One of: ${Object.keys(SUITES).join(', ')}`);
  if (!MIDEN_RPC[opts.network]) fail(`--network must be one of: ${Object.keys(MIDEN_RPC).join(', ')}`);
  if (suite.needsEvmKey && !opts.sepoliaKey) {
    fail(`suite "${opts.suite}" signs on EVM, so it needs --sepolia-key (or E2E_SEPOLIA_PRIVATE_KEY)`);
  }

  console.log(`\nSuite    ${opts.suite} — ${suite.describe}`);
  console.log(`Network  ${opts.network}`);
  console.log(`Epoch    ${opts.epochUrl}`);
  console.log(`Sepolia  ${opts.sepoliaRpc}\n`);
  console.log('Preflight');

  await probeMidenNode(opts.network);
  await probeMidenFaucet(opts.network);
  await probeEpochHealth(opts.epochUrl);
  await probeEpochGasless(opts.epochUrl);
  // The spec mints a throwaway faucet per run, so the probe asks about one too:
  // it must reflect what the suite will actually request, not a friendlier token.
  await probeEpochQuote(opts.epochUrl, '0xabcdefabcdefabcdefabcdefabcdef');
  await probeSepolia(opts.sepoliaRpc);
  await probeSepoliaContracts(opts.sepoliaRpc);
  if (opts.sepoliaKey) await probeFundedKey(opts.sepoliaRpc, opts.sepoliaKey, opts.minEth, opts.mintUsdc);

  const failed = results.filter(r => !r.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`✗ preflight failed (${failed.length}/${results.length}): ${failed.map(f => f.label).join(', ')}`);
    console.error('  Nothing was built or run — fix the above and re-run.\n');
    return 1;
  }
  console.log(`✓ preflight passed (${results.length} checks)\n`);
  if (opts.preflightOnly) return 0;

  const env = {
    E2E_NETWORK: opts.network,
    E2E_REAL_EPOCH: 'true',
    EPOCH_ALLOCATOR_URL: opts.epochUrl,
    EPOCH_POSITIONS_URL: opts.epochPositionsUrl,
    E2E_SEPOLIA_RPC_URL: opts.sepoliaRpc,
    ...(opts.sepoliaKey ? { E2E_SEPOLIA_PRIVATE_KEY: opts.sepoliaKey } : {})
  };

  if (!opts.skipBuild) {
    console.log('Building the extension for a real-endpoint run…\n');
    // The allocator URL is a bundler define, so pointing at a different Epoch
    // host is a REBUILD, not a runtime switch. --skip-build is only safe when
    // dist/ was produced with this same env.
    const code = await run('yarn', ['test:e2e:blockchain:build'], env);
    if (code !== 0) {
      console.error('\n✗ build failed — not running the suite.\n');
      return code;
    }
  }

  const args = ['playwright', 'test', '--config', suite.config, '--retries=1'];
  if (suite.grep) args.push('--grep', suite.grep);
  if (opts.grep) args.push('--grep', opts.grep);
  if (opts.headed) args.push('--headed');

  console.log(`\nRunning: yarn ${args.join(' ')}\n`);
  return run('yarn', args, env);
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err);
    process.exit(1);
  }
);
