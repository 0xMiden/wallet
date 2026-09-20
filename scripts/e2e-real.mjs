#!/usr/bin/env node
/**
 * Run the bridge and swap E2E suites against REAL infrastructure - the hosted
 * Epoch allocator/solver, the real AggLayer bridge, real Sepolia, and the public
 * Miden testnet - instead of the hermetic doubles the PR gates use.
 *
 * Most Epoch/AggLayer coverage runs against `FakeEpochAllocator` + an Anvil
 * chain carrying `anvil_setCode` stubs at the real addresses; swap runs against
 * a local 0.16 node booted for the job. Those doubles quote unconditionally,
 * settle instantly and mine on demand, so they cannot catch a service that stops
 * quoting, reprices or never fills - the class of failure that took
 * `bridge-out-epoch.spec.ts` down for a month (#627) - nor a timing assumption
 * that only holds when blocks arrive on request.
 *
 * Every external dependency is probed BEFORE the build, because the build plus a
 * run is ~20 minutes and a dead solver or an unfunded key should cost seconds to
 * find. The preflight is the point of this script; the spawn of `playwright test`
 * underneath it is the easy part.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_EPOCH_URL = 'https://testnet-dev.epochprotocol.xyz';
const DEFAULT_EPOCH_POSITIONS_URL = 'https://positions-testnet-dev.epochprotocol.xyz';
const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const SEPOLIA_CHAIN_ID = 11155111;
/** Epoch's virtual chain id for a Miden leg - src/lib/epoch/config.ts. */
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
/**
 * The hosted guardian per network, for the preflight probe only. Mirrors
 * `guardianUrl` in playwright/e2e/config/environments.ts, which is what the spec
 * itself reads - this copy exists because the probe runs before Playwright does.
 */
const GUARDIAN_URL = {
  testnet: 'https://guardian.openzeppelin.com',
  devnet: 'https://guardian-stg.openzeppelin.com'
};
const MIDEN_FAUCET_API = {
  testnet: 'https://faucet-api.testnet.miden.io',
  devnet: 'https://faucet-api.devnet.miden.io'
};

export const SUITES = {
  'bridge-out-epoch': {
    config: 'playwright.bridge.config.ts',
    grep: 'Fast Epoch',
    probes: ['epoch', 'sepolia'],
    // Its single test mints a faucet and triggers a live solver fill, then polls
    // settlement for 300s. A retry is not a free second look - it spends the
    // fill again, so a timing flake must not buy one.
    retries: 0,
    describe: 'Miden testnet -> hosted Epoch solver -> real Sepolia USDC'
  },
  'bridge-out-agglayer': {
    config: 'playwright.bridge.config.ts',
    grep: 'Slow AggLayer',
    // No epoch: this route never asks the solver anything, so an Epoch refusal
    // must not decide whether an AggLayer run happens.
    probes: ['sepolia'],
    describe: 'Miden testnet -> real AggLayer bridge (Miden leg asserted)'
  },
  'bridge-out': {
    config: 'playwright.bridge.config.ts',
    grep: 'bridge-out',
    probes: ['epoch', 'sepolia'],
    retries: 0, // includes the Epoch route; see bridge-out-epoch.
    describe: 'both bridge-out routes'
  },
  swap: {
    config: 'playwright.swap.config.ts',
    probes: ['dex'],
    // The guardian scenario is excluded by default: it is the one swap spec that
    // needs a co-signer, and on testnet that means a third party's hosted
    // guardian rather than the container the PR job boots. `swap-guardian` runs
    // it on its own, so a guardian outage cannot red the whole swap suite.
    grepInvert: 'guardian maker',
    describe: 'in-protocol DEX (PSWAP) fills on public Miden testnet'
  },
  'swap-guardian': {
    config: 'playwright.swap.config.ts',
    grep: 'guardian maker',
    probes: ['dex', 'guardian'],
    describe: 'a guardian-co-signed PSWAP maker order against a hosted testnet guardian'
  }
};

const USAGE = `
Run the wallet's bridge and swap E2E against real infrastructure:
the hosted Epoch solver, the AggLayer bridge, Sepolia, and public Miden testnet.

  yarn e2e:real --suite <name> [options]

Suites
${Object.entries(SUITES)
  .map(([name, s]) => `  ${name.padEnd(21)} ${s.describe}`)
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
  --preflight-only          probe the services and exit; build and run nothing
  --skip-build              reuse the existing dist/ (it must match --network)
  --headed                  run the browser headed
  --grep <pattern>          further narrow the tests within the suite
  -h, --help                this message

No suite here is secret-gated. Bridge-out is solver-fulfilled and swap is
Miden-side, so neither signs on EVM and neither needs a key; --sepolia-key is
accepted so a funded account's gas and test-USDC balance can be READ ahead of a
suite that does sign. Bridge-IN would be that suite, and it
is not here: it cannot run on the extension, whose COEP isolation for the WASM
prover blocks WalletConnect's cross-origin requests.
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

/**
 * Retries for a suite. One by default, to absorb a transient blip on shared
 * infrastructure - but zero for a suite whose test performs a non-idempotent
 * real-money mutation, where a retry spends it again.
 */
export function suiteRetries(suite) {
  return suite.retries ?? 1;
}

/**
 * Combine the suite's own route filter with an operator `--grep` into a single
 * pattern that requires BOTH.
 *
 * Playwright collapses repeated `--grep` to the last one, so the two cannot be
 * passed as separate flags: the suite's filter would be discarded without a
 * word, and a narrowing flag would silently widen the run onto specs that spend
 * real money. Lookaheads match anywhere in the title, which is what each pattern
 * did on its own.
 */
export function composeGrep(suiteGrep, userGrep) {
  if (!suiteGrep) return userGrep;
  if (!userGrep) return suiteGrep;
  return `(?=.*${suiteGrep})(?=.*${userGrep})`;
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
 * Report something the run does not depend on.
 *
 * An advisory probe cannot fail the preflight, so counting it among the checks
 * would inflate a number whose only meaning is "things that can stop the run".
 * These print with a different marker and stay out of `results`.
 */
function note(label, detail) {
  console.log(`  · ${label.padEnd(34)} ${detail}`);
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
  const { status, body } = await getJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    },
    timeoutMs
  );
  if (status !== 200) throw new Error(`${method}: HTTP ${status}`);
  if (body?.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  // An absent `result` is not an empty answer, it is a reply this code could not
  // read - a proxy error page, a rate-limit body. Returning undefined let
  // probeSepoliaContracts measure `String(undefined)` as 3.5 bytes of contract
  // and pass, and let probeSepolia report "head #NaN" as a success.
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new Error(`${method}: reply carried no result`);
  }
  return body.result;
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
    return note(
      'Epoch gasless relayer',
      ok ? `enabled for Sepolia (${body.relayerAddress})` : 'not available for Sepolia'
    );
  } catch (err) {
    return note('Epoch gasless relayer', `unknown: ${err.message}`);
  }
}

/**
 * The priced output amount in a quote reply, or undefined when there is none.
 *
 * Exported for test: a reply can be `success: true` and still carry no route, or
 * carry a zero amount, and neither is a quote this gate should pass.
 */
export function pricedAmountFrom(res) {
  const raw = res?.path?.[0]?.[0]?.[2]?.[1]?.token?.amount;
  if (raw === undefined || raw === null) return undefined;
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return undefined;
  }
  return value > 0n ? raw : undefined;
}

/**
 * The check that matters. Ask the live solver for the same quote the Fast route
 * asks for and require a priced route back.
 *
 * `/checkIfDepositNeeded` prices the intent from its MANDATE; the surrounding
 * compact (nonce, id, lockTag) is not read for a quote - the request carries
 * `sponsorSignature: "0x"` and `isRegisteredOnchain: false`. So this mirrors the
 * mandate `buildEpochTaskDataParams` produces and leaves the rest well-formed
 * but nominal, which keeps the probe free of the SDK (whose ESM entry needs a
 * bundler) without weakening what is being asserted.
 */
async function probeEpochQuote(epochUrl, faucetId) {
  // Loaded inside the try with every other failure mode: this is a deep subpath
  // of a sub-1.0 dependency, and a resolution failure here must read as one
  // failed check, not as an exception that kills the preflight before any
  // check prints.
  let ARBITER_ADDRESS;
  try {
    ({ ARBITER_ADDRESS } = await import('@epoch-protocol/epoch-commons-sdk/dist/constants/contractAddresses.js'));
  } catch (err) {
    return record(false, 'Epoch live quote', `epoch-commons-sdk did not load: ${err.message}`);
  }

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
    // success:true with no priced leg is not a quote. The point of this gate is
    // that the solver will PRICE the intent, so an absent, unparseable or zero
    // amount fails it. The parse lives in pricedAmountFrom so it is testable -
    // an earlier pass added that helper and left this caller on its own inline
    // copy, which made the helper's tests prove nothing about this gate.
    const out = pricedAmountFrom(res);
    const filler = res?.path?.[0]?.[0]?.[1]?.[0]?.name;
    if (out === undefined) {
      return record(
        false,
        'Epoch live quote',
        `answered success but carried no priced route: ${JSON.stringify(res).slice(0, 160)}`
      );
    }
    return record(true, 'Epoch live quote', `1.0 in -> ${formatUnits(out, 18)} USDC out via ${filler ?? 'solver'}`);
  } catch (err) {
    return record(false, 'Epoch live quote', `request failed: ${err.message}`);
  }
}

/**
 * The in-protocol DEX quote service (`getSwapEta`, src/lib/miden/swap/tokens.ts).
 *
 * INFORMATIONAL, never a gate. The swap suite creates its own faucets and fills
 * between the two wallets it drives, so it never asks this service anything -
 * but it is what the PRODUCT shows a user as the swap ETA and price, and main CI
 * never touches it. A run is the cheapest moment to notice it has gone.
 *
 * `canFill: false` is reported rather than failed: it means no filler is offering
 * that pair right now, which is a fact about testnet liquidity, not about the
 * wallet.
 */
async function probeSwapQuoteService() {
  const BASE = 'https://35-175-40-181.sslip.io';
  // IMIDEN and IUSDT from the shipped registry, as hex - the service rejects
  // bech32. Resolved through the SDK rather than pasted so a registry change
  // cannot leave this probe quietly asking about a token nobody trades.
  let offered;
  let requested;
  try {
    const { AccountId } = await import('@miden-sdk/miden-sdk');
    offered = AccountId.fromBech32('mtst1arqxg9er3xclayt95nud82jnpggl9azj').toString();
    requested = AccountId.fromBech32('mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr').toString();
  } catch (err) {
    return note('DEX quote service', `not checked (SDK load failed: ${err.message})`);
  }

  try {
    const query = new URLSearchParams({
      offered_faucet: offered,
      offered_amount: '100000000',
      requested_faucet: requested,
      requested_amount: '200000000'
    });
    const { status, body } = await getJson(`${BASE}/v1/swap-eta?${query}`);
    if (status !== 200) {
      return note('DEX quote service', `degraded: HTTP ${status} (the suite does not use it)`);
    }
    const fill = body?.canFill ? `fillable, eta ${body.estimatedSeconds}s` : 'priced, no filler offering';
    return note('DEX quote service', `${fill}, price ${body?.marketPrice}`);
  } catch (err) {
    return note('DEX quote service', `unreachable: ${err.message} (the suite does not use it)`);
  }
}

/**
 * The hosted guardian the swap-guardian scenario co-signs with. A gate, because
 * that spec cannot do anything without it.
 */
async function probeGuardian(network) {
  // Resolve exactly as swap-guardian.spec.ts does, so the preflight cannot
  // approve one operator while the run uses another.
  // `??`, not `||`: the spec uses `??`, and the two diverge on an empty-string
  // override - which would have the preflight approve a host the run never uses.
  const url = process.env.GUARDIAN_URL ?? GUARDIAN_URL[network];
  if (!url) return record(false, 'Guardian', `no hosted guardian known for network "${network}"`);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    return record(res.status < 500, 'Guardian', `${url} answered HTTP ${res.status}`);
  } catch (err) {
    return record(false, 'Guardian', `${url} unreachable: ${err.message}`);
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

async function probeFundedKey(sepoliaRpc, privateKey, minEth) {
  let viem;
  let accounts;
  try {
    viem = await import('viem');
    accounts = await import('viem/accounts');
  } catch (err) {
    return record(false, 'Sepolia funded key', `viem not resolvable: ${err.message}`);
  }

  let account;
  try {
    account = accounts.privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  } catch {
    return record(false, 'Sepolia funded key', 'not a valid private key (expect 32 bytes hex)');
  }

  let wei;
  try {
    wei = BigInt(await rpc(sepoliaRpc, 'eth_getBalance', [account.address, 'latest']));
  } catch (err) {
    return record(false, 'Sepolia gas', `could not read ${account.address}: ${err.message}`);
  }
  const floor = viem.parseEther(minEth);
  if (wei < floor) {
    return record(
      false,
      'Sepolia gas',
      `${account.address} holds ${formatUnits(wei, 18)} ETH, below the ${minEth} ETH floor - fund it from a Sepolia faucet`
    );
  }
  record(true, 'Sepolia gas', `${account.address} holds ${formatUnits(wei, 18)} ETH`);

  // Reported, never topped up. A preflight observes; it does not write. The
  // route's USDC does mint permissionlessly, so a suite that needs a balance can
  // mint its own - but no suite here signs on EVM, so minting during preflight
  // would be an external mutation with no consumer.
  // C-10: advisory. This can never gate a run, so it is a note(), not a record().
  try {
    const balance = BigInt(
      await rpc(sepoliaRpc, 'eth_call', [
        { to: SEPOLIA_USDC, data: `0x70a08231${account.address.slice(2).padStart(64, '0')}` },
        'latest'
      ])
    );
    return note('Sepolia test USDC', `${formatUnits(balance, 18)} USDC held`);
  } catch (err) {
    return note('Sepolia test USDC', `not read: ${err.message}`);
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

export function run(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

    // 'error' fires INSTEAD of 'close' when the spawn itself fails, so a
    // listener on 'close' alone leaves this promise pending forever and hangs
    // the script on something as ordinary as yarn not being on PATH.
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    };

    // No signal forwarding, deliberately, and this is a decision not an omission.
    //
    // Cancelling the wrapper can orphan the child tree when the signal is sent to
    // this PID alone (`kill <pid>`); a tty's Ctrl-C reaches the whole foreground
    // process group and does not have that problem. Forwarding it correctly needs
    // `detached: true` plus `process.kill(-pid)` so the signal reaches the
    // grandchildren (Playwright's workers and browsers), which changes this
    // wrapper's job-control and stdio semantics.
    //
    // Four attempts to do it without that were each found broken by review: a
    // one-shot handler that suppressed node's default exit; an escalation that
    // killed only the launcher and exited; a removal that dropped SIGINT and
    // SIGTERM together; and a `once` version that leaves the next child unarmed
    // and still cannot reach grandchildren. It is a developer convenience, not a
    // correctness property of any test, so it is tracked as a follow-up rather
    // than guessed at again. To be exact about the baseline: this wrapper is new
    // in this change, so there is no prior behaviour to regress from - what is
    // true is that no test's correctness depends on cancellation, and each
    // attempt so far has been worse than none.

    child.on('error', err => {
      console.error(`✗ could not start ${command}: ${err.message}`);
      finish(1);
    });
    child.on('close', finish);
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

  console.log(`\nSuite    ${opts.suite} - ${suite.describe}`);
  console.log(`Network  ${opts.network}`);
  if (suite.probes?.includes('epoch')) console.log(`Epoch    ${opts.epochUrl}`);
  if (suite.probes?.includes('sepolia')) console.log(`Sepolia  ${opts.sepoliaRpc}`);
  console.log('');
  console.log('Preflight');

  // The Miden chain and its faucet are common to every suite: the faucet grant is
  // what pays fees for each fresh account, so a dead faucet fails the run at
  // funding rather than at the assertion.
  await probeMidenNode(opts.network);
  await probeMidenFaucet(opts.network);

  // Keyed on what the suite actually talks to, not on which Playwright config it
  // happens to share: both bridge routes use one config, but only the Epoch route
  // asks the solver anything.
  const needs = suite.probes ?? [];
  if (needs.includes('epoch')) {
    await probeEpochHealth(opts.epochUrl);
    // The spec mints a throwaway faucet per run, so the probe asks about one too:
    // it must reflect what the suite will actually request, not a friendlier token.
    await probeEpochQuote(opts.epochUrl, '0xabcdefabcdefabcdefabcdefabcdef');
  }
  if (needs.includes('sepolia')) {
    await probeSepolia(opts.sepoliaRpc);
    await probeSepoliaContracts(opts.sepoliaRpc);
  }
  if (needs.includes('guardian')) await probeGuardian(opts.network);
  // Only for a suite that actually talks to Sepolia: a key handed to a swap run
  // must not make Sepolia's availability decide whether that run happens.
  if (needs.includes('sepolia') && opts.sepoliaKey) {
    await probeFundedKey(opts.sepoliaRpc, opts.sepoliaKey, opts.minEth);
  }

  // Advisory, printed with `·` and never counted: these report services the
  // PRODUCT depends on and main CI never touches, but no suite here asks them
  // anything, so neither may decide whether a run happens.
  if (needs.includes('epoch')) await probeEpochGasless(opts.epochUrl);
  if (needs.includes('dex')) await probeSwapQuoteService();

  const failed = results.filter(r => !r.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`✗ preflight failed (${failed.length}/${results.length}): ${failed.map(f => f.label).join(', ')}`);
    console.error('  Nothing was built or run - fix the above and re-run.\n');
    return 1;
  }
  console.log(`✓ preflight passed (${results.length} checks)\n`);
  if (opts.preflightOnly) return 0;

  const env = {
    E2E_NETWORK: opts.network,
    E2E_REAL_EPOCH: 'true',
    // GUARDIAN_URL is deliberately NOT injected: swap-guardian.spec.ts resolves
    // it from the run's own environment record, so injecting it here would make
    // this table a second owner of the same fact. The table below stays because
    // probeGuardian reads it to decide what to probe.
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
      console.error('\n✗ build failed - not running the suite.\n');
      return code;
    }
  }

  const args = ['playwright', 'test', '--config', suite.config, `--retries=${suiteRetries(suite)}`];
  // ONE --grep, always. Playwright keeps only the last one it is given, so
  // passing the suite's filter and the operator's as two flags silently drops
  // the suite's - and `--suite bridge-out-agglayer --grep 'Fast Epoch'` would
  // then run the real-money Epoch spec the suite exists to exclude. Lookaheads
  // are how two patterns become one that requires both.
  const grep = composeGrep(suite.grep, opts.grep);
  if (grep) args.push('--grep', grep);
  if (suite.grepInvert) args.push('--grep-invert', suite.grepInvert);
  if (opts.headed) args.push('--headed');

  console.log(`\nRunning: yarn ${args.join(' ')}\n`);
  return run('yarn', args, env);
}

// Only when run as a command. Importing this file (a test does) must not start a
// preflight - the same guard scripts/validate-update-manifest.mjs uses.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
}
