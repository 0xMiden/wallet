import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument } from 'lib/mobile/testing/hidden-document';

import {
  CHAIN_TIP_READ_TIMEOUT_MS,
  isFailedReexecution,
  isProofStale,
  isStaleProofError,
  markFailedReexecution,
  MAX_PROOF_REEXECUTIONS,
  PROOF_ATTEMPT_BUDGET_MS,
  StaleProofError,
  SUBMIT_EXPIRY_MARGIN_BLOCKS,
  withFreshProof
} from './proof-freshness';
import { DELEGATED_PROVE_TIMEOUT_MS } from '../sdk/miden-client-interface';
import { hasErrorBeforeSubmit, markErrorBeforeSubmit } from '../sdk/sdk-error-code';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

const TIP = 1_000;
const FRESH = TIP + SUBMIT_EXPIRY_MARGIN_BLOCKS + 1;
const STALE = TIP + SUBMIT_EXPIRY_MARGIN_BLOCKS;

describe('isProofStale', () => {
  it.each([
    ['past its expiration', TIP - 1, true],
    ['at the tip', TIP, true],
    ['inside the node`s admission slack', TIP + 2, true],
    ['on the margin', STALE, true],
    ['one block clear of the margin', FRESH, false]
  ])('%s', (_label, expirationBlock, stale) => {
    expect(isProofStale(expirationBlock, TIP)).toBe(stale);
  });
});

describe('StaleProofError', () => {
  it('says the attempt ended before its submit', () => {
    const error = new StaleProofError();
    expect(error.name).toBe('StaleProofError');
    expect(hasErrorBeforeSubmit(error)).toBe(true);
    expect(markErrorBeforeSubmit(error)).toBe(error);
  });

  it('is told apart from any other failure, wrapped or not', () => {
    expect(isStaleProofError(new StaleProofError())).toBe(true);
    expect(isStaleProofError(new Error('wrapped', { cause: new StaleProofError() }))).toBe(true);
    expect(isStaleProofError(new Error('StaleProofError'))).toBe(false);
    expect(isStaleProofError('StaleProofError')).toBe(false);
    expect(isStaleProofError(undefined)).toBe(false);
  });
});

describe('markFailedReexecution', () => {
  it('keeps the thrown error, so its class still reaches the lock and the classifiers', () => {
    const failure = new Error('Failed to fetch');
    expect(markFailedReexecution(failure)).toBe(failure);
    expect(isFailedReexecution(failure)).toBe(true);
  });

  it('marks a thrown value that is no object', () => {
    const marked = markFailedReexecution('Failed to fetch');
    expect(String(marked)).toContain('Failed to fetch');
    expect(isFailedReexecution(marked)).toBe(true);
  });

  it('hands back a frozen error untagged rather than throw on the failure path', () => {
    const failure = Object.freeze(new Error('frozen'));
    expect(markFailedReexecution(failure)).toBe(failure);
    expect(isFailedReexecution(failure)).toBe(false);
  });

  it('reads through a wrapper, and leaves any other failure unmarked', () => {
    const failure = markFailedReexecution(new Error('Failed to fetch'));
    expect(isFailedReexecution(new Error('wrapped', { cause: failure }))).toBe(true);
    expect(isFailedReexecution(new Error('Failed to fetch'))).toBe(false);
    expect(isFailedReexecution('Failed to fetch')).toBe(false);
    expect(isFailedReexecution(undefined)).toBe(false);
  });
});

describe('withFreshProof', () => {
  /** One proof per expiration, in order, each read against the matching tip. */
  const run = (
    expirations: (number | undefined)[],
    readTip: () => Promise<number> = async () => TIP,
    assertLive: () => void = () => {}
  ) => {
    const executions: boolean[] = [];
    const pending = withFreshProof({
      executeAndProve: async ({ reexecuting }) => {
        const proof = { expirationBlock: expirations[executions.length] };
        executions.push(reexecuting);
        return proof;
      },
      expirationBlockOf: proof => proof.expirationBlock,
      readTip,
      assertLive
    });
    return { pending, executions };
  };

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('keeps a fresh proof after its one execution', async () => {
    const { pending, executions } = run([FRESH]);
    await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    expect(executions).toEqual([false]);
  });

  it('re-executes a stale proof and keeps the fresh one', async () => {
    const { pending, executions } = run([STALE, FRESH]);
    await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    expect(executions).toEqual([false, true]);
  });

  it('re-executes twice before a fresh proof', async () => {
    const { pending, executions } = run([STALE, STALE, FRESH]);
    await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    expect(executions).toEqual([false, true, true]);
  });

  it('gives up once the re-executions are spent, with no execution past them', async () => {
    const { pending, executions } = run([STALE, STALE, STALE, FRESH]);
    await expect(pending).rejects.toBeInstanceOf(StaleProofError);
    expect(executions).toHaveLength(1 + MAX_PROOF_REEXECUTIONS);
  });

  it('submits as before when the tip read rejects', async () => {
    const { pending, executions } = run([STALE], async () => {
      throw new Error('node down');
    });
    await expect(pending).resolves.toEqual({ expirationBlock: STALE });
    expect(executions).toEqual([false]);
  });

  it('reads the tip once more after a failed read, and judges that answer', async () => {
    const readTip = jest
      .fn<Promise<number>, []>()
      .mockRejectedValueOnce(new Error('connection lost on resume'))
      .mockResolvedValue(TIP);
    const { pending, executions } = run([STALE, FRESH], readTip);
    await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    expect(executions).toEqual([false, true]);
    expect(readTip).toHaveBeenCalledTimes(3);
  });

  it('reads the tip at most twice for one proof', async () => {
    const readTip = jest.fn<Promise<number>, []>().mockRejectedValue(new Error('node down'));
    const { pending } = run([STALE], readTip);
    await expect(pending).resolves.toEqual({ expirationBlock: STALE });
    expect(readTip).toHaveBeenCalledTimes(2);
  });

  it('gives the second read what is left of the one bound', async () => {
    jest.useFakeTimers();
    const readTip = jest
      .fn<Promise<number>, []>()
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(CHAIN_TIP_READ_TIMEOUT_MS - 1);
        throw new Error('connection lost on resume');
      })
      .mockImplementation(() => new Promise<number>(() => {}));
    const { pending, executions } = run([STALE], readTip);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ expirationBlock: STALE });
    expect(readTip).toHaveBeenCalledTimes(2);
    expect(executions).toEqual([false]);
  });

  it('fails open when the app freezes across the read, whose bound a freeze still spends', async () => {
    jest.useFakeTimers();
    __resetBackgroundTimeForTest();
    const doc = installHiddenDocument();
    try {
      initBackgroundTimeTracking();
      const { pending, executions } = run([STALE], () => new Promise<number>(() => {}));
      await jest.advanceTimersByTimeAsync(0);
      doc.setHidden(true);
      doc.freezeFor(60_000);
      doc.setHidden(false);
      await expect(pending).resolves.toEqual({ expirationBlock: STALE });
      expect(executions).toEqual([false]);
    } finally {
      __resetBackgroundTimeForTest();
      doc.restore();
    }
  });

  it('submits as before when the tip read throws where it is called', async () => {
    const { pending, executions } = run([STALE], () => {
      throw new Error('no endpoint');
    });
    await expect(pending).resolves.toEqual({ expirationBlock: STALE });
    expect(executions).toEqual([false]);
  });

  it('submits as before when the tip read outlasts its bound', async () => {
    jest.useFakeTimers();
    const { pending, executions } = run([STALE], () => new Promise<number>(() => {}));
    await jest.advanceTimersByTimeAsync(CHAIN_TIP_READ_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ expirationBlock: STALE });
    expect(executions).toEqual([false]);
  });

  it('judges a tip that answers inside the bound', async () => {
    jest.useFakeTimers();
    const tips: ((tip: number) => void)[] = [];
    const { pending, executions } = run([STALE, FRESH], () => new Promise<number>(resolve => tips.push(resolve)));
    await jest.advanceTimersByTimeAsync(CHAIN_TIP_READ_TIMEOUT_MS - 1);
    tips.shift()!(TIP);
    await jest.advanceTimersByTimeAsync(0);
    tips.shift()!(TIP);
    await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    expect(executions).toEqual([false, true]);
  });

  it('reads no tip for a proof without an expiration', async () => {
    const readTip = jest.fn(async () => TIP);
    const { pending, executions } = run([undefined], readTip);
    await expect(pending).resolves.toEqual({ expirationBlock: undefined });
    expect(readTip).not.toHaveBeenCalled();
    expect(executions).toEqual([false]);
  });

  it('stops on a hold lost during the tip read, before it judges or executes again', async () => {
    const eviction = new WasmClientPoisonedError('watchdog', new Error('evicted'));
    const { pending, executions } = run([STALE, FRESH], undefined, () => {
      throw eviction;
    });
    await expect(pending).rejects.toBe(eviction);
    expect(executions).toEqual([false]);
  });

  it('asks about the hold once per tip read, after it settles', async () => {
    const order: string[] = [];
    const { pending } = run(
      [STALE, FRESH],
      async () => {
        order.push('tip');
        return TIP;
      },
      () => order.push('live')
    );
    await pending;
    expect(order).toEqual(['tip', 'live', 'tip', 'live']);
  });

  it('asks about the hold after a tip read that failed', async () => {
    const eviction = new WasmClientPoisonedError('watchdog', new Error('evicted'));
    const { pending } = run(
      [STALE],
      async () => {
        throw new Error('node down');
      },
      () => {
        throw eviction;
      }
    );
    await expect(pending).rejects.toBe(eviction);
  });

  it('passes a failed execution through untouched', async () => {
    const failure = new Error('transaction execution failed');
    const pending = withFreshProof({
      executeAndProve: async () => {
        throw failure;
      },
      expirationBlockOf: () => FRESH,
      readTip: async () => TIP,
      assertLive: () => {}
    });
    await expect(pending).rejects.toBe(failure);
  });

  describe('with a prover that failed in this attempt', () => {
    const LOCAL_PROVE_MS = 15_000;
    const EXECUTE_MS = 3_000;

    /** Every delegated prove waits out its timeout and falls back locally, as behind a prover that never answers. */
    const behindAHungProver = (localProveMs: number, freshOnLocalPass: boolean) => {
      const proveLocally: boolean[] = [];
      const pending = withFreshProof({
        executeAndProve: async pass => {
          proveLocally.push(pass.proveLocally);
          jest.advanceTimersByTime(EXECUTE_MS);
          if (!pass.proveLocally) {
            jest.advanceTimersByTime(DELEGATED_PROVE_TIMEOUT_MS);
            pass.delegatedProveFailed();
          }
          jest.advanceTimersByTime(localProveMs);
          return { expirationBlock: pass.proveLocally && freshOnLocalPass ? FRESH : STALE };
        },
        expirationBlockOf: proof => proof.expirationBlock,
        readTip: async () => TIP,
        assertLive: () => {}
      });
      return { pending, proveLocally };
    };

    it('re-executes straight to the local prover, and lands inside the budget', async () => {
      jest.useFakeTimers();
      const { pending, proveLocally } = behindAHungProver(LOCAL_PROVE_MS, true);
      await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
      expect(proveLocally).toEqual([false, true]);
      expect(performance.now()).toBeLessThan(PROOF_ATTEMPT_BUDGET_MS);
    });

    it('waits on that prover only once, however the attempt ends', async () => {
      jest.useFakeTimers();
      const { pending, proveLocally } = behindAHungProver(LOCAL_PROVE_MS, false);
      await expect(pending).rejects.toBeInstanceOf(StaleProofError);
      expect(proveLocally.filter(local => !local)).toHaveLength(1);
      expect(performance.now()).toBeLessThan(PROOF_ATTEMPT_BUDGET_MS);
    });

    it('stops rather than start a local pass the budget cannot fit', async () => {
      jest.useFakeTimers();
      const { pending, proveLocally } = behindAHungProver(30_000, true);
      await expect(pending).rejects.toBeInstanceOf(StaleProofError);
      expect(proveLocally).toEqual([false]);
    });

    it('keeps the remote prover for a re-execution when no delegated prove failed', async () => {
      const proveLocally: boolean[] = [];
      const pending = withFreshProof({
        executeAndProve: async pass => {
          proveLocally.push(pass.proveLocally);
          return { expirationBlock: pass.reexecuting ? FRESH : STALE };
        },
        expirationBlockOf: proof => proof.expirationBlock,
        readTip: async () => TIP,
        assertLive: () => {}
      });
      await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
      expect(proveLocally).toEqual([false, false]);
    });

    it('a fresh proof from the fallback ends the attempt where it stands', async () => {
      const pending = withFreshProof({
        executeAndProve: async pass => {
          pass.delegatedProveFailed();
          return { expirationBlock: FRESH };
        },
        expirationBlockOf: proof => proof.expirationBlock,
        readTip: async () => TIP,
        assertLive: () => {}
      });
      await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
    });
  });

  describe('on running time', () => {
    /** Every pass takes `passMs` of running time and proves stale, so only the budget or the count can stop it. */
    const slowPasses = (passMs: number) => {
      let executions = 0;
      const pending = withFreshProof({
        executeAndProve: async () => {
          executions += 1;
          jest.advanceTimersByTime(passMs);
          return { expirationBlock: STALE };
        },
        expirationBlockOf: proof => proof.expirationBlock,
        readTip: async () => TIP,
        assertLive: () => {}
      });
      return { pending, executions: () => executions };
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    it.each([
      ['runs every re-execution while each one fits', 50_000, 1 + MAX_PROOF_REEXECUTIONS],
      ['stops before a pass it cannot fit', 60_000, 2],
      ['stops at once when one more pass cannot fit', 90_000, 1]
    ])('%s', async (_label, passMs, executions) => {
      const run = slowPasses(passMs);
      await expect(run.pending).rejects.toBeInstanceOf(StaleProofError);
      expect(run.executions()).toBe(executions);
      expect(performance.now()).toBeLessThanOrEqual(PROOF_ATTEMPT_BUDGET_MS);
    });

    it('spends none of its budget on a freeze, which is what it recovers from', async () => {
      __resetBackgroundTimeForTest();
      const doc = installHiddenDocument();
      try {
        initBackgroundTimeTracking();
        const pending = withFreshProof({
          executeAndProve: async ({ reexecuting }) => {
            if (reexecuting) return { expirationBlock: FRESH };
            doc.setHidden(true);
            doc.freezeFor(2 * PROOF_ATTEMPT_BUDGET_MS);
            doc.setHidden(false);
            return { expirationBlock: STALE };
          },
          expirationBlockOf: proof => proof.expirationBlock,
          readTip: async () => TIP,
          assertLive: () => {}
        });
        await expect(pending).resolves.toEqual({ expirationBlock: FRESH });
      } finally {
        __resetBackgroundTimeForTest();
        doc.restore();
      }
    });
  });
});
