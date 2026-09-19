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
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SUITES, composeGrep, pricedAmountFrom, run, suiteRetries } from './e2e-real.mjs';

describe('composeGrep', () => {
  it('requires BOTH patterns when a suite filter and a user filter are given', () => {
    // Playwright keeps only the last --grep, so the two must become one pattern.
    // Lookaheads match anywhere in the title, which is what each did alone.
    expect(composeGrep('Slow AggLayer', 'bridges')).toBe('(?=.*Slow AggLayer)(?=.*bridges)');
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
