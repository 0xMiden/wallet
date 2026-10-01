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
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SUITES, composeGrep, pricedAmountFrom, resolveOperatorInput, run, suiteRetries } from './e2e-real.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');

function runCli(...args: string[]) {
  // A key in the caller's environment would add its own refusal ahead of the one
  // under test.
  const env = { ...process.env };
  delete env.E2E_SEPOLIA_PRIVATE_KEY;
  const res = spawnSync(process.execPath, ['scripts/e2e-real.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
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
    epochUrl: 'https://epoch.invalid',
    epochPositionsUrl: 'https://epoch-positions.invalid',
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

  it('refuses a flag given no value', () => {
    const res = runCli('--suite');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--suite needs a value');
    expect(res.stdout).not.toContain('Preflight');
  }, 35_000);

  it('refuses a name inherited from Object.prototype as an unknown argument', () => {
    // Indexed plainly, `constructor` would take 'x' as its value and the run
    // would go on to refuse the suite instead.
    const res = runCli('constructor', 'x', '--suite', 'nope');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument: constructor');
    expect(res.stdout).not.toContain('Preflight');
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
