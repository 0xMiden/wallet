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

import { spawn, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const SEPOLIA_CHAIN_ID = 11155111;
/** Epoch's virtual chain id for a Miden leg - src/lib/epoch/config.ts. */
const MIDEN_CHAIN_ID = 999999999;

/** The Compact, pinned in the Epoch SDK. Everything else the probes ask about comes from the config document. */
const SEPOLIA_COMPACT = '0x00000000000000171ede64904551eeDF3C6C9788';
/** Where wallets read `<network>.json` (0xMiden/wallet-config, branch main) - src/lib/remote-config/source.ts. */
const PUBLISHED_CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';

/**
 * The testnet rollup id: the network id the AggLayer indexer files every Miden -> EVM exit under, and the one the
 * wallet's Slow bridge-out looks its deposit up by. The wallet derives it from the bridge account the config document
 * names (`agglayer::bridge::network_id`, src/lib/remote-config/derive.ts); this probe reads no Miden storage, so it
 * holds the testnet's value: 73 since the testnet bridge moved to rollup 73 (wallet-config testnet.json version 2).
 * The golden exits in src/lib/agglayer/b2agg/exit-hash.vectors.json predate that move and are filed under 86.
 */
export const AGGLAYER_MIDEN_NETWORK_ID = 73;

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

/**
 * Arc Testnet and Circle's xReserve as the usdcx suites use them. The runner reads no TypeScript at import time, so
 * these copy src/lib/usdcx/constant.ts and playwright/e2e/helpers/usdcx-constants.ts; e2e-real.test.ts pins each copy
 * to both.
 */
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_XRESERVE = '0x008888878f94C0d87defdf0B07f46B93C1934442';
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const ARC_CIRCLE_DOMAIN = 26;
export const USDCX_REMOTE_DOMAIN = 10007;
export const USDCX_DECIMALS = 6;
export const XRESERVE_API_TESTNET = 'https://xreserve-api-testnet.circle.com';
/** Emits the AttestationUsed log the round trip's payout gate reads. */
export const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
/** arc.io last: it is the wallet's own Arc RPC (the burn snapshot and the payout confirmation), so the harness spares it. */
export const DEFAULT_ARC_RPCS = [
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
  'https://rpc.testnet.arc.io'
];
/** A 1 USDCx burn plus the 1 USDCx its fees may take: BURN_UNITS + GRANT_MARGIN_UNITS. */
export const USDCX_GRANT_FLOOR_UNITS = 2_000_000n;
/** The faucet tier every usdcx wallet asks for by amount: GRANT_UNITS, 10 USDCx. */
export const USDCX_GRANT_UNITS = 10_000_000n;
/** One 0.001 USDC deposit plus its Arc gas reserve: DEPOSIT_UNITS + GAS_RESERVE_UNITS. */
export const USDCX_FUNDED_KEY_FLOOR_UNITS = 21_000n;
/** R21: the one Arc key every usdcx suite burns to and deposits from; usdcx-constants.ts names the same file. */
export const HARNESS_ARC_KEY_FILE = path.join(os.homedir(), '.miden-e2e', 'arc-keys', 'harness.json');
/** One usdcx run at a time (R21). Beside arc-keys, not in it, so a sweep over the key files never reads it. */
export const USDCX_RUN_LOCK = path.join(os.homedir(), '.miden-e2e', 'usdcx-run.lock');
const ARC_SELECTORS = {
  paused: '0x5c975abb',
  domainDepositsPaused: '0x4a1b13ea',
  domainWithdrawalsPaused: '0xe9cafc83',
  getRemoteToken: '0xb3467549',
  gatewayMinter: '0x0f41efea',
  isRemoteDomainRegistered: '0xf54a69c3',
  balanceOf: '0x70a08231'
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
    probes: ['sepolia', 'agglayer'],
    describe: 'Miden testnet -> real AggLayer bridge (Miden leg asserted)'
  },
  'bridge-out': {
    config: 'playwright.bridge.config.ts',
    grep: 'bridge-out',
    probes: ['epoch', 'sepolia', 'agglayer'],
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
  },
  // The usdcx suites spend real value end to end: a public faucet grant, a burn Circle pays out, a deposit Circle's
  // relayer mints. A retry spends each again on a second fresh Guardian, so none gets one. Each grep selects exactly
  // one describe of playwright/e2e/tests/usdcx, which e2e-real.test.ts checks against Playwright's own listing.
  // `headlessByDefault`: the test run gets E2E_HEADLESS=1 unless --headed, because BridgeIntentWatcher, which moves
  // the burn and deposit phases, polls only while its page reads visible, and new-headless Chromium keeps it so.
  usdcx: {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx round trip',
    probes: ['usdcx', 'usdcx-guardian', 'grant', 'arc-payout'],
    networks: ['testnet'],
    usdcx: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'fresh Guardian: faucet grant, UI burn to the harness Arc key, Circle payout, deposit back'
  },
  'usdcx-in': {
    config: 'playwright.usdcx.config.ts',
    grep: 'funded Arc key',
    probes: ['usdcx', 'usdcx-guardian', 'funded-key'],
    networks: ['testnet'],
    usdcx: true,
    arcKey: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'fresh Guardian: deposit from the harness Arc key (or --arc-key), attest, mint, receive'
  },
  'usdcx-burn': {
    config: 'playwright.usdcx.config.ts',
    grep: 'USDCx burn through the Send UI',
    probes: ['usdcx', 'usdcx-guardian', 'grant', 'arc-payout'],
    networks: ['testnet'],
    usdcx: true,
    headlessByDefault: true,
    retries: 0,
    describe: 'standard and Guardian wallets: faucet grant, UI burn to the harness Arc key, Circle payout'
  }
};

const USAGE = `
Run the wallet's bridge, swap and USDCx E2E against real infrastructure:
the hosted Epoch solver, the AggLayer bridge, Sepolia, Arc Testnet, Circle's
xReserve, the hosted Guardian and public Miden testnet.

  yarn e2e:real --suite <name> [options]

Suites
${Object.entries(SUITES)
  .map(([name, s]) => `  ${name.padEnd(21)} ${s.describe}`)
  .join('\n')}

Options
  --suite <name>            which suite to run (required)
  --network <net>           testnet | devnet            (default: testnet; usdcx suites: testnet only)
  --sepolia-rpc <url>       Sepolia RPC                 (default: a public node)
  --sepolia-key <0x...>     funded Sepolia EOA key, for suites with a signed EVM leg
                            (env: E2E_SEPOLIA_PRIVATE_KEY)
  --arc-rpc <url>           Arc Testnet RPC the usdcx suites try first, then drpc,
                            QuickNode and arc.io (env: E2E_ARC_RPC_URL)
  --arc-key <0x...>         usdcx-in only: deposit from this funded Arc Testnet key
                            instead of the harness key; only its address is printed
                            (env: E2E_ARC_PRIVATE_KEY)
  --min-eth <amount>        preflight gas floor in ether (default: 0.02)
  --preflight-only          probe the services and exit; build and run nothing
  --agglayer-indexer-only   probe only the AggLayer indexer's Miden exit filing and exit;
                            takes no --suite, reads the config document, no URL or key
  --skip-build              reuse the existing dist/ (it must match --network);
                            refused for the usdcx suites
  --headed                  run the browser headed (the usdcx suites run headless otherwise)
  --grep <pattern>          further narrow the tests within the suite
  -h, --help                this message

The Epoch allocator, the Sepolia USDC, the AggLayer bridge and its indexer come
from the network's config document, read as the wallet reads it:
MIDEN_REMOTE_CONFIG_URL when set, else the published 0xMiden/wallet-config.

The usdcx suites need no secret. usdcx and usdcx-burn burn to one harness Arc
key, ~/.miden-e2e/arc-keys/harness.json (mode 0600), which the first real run
creates; the round trip and usdcx-in deposit from it and Circle's payouts refill
it, so no run needs Circle's faucet. usdcx-in needs the key to hold 0.021 USDC,
or an --arc-key that does.

Bridge-out is solver-fulfilled and swap is Miden-side, so neither signs on EVM;
--sepolia-key is accepted so a funded account's gas and test-USDC balance can be
READ ahead of a suite that does sign.

usdcx-in runs bridge-in on the extension with a deposit signed in Node, not
through WalletConnect, which the extension's COEP isolation for the WASM prover
blocks. Every usdcx suite builds, after installing the miden-client CLI pinned
in package.json unless MIDEN_CLIENT_BIN is set (git and cargo; a cold cache
takes up to 35 min). A lock, ~/.miden-e2e/usdcx-run.lock, lets one usdcx run go
at a time: a second refuses, naming the lock and the pid holding it, and the
next run removes a lock whose run died.
`;

// ── args ────────────────────────────────────────────────────────────────────

/**
 * Exported variables a usdcx run refuses, each with why. An E2E build bakes the first three in, and nothing a usdcx
 * spec runs reads GUARDIAN_URL, so each would move what the run checks, or seem to, without a word. Refused by name.
 */
const USDCX_REFUSED_EXPORTS = {
  E2E_EVM_RPC_URL: 'an E2E build reads Sepolia, Base Sepolia and Arbitrum Sepolia through it',
  MIDEN_E2E_USDCX_CHAIN: 'an E2E build then starts a bridge-in from Sepolia instead of Arc Testnet',
  MIDEN_FEE_FAUCET_ID: 'an E2E build then pins the fee asset instead of discovering it from the node',
  GUARDIAN_URL: 'the usdcx suites always use the hosted Guardian of --network, so it would silently not apply'
};
const ARC_KEY_PATTERN = /^(0x)?[0-9a-f]{64}$/i;

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = {
    suite: undefined,
    network: 'testnet',
    sepoliaRpc: process.env.E2E_SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC,
    sepoliaKey: process.env.E2E_SEPOLIA_PRIVATE_KEY,
    arcRpc: process.env.E2E_ARC_RPC_URL,
    arcKey: process.env.E2E_ARC_PRIVATE_KEY,
    refusedExports: Object.keys(USDCX_REFUSED_EXPORTS).filter(name => process.env[name] !== undefined),
    minEth: '0.02',
    preflightOnly: false,
    agglayerIndexerOnly: false,
    skipBuild: false,
    headed: false,
    grep: undefined
  };
  const helpNames = ['-h', '--help'];
  const booleanFlags = {
    '--preflight-only': 'preflightOnly',
    '--agglayer-indexer-only': 'agglayerIndexerOnly',
    '--skip-build': 'skipBuild',
    '--headed': 'headed'
  };
  const takesValue = {
    '--suite': 'suite',
    '--network': 'network',
    '--sepolia-rpc': 'sepoliaRpc',
    '--sepolia-key': 'sepoliaKey',
    '--arc-rpc': 'arcRpc',
    '--arc-key': 'arcKey',
    '--min-eth': 'minEth',
    '--grep': 'grep'
  };
  // A flag never takes another option as its value: `--sepolia-rpc
  // $UNSET --preflight-only` would otherwise store the option as the URL and
  // build and run a suite the operator asked only to preflight. A Set, so an
  // inherited name such as `constructor` stays a valid value.
  // The wallet reads its Epoch hosts from the config document, so a host given here would be preflighted while the
  // wallet used another.
  const retired = ['--epoch-url', '--epoch-positions-url'];
  const optionNames = new Set([...helpNames, ...retired, ...Object.keys(booleanFlags), ...Object.keys(takesValue)]);
  // `--sepolia-key=<key>` names an option too, so it is never a value either:
  // whatever later refused or ran that value would print the key.
  const namesAnOption = token => optionNames.has(token.split('=', 1)[0]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (helpNames.includes(arg)) return { help: true };
    if (retired.includes(arg)) {
      fail(`${arg} is gone: the wallet reads the Epoch hosts from the network's config document`);
    }
    if (Object.hasOwn(booleanFlags, arg)) opts[booleanFlags[arg]] = true;
    else if (Object.hasOwn(takesValue, arg)) {
      const value = argv[++i];
      // A quoted unset variable arrives as '': `--grep "$UNSET"` would otherwise
      // drop the operator's narrowing and widen a real-money run.
      if (value === undefined || value === '' || namesAnOption(value)) fail(`${arg} needs a value`);
      // A later --grep or --suite would silently replace the operator's narrowing
      // and widen a real-money run. Neither refusal prints a value.
      if (seen.has(arg)) fail(`${arg} given more than once`);
      seen.add(arg);
      opts[takesValue[arg]] = value;
    } else if (arg.includes('=')) {
      fail(`unknown argument: ${arg.split('=', 1)[0]}=<value> (pass the value as its own argument)`);
    } else fail(`unknown argument: ${arg}`);
  }
  // A flag is refused where it would not apply; the same value exported is left alone: a usdcx build unsets it, and a
  // usdcx test gets the run's own key over it (childEnvironments).
  opts.arcRpcFlag = seen.has('--arc-rpc');
  opts.arcKeyFlag = seen.has('--arc-key');
  if (opts.agglayerIndexerOnly) {
    // This probe reads the config document and no URL or key, so the empty-variable refusals below do not apply:
    // E2E Bridge sets E2E_SEPOLIA_RPC_URL from an optional secret, which is empty when the secret is unset.
    if (opts.suite !== undefined) fail('--agglayer-indexer-only probes one service and takes no --suite');
    return opts;
  }
  // A flag is never '', so an empty URL here was exported empty and would be
  // probed and built in. After the loop, so a flag overrides it and -h still works.
  if (opts.sepoliaRpc === '') fail('E2E_SEPOLIA_RPC_URL is set but empty');
  for (const name of ['EPOCH_ALLOCATOR_URL', 'EPOCH_POSITIONS_URL']) {
    if (process.env[name] !== undefined) {
      fail(`${name} is set, but the wallet reads the Epoch hosts from the network's config document: unset it`);
    }
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
 * did on its own. Each pattern is grouped so the `.*` reaches every alternative:
 * without the group, (?=.*a|b) tests b only where the match starts.
 *
 * Each given pattern must compile on its own, or this throws: one that does not
 * can close the group it is spliced into, and `x))|((` then composes into a
 * valid pattern with an empty alternative that matches every title.
 */
export function composeGrep(suiteGrep, userGrep) {
  assertRegExp(suiteGrep, "the suite's grep");
  assertRegExp(userGrep, '--grep');
  if (!suiteGrep) return userGrep;
  if (!userGrep) return suiteGrep;
  return `(?=.*(?:${suiteGrep}))(?=.*(?:${userGrep}))`;
}

function assertRegExp(pattern, label) {
  if (!pattern) return;
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${pattern} - ${error.message}`);
  }
}

/**
 * Check parsed operator input in the order main() refuses it. Returns `{ error }`
 * with the refusal, or `{ suite, grep }`: the suite's record and its grep
 * composed with the operator's.
 *
 * Names are looked up as own properties, so `toString` or `constructor` is
 * refused as unknown instead of resolving to what Object.prototype carries.
 */
export function resolveOperatorInput(opts) {
  if (!opts.suite) return { error: `--suite is required. One of: ${Object.keys(SUITES).join(', ')}${USAGE}` };
  if (!Object.hasOwn(SUITES, opts.suite)) {
    return { error: `unknown suite "${opts.suite}". One of: ${Object.keys(SUITES).join(', ')}` };
  }
  const suite = SUITES[opts.suite];
  if (!Object.hasOwn(MIDEN_RPC, opts.network)) {
    return { error: `--network must be one of: ${Object.keys(MIDEN_RPC).join(', ')}` };
  }
  if (suite.networks && !suite.networks.includes(opts.network)) {
    return { error: `--suite ${opts.suite} runs on ${suite.networks.join(', ')} only` };
  }
  let grep;
  try {
    grep = composeGrep(suite.grep, opts.grep);
  } catch (error) {
    return { error: error.message };
  }
  if (!/^\d+(\.\d+)?$/.test(opts.minEth)) {
    return { error: `--min-eth must be a plain non-negative decimal amount of ether, got "${opts.minEth}"` };
  }
  // The key itself is never echoed.
  if (suite.probes?.includes('sepolia') && opts.sepoliaKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(opts.sepoliaKey)) {
    return {
      error:
        'the Sepolia key (--sepolia-key or E2E_SEPOLIA_PRIVATE_KEY) is not a valid private key: expect 32 bytes of hex, with an optional 0x prefix'
    };
  }
  const usdcxProblem = usdcxInputProblem(opts, suite);
  if (usdcxProblem !== undefined) return { error: usdcxProblem };
  return { suite, grep };
}

/**
 * Why the input cannot run `suite`, for what only the usdcx suites read: the Arc flags, the refused exports and
 * --skip-build. No message carries a value: a key, or a URL whose path may hold one.
 */
function usdcxInputProblem(opts, suite) {
  if (!suite.usdcx) {
    if (opts.arcRpcFlag) return '--arc-rpc applies only to the usdcx suites';
    if (opts.arcKeyFlag) return '--arc-key applies only to --suite usdcx-in';
    return undefined;
  }
  // The build bakes the network and the E2E flags these suites depend on, so a reused dist/ proves nothing.
  if (opts.skipBuild) return `--skip-build is refused for --suite ${opts.suite}: it always builds`;
  const exported = (opts.refusedExports ?? []).find(name => Object.hasOwn(USDCX_REFUSED_EXPORTS, name));
  if (exported !== undefined) {
    return `${exported} is set, and --suite ${opts.suite} refuses it: ${USDCX_REFUSED_EXPORTS[exported]}. Unset it.`;
  }
  if (opts.arcRpc === '') return 'E2E_ARC_RPC_URL is set but empty';
  if (opts.arcRpc !== undefined && !isHttpUrl(opts.arcRpc)) {
    return 'the Arc RPC (--arc-rpc or E2E_ARC_RPC_URL) is not an http(s) URL';
  }
  if (!suite.arcKey) return opts.arcKeyFlag ? '--arc-key applies only to --suite usdcx-in' : undefined;
  // No key is fine here: usdcx-in then deposits from the harness key, or refuses after the lock (resolveArcKey).
  if (opts.arcKey === undefined) return undefined;
  if (opts.arcKey === '') return 'E2E_ARC_PRIVATE_KEY is set but empty';
  if (!ARC_KEY_PATTERN.test(opts.arcKey)) {
    return 'the Arc key (--arc-key or E2E_ARC_PRIVATE_KEY) is not a valid private key: expect 32 bytes of hex, with an optional 0x prefix';
  }
  return undefined;
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

async function getJson(url, init = {}, timeoutMs = 20_000, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
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
  return { status: res.status, body, headers: res.headers };
}

/** Retry-After in milliseconds when it is a whole number of seconds; a date, or none, is undefined. */
function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after')?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) * 1_000 : undefined;
}

async function rpc(url, method, params, { timeoutMs = 20_000, fetchImpl } = {}) {
  const { status, body, headers } = await getJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    },
    timeoutMs,
    fetchImpl
  );
  // The status, the JSON-RPC code and Retry-After ride on the error, so withRateLimitRetry can tell a rate limit
  // from a refusal.
  if (status !== 200) {
    throw Object.assign(new Error(`${method}: HTTP ${status}`), { status, retryAfterMs: retryAfterMs(headers) });
  }
  if (body?.error) {
    throw Object.assign(new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`), {
      code: body.error.code
    });
  }
  // An absent `result` is not an empty answer, it is a reply this code could not
  // read - a proxy error page, a rate-limit body. Returning undefined let
  // probeSepoliaContracts measure `String(undefined)` as 3.5 bytes of contract
  // and pass, and let probeSepolia report "head #NaN" as a success.
  if (body === null || typeof body !== 'object' || !('result' in body)) {
    throw new Error(`${method}: reply carried no result`);
  }
  return body.result;
}

const RATE_LIMIT_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 10_000;
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `call`, asked again at most three times when it fails on a rate limit (HTTP 429 or JSON-RPC -32005), each time
 * after the wait the limit named, capped at 10 s, else 1 s. arc.io and Circle answer intermittent 429s a preflight
 * must not read as an outage; any other failure is thrown at once, so a real refusal costs no wait.
 */
async function withRateLimitRetry(call, { sleep = sleepFor } = {}) {
  for (let retry = 0; ; retry++) {
    try {
      return await call();
    } catch (err) {
      const limited = err?.status === 429 || err?.code === -32005;
      if (!limited || retry >= RATE_LIMIT_RETRIES) throw err;
      await sleep(Math.min(err.retryAfterMs ?? 1_000, RETRY_AFTER_CAP_MS));
    }
  }
}

/** One Arc JSON-RPC call through the bounded rate-limit retry. Exported for test. */
export function arcRpc(url, method, params, deps = {}) {
  return withRateLimitRetry(() => rpc(url, method, params, deps), deps);
}

/** A Circle GET through the bounded rate-limit retry; a 429 is thrown so the retry sees it. Exported for test. */
export function circleGet(url, deps = {}) {
  return withRateLimitRetry(async () => {
    const reply = await getJson(url, {}, 20_000, deps.fetchImpl);
    if (reply.status === 429) {
      throw Object.assign(new Error(`${url} answered HTTP 429`), {
        status: 429,
        retryAfterMs: retryAfterMs(reply.headers)
      });
    }
    return reply;
  }, deps);
}

// ── config document ─────────────────────────────────────────────────────────

/** What each probe group asks about, by the document field it comes from. */
const DOCUMENT_FIELDS = {
  epoch: ['allocatorUrl', 'evmUsdc'],
  sepolia: ['evmUsdc', 'l1Bridge'],
  agglayer: ['indexerUrl']
};
const FIELD_PATHS = {
  allocatorUrl: 'epoch.allocatorUrl',
  evmUsdc: 'epoch.evmUsdc',
  l1Bridge: 'agglayer.l1Bridge',
  indexerUrl: 'agglayer.indexerUrl'
};
const URL_FIELDS = new Set(['allocatorUrl', 'indexerUrl']);

// Reads `{ body, network, allowLocalHttp }` on stdin and prints what the wallet's parser makes of the body.
const PARSE_SCRIPT = `
const { parseBridgeConfig } = require('./src/lib/remote-config/schema.ts');
let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  const { body, network, allowLocalHttp } = JSON.parse(input);
  process.stdout.write(JSON.stringify(parseBridgeConfig(body, network, { allowLocalHttp })));
});
`;

/**
 * Where the wallet this run builds reads its config: an E2E build takes MIDEN_REMOTE_CONFIG_URL when it is set,
 * the published repo otherwise (src/lib/remote-config/source.ts).
 */
function configDocumentUrl(network) {
  return `${(process.env.MIDEN_REMOTE_CONFIG_URL || PUBLISHED_CONFIG_URL).replace(/\/+$/, '')}/${network}.json`;
}

/**
 * Run `script` in a child under ts-node, transpiling only, so the preflight reads the TypeScript the wallet and the
 * harness ship rather than a copy kept here. Returns its stdout; throws with the first line it wrote to stderr.
 */
function tsNodeChild(script, { input, args = [], timeoutMs = 60_000 } = {}) {
  const res = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      NODE_PATH: 'src',
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}'
    },
    timeout: timeoutMs
  });
  if (res.status !== 0) throw new Error(res.error?.message ?? res.stderr.trim().split('\n')[0]);
  return res.stdout;
}

/**
 * The document as the wallet's own parser reads it (src/lib/remote-config/schema.ts), or null where the wallet refuses
 * it, so the preflight never judges a document by rules of its own.
 */
function parseLikeTheWallet(body, network, allowLocalHttp) {
  let stdout;
  try {
    stdout = tsNodeChild(PARSE_SCRIPT, { input: JSON.stringify({ body, network, allowLocalHttp }) });
  } catch (err) {
    throw new Error(`could not be parsed: ${err.message}`);
  }
  return JSON.parse(stdout);
}

/**
 * The values the `needs` probe groups ask about, from a document the wallet's parser accepted: Sepolia, and each
 * field present. Throws naming the first problem. EVM addresses come back checksummed, as the wallet's getters send
 * them; the parser lowercases them.
 */
function configTargets(config, needs, getAddress) {
  if (config.evm.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`does not name Sepolia (${SEPOLIA_CHAIN_ID}) as evm.chainId`);
  }
  const read = {
    allocatorUrl: config.epoch.allocatorUrl,
    evmUsdc: config.epoch.evmUsdc,
    l1Bridge: config.agglayer.l1Bridge,
    indexerUrl: config.agglayer.indexerUrl
  };
  const targets = {};
  for (const field of new Set(needs.flatMap(probe => DOCUMENT_FIELDS[probe] ?? []))) {
    const value = read[field];
    if (value === undefined) throw new Error(`names no ${FIELD_PATHS[field]}`);
    targets[field] = URL_FIELDS.has(field) ? value : getAddress(value);
  }
  return targets;
}

/**
 * The probe targets from the network's config document, or null after recording why there are none. A GET that fails
 * or answers anything but 200 is asked again once before it counts, as the indexer probe does: E2E Bridge reads the
 * document on every push to main. A document that arrives is never asked for again, whether or not the wallet's parser
 * accepts it. `get` and `retryDelayMs` are injectable for test.
 *
 * Exported for test.
 */
export async function probeConfigDocument(network, needs, { get = getJson, retryDelayMs = 5_000 } = {}) {
  const url = configDocumentUrl(network);
  const ask = async () => {
    try {
      const reply = await get(url);
      return reply.status === 200 ? { reply } : { problem: `${url} answered HTTP ${reply.status}` };
    } catch (err) {
      return { problem: `${url} unreachable: ${err.message}` };
    }
  };
  let answer = await ask();
  if (answer.problem !== undefined) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    answer = await ask();
  }
  if (answer.problem !== undefined) {
    record(false, 'Config document', answer.problem);
    return null;
  }
  const { reply } = answer;
  try {
    // The wallet takes local http only from a document an E2E build serves itself (src/lib/remote-config/source.ts).
    const config = parseLikeTheWallet(reply.body, network, Boolean(process.env.MIDEN_REMOTE_CONFIG_URL));
    if (config === null) throw new Error('is a document the wallet refuses');
    const { getAddress } = await import('viem');
    const targets = configTargets(config, needs, getAddress);
    record(true, 'Config document', `${url} version ${config.version}`);
    return targets;
  } catch (err) {
    record(false, 'Config document', `${url} ${err.message}`);
    return null;
  }
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

async function probeMidenFaucet(network, { grant = false } = {}) {
  const base = MIDEN_FAUCET_API[network];
  if (!base) return record(false, 'Miden faucet API', `no endpoint known for network "${network}"`);
  let metadata;
  try {
    const { status, body } = await getJson(`${base}/get_metadata`);
    if (status !== 200) return record(false, 'Miden faucet API', `${base} answered HTTP ${status}`);
    metadata = body;
  } catch (err) {
    return record(false, 'Miden faucet API', `${base} unreachable: ${err.message}`);
  }
  // Every fresh E2E account takes a grant of the chain's native asset (USDCx on testnet) before its first
  // fee-charged transaction, so a dead faucet fails the run at funding, not at the assertion.
  record(true, 'Miden faucet API', `node ${metadata.version}, base_amount ${metadata.base_amount}`);
  return grant ? probeUsdcxGrant(metadata) : true;
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
async function probeEpochQuote(epochUrl, evmUsdc, faucetId) {
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
        tokenOut: evmUsdc,
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

// ── usdcx ───────────────────────────────────────────────────────────────────

const endpointHost = url => new URL(url).host;

/** The Arc RPCs a usdcx spec reads and writes through, in order, an operator's first. Exported for test. */
export function arcRpcEndpoints(override) {
  return override ? [override, ...DEFAULT_ARC_RPCS.filter(url => url !== override)] : [...DEFAULT_ARC_RPCS];
}

/** Calldata of `selector` over static arguments: a number as a uint, a 0x address, each left-padded to a word. */
function calldata(selector, ...args) {
  const words = args.map(arg => (typeof arg === 'number' ? arg.toString(16) : arg.slice(2).toLowerCase()));
  return selector + words.map(word => word.padStart(64, '0')).join('');
}

/** The one word an Arc view returns, lowercase. A revert's `0x` or a short answer throws, naming the view. */
async function arcView(url, to, data, name) {
  const word = await arcRpc(url, 'eth_call', [{ to, data }, 'latest']);
  if (typeof word !== 'string' || !/^0x[0-9a-f]{64}$/i.test(word)) {
    throw new Error(`${name} answered ${String(word).slice(0, 20)}, not one word`);
  }
  return word.toLowerCase();
}

const codeBytes = code => Math.max(0, (String(code).length - 2) / 2);

/**
 * Every Arc RPC a spec may use, by chain id and head. The specs fail over between them, so one healthy endpoint
 * passes; the first is returned, and every later Arc probe asks it alone, as one spec read cycle does.
 */
async function probeArcRpc(endpoints) {
  const states = [];
  let healthy;
  for (const url of endpoints) {
    const host = endpointHost(url);
    try {
      const chainId = Number(await arcRpc(url, 'eth_chainId', []));
      if (chainId !== ARC_TESTNET_CHAIN_ID) {
        states.push(`${host} reports chain ${chainId}`);
        continue;
      }
      states.push(`${host} #${Number(await arcRpc(url, 'eth_blockNumber', []))}`);
      if (healthy === undefined) healthy = url;
    } catch (err) {
      states.push(`${host} ${err.message}`);
    }
  }
  const detail =
    healthy === undefined
      ? `no endpoint serves chain ${ARC_TESTNET_CHAIN_ID}: ${states.join('; ')}`
      : states.join('; ');
  record(healthy !== undefined, 'Arc RPC', detail);
  return healthy;
}

/**
 * The deposit leg signs through the first healthy endpoint. An empty raw transaction costs nothing and tells an
 * endpoint that would relay a real one (it fails to decode `0x00`) from one that refuses the method or the plan,
 * which no read can show.
 */
async function probeArcWriteEndpoint(url) {
  const host = endpointHost(url);
  try {
    await arcRpc(url, 'eth_sendRawTransaction', ['0x00']);
    return record(false, 'Arc write endpoint', `${host} accepted an empty raw transaction`);
  } catch (err) {
    if (err.code !== undefined && /decod/i.test(err.message)) {
      return record(true, 'Arc write endpoint', `${host} takes raw transactions (it failed to decode 0x00)`);
    }
    return record(false, 'Arc write endpoint', `${host} refused eth_sendRawTransaction: ${err.message}`);
  }
}

/** The remote token xReserve names for USDCx, lowercase, or undefined after recording why there is none. */
async function probeXReserve(url) {
  const fail = detail => {
    record(false, 'xReserve', detail);
    return undefined;
  };
  try {
    if (codeBytes(await arcRpc(url, 'eth_getCode', [ARC_XRESERVE, 'latest'])) === 0) {
      return fail(`${ARC_XRESERVE} has no code on Arc Testnet`);
    }
    const registeredData = calldata(ARC_SELECTORS.isRemoteDomainRegistered, USDCX_REMOTE_DOMAIN);
    if (BigInt(await arcView(url, ARC_XRESERVE, registeredData, 'isRemoteDomainRegistered')) !== 1n) {
      return fail(`domain ${USDCX_REMOTE_DOMAIN} is not registered`);
    }
    const tokenData = calldata(ARC_SELECTORS.getRemoteToken, USDCX_REMOTE_DOMAIN, ARC_USDC);
    const remoteToken = await arcView(url, ARC_XRESERVE, tokenData, 'getRemoteToken');
    if (BigInt(remoteToken) === 0n) return fail(`getRemoteToken(${USDCX_REMOTE_DOMAIN}, USDC) is zero`);
    record(
      true,
      'xReserve',
      `domain ${USDCX_REMOTE_DOMAIN} registered at ${ARC_XRESERVE}, remote token ${remoteToken}`
    );
    return remoteToken;
  } catch (err) {
    return fail(`${endpointHost(url)}: ${err.message}`);
  }
}

async function probeXReservePause(url, withWithdrawals) {
  const views = [
    ['paused', calldata(ARC_SELECTORS.paused)],
    ['domainDepositsPaused', calldata(ARC_SELECTORS.domainDepositsPaused, USDCX_REMOTE_DOMAIN)],
    ...(withWithdrawals
      ? [['domainWithdrawalsPaused', calldata(ARC_SELECTORS.domainWithdrawalsPaused, USDCX_REMOTE_DOMAIN)]]
      : [])
  ];
  try {
    const set = [];
    for (const [name, data] of views) {
      if (BigInt(await arcView(url, ARC_XRESERVE, data, name)) !== 0n) set.push(name);
    }
    const names = views.map(([name]) => name).join(', ');
    return record(set.length === 0, 'xReserve pause', set.length === 0 ? `${names} false` : `${set.join(', ')} true`);
  } catch (err) {
    return record(false, 'xReserve pause', `${endpointHost(url)}: ${err.message}`);
  }
}

async function probeGatewayMinter(url) {
  try {
    const word = await arcView(url, ARC_XRESERVE, calldata(ARC_SELECTORS.gatewayMinter), 'gatewayMinter');
    const minter = `0x${word.slice(26)}`;
    if (minter !== GATEWAY_MINTER.toLowerCase()) {
      return record(false, 'Gateway minter', `xReserve names ${minter}, not ${GATEWAY_MINTER}`);
    }
    if (codeBytes(await arcRpc(url, 'eth_getCode', [GATEWAY_MINTER, 'latest'])) === 0) {
      return record(false, 'Gateway minter', `${GATEWAY_MINTER} has no code`);
    }
    return record(true, 'Gateway minter', `${GATEWAY_MINTER}, the emitter of the payout's AttestationUsed log`);
  } catch (err) {
    return record(false, 'Gateway minter', `${endpointHost(url)}: ${err.message}`);
  }
}

/** usdcx-in deposits from this key, the harness key or an operator's, so it must hold one deposit and its gas. */
async function probeArcFundedKey(url, arcKey) {
  const address = arcKey.address;
  try {
    const word = await arcView(url, ARC_USDC, calldata(ARC_SELECTORS.balanceOf, address), 'balanceOf');
    const balance = BigInt(word);
    const held = `${arcKey.role} key ${address} holds ${formatUnits(balance, USDCX_DECIMALS)} USDC`;
    if (balance < USDCX_FUNDED_KEY_FLOOR_UNITS) {
      const floor = formatUnits(USDCX_FUNDED_KEY_FLOOR_UNITS, USDCX_DECIMALS);
      const refill =
        arcKey.role === 'harness'
          ? "; refill it with yarn e2e:real --suite usdcx (each run's payout adds about 0.98 USDC), or pass " +
            '--arc-key with a funded key'
          : '';
      return record(false, 'Arc funded key', `${held}, below the ${floor} USDC one deposit and its gas need${refill}`);
    }
    return record(true, 'Arc funded key', held);
  } catch (err) {
    return record(false, 'Arc funded key', `could not read ${address}: ${err.message}`);
  }
}

/** Circle must attest deposits to Miden at the token xReserve names, from Arc's xReserve. */
async function probeCircleXReserveApi(remoteToken) {
  const url = `${XRESERVE_API_TESTNET}/v1/info`;
  try {
    const { status, body } = await circleGet(url);
    if (status !== 200) return record(false, 'Circle xReserve API', `${url} answered HTTP ${status}`);
    const remote = body?.remoteDomains?.find(domain => domain?.domain === USDCX_REMOTE_DOMAIN);
    const listed = (remote?.tokens ?? []).map(token => String(token?.remoteTokenIdentifier).toLowerCase());
    if (!listed.includes(remoteToken)) {
      const found = remote ? `domain ${USDCX_REMOTE_DOMAIN} with ${listed.join(', ') || 'no token'}` : 'no domain';
      return record(false, 'Circle xReserve API', `lists ${found}, not ${USDCX_REMOTE_DOMAIN} at ${remoteToken}`);
    }
    const source = body?.sourceDomains?.find(domain => domain?.domain === ARC_CIRCLE_DOMAIN);
    if (String(source?.contractAddress).toLowerCase() !== ARC_XRESERVE.toLowerCase()) {
      const at = source?.contractAddress ?? 'nothing';
      return record(false, 'Circle xReserve API', `names source ${ARC_CIRCLE_DOMAIN} at ${at}, not ${ARC_XRESERVE}`);
    }
    return record(
      true,
      'Circle xReserve API',
      `attests ${USDCX_REMOTE_DOMAIN} at the on-chain remote token, source ${ARC_CIRCLE_DOMAIN} at ${ARC_XRESERVE}`
    );
  } catch (err) {
    return record(false, 'Circle xReserve API', `${url} unreachable: ${err.message}`);
  }
}

// Discovers the node's native asset as the harness does, and encodes it as xReserve's remote token.
const NATIVE_ASSET_SCRIPT = `
const { discoverFeeFaucetId } = require('./playwright/e2e/helpers/fee-faucet.ts');
const { midenAccountHexToXReserveRecipient } = require('./src/lib/usdcx/recipient.ts');
discoverFeeFaucetId(process.argv[1]).then(
  id => process.stdout.write(JSON.stringify({ id, bytes32: midenAccountHexToXReserveRecipient(id) })),
  error => {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
);
`;

/** A grant pays the wallet's fees only when the faucet xReserve mints for is the chain's native asset. */
async function probeUsdcxNativeAsset(network, remoteToken) {
  try {
    const stdout = tsNodeChild(NATIVE_ASSET_SCRIPT, { args: [MIDEN_RPC[network]], timeoutMs: 90_000 });
    const { id, bytes32 } = JSON.parse(stdout);
    if (String(bytes32).toLowerCase() !== remoteToken) {
      return record(false, 'USDCx native asset', `${id} encodes as ${bytes32}, not the remote token ${remoteToken}`);
    }
    return record(true, 'USDCx native asset', `${id}, the remote token xReserve mints`);
  } catch (err) {
    return record(false, 'USDCx native asset', `not discovered: ${err.message}`);
  }
}

/**
 * The hosted Guardian a usdcx spec co-signs with, as the spec records it: `/status` ok for --network, and the ECDSA
 * commitment the spec checks the account's auth against. GUARDIAN_URL is refused for these suites, so the table
 * alone names it.
 */
async function probeUsdcxGuardian(network) {
  const url = GUARDIAN_URL[network];
  try {
    const status = await getJson(`${url}/status`);
    if (status.status !== 200 || status.body?.status !== 'ok') {
      const reported = status.body?.status ?? 'none';
      return record(false, 'Guardian identity', `${url}/status answered HTTP ${status.status}, status ${reported}`);
    }
    if (status.body.environment !== network) {
      return record(false, 'Guardian identity', `${url} serves ${status.body.environment}, not ${network}`);
    }
    const key = await getJson(`${url}/pubkey?scheme=ecdsa`);
    const commitment = String(key.body?.commitment);
    if (
      key.status !== 200 ||
      !/^0x[0-9a-f]{64}$/i.test(commitment) ||
      !/^0x[0-9a-f]+$/i.test(String(key.body?.pubkey))
    ) {
      return record(false, 'Guardian identity', `${url}/pubkey?scheme=ecdsa carried no ECDSA commitment and pubkey`);
    }
    const { version, git_commit: gitCommit } = status.body;
    return record(true, 'Guardian identity', `${url} ${version} (${gitCommit}), ECDSA commitment ${commitment}`);
  } catch (err) {
    return record(false, 'Guardian identity', `${url} unreachable: ${err.message}`);
  }
}

/**
 * Why the public faucet cannot fund a usdcx run, or undefined. Every usdcx wallet asks for USDCX_GRANT_UNITS by amount
 * (R19), so the faucet must list that tier and hold one grant of it.
 *
 * Exported for test.
 */
export function usdcxGrantProblem(metadata) {
  const usdcx = units => formatUnits(units, USDCX_DECIMALS);
  if (metadata?.decimals !== USDCX_DECIMALS) {
    return `serves ${metadata?.decimals} decimals, not USDCx's ${USDCX_DECIMALS}`;
  }
  const tiers = Array.isArray(metadata.token_amounts) ? metadata.token_amounts : [];
  const tier = USDCX_GRANT_UNITS / 10n ** BigInt(USDCX_DECIMALS);
  if (!tiers.some(tokens => Number.isSafeInteger(tokens) && BigInt(tokens) === tier)) {
    return `offers token_amounts [${tiers.join(', ')}], not the ${usdcx(USDCX_GRANT_UNITS)} USDCx tier every usdcx wallet asks for`;
  }
  let balance;
  try {
    balance = BigInt(metadata.balance);
  } catch {
    return 'reports no readable balance';
  }
  if (balance < USDCX_GRANT_UNITS) {
    return `holds ${usdcx(balance)} USDCx, less than one grant of ${usdcx(USDCX_GRANT_UNITS)} USDCx`;
  }
  return undefined;
}

function probeUsdcxGrant(metadata) {
  const problem = usdcxGrantProblem(metadata);
  const offered = `offers the ${formatUnits(USDCX_GRANT_UNITS, USDCX_DECIMALS)} USDCx tier every usdcx wallet asks for`;
  return record(problem === undefined, 'USDCx faucet grant', problem ?? offered);
}

/**
 * The Arc, Circle and Miden facts a usdcx run depends on, read as its specs read them. Nothing on Arc can be checked
 * without a healthy endpoint, and the Circle and native-asset checks compare with the remote token xReserve names on
 * chain, so each stage needs the one before it.
 */
async function probeUsdcx(opts, needs, arcKey) {
  const endpoint = await probeArcRpc(arcRpcEndpoints(opts.arcRpc));
  if (endpoint === undefined) return;
  await probeArcWriteEndpoint(endpoint);
  const remoteToken = await probeXReserve(endpoint);
  await probeXReservePause(endpoint, needs.includes('arc-payout'));
  if (needs.includes('arc-payout')) await probeGatewayMinter(endpoint);
  if (needs.includes('funded-key')) await probeArcFundedKey(endpoint, arcKey);
  if (remoteToken === undefined) return;
  await probeCircleXReserveApi(remoteToken);
  await probeUsdcxNativeAsset(opts.network, remoteToken);
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
 * The three contracts a run calls: the USDC and the AggLayer bridge the config
 * document names, and the Compact the Epoch SDK pins. On Anvil they are
 * `anvil_setCode` stubs; a real run needs the genuine deployments, and an empty
 * address would otherwise surface as an opaque revert deep inside a 15-minute test.
 */
async function probeSepoliaContracts(sepoliaRpc, { evmUsdc, l1Bridge }) {
  const targets = [
    ['USDC', evmUsdc],
    ['The Compact', SEPOLIA_COMPACT],
    ['AggLayer bridge', l1Bridge]
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

async function probeFundedKey(sepoliaRpc, privateKey, minEth, evmUsdc) {
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
  if (!evmUsdc) return note('Sepolia test USDC', 'not read: the config document named no USDC');
  try {
    const balance = BigInt(
      await rpc(sepoliaRpc, 'eth_call', [
        { to: evmUsdc, data: `0x70a08231${account.address.slice(2).padStart(64, '0')}` },
        'latest'
      ])
    );
    return note('Sepolia test USDC', `${formatUnits(balance, 18)} USDC held`);
  } catch (err) {
    return note('Sepolia test USDC', `not read: ${err.message}`);
  }
}

/**
 * Why the indexer's answer for Miden exit 0 shows it no longer files Miden exits under the testnet rollup id this
 * runner pins, or undefined when it does. The wallet derives the rollup id at runtime from the Miden bridge account;
 * the Slow bridge-out finds its deposit by that `network_id` and by `dest_net`, so an indexer that renumbers the Miden
 * network leaves every bridge-out unsettled with no error anywhere (#1325).
 *
 * Exported for test.
 */
export function agglayerExitFilingProblem(status, body) {
  if (status !== 200) return `answered HTTP ${status} for Miden exit 0`;
  const deposit = body?.deposit;
  if (deposit?.network_id !== AGGLAYER_MIDEN_NETWORK_ID) {
    return `files Miden exit 0 under network ${deposit?.network_id}, not the testnet rollup id ${AGGLAYER_MIDEN_NETWORK_ID}`;
  }
  if (deposit.dest_net !== 0) return `files Miden exit 0 as bound for network ${deposit.dest_net}, not Sepolia (0)`;
  return undefined;
}

/**
 * Check the filing of Miden exit 0 by the indexer the config document names, asking a second time before a failure
 * counts: E2E Bridge runs this on every push to main, and a third party's blip must not red main on its own. A
 * renumbering fails both asks. `get` and `retryDelayMs` are injectable for test.
 *
 * Exported for test.
 */
export async function probeAgglayerIndexer(indexerUrl, { get = getJson, retryDelayMs = 5_000 } = {}) {
  const url = `${indexerUrl}/bridge?net_id=${AGGLAYER_MIDEN_NETWORK_ID}&deposit_cnt=0`;
  const ask = async () => {
    try {
      const { status, body } = await get(url);
      return agglayerExitFilingProblem(status, body);
    } catch (err) {
      return `${indexerUrl} unreachable: ${err.message}`;
    }
  };
  let problem = await ask();
  if (problem !== undefined) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    problem = await ask();
  }
  return record(
    problem === undefined,
    'AggLayer indexer',
    problem ?? `files Miden exits under network ${AGGLAYER_MIDEN_NETWORK_ID}`
  );
}

/** What makes `text` something other than a harness key entry, or undefined. */
function harnessEntryProblem(text, privateKeyToAccount) {
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (entry?.role !== 'harness') return `role ${JSON.stringify(entry?.role)}, not "harness"`;
  if (typeof entry.privateKey !== 'string' || !/^0x[0-9a-f]{64}$/.test(entry.privateKey)) {
    return 'its privateKey is not 0x and 64 lowercase hex';
  }
  try {
    if (privateKeyToAccount(entry.privateKey).address === entry.address) return undefined;
  } catch {
    return 'its privateKey is not a valid secp256k1 key';
  }
  return 'its address does not derive from its privateKey';
}

/**
 * The harness Arc key (R21): the one key every usdcx run burns to and deposits from, so each burn's payout refills what
 * the deposits spend. Returns `{ address, privateKey, created }`, writing a new key 0600 into a 0700 directory when the
 * file is missing and `create` is set, or `{ missing: true }`. A file that exists is never replaced, since it may hold
 * USDC. Throws naming the file and what is wrong with it, never a key.
 *
 * Exported for test.
 */
export async function harnessArcKey(file, { create }) {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`cannot read the harness Arc key file ${file}: ${err.code ?? err.message}`);
    }
    if (!create) return { missing: true };
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    const entry = { role: 'harness', iso: new Date().toISOString(), address, privateKey, walletAddress: '' };
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { address, privateKey, created: true };
  }
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`the harness Arc key file ${file} is open to other users (mode ${mode.toString(8)}): chmod 600 it`);
  }
  const problem = harnessEntryProblem(text, privateKeyToAccount);
  if (problem !== undefined) {
    throw new Error(
      `${file} is not a harness Arc key entry (${problem}); it may hold a funded key, so the runner never replaces ` +
        'it: fix or move it by hand'
    );
  }
  const { address, privateKey } = JSON.parse(text);
  return { address, privateKey, created: false };
}

/**
 * The Arc key a usdcx run hands its test (R21): usdcx-in's operator key when --arc-key or E2E_ARC_PRIVATE_KEY names
 * one, else the harness key, which a real usdcx or usdcx-burn run creates on first use. `{ error }` when usdcx-in has
 * neither. No message carries a key.
 */
async function resolveArcKey(opts, suite) {
  if (suite.arcKey && opts.arcKey !== undefined) {
    const privateKey = `0x${opts.arcKey.replace(/^0x/i, '').toLowerCase()}`;
    const { privateKeyToAccount } = await import('viem/accounts');
    try {
      return { role: 'operator', privateKey, address: privateKeyToAccount(privateKey).address };
    } catch {
      return { error: 'the Arc key (--arc-key or E2E_ARC_PRIVATE_KEY) is not a valid secp256k1 private key' };
    }
  }
  const harness = await harnessArcKey(HARNESS_ARC_KEY_FILE, { create: !suite.arcKey && !opts.preflightOnly });
  if (harness.missing && suite.arcKey) {
    return {
      error:
        `--suite ${opts.suite} has no Arc key: pass --arc-key or export E2E_ARC_PRIVATE_KEY, or run --suite usdcx ` +
        `first, which creates the harness key ${HARNESS_ARC_KEY_FILE} and refills it with Circle's payout`
    };
  }
  return { role: 'harness', ...harness };
}

/** The banner's Arc key line: the role and the address, never the key. */
function describeArcKey(arcKey) {
  if (arcKey.role === 'operator') return `operator ${arcKey.address} (--arc-key or E2E_ARC_PRIVATE_KEY)`;
  if (arcKey.missing) {
    return `harness: none yet; the first real usdcx or usdcx-burn run creates ${HARNESS_ARC_KEY_FILE}`;
  }
  const created = arcKey.created ? ", created by this run; Circle's payouts fund it" : '';
  return `harness ${arcKey.address} (${HARNESS_ARC_KEY_FILE})${created}`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, but another user's.
    return err.code === 'EPERM';
  }
}

function readLockText(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Removes the lock while it still names this run; otherwise says why it was left. */
function releaseUsdcxRunLock(lockPath, mine) {
  let held;
  try {
    held = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (held?.pid !== mine.pid || held?.startedAt !== mine.startedAt) {
    return `the usdcx run lock ${lockPath} no longer names this run; left in place`;
  }
  unlinkSync(lockPath);
  return undefined;
}

/**
 * The usdcx run lock (R21): one run at a time burns to and deposits from the harness key, so the payout gate's
 * one-log, value-equals-delta proof holds. Returns `{ release, recordChild, removed? }`, or `{ error }` naming the lock
 * and the run holding it. A lock whose run and recorded test child are both gone is removed (`removed` says so) and
 * taken. It is written whole to a temporary file and linked into place, so no reader sees half of it; `isAlive` is for
 * tests.
 *
 * Exported for test.
 */
export function acquireUsdcxRunLock(
  lockPath,
  { suite, pid = process.pid, now = () => new Date(), isAlive = pidAlive }
) {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const mine = { pid, suite, startedAt: now().toISOString() };
  const place = (content, put) => {
    const temporary = `${lockPath}.${pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(content)}\n`, { mode: 0o600 });
    try {
      put(temporary);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const unreadable = reason =>
    `cannot read the usdcx run lock ${lockPath} (${reason}); if no usdcx run is going, remove it`;
  let removed;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      place(mine, temporary => linkSync(temporary, lockPath));
      return {
        removed,
        release: () => releaseUsdcxRunLock(lockPath, mine),
        recordChild: childPid => {
          if (childPid !== undefined) place({ ...mine, childPid }, temporary => renameSync(temporary, lockPath));
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        return { error: `cannot take the usdcx run lock ${lockPath}: ${err.code ?? err.message}` };
      }
    }
    let text;
    try {
      text = readLockText(lockPath);
    } catch (err) {
      return { error: unreadable(err.code ?? err.message) };
    }
    if (text === undefined) continue;
    let held;
    try {
      held = JSON.parse(text);
    } catch {
      held = undefined;
    }
    if (!Number.isSafeInteger(held?.pid)) return { error: unreadable('not a lock this runner wrote') };
    const runnerAlive = isAlive(held.pid);
    const childAlive = Number.isSafeInteger(held.childPid) && isAlive(held.childPid);
    if (runnerAlive || childAlive) {
      const who = runnerAlive
        ? `pid ${held.pid}`
        : `pid ${held.pid} exited; its child, pid ${held.childPid}, is still running`;
      return {
        error:
          `another usdcx run holds the lock ${lockPath} (${who}, --suite ${held.suite}, since ${held.startedAt}). ` +
          'Two runs would pay into and spend from the one harness Arc key, which breaks the payout check. ' +
          `Wait for it to end; if no yarn e2e:real run is going, remove ${lockPath}`
      };
    }
    // Two runs finding the same stale lock can both pass this re-read before either unlinks; accepted for one operator.
    if (readLockText(lockPath) !== text) continue;
    unlinkSync(lockPath);
    removed =
      `removed a stale usdcx run lock ${lockPath}: pid ${held.pid} (--suite ${held.suite}, since ${held.startedAt}) ` +
      'is no longer running';
  }
  return { error: `could not take the usdcx run lock ${lockPath}: another run took it first` };
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

/**
 * The environment of the build and of the test run, each as `{ env, unset }` for run(). A usdcx child gets what its
 * phase reads and loses what it must not: no build sees a private key, and each usdcx test sees the one Arc key it
 * burns to or deposits from (`arcKey`, from resolveArcKey: the harness key, or usdcx-in's operator key) and its role.
 *
 * Exported for test.
 */
export function childEnvironments(opts, suite, cliBin, arcKey) {
  if (!suite.usdcx) {
    const env = {
      E2E_NETWORK: opts.network,
      E2E_REAL_EPOCH: 'true',
      // GUARDIAN_URL is deliberately NOT injected: swap-guardian.spec.ts resolves
      // it from the run's own environment record, so injecting it here would make
      // this table a second owner of the same fact. The table below stays because
      // probeGuardian reads it to decide what to probe.
      E2E_SEPOLIA_RPC_URL: opts.sepoliaRpc,
      ...(opts.sepoliaKey ? { E2E_SEPOLIA_PRIVATE_KEY: opts.sepoliaKey } : {})
    };
    return { build: { env, unset: [] }, test: { env, unset: [] } };
  }
  const headless = suite.headlessByDefault === true && !opts.headed;
  return {
    build: { env: { E2E_NETWORK: opts.network }, unset: ['E2E_ARC_PRIVATE_KEY', 'E2E_SEPOLIA_PRIVATE_KEY'] },
    test: {
      env: {
        E2E_NETWORK: opts.network,
        // Each usdcx describe's beforeAll throws without it, so no other entry point starts a paid run.
        E2E_REAL_USDCX: 'true',
        MIDEN_CLIENT_BIN: cliBin,
        ...(opts.arcRpc ? { E2E_ARC_RPC_URL: opts.arcRpc } : {}),
        // Given over any exported value, so an exported key never reaches usdcx or usdcx-burn.
        E2E_ARC_PRIVATE_KEY: arcKey.privateKey,
        E2E_ARC_KEY_ROLE: arcKey.role,
        ...(headless ? { E2E_HEADLESS: '1' } : {})
      },
      // --headed must win over an exported E2E_HEADLESS, so it is unset rather than left to be inherited.
      unset: ['E2E_SEPOLIA_PRIVATE_KEY', ...(headless ? [] : ['E2E_HEADLESS'])]
    }
  };
}

/**
 * Install, or reuse, the miden-client CLI pinned in package.json, and return its path: the installer's last stdout
 * line. It runs here, before the build, because a fixture left to resolve it (resolveCliPath in
 * playwright/e2e/helpers/miden-cli.ts) would spend a cold install of up to 35 min inside the test timeout.
 * Undefined after reporting a failure.
 */
function installPinnedCli() {
  console.log('Installing the pinned miden-client CLI (a cold cache builds it with cargo, up to 35 min)\n');
  const res = spawnSync(process.execPath, ['scripts/install-pinned-miden-cli.cjs', 'install'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 2_100_000,
    maxBuffer: 16 * 1024 * 1024
  });
  const cliBin = res.status === 0 ? res.stdout.trim().split('\n').pop() : undefined;
  if (cliBin) return cliBin;
  const why = res.error?.message ?? `exit ${res.status}`;
  console.error(`\n✗ the pinned miden-client CLI did not install (${why}) - nothing was built or run.\n`);
  return undefined;
}

/**
 * Run `command` with `env` over this process's environment, less each name in `opts.unset`. A key a phase must not
 * see has to be deleted: the child inherits everything the operator exported. A name both unset and given in `env`
 * takes the given value. `opts.onSpawn` sees each child as it starts: the usdcx run lock records its pid, so a test a
 * killed runner left running keeps the lock held.
 */
export function run(command, args, env, opts = {}) {
  return new Promise(resolve => {
    const inherited = { ...process.env };
    for (const name of opts.unset ?? []) delete inherited[name];
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...inherited, ...env } });
    opts.onSpawn?.(child);

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
  if (opts.agglayerIndexerOnly) {
    console.log(`\nConfig   ${configDocumentUrl(opts.network)}`);
    console.log('\nPreflight');
    const targets = await probeConfigDocument(opts.network, ['agglayer']);
    if (targets) await probeAgglayerIndexer(targets.indexerUrl);
    return results.every(r => r.ok) ? 0 : 1;
  }
  // Every refusal of operator input happens here, before the banner: one found
  // later is never reached under --preflight-only, and otherwise costs the probes
  // and a build first. probeFundedKey keeps its own checks as a backstop.
  const { error, suite, grep } = resolveOperatorInput(opts);
  if (error !== undefined) fail(error);
  // Before the key, the banner and the probes, so a second run refuses at once; --preflight-only takes none.
  const lock =
    suite.usdcx && !opts.preflightOnly ? acquireUsdcxRunLock(USDCX_RUN_LOCK, { suite: opts.suite }) : undefined;
  if (lock?.error !== undefined) fail(lock.error);
  if (lock?.removed !== undefined) console.log(`\n· ${lock.removed}`);
  try {
    return await runSuite(opts, suite, grep, lock);
  } finally {
    const left = lock?.release();
    if (left !== undefined) console.error(`· ${left}`);
  }
}

/** Everything after the operator's input is accepted: the Arc key, the banner, the preflight, the CLI, build and test. */
async function runSuite(opts, suite, grep, lock) {
  const arcKey = suite.usdcx ? await resolveArcKey(opts, suite).catch(err => ({ error: err.message })) : undefined;
  if (arcKey?.error !== undefined) {
    console.error(`\n✗ ${arcKey.error}\n`);
    return 1;
  }
  const needs = suite.probes ?? [];
  const needsDocument = needs.some(probe => Object.hasOwn(DOCUMENT_FIELDS, probe));
  console.log(`\nSuite    ${opts.suite} - ${suite.describe}`);
  console.log(`Network  ${opts.network}`);
  if (needsDocument) console.log(`Config   ${configDocumentUrl(opts.network)}`);
  if (needs.includes('sepolia')) console.log(`Sepolia  ${opts.sepoliaRpc}`);
  // Hosts only: an operator's endpoint may carry its API key in the path.
  if (needs.includes('usdcx')) console.log(`Arc RPC  ${arcRpcEndpoints(opts.arcRpc).map(endpointHost).join(', ')}`);
  if (arcKey !== undefined) console.log(`Arc key  ${describeArcKey(arcKey)}`);
  if (arcKey?.role === 'harness' && opts.arcKey !== undefined) {
    console.log(
      '· E2E_ARC_PRIVATE_KEY is exported but applies only to --suite usdcx-in; this run uses the harness key'
    );
  }
  console.log('');
  console.log('Preflight');

  // The Miden chain and its faucet are common to every suite: the faucet grant is
  // what pays fees for each fresh account, so a dead faucet fails the run at
  // funding rather than at the assertion.
  await probeMidenNode(opts.network);
  await probeMidenFaucet(opts.network, { grant: needs.includes('grant') });

  // What the probes ask about is what the wallet will use: the document it reads,
  // never a copy kept here. Without a usable one, nothing it names is probed.
  const targets = needsDocument ? await probeConfigDocument(opts.network, needs) : null;

  // Keyed on what the suite actually talks to, not on which Playwright config it
  // happens to share: both bridge routes use one config, but only the Epoch route
  // asks the solver anything.
  if (targets && needs.includes('epoch')) {
    await probeEpochHealth(targets.allocatorUrl);
    // The spec mints a throwaway faucet per run, so the probe asks about one too:
    // it must reflect what the suite will actually request, not a friendlier token.
    await probeEpochQuote(targets.allocatorUrl, targets.evmUsdc, '0xabcdefabcdefabcdefabcdefabcdef');
  }
  if (needs.includes('sepolia')) {
    await probeSepolia(opts.sepoliaRpc);
    if (targets) await probeSepoliaContracts(opts.sepoliaRpc, targets);
  }
  if (targets && needs.includes('agglayer')) await probeAgglayerIndexer(targets.indexerUrl);
  if (needs.includes('guardian')) await probeGuardian(opts.network);
  if (needs.includes('usdcx-guardian')) await probeUsdcxGuardian(opts.network);
  if (needs.includes('usdcx')) await probeUsdcx(opts, needs, arcKey);
  // Only for a suite that actually talks to Sepolia: a key handed to a swap run
  // must not make Sepolia's availability decide whether that run happens.
  if (needs.includes('sepolia') && opts.sepoliaKey) {
    await probeFundedKey(opts.sepoliaRpc, opts.sepoliaKey, opts.minEth, targets?.evmUsdc);
  }

  // Advisory, printed with `·` and never counted: these report services the
  // PRODUCT depends on and main CI never touches, but no suite here asks them
  // anything, so neither may decide whether a run happens.
  if (targets && needs.includes('epoch')) await probeEpochGasless(targets.allocatorUrl);
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

  let cliBin;
  if (suite.usdcx) {
    cliBin = process.env.MIDEN_CLIENT_BIN || installPinnedCli();
    if (!cliBin) return 1;
    console.log(`Miden CLI ${cliBin}\n`);
  }
  const phases = childEnvironments(opts, suite, cliBin, arcKey);
  const onSpawn = child => lock?.recordChild(child.pid);

  if (!opts.skipBuild) {
    console.log('Building the extension for a real-endpoint run…\n');
    // The wallet reads its Epoch hosts from the config document at runtime, but
    // the network and MIDEN_REMOTE_CONFIG_URL are build defines: --skip-build is
    // only safe when dist/ was produced with this same env.
    const code = await run('yarn', ['test:e2e:blockchain:build'], phases.build.env, {
      unset: phases.build.unset,
      onSpawn
    });
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
  if (grep) args.push('--grep', grep);
  if (suite.grepInvert) args.push('--grep-invert', suite.grepInvert);
  if (opts.headed) args.push('--headed');

  console.log(`\nRunning: yarn ${args.join(' ')}\n`);
  return run('yarn', args, phases.test.env, { unset: phases.test.unset, onSpawn });
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
