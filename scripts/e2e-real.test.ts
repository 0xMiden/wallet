/**
 * Unit cover for the two decisions in the real-endpoint runner that can spend
 * money unintentionally, plus the child-process contract.
 *
 * Both guards were added in review and neither was reachable from a test until
 * the runner exported them. `composeGrep`'s own docstring says getting it wrong
 * "would silently widen the run onto specs that spend real money", and
 * `suiteRetries` decides whether a spent, non-idempotent run repeats itself.
 * Those are exactly the things that should not rest on having read the code
 * carefully once.
 *
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AGGLAYER_MIDEN_NETWORK_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_TESTNET_CHAIN_ID,
  ARC_USDC,
  ARC_XRESERVE,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  HARNESS_ARC_KEY_FILE,
  SUITES,
  USDCX_DECIMALS,
  USDCX_FUNDED_KEY_FLOOR_UNITS,
  USDCX_GRANT_FLOOR_UNITS,
  USDCX_GRANT_UNITS,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_API_TESTNET,
  acquireUsdcxRunLock,
  agglayerExitFilingProblem,
  arcRpc,
  arcRpcEndpoints,
  childEnvironments,
  circleGet,
  composeGrep,
  harnessArcKey,
  pricedAmountFrom,
  probeAgglayerIndexer,
  probeConfigDocument,
  resolveOperatorInput,
  run,
  suiteRetries,
  usdcxGrantProblem
} from './e2e-real.mjs';
import * as harness from '../playwright/e2e/helpers/usdcx-constants';
import * as wallet from '../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../src/lib/walletconnect/config';

const REPO_ROOT = path.resolve(__dirname, '..');

// The caller's environment without any variable the runner reads or a usdcx child carries: a key, an empty URL
// or a served config document there would add its own refusal, or its own document, ahead of the one under test.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'E2E_SEPOLIA_PRIVATE_KEY',
    'EPOCH_ALLOCATOR_URL',
    'EPOCH_POSITIONS_URL',
    'E2E_SEPOLIA_RPC_URL',
    'MIDEN_REMOTE_CONFIG_URL',
    'E2E_ARC_RPC_URL',
    'E2E_ARC_PRIVATE_KEY',
    'USDCX_LIVE_EVM_PRIVATE_KEY',
    'E2E_ARC_KEY_ROLE',
    'E2E_EVM_RPC_URL',
    'MIDEN_E2E_USDCX_CHAIN',
    'MIDEN_FEE_FAUCET_ID',
    'GUARDIAN_URL',
    'MIDEN_CLIENT_BIN',
    'E2E_HEADLESS',
    'E2E_NETWORK',
    'E2E_REAL_EPOCH',
    'E2E_REAL_USDCX'
  ]) {
    delete env[name];
  }
  return env;
}

// A home of its own for every runner a test starts: a real usdcx run takes ~/.miden-e2e/usdcx-run.lock and creates the
// harness Arc key there, which must never be the operator's, nor wait on a run the operator has going.
function freshHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'e2e-real-home-'));
}

// A leading object sets variables for the child, over cleanEnv().
function runCli(first: string | Record<string, string>, ...rest: string[]) {
  const override = typeof first === 'string' ? {} : first;
  const args = typeof first === 'string' ? [first, ...rest] : rest;
  const env = cleanEnv();
  const res = spawnSync(process.execPath, ['scripts/e2e-real.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...env, HOME: freshHome(), ...override },
    timeout: 30_000
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('composeGrep', () => {
  it('requires BOTH patterns when a suite filter and a user filter are given', () => {
    // Playwright keeps only the last --grep, so the two must become one pattern.
    // Lookaheads match anywhere in the title, which is what each did alone.
    expect(composeGrep('Slow AggLayer', 'bridges')).toBe('(?=.*(?:Slow AggLayer))(?=.*(?:bridges))');
  });

  it('keeps an alternation inside its own lookahead', () => {
    // Ungrouped, (?=.*Fast Epoch|Slow AggLayer) tests the second alternative only
    // where the match starts, which no position in this title satisfies.
    const composed = new RegExp(composeGrep('bridge-out', 'Fast Epoch|Slow AggLayer'));
    expect(composed.test('bridge-out Miden to EVM (Slow AggLayer) > bridges the AggLayer token')).toBe(true);
  });

  it('never widens a real-money run when the user pattern is an alternation', () => {
    const composed = new RegExp(composeGrep('Slow AggLayer', 'Fast Epoch|smoke'));
    expect(composed.test('bridge-out Miden to Sepolia (Fast Epoch) > bridges a token')).toBe(false);
  });

  it('matches a title that satisfies both', () => {
    const composed = new RegExp(composeGrep('Slow AggLayer', 'bridges'));
    expect(composed.test('bridge-out Miden to EVM (Slow AggLayer) > bridges the AggLayer token')).toBe(true);
  });

  it('does NOT match a title that satisfies only the user pattern', () => {
    // The regression this guards: `--suite bridge-out-agglayer --grep 'Fast Epoch'`
    // must select nothing, not the real-money Epoch spec.
    const composed = new RegExp(composeGrep('Slow AggLayer', 'Fast Epoch'));
    expect(composed.test('bridge-out Miden to Sepolia (Fast Epoch) > bridges a token')).toBe(false);
  });

  it('passes either pattern through alone', () => {
    expect(composeGrep('Fast Epoch', undefined)).toBe('Fast Epoch');
    expect(composeGrep(undefined, 'smoke')).toBe('smoke');
    expect(composeGrep(undefined, undefined)).toBeUndefined();
  });

  it('refuses a user pattern that only compiles once composed', () => {
    // Composed, this closes its own lookahead and adds an empty alternative that
    // matches every title, widening the run onto every real-money spec.
    expect(() => composeGrep('Slow AggLayer', 'x))|((')).toThrow('not a valid regular expression');
  });

  it('refuses an invalid user pattern even with no suite filter to compose with', () => {
    expect(() => composeGrep(undefined, '(')).toThrow('not a valid regular expression');
  });

  it("says why a pattern is invalid, in the engine's own words", () => {
    const invalid = 'x))|((';
    let reason = '';
    try {
      new RegExp(invalid);
    } catch (error) {
      reason = (error as Error).message;
    }
    expect(reason).toMatch(/Unmatched|Invalid regular expression/);
    expect(() => composeGrep('Slow AggLayer', invalid)).toThrow(reason);
  });
});

describe('resolveOperatorInput', () => {
  // What parseArgs returns for `--suite swap` with no key in the environment.
  // Each case changes only the field under test.
  const parseArgsDefaults = {
    suite: 'swap',
    network: 'testnet',
    sepoliaRpc: 'https://sepolia.invalid',
    sepoliaKey: undefined,
    minEth: '0.02',
    preflightOnly: false,
    skipBuild: false,
    headed: false,
    grep: undefined
  };
  const resolve = (changed: Record<string, unknown> = {}) => resolveOperatorInput({ ...parseArgsDefaults, ...changed });
  const hex64 = 'ab'.repeat(32);

  it('returns the suite and its composed grep for the defaults', () => {
    expect(resolve()).toStrictEqual({ suite: SUITES.swap, grep: composeGrep(SUITES.swap.grep, undefined) });
  });

  it('accepts devnet', () => {
    expect(resolve({ network: 'devnet' }).error).toBeUndefined();
  });

  it('requires --suite', () => {
    expect(resolve({ suite: undefined }).error).toContain('--suite is required');
  });

  // toString and __proto__ are on every object, so a plain index finds them.
  it.each(['nope', 'toString', '__proto__'])('refuses the unknown suite %s', suite => {
    expect(resolve({ suite }).error).toContain(`unknown suite "${suite}"`);
  });

  it.each(['mainnet', 'constructor'])('refuses the unknown network %s', network => {
    expect(resolve({ network }).error).toContain('--network must be one of');
  });

  it.each(['1', '0.02'])('accepts --min-eth %s', minEth => {
    expect(resolve({ minEth }).error).toBeUndefined();
  });

  it('refuses a --min-eth that is not a plain decimal', () => {
    expect(resolve({ minEth: 'abc' }).error).toContain('--min-eth must be a plain non-negative decimal');
  });

  it.each([
    ['with', `0x${hex64}`],
    ['without', hex64]
  ])('accepts a 32-byte key %s 0x on a suite that probes Sepolia', (_, sepoliaKey) => {
    expect(resolve({ suite: 'bridge-out-agglayer', sepoliaKey }).error).toBeUndefined();
  });

  it('refuses a short key on a suite that probes Sepolia', () => {
    expect(resolve({ suite: 'bridge-out-agglayer', sepoliaKey: '0x01' }).error).toContain('not a valid private key');
  });

  it('does not judge a key handed to a suite that never talks to Sepolia', () => {
    expect(resolve({ sepoliaKey: '0x01' }).error).toBeUndefined();
  });

  it('refuses an invalid --grep before a bad --min-eth', () => {
    expect(resolve({ grep: 'x))|((', minEth: 'abc' }).error).toContain('not a valid regular expression');
  });

  it('refuses a bad --min-eth before a bad key', () => {
    const { error } = resolve({ suite: 'bridge-out-agglayer', minEth: 'abc', sepoliaKey: '0x01' });
    expect(error).toContain('--min-eth must be a plain non-negative decimal');
  });
});

describe('the command refuses operator input before any probe or build', () => {
  // Each refusal must come before the banner: under --preflight-only a later one
  // is never reached, and otherwise it costs the probes and a build first.
  it('refuses an invalid --grep', () => {
    const res = runCli('--suite', 'bridge-out-agglayer', '--grep', 'x))|((', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not a valid regular expression');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses a Sepolia key that is not 32 bytes of hex', () => {
    const res = runCli('--suite', 'bridge-out-agglayer', '--sepolia-key', '0x01', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not a valid private key');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses an --min-eth that is not a plain decimal', () => {
    const key = `0x${'1'.repeat(64)}`;
    const res = runCli('--suite', 'bridge-out-agglayer', '--sepolia-key', key, '--min-eth', 'abc', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--min-eth must be a plain non-negative decimal');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses an unknown argument', () => {
    const res = runCli('--bogus');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: --bogus');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('never echoes a value given with =', () => {
    const res = runCli(`--sepolia-key=0x${'1'.repeat(64)}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: --sepolia-key=<value>');
    expect(res.stderr).not.toContain('1'.repeat(64));
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses a flag given no value', () => {
    const res = runCli('--suite');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--suite needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  // A quoted unset variable arrives as '': `--grep "$UNSET"` would drop the
  // operator's narrowing and widen a real-money run.
  it.each(['--suite', '--network', '--sepolia-rpc', '--sepolia-key', '--arc-rpc', '--arc-key', '--min-eth', '--grep'])(
    'refuses an empty value for %s',
    flag => {
      const res = runCli('--suite', 'swap', flag, '', '--min-eth', 'abc');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${flag} needs a value`);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  // Playwright keeps only the last --grep, so a second one would silently replace
  // the operator's narrowing. The prefix's bad --min-eth keeps a taken repeat off
  // the network.
  it.each([
    ['--suite', 'swap', 'swap'],
    ['--network', 'testnet', 'devnet'],
    ['--sepolia-rpc', 'https://a.example', 'https://b.example'],
    ['--sepolia-key', `0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`],
    ['--arc-rpc', 'https://c.example', 'https://d.example'],
    ['--arc-key', `0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`],
    ['--grep', 'aaa', 'bbb']
  ])(
    'refuses %s given twice',
    (flag, first, second) => {
      const res = runCli('--suite', 'swap', '--min-eth', 'abc', flag, first, flag, second);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${flag} given more than once`);
      expect(res.stderr).not.toContain(first);
      expect(res.stderr).not.toContain(second);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses --min-eth given twice', () => {
    const res = runCli('--suite', 'swap', '--min-eth', '1', '--min-eth', 'abc');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--min-eth given more than once');
    expect(res.stderr).not.toContain('1');
    expect(res.stderr).not.toContain('abc');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('accepts a boolean flag given twice', () => {
    const res = runCli('--suite', 'swap', '--headed', '--headed', '--min-eth', 'abc');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--min-eth must be a plain non-negative decimal');
    expect(res.stderr).not.toContain('given more than once');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  // A swallowed option is lost without a word: `--grep --preflight-only` would
  // build and run a real-money suite the operator asked only to preflight. The
  // trailing bad --min-eth keeps each run off the network if the flag does take it.
  it('refuses another option as the value of --grep', () => {
    const res = runCli('--suite', 'swap', '--grep', '--preflight-only', '--min-eth', 'abc');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--grep needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses another option as the value of --network', () => {
    const res = runCli('--network', '--suite', 'swap', '--min-eth', 'abc');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--network needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses -h as the value of --suite', () => {
    const res = runCli('--suite', '-h');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--suite needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it.each([
    '--suite',
    '--network',
    '--sepolia-rpc',
    '--sepolia-key',
    '--arc-rpc',
    '--arc-key',
    '--min-eth',
    '--grep',
    '--preflight-only',
    '--skip-build',
    '--headed',
    '-h',
    '--help'
  ])(
    'refuses the documented option %s as the value of --grep',
    name => {
      const res = runCli('--suite', 'swap', '--grep', name, '--min-eth', 'abc');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--grep needs a value');
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  // Taken as a value, the key would be printed by whatever refused or ran it.
  it.each(['--suite', '--min-eth', '--grep'])(
    'refuses an option given with = as the value of %s',
    flag => {
      const key = `0x${'1'.repeat(64)}`;
      const res = runCli('--suite', 'bridge-out-agglayer', '--min-eth', 'abc', flag, `--sepolia-key=${key}`);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${flag} needs a value`);
      expect(res.stderr).not.toContain('1'.repeat(64));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  // Only an option name is refused: a value may start with '-', and a name
  // Object.prototype carries is not an option.
  it.each(['-x', 'constructor'])(
    'takes %s as the value of --grep',
    value => {
      const res = runCli('--suite', 'swap', '--grep', value, '--min-eth', 'abc');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--min-eth must be a plain non-negative decimal');
      expect(res.stderr).not.toContain('needs a value');
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses a name inherited from Object.prototype as an unknown argument', () => {
    // Indexed plainly, `constructor` would take 'x' as its value and the run
    // would go on to refuse the suite instead.
    const res = runCli('constructor', 'x', '--suite', 'nope');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: constructor');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  // `export E2E_SEPOLIA_RPC_URL=` is not `unset`: '' would be probed and built in.
  it('refuses E2E_SEPOLIA_RPC_URL set but empty', () => {
    const res = runCli({ E2E_SEPOLIA_RPC_URL: '' }, '--suite', 'swap', '--min-eth', 'abc');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_SEPOLIA_RPC_URL is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  // The wallet reads its Epoch hosts from the network's config document, so a
  // run given its own would preflight one host while the wallet uses another.
  it.each([
    ['EPOCH_ALLOCATOR_URL', 'https://allocator.example'],
    ['EPOCH_POSITIONS_URL', 'https://positions.example'],
    ['EPOCH_ALLOCATOR_URL', '']
  ])(
    'refuses %s set (to "%s"), which nothing reads any more',
    (name, value) => {
      const res = runCli({ [name]: value }, '--suite', 'swap', '--min-eth', 'abc');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${name} is set`);
      expect(res.stderr).toContain('config document');
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each(['--epoch-url', '--epoch-positions-url'])(
    'refuses %s, which nothing reads any more',
    flag => {
      const res = runCli('--suite', 'swap', flag, 'https://a.example', '--min-eth', 'abc');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${flag} is gone`);
      expect(res.stderr).toContain('config document');
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('takes a flag over an empty variable', () => {
    const res = runCli(
      { E2E_SEPOLIA_RPC_URL: '' },
      '--suite',
      'swap',
      '--sepolia-rpc',
      'https://sepolia.example',
      '--min-eth',
      'abc'
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--min-eth must be a plain non-negative decimal');
    expect(res.stderr).not.toContain('is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('prints the usage despite an empty variable', () => {
    const res = runCli({ E2E_SEPOLIA_RPC_URL: '' }, '-h');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('yarn e2e:real --suite <name> [options]');
  }, 35_000);
});

const ALLOCATOR = 'https://allocator.example';
const EVM_USDC = `0x${'a'.repeat(40)}`;
const L1_BRIDGE = `0x${'b'.repeat(40)}`;
const INDEXER = 'https://indexer.example/api';
const PUBLISHED = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json';
const DOCUMENT = {
  network: 'testnet',
  version: 7,
  evm: { chainId: 11155111 },
  agglayer: { l1Bridge: L1_BRIDGE, midenBridge: '0x3b66e20b5088f25133b69216484652', indexerUrl: INDEXER },
  epoch: { allocatorUrl: ALLOCATOR, positionsUrl: 'https://positions.example', evmUsdc: EVM_USDC },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
};

const STUB = pathToFileURL(path.join(__dirname, 'e2e-real.fetch-stub.mjs')).href;

// The whole command, its every request answered by the stub and logged. `answers` overrides the stub's defaults
// (ANSWERS in e2e-real.fetch-stub.mjs).
function stubbed(
  args: string[],
  served: unknown,
  env: Record<string, string> = {},
  answers: Record<string, unknown> = {}
) {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-')), 'requests.log');
  writeFileSync(log, '');
  const home = env.HOME ?? freshHome();
  const res = spawnSync(process.execPath, ['--import', STUB, 'scripts/e2e-real.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...cleanEnv(),
      ...env,
      HOME: home,
      E2E_REAL_FETCH_STUB: JSON.stringify({ document: served, log, answers })
    },
    timeout: 30_000
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    output: `${res.stdout}${res.stderr}`,
    requests: readFileSync(log, 'utf8'),
    home
  };
}

// The whole command under --preflight-only.
function preflight(
  suite: string,
  served: unknown = DOCUMENT,
  env: Record<string, string> = {},
  answers: Record<string, unknown> = {}
) {
  return stubbed(['--suite', suite, '--preflight-only'], served, env, answers);
}

describe('the preflight reads what it probes from the network config document', () => {
  // Any valid secp256k1 scalar: the stub answers every read, so nothing is ever signed or sent.
  const FUNDED_KEY = `0x${'11'.repeat(32)}`;

  it('probes the allocator, the USDC and the L1 bridge the published document names', () => {
    const res = preflight('bridge-out-epoch');
    expect(res.requests).toContain(`${ALLOCATOR}/health`);
    expect(res.requests).toContain(`${ALLOCATOR}/checkIfDepositNeeded`);
    // Checksummed, as the wallet's getters send them: its parser lowercases every address.
    expect(res.requests).toContain(`eth_getCode ["${getAddress(EVM_USDC)}","latest"]`);
    expect(res.requests).toContain(`eth_getCode ["${getAddress(L1_BRIDGE)}","latest"]`);
    expect(res.requests).toContain(`"tokenOut":"${getAddress(EVM_USDC)}"`);
    expect(res.requests).toContain(`${ALLOCATOR}/gasless-status`);
    expect(res.requests).toContain(PUBLISHED);
    expect(res.output).toContain(`Config   ${PUBLISHED}`);
    expect(res.status).toBe(0);
  }, 35_000);

  it("reads a funded key's test USDC at the USDC the document names", () => {
    const res = preflight('bridge-out-epoch', DOCUMENT, { E2E_SEPOLIA_PRIVATE_KEY: FUNDED_KEY });
    expect(res.requests).toContain(`eth_call [{"to":"${getAddress(EVM_USDC)}"`);
    expect(res.status).toBe(0);
  }, 35_000);

  it("reads no funded key's test USDC from a document the preflight refused", () => {
    const res = preflight(
      'bridge-out-epoch',
      { ...DOCUMENT, network: 'devnet' },
      { E2E_SEPOLIA_PRIVATE_KEY: FUNDED_KEY }
    );
    expect(res.output).toContain('not read: the config document named no USDC');
    expect(res.requests).toContain('eth_getBalance');
    expect(res.requests).not.toContain('eth_call');
  }, 35_000);

  it.each([
    ['for another network', { ...DOCUMENT, network: 'devnet' }],
    [
      'with an allocator that is not https',
      { ...DOCUMENT, epoch: { ...DOCUMENT.epoch, allocatorUrl: 'http://a.example' } }
    ],
    ['with a malformed USDC address', { ...DOCUMENT, epoch: { ...DOCUMENT.epoch, evmUsdc: '0x1234' } }],
    ['naming no allocator', { ...DOCUMENT, epoch: { evmUsdc: EVM_USDC } }]
  ])(
    'fails the preflight on a document %s and probes nothing it would have named',
    (_label, served) => {
      const res = preflight('bridge-out-epoch', served);
      expect(res.status).toBe(1);
      expect(res.output).toContain('Config document');
      expect(res.requests).not.toContain('/health');
      expect(res.requests).not.toContain('eth_getCode');
    },
    35_000
  );

  it.each([
    ['a positions host that is not a URL', { ...DOCUMENT, epoch: { ...DOCUMENT.epoch, positionsUrl: 42 } }],
    ['a malformed Miden bridge', { ...DOCUMENT, agglayer: { ...DOCUMENT.agglayer, midenBridge: '0x1234' } }],
    ['a switch that is not a boolean', { ...DOCUMENT, features: { ...DOCUMENT.features, earn: 'true' } }]
  ])(
    'fails the preflight on a document the wallet refuses for %s, a field no probe reads, and probes nothing',
    (_label, served) => {
      const res = preflight('bridge-out-epoch', served);
      expect(res.status).toBe(1);
      expect(res.output).toContain('Config document');
      expect(res.requests).not.toContain('/health');
      expect(res.requests).not.toContain('/checkIfDepositNeeded');
      expect(res.requests).not.toContain('eth_getCode');
    },
    35_000
  );

  it('passes a document that leaves a switch out, which the wallet reads as off', () => {
    const { bridgeOut: _left, ...features } = DOCUMENT.features;
    const res = preflight('bridge-out-epoch', { ...DOCUMENT, features });
    expect(res.status).toBe(0);
    expect(res.requests).toContain(`${ALLOCATOR}/health`);
  }, 35_000);

  it('reads the served document the E2E build reads when MIDEN_REMOTE_CONFIG_URL is set', () => {
    const served = { ...DOCUMENT, epoch: { ...DOCUMENT.epoch, allocatorUrl: 'http://127.0.0.1:8548' } };
    const res = preflight('bridge-out-epoch', served, { MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8550/' });
    expect(res.requests).toContain('http://127.0.0.1:8550/testnet.json');
    expect(res.requests).toContain('http://127.0.0.1:8548/health');
    expect(res.requests).not.toContain(PUBLISHED);
    expect(res.status).toBe(0);
  }, 35_000);

  const EXIT_0 = `${INDEXER}/bridge?net_id=${AGGLAYER_MIDEN_NETWORK_ID}&deposit_cnt=0`;

  it('asks the indexer the document names for Miden exit 0', () => {
    const res = preflight('bridge-out-agglayer');
    expect(res.requests).toContain(EXIT_0);
    expect(res.output).toContain(`files Miden exits under network ${AGGLAYER_MIDEN_NETWORK_ID}`);
    expect(res.status).toBe(0);
  }, 35_000);

  it('fails the preflight on a document naming no indexer for a Slow suite, and asks no indexer', () => {
    const res = preflight('bridge-out-agglayer', { ...DOCUMENT, agglayer: { l1Bridge: L1_BRIDGE } });
    expect(res.status).toBe(1);
    expect(res.output).toContain('names no agglayer.indexerUrl');
    expect(res.requests).not.toContain('/bridge?');
  }, 35_000);

  // E2E Bridge runs this on its own, with no Sepolia URL or key: only the document and its indexer are read.
  it('--agglayer-indexer-only reads the document and asks only its indexer', () => {
    const res = stubbed(['--agglayer-indexer-only'], DOCUMENT, { E2E_SEPOLIA_RPC_URL: '' });
    expect(res.requests.trim().split('\n')).toEqual([PUBLISHED, EXIT_0]);
    expect(res.status).toBe(0);
  }, 35_000);

  it('--agglayer-indexer-only fails on a document the wallet refuses, and asks no indexer', () => {
    const res = stubbed(['--agglayer-indexer-only'], { ...DOCUMENT, network: 'devnet' });
    expect(res.status).toBe(1);
    expect(res.output).toContain('Config document');
    expect(res.requests).not.toContain('/bridge?');
  }, 35_000);

  it('reads no document for a suite that probes nothing it names', () => {
    const res = preflight('swap');
    expect(res.requests).not.toContain('.json');
  }, 35_000);
});

// E2E Bridge reads the document on every push to main, so a failed GET or a gateway error is asked again once. A
// document that arrives is judged on that answer, whatever the wallet's parser makes of it.
describe('the config document fetch asks twice', () => {
  const SERVED = { status: 200, body: DOCUMENT };
  let log: jest.SpyInstance;

  // `record` prints one line per probe.
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const printed = () => log.mock.calls.flat().join('\n');

  it('asks once when the first GET serves the document', async () => {
    const get = jest.fn().mockResolvedValue(SERVED);

    await expect(probeConfigDocument('testnet', ['agglayer'], { get, retryDelayMs: 0 })).resolves.toEqual({
      indexerUrl: INDEXER
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(PUBLISHED);
  }, 35_000);

  it.each([
    ['a GET that throws', () => Promise.reject(new Error('socket hang up'))],
    ['a gateway error', () => Promise.resolve({ status: 502, body: 'Bad Gateway' })]
  ])(
    'reads the document from the second GET after %s',
    async (_label, firstAnswer) => {
      const get = jest.fn().mockImplementationOnce(firstAnswer).mockResolvedValueOnce(SERVED);

      await expect(probeConfigDocument('testnet', ['agglayer'], { get, retryDelayMs: 0 })).resolves.toEqual({
        indexerUrl: INDEXER
      });
      expect(get).toHaveBeenCalledTimes(2);
    },
    35_000
  );

  it.each([
    ['two GETs that throw', () => Promise.reject(new Error('socket hang up')), 'unreachable: socket hang up'],
    ['two gateway errors', () => Promise.resolve({ status: 502, body: 'Bad Gateway' }), 'answered HTTP 502']
  ])('fails after %s', async (_label, answer, reason) => {
    const get = jest.fn().mockImplementation(answer);

    await expect(probeConfigDocument('testnet', ['agglayer'], { get, retryDelayMs: 0 })).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
    expect(printed()).toContain(reason);
  });

  it('asks once for a document the wallet refuses', async () => {
    const get = jest.fn().mockResolvedValue({ status: 200, body: { ...DOCUMENT, network: 'devnet' } });

    await expect(probeConfigDocument('testnet', ['agglayer'], { get, retryDelayMs: 0 })).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(printed()).toContain('Config document');
  }, 35_000);
});

describe('suiteRetries', () => {
  it('gives a real-money suite no retries', () => {
    // Its test mints a faucet and triggers a live solver fill; a retry spends
    // that fill a second time.
    expect(suiteRetries(SUITES['bridge-out-epoch'])).toBe(0);
    expect(suiteRetries(SUITES['bridge-out'])).toBe(0);
  });

  it('defaults to one retry elsewhere, to absorb a transient blip', () => {
    expect(suiteRetries(SUITES.swap)).toBe(1);
    expect(suiteRetries(SUITES['bridge-out-agglayer'])).toBe(1);
  });
});

describe('run', () => {
  it('resolves a non-zero code when the command cannot be spawned', async () => {
    // 'error' fires instead of 'close' on a spawn failure, so a listener on
    // 'close' alone left this pending forever and hung the whole script.
    await expect(run('this-command-does-not-exist-e2e-real', [], {})).resolves.not.toBe(0);
  }, 15_000);

  // main() hands every child the operator's whole environment, so leaving a key out of `env` strips nothing.
  it('deletes each unset name from the inherited environment, and a value given in env still wins', async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-run-')), 'env.json');
    const dump = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
    process.env.E2E_REAL_RUN_INHERITED = 'inherited';
    process.env.E2E_REAL_RUN_GIVEN = 'inherited';
    try {
      const code = await run(
        process.execPath,
        ['-e', dump],
        { E2E_REAL_RUN_ADDED: 'added', E2E_REAL_RUN_GIVEN: 'given' },
        { unset: ['E2E_REAL_RUN_INHERITED', 'E2E_REAL_RUN_GIVEN'] }
      );
      expect(code).toBe(0);
      const env = JSON.parse(readFileSync(out, 'utf8'));
      expect(env.E2E_REAL_RUN_INHERITED).toBeUndefined();
      expect(env.E2E_REAL_RUN_ADDED).toBe('added');
      expect(env.E2E_REAL_RUN_GIVEN).toBe('given');
    } finally {
      delete process.env.E2E_REAL_RUN_INHERITED;
      delete process.env.E2E_REAL_RUN_GIVEN;
    }
  }, 15_000);
});

describe('pricedAmountFrom', () => {
  const reply = (amount: unknown) => ({ path: [[[[{}], [{}], [{}, { token: { amount } }]]]] });

  it('returns the amount when the route is priced', () => {
    expect(pricedAmountFrom(reply('991699999999999999'))).toBe('991699999999999999');
  });

  it('rejects a success reply that carries no route', () => {
    expect(pricedAmountFrom({ success: true })).toBeUndefined();
  });

  it('rejects a zero amount - a zero price is not a quote', () => {
    expect(pricedAmountFrom(reply('0'))).toBeUndefined();
  });

  it('rejects an unparseable amount', () => {
    expect(pricedAmountFrom(reply('not-a-number'))).toBeUndefined();
  });
});

/**
 * The AggLayer indexer guard (#1325). The Slow bridge-out finds its deposit by the network id the indexer files
 * Miden exits under, and a renumbering once left every bridge-out unsettled with no error anywhere. E2E Bridge runs
 * this probe on its own, after the suite, so a renumbering fails that job without hiding the suite's own result.
 */
describe('the AggLayer indexer guard', () => {
  // Miden exit 0 as the live testnet indexer serves it, trimmed to the fields the guard reads.
  const LIVE = {
    deposit: {
      deposit_cnt: 0,
      network_id: 73,
      dest_net: 0,
      tx_hash: '0x7f575a1303af796b028c12c0e9a920800c411fd04064aa6c77a9c0439988b9db'
    }
  };

  // The wallet derives the rollup id from the bridge account; the probe holds the testnet's, the network the live
  // indexer files Miden exit 0 under.
  it('pins the testnet rollup id: the network the testnet indexer filed Miden exit 0 under', () => {
    expect(AGGLAYER_MIDEN_NETWORK_ID).toBe(LIVE.deposit.network_id);
  });

  it('accepts the live filing', () => {
    expect(agglayerExitFilingProblem(200, LIVE)).toBeUndefined();
  });

  it.each([
    ['an unknown deposit (HTTP 500)', 500, { code: 2, message: 'not found' }, 'HTTP 500'],
    [
      'a renumbered network (78)',
      200,
      { deposit: { ...LIVE.deposit, network_id: 78 } },
      'under network 78, not the testnet rollup id 73'
    ],
    [
      'an exit bound elsewhere (dest_net 1)',
      200,
      { deposit: { ...LIVE.deposit, dest_net: 1 } },
      'network 1, not Sepolia'
    ]
  ])('refuses %s', (_label, status, body, reason) => {
    expect(agglayerExitFilingProblem(status, body)).toContain(reason);
  });

  // E2E Bridge must not go red on one gateway blip, so a failed GET or a problem answer is asked again once.
  describe('retrying once', () => {
    const RENUMBERED = { deposit: { ...LIVE.deposit, network_id: 78 } };

    // `record` prints one line per probe.
    beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('asks once when the first GET shows the live filing', async () => {
      const get = jest.fn().mockResolvedValue({ status: 200, body: LIVE });

      await expect(probeAgglayerIndexer(INDEXER, { get, retryDelayMs: 0 })).resolves.toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith(`${INDEXER}/bridge?net_id=73&deposit_cnt=0`);
    });

    it.each([
      ['a GET that throws', () => Promise.reject(new Error('socket hang up'))],
      ['a gateway error', () => Promise.resolve({ status: 502, body: 'Bad Gateway' })]
    ])('passes on the second GET after %s', async (_label, firstAnswer) => {
      const get = jest.fn().mockImplementationOnce(firstAnswer).mockResolvedValueOnce({ status: 200, body: LIVE });

      await expect(probeAgglayerIndexer(INDEXER, { get, retryDelayMs: 0 })).resolves.toBe(true);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('fails a renumbering, which the second GET shows again', async () => {
      const get = jest.fn().mockResolvedValue({ status: 200, body: RENUMBERED });

      await expect(probeAgglayerIndexer(INDEXER, { get, retryDelayMs: 0 })).resolves.toBe(false);
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  it('is probed by both bridge-out suites that take the Slow route', () => {
    expect(SUITES['bridge-out-agglayer'].probes).toContain('agglayer');
    expect(SUITES['bridge-out'].probes).toContain('agglayer');
  });

  // E2E Bridge sets E2E_SEPOLIA_RPC_URL from an optional secret, which is empty when unset, and the indexer probe
  // reads no Sepolia URL, so its own refusal must come before the empty-variable ones. No network: the suite is refused.
  it('refuses a --suite beside --agglayer-indexer-only, ahead of any empty-variable refusal', () => {
    const res = runCli({ E2E_SEPOLIA_RPC_URL: '' }, '--agglayer-indexer-only', '--suite', 'swap');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--agglayer-indexer-only probes one service and takes no --suite');
    expect(res.stderr).not.toContain('is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);
});

describe('probeAgglayerIndexer uses the shared check', () => {
  // Source-level, like probeEpochQuote's. The probe's verdict is also tested above through an injected GET; its call
  // sites in main(), which does live network I/O, are reachable only here.
  const source = readFileSync(path.join(__dirname, 'e2e-real.mjs'), 'utf8');
  const body = /async function probeAgglayerIndexer\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';

  it('finds the function', () => {
    expect(body).not.toBe('');
  });

  it('decides with agglayerExitFilingProblem', () => {
    expect(body).toContain('agglayerExitFilingProblem(status, body)');
  });

  // Each call asks the indexer the config document names, never a copy kept in the runner.
  it('runs for a suite that needs it and for --agglayer-indexer-only', () => {
    expect(source).toContain(
      "if (targets && needs.includes('agglayer')) await probeAgglayerIndexer(targets.indexerUrl);"
    );
    expect(source.match(/await probeAgglayerIndexer\(targets\.indexerUrl\);/g)).toHaveLength(2);
    expect(source.match(/probeAgglayerIndexer\(/g)).toHaveLength(3);
  });
});

describe('probeEpochQuote uses the shared parser', () => {
  // A source-level assertion, deliberately: probeEpochQuote is module-private and
  // does live network I/O, so the call site cannot be reached behaviourally from
  // a unit test. It is worth pinning anyway, because this exact regression has
  // already happened once - pricedAmountFrom was extracted and tested while the
  // probe kept its own inline copy, so four passing tests proved nothing about
  // the gate they were written for.
  const source = readFileSync(path.join(__dirname, 'e2e-real.mjs'), 'utf8');
  const body = /async function probeEpochQuote\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';

  it('finds the function', () => {
    expect(body).not.toBe('');
  });

  it('calls pricedAmountFrom rather than re-parsing the reply', () => {
    expect(body).toContain('pricedAmountFrom(res)');
  });

  it('keeps no inline copy of the path parse', () => {
    expect(body).not.toContain('token?.amount');
  });
});

// Every invocation here passes --preflight-only, so a refusal that regresses can reach the probes but never a build.
describe('the usdcx suites refuse what would not apply, before any probe or build', () => {
  const ARC_KEY = `0x${'5a'.repeat(32)}`;
  const MALFORMED = `0x${'5a'.repeat(31)}zz`;
  const printed = (res: { stdout: string; stderr: string }) => `${res.stdout}${res.stderr}`;

  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --network devnet for --suite %s',
    suite => {
      const res = runCli('--suite', suite, '--network', 'devnet', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`--suite ${suite} runs on testnet only`);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each(['usdcx', 'usdcx-in', 'usdcx-burn'])(
    'refuses --skip-build for --suite %s',
    suite => {
      const res = runCli({ E2E_ARC_PRIVATE_KEY: ARC_KEY }, '--suite', suite, '--skip-build', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`--skip-build is refused for --suite ${suite}`);
      expect(printed(res)).not.toContain(ARC_KEY.slice(2));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each([
    ['E2E_EVM_RPC_URL', 'https://refused-evm-rpc.example'],
    ['MIDEN_E2E_USDCX_CHAIN', 'refused-usdcx-chain'],
    ['MIDEN_FEE_FAUCET_ID', '0xrefusedfeefaucet'],
    ['GUARDIAN_URL', 'https://refused-guardian.example']
  ])(
    'refuses an exported %s by name, never by value',
    (name, value) => {
      const res = runCli({ [name]: value }, '--suite', 'usdcx-burn', '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${name} is set, and --suite usdcx-burn refuses it`);
      expect(printed(res)).not.toContain(value);
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses usdcx-in with no key and no harness key, naming both ways to give one', () => {
    const res = runCli('--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      '--suite usdcx-in has no Arc key: pass --arc-key or export E2E_ARC_PRIVATE_KEY, or run --suite usdcx first'
    );
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses usdcx-in with E2E_ARC_PRIVATE_KEY set but empty', () => {
    const res = runCli({ E2E_ARC_PRIVATE_KEY: '' }, '--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_ARC_PRIVATE_KEY is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it.each([
    ['--arc-key', {}, ['--arc-key', MALFORMED]],
    ['E2E_ARC_PRIVATE_KEY', { E2E_ARC_PRIVATE_KEY: MALFORMED }, []]
  ])(
    'refuses a malformed key from %s without printing it',
    (_source, env, args) => {
      const res = runCli(env, '--suite', 'usdcx-in', ...args, '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('the Arc key (--arc-key or E2E_ARC_PRIVATE_KEY) is not a valid private key');
      expect(printed(res)).not.toContain('5a'.repeat(31));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it.each(['usdcx', 'usdcx-burn', 'swap'])(
    'refuses --arc-key on --suite %s without printing it',
    suite => {
      const res = runCli('--suite', suite, '--arc-key', ARC_KEY, '--preflight-only');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--arc-key applies only to --suite usdcx-in');
      expect(printed(res)).not.toContain(ARC_KEY.slice(2));
      expect(res.stdout).not.toContain('Preflight');
    },
    35_000
  );

  it('refuses --arc-rpc on a suite that never reads Arc, without printing it', () => {
    const res = runCli('--suite', 'swap', '--arc-rpc', 'https://arc-rpc.example/token-in-path', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--arc-rpc applies only to the usdcx suites');
    expect(printed(res)).not.toContain('token-in-path');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses E2E_ARC_RPC_URL set but empty on a usdcx suite', () => {
    const res = runCli({ E2E_ARC_RPC_URL: '' }, '--suite', 'usdcx', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('E2E_ARC_RPC_URL is set but empty');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses an Arc RPC that is not an http(s) URL, without printing it', () => {
    const res = runCli('--suite', 'usdcx', '--arc-rpc', 'ftp://arc-rpc.example/token-in-path', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('the Arc RPC (--arc-rpc or E2E_ARC_RPC_URL) is not an http(s) URL');
    expect(printed(res)).not.toContain('token-in-path');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('never echoes an --arc-key given with =', () => {
    const res = runCli(`--arc-key=${ARC_KEY}`, '--suite', 'usdcx-in', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: --arc-key=<value>');
    expect(printed(res)).not.toContain(ARC_KEY.slice(2));
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses another option as the value of --arc-key', () => {
    const res = runCli('--suite', 'usdcx-in', '--arc-key', '--preflight-only');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--arc-key needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);
});

describe('resolveOperatorInput on the usdcx suites', () => {
  const ARC_KEY = `0x${'ab'.repeat(32)}`;
  // What parseArgs returns for `--suite usdcx` with nothing exported; each case changes only what it names.
  const parsed = {
    suite: 'usdcx',
    network: 'testnet',
    sepoliaRpc: 'https://sepolia.invalid',
    sepoliaKey: undefined,
    arcRpc: undefined,
    arcKey: undefined,
    arcRpcFlag: false,
    arcKeyFlag: false,
    refusedExports: [],
    minEth: '0.02',
    preflightOnly: false,
    skipBuild: false,
    headed: false,
    grep: undefined
  };
  const resolve = (changed: Record<string, unknown> = {}) => resolveOperatorInput({ ...parsed, ...changed });

  it.each([
    ['usdcx', {}],
    ['usdcx-burn', {}],
    ['usdcx-in', {}],
    ['usdcx-in', { arcKey: ARC_KEY }],
    ['usdcx-in', { arcKey: 'ab'.repeat(32), arcKeyFlag: true }],
    ['usdcx', { arcRpc: 'https://arc-rpc.example', arcRpcFlag: true }]
  ])('accepts --suite %s with %o', (suite, changed) => {
    expect(resolve({ suite, ...changed })).toStrictEqual({ suite: SUITES[suite], grep: SUITES[suite].grep });
  });

  // The runner hands usdcx and usdcx-burn the harness key over an exported one, so neither reads it.
  it('lets an exported key that is malformed pass on usdcx, which never reads it', () => {
    expect(resolve({ arcKey: '0x01' }).error).toBeUndefined();
  });

  it('leaves the usdcx refusals off a suite that is not usdcx', () => {
    expect(
      resolve({ suite: 'swap-guardian', refusedExports: ['GUARDIAN_URL', 'E2E_EVM_RPC_URL'] }).error
    ).toBeUndefined();
  });
});

const PLAYWRIGHT_CLI = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

interface ListedSuite {
  title: string;
  specs?: { title: string }[];
  suites?: ListedSuite[];
}

// Playwright's own listing of playwright.usdcx.config.ts as `<describe> > <test>`, narrowed by `grep` the way the
// runner passes it. usdcx-burn builds its two titles in a loop, so no reading of the spec source can stand in for
// this. List mode loads the files and writes nothing: no global setup, no output-dir cleanup.
function listUsdcxTests(grep?: string) {
  const env = cleanEnv();
  // Playwright refuses to declare a test while JEST_WORKER_ID is set, and this child inherits it from the worker.
  delete env.JEST_WORKER_ID;
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const res = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--list',
      '--config',
      'playwright.usdcx.config.ts',
      '--reporter=json',
      ...(grep === undefined ? [] : ['--grep', grep])
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
  );
  let report: { suites: ListedSuite[]; errors: unknown[] };
  try {
    report = JSON.parse(res.stdout);
  } catch {
    // A config that throws at load prints its error to stderr and no report.
    throw new Error(
      `playwright --list printed no JSON report (exit ${res.status}): ${res.stderr}\n${res.stdout.slice(0, 200)}`
    );
  }
  const tests: string[] = [];
  const walk = (suite: ListedSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) tests.push([...titles, spec.title].join(' > '));
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites) walk(file, []);
  return { tests: tests.sort(), errors: report.errors };
}

describe('the usdcx suites', () => {
  const OWN: Record<string, string> = {
    usdcx: 'USDCx round trip: burn to the harness Arc key, Circle payout, deposit back',
    'usdcx-in': 'USDCx bridge-in from a funded Arc key',
    'usdcx-burn': 'USDCx burn through the Send UI after a public faucet grant'
  };
  let listed: ReturnType<typeof listUsdcxTests>;

  beforeAll(() => {
    listed = listUsdcxTests();
  }, 60_000);

  it('find the three describes and four tests the contract names under playwright.usdcx.config.ts', () => {
    expect(listed.errors).toEqual([]);
    expect([...new Set(listed.tests.map(test => test.split(' > ')[0]))].sort()).toEqual(Object.values(OWN).sort());
    expect(listed.tests).toHaveLength(4);
    expect(listed.tests.filter(test => test.startsWith(`${OWN['usdcx-burn']} > `))).toEqual([
      `${OWN['usdcx-burn']} > Guardian wallet publishes a burn, the faucet consumes it and Circle pays it out`,
      `${OWN['usdcx-burn']} > standard wallet publishes a burn, the faucet consumes it and Circle pays it out`
    ]);
  });

  it.each(Object.keys(OWN))(
    '--suite %s greps exactly the tests of its own describe',
    name => {
      const own = listed.tests.filter(test => test.startsWith(`${OWN[name]} > `));
      expect(listUsdcxTests(composeGrep(SUITES[name].grep, undefined))).toEqual({ tests: own, errors: [] });
    },
    60_000
  );

  // Each spends a faucet grant, a burn Circle pays out or a deposit Circle mints; a retry spends it again.
  it.each(Object.keys(OWN))('--suite %s runs playwright.usdcx.config.ts on testnet, with no retries', name => {
    expect(SUITES[name]).toMatchObject({ config: 'playwright.usdcx.config.ts', networks: ['testnet'], usdcx: true });
    expect(suiteRetries(SUITES[name])).toBe(0);
  });

  it('takes an Arc key on usdcx-in alone', () => {
    expect(Object.keys(SUITES).filter(name => SUITES[name].arcKey)).toEqual(['usdcx-in']);
  });
});

// Guards: both pass before this change and must after it.
describe('the usdcx refusals stay out of the other entry points', () => {
  it('swap-guardian still probes an exported GUARDIAN_URL override', () => {
    const res = preflight('swap-guardian', DOCUMENT, { GUARDIAN_URL: 'https://guardian-override.example' });
    expect(res.requests).toContain('https://guardian-override.example\n');
    expect(res.output).not.toContain('GUARDIAN_URL is set');
    expect(res.status).toBe(0);
  }, 35_000);

  it('--agglayer-indexer-only with every refused variable exported reads the document and asks only its indexer', () => {
    const res = stubbed(['--agglayer-indexer-only'], DOCUMENT, {
      E2E_EVM_RPC_URL: 'https://evm.example',
      MIDEN_E2E_USDCX_CHAIN: 'sepolia',
      MIDEN_FEE_FAUCET_ID: '0x01',
      GUARDIAN_URL: 'https://guardian.example',
      E2E_ARC_RPC_URL: '',
      E2E_ARC_PRIVATE_KEY: ''
    });
    expect(res.requests.trim().split('\n')).toEqual([
      PUBLISHED,
      `${INDEXER}/bridge?net_id=${AGGLAYER_MIDEN_NETWORK_ID}&deposit_cnt=0`
    ]);
    expect(res.status).toBe(0);
  }, 35_000);
});

describe('the bounded rate-limit retry on Arc and Circle calls', () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body)
  });
  const answer = (result: string) => reply(200, { jsonrpc: '2.0', id: 1, result });
  const refusal = (code: number, message: string) => reply(200, { jsonrpc: '2.0', id: 1, error: { code, message } });
  const ARC = 'https://arc-rpc.example';

  it('asks again after 429 and 429, waiting what each Retry-After named up to 10 s, and takes the third answer', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(429, 'Too Many Requests', { 'retry-after': '2' }))
      .mockResolvedValueOnce(reply(429, 'Too Many Requests', { 'retry-after': '30' }))
      .mockResolvedValueOnce(answer('0x4cef52'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_chainId', [], { fetchImpl, sleep })).resolves.toBe('0x4cef52');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [10_000]]);
  });

  it('asks again after a JSON-RPC -32005, waiting 1 s when nothing names a wait', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(refusal(-32005, 'limit exceeded'))
      .mockResolvedValueOnce(answer('0x1'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_blockNumber', [], { fetchImpl, sleep })).resolves.toBe('0x1');
    expect(sleep.mock.calls).toEqual([[1_000]]);
  });

  it('fails a -32012 at once: only a rate limit is asked again', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(refusal(-32012, 'credits exhausted'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_call', [], { fetchImpl, sleep })).rejects.toMatchObject({
      code: -32012,
      message: 'eth_call: credits exhausted'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the third retry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, 'Too Many Requests', { 'retry-after': '1' }));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(arcRpc(ARC, 'eth_chainId', [], { fetchImpl, sleep })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('asks Circle again after a 429', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(429, 'slow down'))
      .mockResolvedValueOnce(reply(200, { remoteDomains: [] }));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(circleGet('https://circle.example/v1/info', { fetchImpl, sleep })).resolves.toMatchObject({
      status: 200,
      body: { remoteDomains: [] }
    });
    expect(sleep.mock.calls).toEqual([[1_000]]);
  });
});

describe('arcRpcEndpoints', () => {
  it("asks drpc, then QuickNode, then arc.io, the wallet's own Arc RPC, last", () => {
    expect(arcRpcEndpoints(undefined)).toEqual([
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io',
      'https://rpc.testnet.arc.io'
    ]);
  });

  it('asks an operator endpoint first', () => {
    expect(arcRpcEndpoints('https://arc-rpc.example')).toEqual(['https://arc-rpc.example', ...DEFAULT_ARC_RPCS]);
  });

  it('asks a default the operator named once, first', () => {
    expect(arcRpcEndpoints('https://rpc.testnet.arc.io')).toEqual([
      'https://rpc.testnet.arc.io',
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io'
    ]);
  });
});

describe('usdcxGrantProblem', () => {
  // The live testnet faucet's get_metadata, 2026-10-10.
  const LIVE = {
    version: '0.17.1',
    decimals: 6,
    base_amount: 100000000,
    token_amounts: [1, 10, 100],
    balance: 999444411348973
  };

  it('passes the live faucet, which offers the 10 USDCx tier every usdcx wallet asks for', () => {
    expect(usdcxGrantProblem(LIVE)).toBeUndefined();
  });

  it('asks the smallest live tier that leaves a 1 USDCx burn and its fees their margin', () => {
    // 210: the most a grant's consume fee takes at testnet's base fee of 7 (base fee x 30).
    const covering = LIVE.token_amounts
      .map(tokens => BigInt(tokens) * 10n ** BigInt(USDCX_DECIMALS))
      .filter(units => units - 210n >= USDCX_GRANT_FLOOR_UNITS);
    expect(covering[0]).toBe(USDCX_GRANT_UNITS);
  });

  it('fails a faucet whose token_amounts lack the 10 USDCx tier', () => {
    expect(usdcxGrantProblem({ ...LIVE, token_amounts: [1, 100] })).toBe(
      'offers token_amounts [1, 100], not the 10 USDCx tier every usdcx wallet asks for'
    );
  });

  it('fails a faucet that lists no token_amounts', () => {
    const { token_amounts: _dropped, ...untiered } = LIVE;
    expect(usdcxGrantProblem(untiered)).toContain('offers token_amounts [], not the 10 USDCx tier');
  });

  it('fails a faucet that is not on six decimals', () => {
    expect(usdcxGrantProblem({ ...LIVE, decimals: 18 })).toContain("serves 18 decimals, not USDCx's 6");
  });

  it('fails a faucet holding less than one grant', () => {
    expect(usdcxGrantProblem({ ...LIVE, balance: 9_999_999 })).toContain('less than one grant of 10 USDCx');
  });

  it('fails a faucet that reports no balance', () => {
    const { balance: _dropped, ...unreported } = LIVE;
    expect(usdcxGrantProblem(unreported)).toBe('reports no readable balance');
  });
});

// The runner reads no TypeScript at import, so it keeps copies; each must equal what the specs and the wallet use.
// The wallet holds no GatewayMinter and no harness floors, so the harness stands in twice for those rows.
describe('the usdcx constants are the ones the harness and the wallet use', () => {
  it.each([
    ['ARC_TESTNET_CHAIN_ID', ARC_TESTNET_CHAIN_ID, harness.ARC_CHAIN_ID, ARC_TESTNET.id],
    ['ARC_XRESERVE', ARC_XRESERVE, harness.ARC_XRESERVE, wallet.XRESERVE_ADDRESS.get(ARC_TESTNET.id)],
    ['ARC_USDC', ARC_USDC, harness.ARC_USDC, wallet.CIRCLE_USDC_ADDRESS.get(ARC_TESTNET.id)],
    ['ARC_CIRCLE_DOMAIN', ARC_CIRCLE_DOMAIN, harness.ARC_CIRCLE_DOMAIN, wallet.CIRCLE_DOMAIN.get(ARC_TESTNET.id)],
    ['USDCX_REMOTE_DOMAIN', USDCX_REMOTE_DOMAIN, harness.USDCX_REMOTE_DOMAIN, wallet.USDCX_REMOTE_DOMAIN],
    [
      'XRESERVE_API_TESTNET',
      XRESERVE_API_TESTNET,
      harness.ARC_ATTESTATION_API,
      wallet.XRESERVE_ATTESTATION_API_TESTNET
    ],
    ['USDCX_DECIMALS', USDCX_DECIMALS, wallet.USDCX_DECIMALS, wallet.USDCX_DECIMALS],
    ['GATEWAY_MINTER', GATEWAY_MINTER, harness.GATEWAY_MINTER, harness.GATEWAY_MINTER],
    [
      'USDCX_GRANT_FLOOR_UNITS',
      USDCX_GRANT_FLOOR_UNITS,
      harness.BURN_UNITS + harness.GRANT_MARGIN_UNITS,
      harness.BURN_UNITS + harness.GRANT_MARGIN_UNITS
    ],
    [
      'USDCX_FUNDED_KEY_FLOOR_UNITS',
      USDCX_FUNDED_KEY_FLOOR_UNITS,
      harness.DEPOSIT_UNITS + harness.GAS_RESERVE_UNITS,
      harness.DEPOSIT_UNITS + harness.GAS_RESERVE_UNITS
    ],
    ['USDCX_GRANT_UNITS', USDCX_GRANT_UNITS, harness.GRANT_UNITS, harness.GRANT_UNITS],
    ['HARNESS_ARC_KEY_FILE', HARNESS_ARC_KEY_FILE, harness.HARNESS_ARC_KEY_FILE, harness.HARNESS_ARC_KEY_FILE]
  ])('%s matches', (_name, runner, harnessValue, walletValue) => {
    expect([harnessValue, walletValue]).toEqual([runner, runner]);
  });

  it('tries the same Arc RPCs in the same order as the harness', () => {
    expect(DEFAULT_ARC_RPCS).toEqual([...harness.DEFAULT_ARC_RPCS]);
  });
});

describe('the usdcx preflight', () => {
  // Any valid secp256k1 scalar: the stub answers every read, so nothing is ever signed or sent.
  const ARC_KEY: `0x${string}` = `0x${'11'.repeat(32)}`;
  const KEYED = { E2E_ARC_PRIVATE_KEY: ARC_KEY };
  const VIEWS = parseAbi([
    'function paused() view returns (bool)',
    'function domainDepositsPaused(uint32) view returns (bool)',
    'function domainWithdrawalsPaused(uint32) view returns (bool)',
    'function getRemoteToken(uint32, address) view returns (bytes32)',
    'function gatewayMinter() view returns (address)',
    'function isRemoteDomainRegistered(uint32) view returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ]);
  // How the stub logs an eth_call, so the runner's calldata is checked against viem's ABI encoding.
  const call = (to: string, data: string) => `{"to":"${to}","data":"${data}"}`;
  const XRESERVE_CALLS = {
    registered: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'isRemoteDomainRegistered', args: [10007] })
    ),
    remoteToken: call(
      ARC_XRESERVE,
      encodeFunctionData({
        abi: VIEWS,
        functionName: 'getRemoteToken',
        args: [10007, '0x3600000000000000000000000000000000000000']
      })
    ),
    paused: call(ARC_XRESERVE, encodeFunctionData({ abi: VIEWS, functionName: 'paused' })),
    depositsPaused: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'domainDepositsPaused', args: [10007] })
    ),
    withdrawalsPaused: call(
      ARC_XRESERVE,
      encodeFunctionData({ abi: VIEWS, functionName: 'domainWithdrawalsPaused', args: [10007] })
    ),
    gatewayMinter: call(ARC_XRESERVE, encodeFunctionData({ abi: VIEWS, functionName: 'gatewayMinter' }))
  };
  const BALANCE_OF = '"data":"0x70a08231';
  // The stub's getRemoteToken answer, and Arc's xReserve as Circle's /v1/info lists it.
  const REMOTE_TOKEN = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';
  const ARC_SOURCE = { chain: 'Arc', domain: ARC_CIRCLE_DOMAIN, contractAddress: ARC_XRESERVE };
  const missing = (requests: string, expected: string[]) => expected.filter(request => !requests.includes(request));
  const failedChecks = (output: string) =>
    /✗ preflight failed \(\d+\/\d+\): ([^\n]*)/.exec(output)?.[1].split(', ') ?? [];

  it('asks usdcx every Arc, Circle, Guardian and faucet question, the payout ones included', () => {
    const res = preflight('usdcx');
    expect(res.output).toContain('✓ preflight passed (11 checks)');
    expect(res.status).toBe(0);
    expect(
      missing(res.requests, [
        'https://rpc.drpc.testnet.arc.io eth_chainId []',
        'https://rpc.drpc.testnet.arc.io eth_sendRawTransaction ["0x00"]',
        `eth_getCode ["${ARC_XRESERVE}","latest"]`,
        ...Object.values(XRESERVE_CALLS),
        `eth_getCode ["${GATEWAY_MINTER}","latest"]`,
        `${XRESERVE_API_TESTNET}/v1/info`,
        'https://guardian.openzeppelin.com/status',
        'https://guardian.openzeppelin.com/pubkey?scheme=ecdsa',
        'https://faucet-api.testnet.miden.io/get_metadata',
        'native asset https://rpc.testnet.miden.io'
      ])
    ).toEqual([]);
    expect(res.requests).not.toContain(BALANCE_OF);
    expect(res.requests).not.toContain('SPAWN');
  }, 35_000);

  it('asks usdcx-in for the funded key and no payout question, printing its address and never the key', () => {
    const { address } = privateKeyToAccount(ARC_KEY);
    const res = preflight('usdcx-in', DOCUMENT, KEYED);
    expect(res.output).toContain('✓ preflight passed (10 checks)');
    expect(res.status).toBe(0);
    expect(res.requests).toContain(
      call(ARC_USDC, encodeFunctionData({ abi: VIEWS, functionName: 'balanceOf', args: [address] }))
    );
    expect(res.requests).not.toContain(XRESERVE_CALLS.gatewayMinter);
    expect(res.requests).not.toContain(XRESERVE_CALLS.withdrawalsPaused);
    expect(res.output).toContain(address);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
  }, 35_000);

  // Each usdcx-burn test waits for its own payout, so the runner asks the payout questions before the build.
  it('asks usdcx-burn the payout questions and no funded-key question', () => {
    const res = preflight('usdcx-burn');
    expect(res.output).toContain('✓ preflight passed (11 checks)');
    expect(res.status).toBe(0);
    expect(
      missing(res.requests, [
        'https://faucet-api.testnet.miden.io/get_metadata',
        XRESERVE_CALLS.withdrawalsPaused,
        XRESERVE_CALLS.gatewayMinter,
        `eth_getCode ["${GATEWAY_MINTER}","latest"]`
      ])
    ).toEqual([]);
    expect(res.requests).not.toContain(BALANCE_OF);
  }, 35_000);

  it.each([
    ['Arc RPC', 'usdcx', { arcChainId: '0xaa36a7' }],
    [
      'Arc write endpoint',
      'usdcx',
      { rawTransaction: { code: -32601, message: 'the method eth_sendRawTransaction does not exist/is not available' } }
    ],
    ['xReserve', 'usdcx', { registered: false }],
    ['xReserve pause', 'usdcx', { depositsPaused: true }],
    // One row per check of Circle's /v1/info: Miden listed without the on-chain token, then another source contract.
    [
      'Circle xReserve API',
      'usdcx',
      {
        circleInfo: {
          sourceDomains: [ARC_SOURCE],
          remoteDomains: [{ chain: 'Miden', domain: USDCX_REMOTE_DOMAIN, tokens: [] }]
        }
      }
    ],
    [
      'Circle xReserve API',
      'usdcx-burn',
      {
        circleInfo: {
          sourceDomains: [{ ...ARC_SOURCE, contractAddress: `0x${'33'.repeat(20)}` }],
          remoteDomains: [
            {
              chain: 'Miden',
              domain: USDCX_REMOTE_DOMAIN,
              tokens: [{ remoteToken: 'USDCx', remoteTokenIdentifier: REMOTE_TOKEN }]
            }
          ]
        }
      }
    ],
    ['USDCx native asset', 'usdcx', { nativeAsset: { id: '0x01', bytes32: `0x${'0'.repeat(64)}` } }],
    [
      'Guardian identity',
      'usdcx',
      { guardianStatus: { status: 'ok', version: '0.18.0', git_commit: 'fab5f5cb2c3f', environment: 'devnet' } }
    ],
    // Every usdcx wallet asks for the 10 USDCx tier by amount, so a faucet without it fails, whatever else it offers.
    [
      'USDCx faucet grant',
      'usdcx-burn',
      {
        faucet: {
          version: 'stub',
          decimals: 6,
          base_amount: 100000000,
          token_amounts: [1, 100],
          balance: 999444411348973
        }
      }
    ],
    ['Gateway minter', 'usdcx', { gatewayMinter: `0x${'22'.repeat(20)}` }],
    ['Arc funded key', 'usdcx-in', { usdcBalance: '20999' }]
  ])(
    'fails %s alone on --suite %s when its answer is wrong',
    (label, suite, answers) => {
      const res = preflight(suite, DOCUMENT, KEYED, answers);
      expect(failedChecks(res.output)).toEqual([label]);
      expect(res.status).toBe(1);
      expect(res.requests).not.toContain('SPAWN');
    },
    35_000
  );

  it('names the harness key and how to refill it when it holds less than usdcx-in needs, never the key', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-real-home-'));
    const file = path.join(home, '.miden-e2e', 'arc-keys', 'harness.json');
    const { address, privateKey } = await harnessArcKey(file, { create: true });
    const res = preflight('usdcx-in', DOCUMENT, { HOME: home }, { usdcBalance: '20999' });
    expect(failedChecks(res.output)).toEqual(['Arc funded key']);
    expect(res.output).toContain(
      `harness key ${address} holds 0.0209 USDC, below the 0.021 USDC one deposit and its gas need; refill it with ` +
        "yarn e2e:real --suite usdcx (each run's payout adds about 0.98 USDC), or pass --arc-key with a funded key"
    );
    expect(res.output).not.toContain(privateKey.slice(2));
    expect(res.status).toBe(1);
  }, 35_000);

  it.each([
    ['usdcx', ['xReserve pause']],
    ['usdcx-in', []],
    ['usdcx-burn', ['xReserve pause']]
  ])(
    'on paused withdrawals --suite %s fails %j: only a suite that waits for a payout withdraws',
    (suite, failed) => {
      const res = preflight(suite, DOCUMENT, KEYED, { withdrawalsPaused: true });
      expect(failedChecks(res.output)).toEqual(failed);
      expect(res.status).toBe(failed.length === 0 ? 0 : 1);
    },
    35_000
  );

  it('passes with drpc down, asking QuickNode everything after the chain checks', () => {
    const res = preflight('usdcx', DOCUMENT, {}, { arcDown: ['rpc.drpc.testnet.arc.io'] });
    expect(res.status).toBe(0);
    expect(res.requests).toContain('https://rpc.quicknode.testnet.arc.io eth_sendRawTransaction ["0x00"]');
    expect(res.requests).not.toContain('https://rpc.drpc.testnet.arc.io eth_sendRawTransaction');
  }, 35_000);

  it('asks a rate-limited endpoint again: 429, 429, then the answer', () => {
    const res = preflight('usdcx', DOCUMENT, {}, { rateLimited: { eth_chainId: 2 } });
    const asked = res.requests.split('\n').filter(line => line === 'https://rpc.drpc.testnet.arc.io eth_chainId []');
    expect(asked).toHaveLength(3);
    expect(res.status).toBe(0);
  }, 35_000);

  it('tries --arc-rpc first and never prints its path', () => {
    const res = stubbed(
      ['--suite', 'usdcx', '--arc-rpc', 'https://arc-rpc.example/secret-token', '--preflight-only'],
      DOCUMENT
    );
    const arcCalls = res.requests.split('\n').filter(line => line.includes(' eth_'));
    expect(arcCalls[0]).toBe('https://arc-rpc.example/secret-token eth_chainId []');
    expect(res.requests).toContain('https://arc-rpc.example/secret-token eth_sendRawTransaction ["0x00"]');
    expect(res.output).toContain(
      'Arc RPC  arc-rpc.example, rpc.drpc.testnet.arc.io, rpc.quicknode.testnet.arc.io, rpc.testnet.arc.io'
    );
    expect(res.output).not.toContain('secret-token');
    expect(res.status).toBe(0);
  }, 35_000);

  // The runner hands usdcx's test the harness key over it, so nothing on usdcx reads it.
  it('lets usdcx run with a malformed E2E_ARC_PRIVATE_KEY exported', () => {
    const res = preflight('usdcx', DOCUMENT, { E2E_ARC_PRIVATE_KEY: '0x01' });
    expect(res.status).toBe(0);
  }, 35_000);
});

describe('childEnvironments', () => {
  const SEPOLIA_KEY = `0x${'22'.repeat(32)}`;
  const CLI = '/cli/bin/miden-client';
  // What parseArgs returns for `--suite usdcx`; each case changes only what it names.
  const parsed = {
    suite: 'usdcx',
    network: 'testnet',
    sepoliaRpc: 'https://sepolia.invalid',
    sepoliaKey: undefined,
    arcRpc: undefined,
    arcKey: undefined,
    headed: false
  };

  // What resolveArcKey hands childEnvironments: the harness key, or usdcx-in's operator key.
  const HARNESS = { role: 'harness', privateKey: `0x${'cd'.repeat(32)}`, address: '0xharness' };
  const OPERATOR = { role: 'operator', privateKey: `0x${'ab'.repeat(32)}`, address: '0xoperator' };
  // Every phase drops every private key the operator may have exported, and gets back in env only the one it reads.
  const KEYS = ['E2E_ARC_PRIVATE_KEY', 'E2E_SEPOLIA_PRIVATE_KEY', 'USDCX_LIVE_EVM_PRIVATE_KEY'];

  it('builds usdcx with no key in reach and tests it with the harness key and its role', () => {
    expect(childEnvironments(parsed, SUITES.usdcx, CLI, HARNESS)).toStrictEqual({
      build: { env: { E2E_NETWORK: 'testnet' }, unset: KEYS },
      test: {
        env: {
          E2E_NETWORK: 'testnet',
          E2E_REAL_USDCX: 'true',
          MIDEN_CLIENT_BIN: CLI,
          E2E_ARC_PRIVATE_KEY: HARNESS.privateKey,
          E2E_ARC_KEY_ROLE: 'harness',
          E2E_HEADLESS: '1'
        },
        unset: KEYS
      }
    });
  });

  it("hands usdcx-in's test, and no build, the operator key and the operator's Arc RPC", () => {
    const opts = { ...parsed, suite: 'usdcx-in', arcKey: 'ab'.repeat(32), arcRpc: 'https://arc-rpc.example' };
    expect(childEnvironments(opts, SUITES['usdcx-in'], CLI, OPERATOR)).toStrictEqual({
      build: { env: { E2E_NETWORK: 'testnet' }, unset: KEYS },
      test: {
        env: {
          E2E_NETWORK: 'testnet',
          E2E_REAL_USDCX: 'true',
          MIDEN_CLIENT_BIN: CLI,
          E2E_ARC_RPC_URL: 'https://arc-rpc.example',
          E2E_ARC_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
          E2E_ARC_KEY_ROLE: 'operator',
          E2E_HEADLESS: '1'
        },
        unset: KEYS
      }
    });
  });

  it('runs headed under --headed, and unsets an exported E2E_HEADLESS', () => {
    const { test } = childEnvironments(
      { ...parsed, suite: 'usdcx-burn', headed: true },
      SUITES['usdcx-burn'],
      CLI,
      HARNESS
    );
    expect(test.env).not.toHaveProperty('E2E_HEADLESS');
    expect(test.unset).toStrictEqual([...KEYS, 'E2E_HEADLESS']);
  });

  it('builds a suite that is not usdcx with no key in reach, and hands its test the Sepolia key alone', () => {
    const env = { E2E_NETWORK: 'testnet', E2E_REAL_EPOCH: 'true', E2E_SEPOLIA_RPC_URL: 'https://sepolia.invalid' };
    expect(
      childEnvironments({ ...parsed, suite: 'swap', sepoliaKey: SEPOLIA_KEY }, SUITES.swap, undefined)
    ).toStrictEqual({
      build: { env, unset: KEYS },
      test: { env: { ...env, E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY }, unset: KEYS }
    });
  });
});

describe('a usdcx run', () => {
  const ARC_KEY: `0x${string}` = `0x${'11'.repeat(32)}`;
  const SEPOLIA_KEY = `0x${'22'.repeat(32)}`;
  // The iOS nightly's Arc key name, which an operator who runs both may have exported.
  const IOS_KEY = `0x${'33'.repeat(32)}`;
  const STUB_CLI = '/stub/cli/bin/miden-client';
  interface Spawned {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  // The stub logs the CLI install and each child run() starts, with the environment names a phase sets or unsets.
  const spawned = (requests: string): Spawned[] =>
    requests
      .split('\n')
      .filter(line => line.startsWith('SPAWN '))
      .map(line => JSON.parse(line.slice('SPAWN '.length)));
  const testArgs = (grep: string) => [
    'playwright',
    'test',
    '--config',
    'playwright.usdcx.config.ts',
    '--retries=0',
    '--grep',
    grep
  ];
  const lockOf = (home: string) => path.join(home, '.miden-e2e', 'usdcx-run.lock');
  const harnessFileOf = (home: string) => path.join(home, '.miden-e2e', 'arc-keys', 'harness.json');

  it('creates the harness key under the lock, installs, preflights and builds with no key, then tests with the harness key', () => {
    const res = stubbed(['--suite', 'usdcx'], DOCUMENT, {
      E2E_ARC_PRIVATE_KEY: ARC_KEY,
      E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY,
      USDCX_LIVE_EVM_PRIVATE_KEY: IOS_KEY
    });
    const harness = JSON.parse(readFileSync(harnessFileOf(res.home), 'utf8'));
    // The installer runs every crate's build script under cargo, and the native-asset child is a ts-node preflight.
    expect(res.requests).toContain('native asset https://rpc.testnet.miden.io {}\n');
    expect(spawned(res.requests)).toEqual([
      { command: 'install-pinned-miden-cli', args: ['scripts/install-pinned-miden-cli.cjs', 'install'], env: {} },
      { command: 'yarn', args: ['test:e2e:blockchain:build'], env: { E2E_NETWORK: 'testnet' } },
      {
        command: 'yarn',
        args: testArgs('USDCx round trip'),
        env: {
          E2E_NETWORK: 'testnet',
          E2E_REAL_USDCX: 'true',
          MIDEN_CLIENT_BIN: STUB_CLI,
          E2E_ARC_PRIVATE_KEY: harness.privateKey,
          E2E_ARC_KEY_ROLE: 'harness',
          E2E_HEADLESS: '1'
        }
      }
    ]);
    expect(harness).toMatchObject({ role: 'harness', walletAddress: '' });
    expect(statSync(harnessFileOf(res.home)).mode & 0o777).toBe(0o600);
    expect(res.output).toContain(`Arc key  harness ${harness.address}`);
    expect(res.output).toContain('· E2E_ARC_PRIVATE_KEY is exported but applies only to --suite usdcx-in');
    expect(res.output).not.toContain(harness.privateKey.slice(2));
    expect(res.output).not.toContain(ARC_KEY.slice(2));
    expect(res.output).not.toContain(SEPOLIA_KEY.slice(2));
    expect(res.output).not.toContain(IOS_KEY.slice(2));
    expect(existsSync(lockOf(res.home))).toBe(false);
    expect(res.status).toBe(0);
  }, 35_000);

  it("hands usdcx-in's test, and only it, the --arc-key and the --arc-rpc", () => {
    const res = stubbed(
      ['--suite', 'usdcx-in', '--arc-key', '11'.repeat(32), '--arc-rpc', 'https://arc-rpc.example'],
      DOCUMENT,
      { E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY, USDCX_LIVE_EVM_PRIVATE_KEY: IOS_KEY }
    );
    const [install, build, test] = spawned(res.requests);
    expect(install.env).toEqual({});
    expect(build.env).toEqual({ E2E_NETWORK: 'testnet' });
    expect(test).toEqual({
      command: 'yarn',
      args: testArgs('funded Arc key'),
      env: {
        E2E_NETWORK: 'testnet',
        E2E_REAL_USDCX: 'true',
        MIDEN_CLIENT_BIN: STUB_CLI,
        E2E_HEADLESS: '1',
        E2E_ARC_PRIVATE_KEY: ARC_KEY,
        E2E_ARC_KEY_ROLE: 'operator',
        E2E_ARC_RPC_URL: 'https://arc-rpc.example'
      }
    });
    expect(existsSync(path.join(res.home, '.miden-e2e', 'arc-keys'))).toBe(false);
    expect(res.output).toContain(privateKeyToAccount(ARC_KEY).address);
    expect(res.output).not.toContain(ARC_KEY.slice(2));
    expect(res.status).toBe(0);
  }, 35_000);

  it('takes an exported MIDEN_CLIENT_BIN and installs nothing', () => {
    const res = stubbed(['--suite', 'usdcx-burn'], DOCUMENT, { MIDEN_CLIENT_BIN: '/operator/bin/miden-client' });
    const children = spawned(res.requests);
    expect(children.map(child => child.command)).toEqual(['yarn', 'yarn']);
    expect(children[1].args).toEqual(testArgs('USDCx burn through the Send UI'));
    expect(children[1].env).toMatchObject({ MIDEN_CLIENT_BIN: '/operator/bin/miden-client' });
    expect(res.status).toBe(0);
  }, 35_000);

  it('runs headed under --headed, over an exported E2E_HEADLESS', () => {
    const res = stubbed(['--suite', 'usdcx', '--headed'], DOCUMENT, { E2E_HEADLESS: '1' });
    const test = spawned(res.requests)[2];
    expect(test.args).toEqual([...testArgs('USDCx round trip'), '--headed']);
    expect(test.env).not.toHaveProperty('E2E_HEADLESS');
    expect(res.status).toBe(0);
  }, 35_000);

  it('builds and runs nothing when the pinned CLI does not install', () => {
    const res = stubbed(['--suite', 'usdcx'], DOCUMENT, {}, { cliInstall: { status: 1, stdout: '' } });
    expect(spawned(res.requests).map(child => child.command)).toEqual(['install-pinned-miden-cli']);
    expect(res.output).toContain('the pinned miden-client CLI did not install (exit 1)');
    expect(existsSync(lockOf(res.home))).toBe(false);
    expect(res.status).toBe(1);
  }, 35_000);

  it('gives a swap run no install, no key in its build, and the Sepolia key alone in its test', () => {
    const res = stubbed(['--suite', 'swap'], DOCUMENT, {
      E2E_ARC_PRIVATE_KEY: ARC_KEY,
      E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY,
      USDCX_LIVE_EVM_PRIVATE_KEY: IOS_KEY
    });
    const env = {
      E2E_NETWORK: 'testnet',
      E2E_REAL_EPOCH: 'true',
      E2E_SEPOLIA_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com'
    };
    expect(spawned(res.requests)).toEqual([
      { command: 'yarn', args: ['test:e2e:blockchain:build'], env },
      {
        command: 'yarn',
        args: [
          'playwright',
          'test',
          '--config',
          'playwright.swap.config.ts',
          '--retries=1',
          '--grep-invert',
          'guardian maker'
        ],
        env: { ...env, E2E_SEPOLIA_PRIVATE_KEY: SEPOLIA_KEY }
      }
    ]);
    expect(existsSync(path.join(res.home, '.miden-e2e'))).toBe(false);
    expect(res.status).toBe(0);
  }, 35_000);

  it('deposits from the harness key on usdcx-in when no key is given, probing its address', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-real-home-'));
    const { address, privateKey } = await harnessArcKey(harnessFileOf(home), { create: true });
    const res = stubbed(['--suite', 'usdcx-in'], DOCUMENT, { HOME: home });
    const balanceOf = encodeFunctionData({
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [address]
    });
    expect(res.requests).toContain(`"data":"${balanceOf}"`);
    expect(res.output).toContain(`harness key ${address} holds 10 USDC`);
    expect(spawned(res.requests)[2].env).toMatchObject({
      E2E_ARC_PRIVATE_KEY: privateKey,
      E2E_ARC_KEY_ROLE: 'harness'
    });
    expect(res.output).not.toContain(privateKey.slice(2));
    expect(res.status).toBe(0);
  }, 35_000);

  it('refuses to start while the lock names a live run, before the preflight', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-real-home-'));
    mkdirSync(path.dirname(lockOf(home)), { recursive: true });
    const holder = `${JSON.stringify({ pid: process.pid, suite: 'usdcx-in', startedAt: '2026-10-11T11:00:00.000Z' })}\n`;
    writeFileSync(lockOf(home), holder);
    const res = stubbed(['--suite', 'usdcx'], DOCUMENT, { HOME: home });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      `another usdcx run holds the lock ${lockOf(home)} (pid ${process.pid}, --suite usdcx-in, since 2026-10-11T11:00:00.000Z)`
    );
    expect(res.stdout).not.toContain('Preflight');
    expect(res.requests).not.toContain('SPAWN');
    expect(readFileSync(lockOf(home), 'utf8')).toBe(holder);
    expect(existsSync(harnessFileOf(home))).toBe(false);
  }, 35_000);

  it('removes a lock a dead run left, says so, and runs', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-real-home-'));
    mkdirSync(path.dirname(lockOf(home)), { recursive: true });
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockOf(home), `${JSON.stringify({ pid, suite: 'usdcx', startedAt: '2026-10-11T11:00:00.000Z' })}\n`);
    const res = stubbed(['--suite', 'usdcx-burn'], DOCUMENT, { HOME: home });
    expect(res.output).toContain(`removed a stale usdcx run lock ${lockOf(home)}: pid ${pid} (--suite usdcx,`);
    expect(existsSync(lockOf(home))).toBe(false);
    expect(res.status).toBe(0);
  }, 35_000);

  it('takes no lock and creates no harness key under --preflight-only', () => {
    const res = preflight('usdcx');
    expect(res.output).toContain('Arc key  harness: none yet; the first real usdcx or usdcx-burn run creates');
    expect(existsSync(path.join(res.home, '.miden-e2e'))).toBe(false);
    expect(res.status).toBe(0);
  }, 35_000);
});

describe('harnessArcKey', () => {
  const fileIn = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'harness-key-')), 'arc-keys', 'harness.json');

  it('creates the key on first use, 0600 in a 0700 directory, and reads the same key after', async () => {
    const file = fileIn();
    const created = await harnessArcKey(file, { create: true });
    expect(created.created).toBe(true);
    expect(created.address).toBe(privateKeyToAccount(created.privateKey).address);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      role: 'harness',
      iso: expect.any(String),
      address: created.address,
      privateKey: created.privateKey,
      walletAddress: ''
    });
    await expect(harnessArcKey(file, { create: true })).resolves.toEqual({
      address: created.address,
      privateKey: created.privateKey,
      created: false
    });
  });

  it('reports a missing key when it may not create one, and creates nothing', async () => {
    const file = fileIn();
    await expect(harnessArcKey(file, { create: false })).resolves.toEqual({ missing: true });
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it('refuses a key file other users can read, never printing the key', async () => {
    const file = fileIn();
    const { privateKey } = await harnessArcKey(file, { create: true });
    chmodSync(file, 0o644);
    const refused = harnessArcKey(file, { create: true });
    await expect(refused).rejects.toThrow(
      `the harness Arc key file ${file} is open to other users (mode 644): chmod 600 it`
    );
    await expect(refused).rejects.not.toThrow(privateKey.slice(2));
  });

  it.each<[string, (entry: Record<string, unknown>) => string]>([
    ['not JSON', () => 'not json'],
    ['role "per-run", not "harness"', entry => JSON.stringify({ ...entry, role: 'per-run' })],
    [
      'its address does not derive from its privateKey',
      entry => JSON.stringify({ ...entry, address: getAddress(`0x${'12'.repeat(20)}`) })
    ]
  ])('refuses an entry that is %s, never printing the key or replacing the file', async (problem, rewrite) => {
    const file = fileIn();
    const { privateKey } = await harnessArcKey(file, { create: true });
    writeFileSync(file, rewrite(JSON.parse(readFileSync(file, 'utf8'))));
    const written = readFileSync(file, 'utf8');
    const refused = harnessArcKey(file, { create: true });
    await expect(refused).rejects.toThrow(
      `${file} is not a harness Arc key entry (${problem}); it may hold a funded key, so the runner never replaces it`
    );
    await expect(refused).rejects.not.toThrow(privateKey.slice(2));
    expect(readFileSync(file, 'utf8')).toBe(written);
  });
});

describe('acquireUsdcxRunLock', () => {
  const lockIn = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'usdcx-lock-')), '.miden-e2e', 'usdcx-run.lock');
  const AT = () => new Date('2026-10-11T12:00:00.000Z');
  const hold = (lock: string, content: Record<string, unknown>) => {
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, `${JSON.stringify(content)}\n`);
  };

  it('takes a free lock as 0600 JSON naming the run, and release removes it', () => {
    const lock = lockIn();
    const taken = acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 4242, now: AT });
    expect(taken.error).toBeUndefined();
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual({
      pid: 4242,
      suite: 'usdcx',
      startedAt: '2026-10-11T12:00:00.000Z'
    });
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(lock))).toEqual(['usdcx-run.lock']);
    expect(taken.release()).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses while the run holding it lives, naming the lock and its pid', () => {
    const lock = lockIn();
    hold(lock, { pid: 4242, suite: 'usdcx-burn', startedAt: '2026-10-11T11:00:00.000Z' });
    expect(acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 5151, isAlive: () => true })).toEqual({
      error:
        `another usdcx run holds the lock ${lock} (pid 4242, --suite usdcx-burn, since 2026-10-11T11:00:00.000Z). ` +
        'Two runs would pay into and spend from the one harness Arc key, which breaks the payout check. ' +
        `Wait for it to end; if no yarn e2e:real run is going, remove ${lock}`
    });
  });

  it("refuses while a dead run's test child still runs", () => {
    const lock = lockIn();
    hold(lock, { pid: 4242, suite: 'usdcx', startedAt: '2026-10-11T11:00:00.000Z', childPid: 4343 });
    const taken = acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 5151, isAlive: pid => pid === 4343 });
    expect(taken.error).toContain('(pid 4242 exited; its child, pid 4343, is still running, --suite usdcx, since');
  });

  it('removes a lock whose run and child are gone, says so, and takes it', () => {
    const lock = lockIn();
    hold(lock, { pid: 4242, suite: 'usdcx-in', startedAt: '2026-10-11T11:00:00.000Z', childPid: 4343 });
    const taken = acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 5151, now: AT, isAlive: () => false });
    expect(taken.removed).toBe(
      `removed a stale usdcx run lock ${lock}: pid 4242 (--suite usdcx-in, since 2026-10-11T11:00:00.000Z) ` +
        'is no longer running'
    );
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: 5151, suite: 'usdcx' });
  });

  it('refuses a lock it cannot read, and leaves it', () => {
    const lock = lockIn();
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, 'garbage');
    expect(acquireUsdcxRunLock(lock, { suite: 'usdcx', isAlive: () => false })).toEqual({
      error: `cannot read the usdcx run lock ${lock} (not a lock this runner wrote); if no usdcx run is going, remove it`
    });
    expect(readFileSync(lock, 'utf8')).toBe('garbage');
  });

  it('leaves the lock when it no longer names this run', () => {
    const lock = lockIn();
    const taken = acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 4242, now: AT });
    hold(lock, { pid: 5151, suite: 'usdcx', startedAt: '2026-10-11T12:05:00.000Z' });
    expect(taken.release()).toBe(`the usdcx run lock ${lock} no longer names this run; left in place`);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: 5151 });
  });

  it('names the test child in the lock, so the lock stays held after the runner dies', () => {
    const lock = lockIn();
    const taken = acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 4242, now: AT });
    taken.recordChild(4343);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual({
      pid: 4242,
      suite: 'usdcx',
      startedAt: '2026-10-11T12:00:00.000Z',
      childPid: 4343
    });
    expect(readdirSync(path.dirname(lock))).toEqual(['usdcx-run.lock']);
    expect(acquireUsdcxRunLock(lock, { suite: 'usdcx', pid: 5151, isAlive: pid => pid === 4343 }).error).toContain(
      'its child, pid 4343'
    );
  });
});

describe('the usage', () => {
  it('documents the usdcx suites, the Arc flags, the pinned CLI and one usdcx run at a time', () => {
    const res = runCli('-h');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`  ${'usdcx-in'.padEnd(21)} ${SUITES['usdcx-in'].describe}`);
    expect(res.stdout).toContain('--arc-rpc <url>');
    expect(res.stdout).toContain('(env: E2E_ARC_RPC_URL)');
    expect(res.stdout).toContain('--arc-key <0x...>');
    expect(res.stdout).toContain('(env: E2E_ARC_PRIVATE_KEY)');
    expect(res.stdout).toContain('unless MIDEN_CLIENT_BIN is set');
    expect(res.stdout).toContain('A lock, ~/.miden-e2e/usdcx-run.lock, lets one usdcx run go');
    expect(res.stdout).toContain('usdcx and usdcx-burn burn to one harness Arc');
  }, 35_000);
});
