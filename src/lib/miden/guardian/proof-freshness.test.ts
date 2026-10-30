import {
  CHAIN_TIP_READ_TIMEOUT_MS,
  isProofStale,
  isStaleProofError,
  MAX_PROOF_REEXECUTIONS,
  StaleProofError,
  SUBMIT_EXPIRY_MARGIN_BLOCKS,
  withFreshProof
} from './proof-freshness';
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

describe('withFreshProof', () => {
  /** One proof per expiration, in order, each read against the matching tip. */
  const run = (
    expirations: (number | undefined)[],
    readTip: () => Promise<number> = async () => TIP,
    assertLive: () => void = () => {}
  ) => {
    const executions: boolean[] = [];
    const pending = withFreshProof({
      executeAndProve: async reexecuting => {
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
});
