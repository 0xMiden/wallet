/** @jest-environment node */
import { privateKeyToAccount } from 'viem/accounts';

import type { JsonValue } from './history';
import { DEPOSIT_UNITS } from './usdcx-constants';
import {
  anyOf,
  arcKeyRoleFromEnv,
  arcPrivateKeyFromEnv,
  assertUsdcxLiveRun,
  boundedTerm,
  burnCompletionPath,
  burnOutputNoteProblem,
  consumeFeePath,
  depositClaimProblem,
  describePage,
  errorText,
  evidenceJson,
  exactlyOne,
  explainSettleFailure,
  grantFundingProblem,
  jsonObject,
  jsonString,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  sampleInBackground,
  takeRunArcKey,
  withStepBudget
} from './usdcx-run';

const KEY = 'ab'.repeat(32);
const RUNNER = {
  E2E_REAL_USDCX: 'true',
  E2E_NETWORK: 'testnet',
  E2E_ARC_PRIVATE_KEY: KEY,
  E2E_ARC_KEY_ROLE: 'harness'
};
const RECEIVE_ORDER = ['delivering', 'ready', 'received'];

/** The message a call throws, or '' when it returns. */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return errorText(error);
  }
  return '';
}

/** A clock that moves only when the code under test sleeps; a loop that never ends fails instead of hanging. */
function fakeClock() {
  const clock = { at: 0, sleeps: 0 };
  return {
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.sleeps += 1;
      if (clock.sleeps > 100) throw new Error('slept more than 100 times');
      clock.at += ms;
    }
  };
}

/** Lets a loop that yields through `setImmediate` run `rounds` times. */
async function macrotasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

describe('assertUsdcxLiveRun', () => {
  it('accepts a run the runner started on testnet with its Arc key, in either role', () => {
    expect(thrown(() => assertUsdcxLiveRun(RUNNER))).toBe('');
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_ARC_KEY_ROLE: 'operator' }))).toBe('');
  });

  it('refuses a run the runner did not start', () => {
    expect(thrown(() => assertUsdcxLiveRun({ E2E_NETWORK: 'testnet' }))).toBe(
      'the USDCx live suites run only through `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` ' +
        '(E2E_REAL_USDCX is not "true")'
    );
  });

  it('refuses every network but testnet', () => {
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_NETWORK: 'devnet' }))).toBe(
      'the USDCx live suites run only on testnet, but E2E_NETWORK is devnet'
    );
    expect(thrown(() => assertUsdcxLiveRun({ E2E_REAL_USDCX: 'true' }))).toBe(
      'the USDCx live suites run only on testnet, but E2E_NETWORK is unset'
    );
  });

  it('refuses a run the runner handed no Arc key or no role, and never echoes the key', () => {
    const refusal =
      'the usdcx suites take their Arc key from `yarn e2e:real` (E2E_ARC_PRIVATE_KEY or E2E_ARC_KEY_ROLE is unset)';
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_ARC_PRIVATE_KEY: undefined }))).toBe(refusal);
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_ARC_KEY_ROLE: 'fresh' }))).toBe(refusal);
    expect(thrown(() => assertUsdcxLiveRun({ ...RUNNER, E2E_NETWORK: 'devnet' }))).not.toContain(KEY);
  });
});

describe('arcPrivateKeyFromEnv', () => {
  it('returns the key as 0x and lowercase hex', () => {
    expect(arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: ` 0X${KEY.toUpperCase()} ` })).toBe(`0x${KEY}`);
    expect(arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: KEY })).toBe(`0x${KEY}`);
  });

  it('refuses a key of the wrong length with a message that does not echo it', () => {
    expect(thrown(() => arcPrivateKeyFromEnv({ E2E_ARC_PRIVATE_KEY: KEY.slice(1) }))).toBe(
      'E2E_ARC_PRIVATE_KEY is not a 32-byte hex private key'
    );
  });
});

describe('arcKeyRoleFromEnv', () => {
  it('reads the role the runner names, and refuses any other', () => {
    expect(arcKeyRoleFromEnv({ E2E_ARC_KEY_ROLE: 'harness' })).toBe('harness');
    expect(arcKeyRoleFromEnv({ E2E_ARC_KEY_ROLE: 'operator' })).toBe('operator');
    expect(thrown(() => arcKeyRoleFromEnv({}))).toBe('E2E_ARC_KEY_ROLE is unset, not harness or operator');
  });
});

describe('takeRunArcKey', () => {
  it('takes the key out of the env on first use, so no later child inherits it, and returns that key after', () => {
    const env: Record<string, string | undefined> = { ...RUNNER };
    const privateKey: `0x${string}` = `0x${KEY}`;
    const taken = takeRunArcKey(env);
    expect(taken).toEqual({ key: { address: privateKeyToAccount(privateKey).address, privateKey }, role: 'harness' });
    expect(env).toStrictEqual({ E2E_REAL_USDCX: 'true', E2E_NETWORK: 'testnet', E2E_ARC_KEY_ROLE: 'harness' });
    expect(takeRunArcKey(env)).toBe(taken);
  });
});

describe('withStepBudget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('hands back the step result', async () => {
    await expect(withStepBudget('fund', 1_000, async () => 7)).resolves.toBe(7);
  });

  it('names the step on a failure and keeps the cause', async () => {
    const cause = new Error('vault 5, expected 6');
    const failure = await withStepBudget('fund', 1_000, async () => Promise.reject(cause)).catch(
      (error: unknown) => error
    );
    expect(errorText(failure)).toBe('fund: vault 5, expected 6');
    expect(failure instanceof Error ? failure.cause : undefined).toBe(cause);
  });

  it('rejects a step that outruns its budget and appends its context', async () => {
    jest.useFakeTimers();
    const outcome = withStepBudget(
      'payout',
      1_000,
      () => new Promise<never>(() => undefined),
      async () => 'key 0xabc'
    ).catch((error: unknown) => errorText(error));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('payout: exceeded its 1000 ms budget\nkey 0xabc');
  });

  it('keeps the failure when the context cannot be read', async () => {
    const outcome = withStepBudget(
      'settle_grant',
      1_000,
      async () => Promise.reject(new Error('not canonical')),
      async () => Promise.reject(new Error('guardian down'))
    ).catch((error: unknown) => errorText(error));
    await expect(outcome).resolves.toBe('settle_grant: not canonical\n(context unavailable: guardian down)');
  });

  it("aborts the step's signal at its deadline, naming the step, and not before", async () => {
    jest.useFakeTimers();
    let handed: AbortSignal | undefined;
    const outcome = withStepBudget('deposit_submit', 1_000, signal => {
      handed = signal;
      return new Promise<never>(() => undefined);
    }).catch((error: unknown) => errorText(error));
    await jest.advanceTimersByTimeAsync(999);
    expect(handed?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(handed?.aborted).toBe(true);
    expect(errorText(handed?.reason)).toBe('deposit_submit exceeded its 1000 ms budget');
    await expect(outcome).resolves.toBe('deposit_submit: exceeded its 1000 ms budget');
  });

  it('never aborts the signal of a step that ended within its budget', async () => {
    jest.useFakeTimers();
    let handed: AbortSignal | undefined;
    await withStepBudget('deposit_submit', 1_000, async signal => {
      handed = signal;
      return 7;
    });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(handed?.aborted).toBe(false);
  });
});

describe('namedSteps', () => {
  it('records each step under its name and hands back its value', async () => {
    const names: string[] = [];
    const step = namedSteps({
      step: async (name, fn) => {
        names.push(name);
        await fn();
      }
    });
    await expect(step('arc_state', 1_000, async () => 'ok')).resolves.toBe('ok');
    expect(names).toEqual(['arc_state']);
  });

  it('rejects with the step-named failure the recorder rethrows', async () => {
    const step = namedSteps({ step: async (_name, fn) => fn() });
    await expect(step('mint', 1_000, async () => Promise.reject(new Error('no note')))).rejects.toThrow(
      'mint: no note'
    );
  });

  it("hands each step its budget's signal", async () => {
    jest.useFakeTimers();
    try {
      let handed: AbortSignal | undefined;
      const step = namedSteps({ step: async (_name, fn) => fn() });
      const outcome = step('deposit_submit', 1_000, signal => {
        handed = signal;
        return new Promise<never>(() => undefined);
      }).catch((error: unknown) => errorText(error));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(handed?.aborted).toBe(true);
      await expect(outcome).resolves.toBe('deposit_submit: exceeded its 1000 ms budget');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('PhaseTimeline', () => {
  it('keeps one sample per change and ignores unread phases', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('delivering', 1_000);
    timeline.record('delivering', 2_000);
    timeline.record(undefined, 3_000);
    timeline.record('ready', 4_000);
    expect(timeline.samples()).toEqual([
      { phase: 'delivering', atMs: 1_000 },
      { phase: 'ready', atMs: 4_000 }
    ]);
    expect([timeline.last(), timeline.firstAt('ready'), timeline.saw('received')]).toEqual(['ready', 4_000, false]);
    expect(timeline.describe()).toBe('delivering@1970-01-01T00:00:01.000Z -> ready@1970-01-01T00:00:04.000Z');
  });

  it('accepts phases in order, skipped ones included', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('delivering', 1_000);
    timeline.record('received', 2_000);
    expect(thrown(() => timeline.assertMonotone())).toBe('');
  });

  it('refuses a phase that goes back', () => {
    const timeline = new PhaseTimeline('POSITIVE', RECEIVE_ORDER);
    timeline.record('ready', 1_000);
    timeline.record('delivering', 4_000);
    expect(thrown(() => timeline.assertMonotone())).toBe(
      'POSITIVE: phase "delivering" breaks the order delivering -> ready -> received ' +
        '(ready@1970-01-01T00:00:01.000Z -> delivering@1970-01-01T00:00:04.000Z)'
    );
  });

  it('refuses a phase outside the order, even as the first sample', () => {
    const timeline = new PhaseTimeline('NEGATIVE', ['delivering', 'failed']);
    timeline.record('ready', 1_000);
    expect(thrown(() => timeline.assertMonotone())).toBe(
      'NEGATIVE: phase "ready" breaks the order delivering -> failed (ready@1970-01-01T00:00:01.000Z)'
    );
  });
});

describe('sampleInBackground', () => {
  const yieldOnce = () => new Promise<void>(resolve => setImmediate(resolve));

  it('samples until a tick reports done', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      2_000,
      yieldOnce
    );
    await macrotasks(10);
    await sampler.stop();
    expect(calls).toBe(3);
  });

  it('rides out one failed tick', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('service worker restarting');
        return true;
      },
      2_000,
      yieldOnce
    );
    await macrotasks(5);
    await expect(sampler.stop()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('ends on the third failure in a row and reports it on stop', async () => {
    let calls = 0;
    const sampler = sampleInBackground(
      async () => {
        calls += 1;
        throw new Error(`service worker gone ${calls}`);
      },
      2_000,
      yieldOnce
    );
    await macrotasks(10);
    await expect(sampler.stop()).rejects.toThrow('service worker gone 3');
    expect(calls).toBe(3);
  });
});

describe('pollUntil', () => {
  it('returns the first read that is done', async () => {
    const reads = [1, 2, 3];
    const clock = fakeClock();
    await expect(
      pollUntil(
        'count',
        async () => reads.shift() ?? 0,
        value => value >= 2,
        { timeoutMs: 10_000, intervalMs: 1_000, ...clock }
      )
    ).resolves.toBe(2);
    expect(reads).toEqual([3]);
  });

  it('names the label, the last read and the detail when time runs out', async () => {
    const clock = fakeClock();
    const outcome = pollUntil(
      'burn row to reach confirmed',
      async () => ({ phase: 'pending', amount: 5n }),
      row => row.phase === 'confirmed',
      { timeoutMs: 10_000, intervalMs: 3_000, describe: async last => `phase ${last?.phase}`, ...clock }
    );
    await expect(outcome).rejects.toThrow(
      'burn row to reach confirmed: not reached within 10000 ms; last read {"phase":"pending","amount":"5"}; phase pending'
    );
    expect(clock.now()).toBe(10_000);
  });

  it('lets a failed read through at once', async () => {
    let calls = 0;
    const outcome = pollUntil(
      'grant consume',
      async () => {
        calls += 1;
        throw new Error('consume failed at stage proving');
      },
      () => true,
      { timeoutMs: 10_000, intervalMs: 1_000, ...fakeClock() }
    );
    await expect(outcome).rejects.toThrow('consume failed at stage proving');
    expect(calls).toBe(1);
  });
});

describe('readSettledChange', () => {
  it('waits for the balance to move and then hold', async () => {
    const reads = [5n, 5n, 3n, 4n, 4n];
    await expect(
      readSettledChange(async () => reads.shift() ?? 0n, 5n, { timeoutMs: 60_000, intervalMs: 4_000, ...fakeClock() })
    ).resolves.toBe(4n);
  });

  it('times out when the balance never moves', async () => {
    await expect(
      readSettledChange(async () => 5n, 5n, { timeoutMs: 8_000, intervalMs: 4_000, ...fakeClock() })
    ).rejects.toThrow('balance to move from 5 and hold: not reached within 8000 ms; last read ["5","5"]');
  });
});

describe('consumeFeePath', () => {
  it('reads the fee a consume recorded with its result', () => {
    expect(consumeFeePath({ id: 'c1', feeAmount: '133' })).toEqual({ kind: 'result', fee: 133n });
  });

  it('calls a consume with no fee and no released result a landed path', () => {
    expect(consumeFeePath({ id: 'c1' })).toEqual({ kind: 'landed' });
  });

  it('refuses a recorded fee that is not positive', () => {
    expect(thrown(() => consumeFeePath({ id: 'c1', feeAmount: '0' }))).toBe(
      'consume c1 recorded fee 0, not a positive base-unit amount'
    );
  });

  it('refuses a released result with no fee', () => {
    expect(thrown(() => consumeFeePath({ id: 'c1', resultReleasedAt: 1_760_000_000 }))).toBe(
      'consume c1 released its result at 2025-10-09T08:53:20.000Z but recorded no fee'
    );
  });
});

describe('burnCompletionPath', () => {
  it('decodes from resultBytes when the row still has them', () => {
    expect(burnCompletionPath({ resultBytes: 'AAEC', resultReleasedAt: 1 })).toEqual({
      kind: 'result',
      resultBytes: 'AAEC'
    });
  });

  it('reports a reaped result instead of guessing the outputs', () => {
    expect(thrown(() => burnCompletionPath({ resultReleasedAt: 1_760_000_000 }))).toBe(
      'resultBytes released at 2025-10-09T08:53:20.000Z, 10 min after completedAt; outputs not decoded'
    );
  });

  it('calls a row with neither a landed path', () => {
    expect(burnCompletionPath({})).toEqual({ kind: 'landed' });
  });
});

describe('burnOutputNoteProblem', () => {
  const NOTE = `0x${'ab'.repeat(32)}`;
  const LOCAL = { kind: 'result', resultBytes: 'AAEC' } as const;

  // Only the local completion path writes outputNoteIds; a landed path is proven by the node (burnEvidence).
  it('passes a burn that completed through a landed path and lists no output notes', () => {
    expect(burnOutputNoteProblem({ kind: 'landed' }, { id: 'tx-landed' }, NOTE)).toBeUndefined();
    expect(burnOutputNoteProblem({ kind: 'landed' }, { id: 'tx-landed', outputNoteIds: [] }, NOTE)).toBeUndefined();
  });

  it('passes a local completion that lists the burn note', () => {
    expect(burnOutputNoteProblem(LOCAL, { id: 'tx-local', outputNoteIds: [NOTE] }, NOTE)).toBeUndefined();
  });

  it('fails a local completion that does not list the burn note, naming what it lists', () => {
    expect(burnOutputNoteProblem(LOCAL, { id: 'tx-local' }, NOTE)).toBe(
      `burn tx-local completed locally, but its outputNoteIds [] do not name burn note ${NOTE}`
    );
    expect(burnOutputNoteProblem(LOCAL, { id: 'tx-local', outputNoteIds: ['0x01'] }, NOTE)).toBe(
      `burn tx-local completed locally, but its outputNoteIds [0x01] do not name burn note ${NOTE}`
    );
  });
});

describe('fee and ledger text', () => {
  it('records a bounded fee with its ceiling', () => {
    expect(boundedTerm('f2', { fee: 133n, ceiling: 399n })).toEqual({
      name: 'f2',
      amount: 133n,
      kind: 'bounded',
      ceiling: 399n
    });
  });

  it('prints every ledger term', () => {
    expect(
      ledgerLine([
        ['G', 10_000_000n],
        ['f0', 133n]
      ])
    ).toBe('G=10000000 f0=133');
  });
});

describe('depositClaimProblem', () => {
  it("passes the suites' deposit at testnet's base fee of 7, and the least deposit over the floor", () => {
    expect(depositClaimProblem(DEPOSIT_UNITS, 7)).toBeUndefined();
    expect(depositClaimProblem(211n, 7)).toBeUndefined();
  });

  it('names the floor a deposit does not exceed, the floor itself included', () => {
    expect(depositClaimProblem(210n, 7)).toBe(
      "a deposit of 210 does not exceed the wallet's claim floor 210 (base fee 7 x 30), so the wallet would leave " +
        'its mint unclaimed: raise DEPOSIT_UNITS'
    );
    expect(depositClaimProblem(1_000n, 34)).toContain("the wallet's claim floor 1020 (base fee 34 x 30)");
  });
});

describe('grantFundingProblem', () => {
  it("passes a vault that leaves each burn its own fee margin: 2 USDCx for the 1 USDCx burn, 3 for Sepolia's 2", () => {
    expect(grantFundingProblem(2_000_000n, 1_000_000n)).toBeUndefined();
    expect(grantFundingProblem(3_000_000n, 2_000_000n)).toBeUndefined();
  });

  it('names what the burn and its fees need when the vault falls short of them', () => {
    expect(grantFundingProblem(2_999_999n, 2_000_000n)).toBe(
      'the vault holds 2.999999 USDCx, under the 3 a 2 USDCx burn and its fees need'
    );
    expect(grantFundingProblem(1_999_999n, 1_000_000n)).toBe(
      'the vault holds 1.999999 USDCx, under the 2 a 1 USDCx burn and its fees need'
    );
  });
});

describe('exactlyOne', () => {
  it('returns the only item', () => {
    expect(exactlyOne(['a'], 'consume row', item => item)).toBe('a');
  });

  it('names every item when there is more than one, and the count when there is none', () => {
    expect(thrown(() => exactlyOne(['a', 'b'], 'consume row', item => item))).toBe(
      'expected exactly one consume row, found 2: a; b'
    );
    expect(thrown(() => exactlyOne([], 'consume row', item => item))).toBe('expected exactly one consume row, found 0');
  });
});

describe('JSON narrowing', () => {
  it('keeps only objects and strings', () => {
    const bridgeIn: JsonValue = { bridgeReceiveTxId: 'row-1' };
    expect(jsonString(jsonObject(bridgeIn)?.bridgeReceiveTxId)).toBe('row-1');
    expect([jsonObject(['row-1']), jsonObject(null), jsonObject('row-1'), jsonString(5)]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ]);
  });
});

describe('evidenceJson', () => {
  it('writes bigints as decimal strings', () => {
    const evidence = newRunEvidence('usdcx');
    evidence.fees.push({ name: 'f0', amount: 133n, kind: 'exact' });
    expect(JSON.parse(evidenceJson(evidence, [`0x${KEY}`])).fees).toEqual([
      { name: 'f0', amount: '133', kind: 'exact' }
    ]);
  });

  it('refuses evidence that holds the key in any spelling', () => {
    const evidence = newRunEvidence('usdcx');
    evidence.notes.push(`leaked ${KEY.toUpperCase()}`);
    expect(thrown(() => evidenceJson(evidence, [`0x${KEY}`]))).toBe(
      'the evidence would contain a private key, so it was not written'
    );
  });
});

describe('explainSettleFailure', () => {
  it('reads a missing push as tracking that started late', () => {
    const error = new Error('waitForGuardianSettled: no delta push was observed, so there is nothing to wait for');
    expect(explainSettleFailure(error).message).toBe(
      'tracking started late: waitForGuardianSettled: no delta push was observed, so there is nothing to wait for'
    );
  });

  it('passes any other failure through unchanged', () => {
    const error = new Error('waitForGuardianSettled: the guardian has not canonicalized the last pushed delta');
    expect(explainSettleFailure(error)).toBe(error);
  });
});

describe('describePage', () => {
  it('names the route and the visibility', async () => {
    await expect(describePage('chrome-extension://abc/fullpage.html#/history', async () => 'hidden')).resolves.toBe(
      'page route #/history, visibility hidden'
    );
  });

  it('still names the route when the visibility cannot be read', async () => {
    await expect(
      describePage('chrome-extension://abc/fullpage.html', async () => Promise.reject(new Error('page closed')))
    ).resolves.toBe('page route (no route), visibility unreadable (page closed)');
  });
});

describe('anyOf', () => {
  it('matches each text whole, around whitespace, and nothing else', () => {
    const pill = anyOf(['Burn confirmed', 'Confirmed']);
    expect(['Burn confirmed', ' Confirmed ', 'Burn confirmed.', 'Not Confirmed'].map(text => pill.test(text))).toEqual([
      true,
      true,
      false,
      false
    ]);
    expect(anyOf(['a.b']).test('axb')).toBe(false);
  });
});
