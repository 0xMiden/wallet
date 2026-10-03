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
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SUITES, composeGrep, pricedAmountFrom, resolveOperatorInput, run, suiteRetries } from './e2e-real.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');

// The caller's environment without any variable the runner reads: a key, an
// empty URL or a served config document there would add its own refusal, or its
// own document, ahead of the one under test.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'E2E_SEPOLIA_PRIVATE_KEY',
    'EPOCH_ALLOCATOR_URL',
    'EPOCH_POSITIONS_URL',
    'E2E_SEPOLIA_RPC_URL',
    'MIDEN_REMOTE_CONFIG_URL'
  ]) {
    delete env[name];
  }
  return env;
}

// A leading object sets variables for the child, over cleanEnv().
function runCli(first: string | Record<string, string>, ...rest: string[]) {
  const override = typeof first === 'string' ? {} : first;
  const args = typeof first === 'string' ? [first, ...rest] : rest;
  const env = cleanEnv();
  const res = spawnSync(process.execPath, ['scripts/e2e-real.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...env, ...override },
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
  it.each(['--suite', '--network', '--sepolia-rpc', '--sepolia-key', '--min-eth', '--grep'])(
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

describe('the preflight reads what it probes from the network config document', () => {
  const ALLOCATOR = 'https://allocator.example';
  const EVM_USDC = `0x${'a'.repeat(40)}`;
  const L1_BRIDGE = `0x${'b'.repeat(40)}`;
  const PUBLISHED = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json';
  const DOCUMENT = {
    network: 'testnet',
    version: 7,
    evm: { chainId: 11155111 },
    agglayer: { l1Bridge: L1_BRIDGE, midenBridge: '0x3b66e20b5088f25133b69216484652' },
    epoch: { allocatorUrl: ALLOCATOR, positionsUrl: 'https://positions.example', evmUsdc: EVM_USDC },
    features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
  };
  const STUB = pathToFileURL(path.join(__dirname, 'e2e-real.fetch-stub.mjs')).href;

  // The whole command under --preflight-only, its every request answered by the stub and logged.
  function preflight(suite: string, served: unknown = DOCUMENT, env: Record<string, string> = {}) {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-real-')), 'requests.log');
    writeFileSync(log, '');
    const res = spawnSync(
      process.execPath,
      ['--import', STUB, 'scripts/e2e-real.mjs', '--suite', suite, '--preflight-only'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...cleanEnv(), ...env, E2E_REAL_FETCH_STUB: JSON.stringify({ document: served, log }) },
        timeout: 30_000
      }
    );
    return { status: res.status, output: `${res.stdout}${res.stderr}`, requests: readFileSync(log, 'utf8') };
  }

  it('probes the allocator, the USDC and the L1 bridge the published document names', () => {
    const res = preflight('bridge-out-epoch');
    expect(res.requests).toContain(`${ALLOCATOR}/health`);
    expect(res.requests).toContain(`${ALLOCATOR}/checkIfDepositNeeded`);
    expect(res.requests).toContain(`eth_getCode ["${EVM_USDC}","latest"]`);
    expect(res.requests).toContain(`eth_getCode ["${L1_BRIDGE}","latest"]`);
    expect(res.requests).toContain(PUBLISHED);
    expect(res.status).toBe(0);
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

  it('reads the served document the E2E build reads when MIDEN_REMOTE_CONFIG_URL is set', () => {
    const served = { ...DOCUMENT, epoch: { ...DOCUMENT.epoch, allocatorUrl: 'http://127.0.0.1:8548' } };
    const res = preflight('bridge-out-epoch', served, { MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8550/' });
    expect(res.requests).toContain('http://127.0.0.1:8550/testnet.json');
    expect(res.requests).toContain('http://127.0.0.1:8548/health');
    expect(res.requests).not.toContain(PUBLISHED);
    expect(res.status).toBe(0);
  }, 35_000);

  it('reads no document for a suite that probes nothing it names', () => {
    const res = preflight('swap');
    expect(res.requests).not.toContain('.json');
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
