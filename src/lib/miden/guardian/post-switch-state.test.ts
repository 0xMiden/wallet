import { adoptPostSwitchState, readPostSwitchLocalState } from './post-switch-state';

const mockGetAccount = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: (...a: unknown[]) => mockGetAccount(...a) }
}));

// Models hold OWNERSHIP, so the post-read re-check can be exercised.
let mockCurrentHold: object | null = null;
jest.mock('../sdk/miden-client', () => {
  const { WasmClientPoisonedError: PoisonError } = jest.requireActual('../sdk/wasm-client-poison');
  return {
    withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
      const hold = {};
      mockCurrentHold = hold;
      try {
        return await fn(hold);
      } finally {
        if (mockCurrentHold === hold) mockCurrentHold = null;
      }
    },
    assertWasmHoldCurrent: (hold: object | null, where: string) => {
      if (hold !== null && hold === mockCurrentHold) return;
      throw new PoisonError('watchdog', new Error(where));
    }
  };
});

const mockGetGuardianCommitmentFromAccount = jest.fn();
jest.mock('./account', () => ({
  getGuardianCommitmentFromAccount: (...a: unknown[]) => mockGetGuardianCommitmentFromAccount(...a)
}));

const mockCheckEndpointCommitment = jest.fn();
jest.mock('./operator-map', () => ({
  checkEndpointCommitment: (...a: unknown[]) => mockCheckEndpointCommitment(...a)
}));

const NEW = 'https://guardian.new';

/** A fake clock whose waits advance it, so a bound is reached without real time passing. */
const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: jest.fn(async (ms: number) => {
      t += ms;
    })
  };
};

/** The local copy names `newkey` once `adopted` says so; the new operator holds `newkey`. */
const localNamesNewKeyWhen = (adopted: () => boolean) => {
  mockGetGuardianCommitmentFromAccount.mockImplementation(() => (adopted() ? 'newkey' : 'oldkey'));
  mockCheckEndpointCommitment.mockImplementation(async (_endpoint: string, key: string) =>
    key === 'newkey' ? 'match' : 'mismatch'
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccount.mockResolvedValue({ __account: true });
});

describe('readPostSwitchLocalState (#1233)', () => {
  it.each([
    ['match', 'post-switch'],
    ['mismatch', 'pre-switch'],
    ['unreachable', 'unknown']
  ])('reads a %s answer for the local guardian key as %s', async (verdict, expected) => {
    mockGetGuardianCommitmentFromAccount.mockReturnValue('localkey');
    mockCheckEndpointCommitment.mockResolvedValue(verdict);

    await expect(readPostSwitchLocalState('acc', NEW)).resolves.toBe(expected);
    expect(mockCheckEndpointCommitment).toHaveBeenCalledWith(NEW, 'localkey');
  });

  it.each([
    ['a missing account', null],
    ['an account whose guardian slot is empty', { __account: true }]
  ])('reads %s as unknown without asking the operator', async (_label, account) => {
    mockGetAccount.mockResolvedValue(account);
    mockGetGuardianCommitmentFromAccount.mockReturnValue(undefined);

    await expect(readPostSwitchLocalState('acc', NEW)).resolves.toBe('unknown');
    expect(mockCheckEndpointCommitment).not.toHaveBeenCalled();
  });

  it('stops before the guardian-slot read when the hold is evicted during the account read', async () => {
    mockGetAccount.mockImplementation(async () => {
      mockCurrentHold = null;
      return { __account: true };
    });

    await expect(readPostSwitchLocalState('acc', NEW)).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
    expect(mockGetGuardianCommitmentFromAccount).not.toHaveBeenCalled();
  });
});

describe('adoptPostSwitchState (#1233)', () => {
  it('adopts until the local copy names the new guardian, then stops', async () => {
    let adopted = false;
    const adoptOnce = jest.fn(async () => {
      adopted = true;
    });
    localNamesNewKeyWhen(() => adopted);
    const { now, sleep } = fakeClock();

    await expect(adoptPostSwitchState(adoptOnce, 'acc', NEW, { now, sleep })).resolves.toBe('post-switch');
    expect(adoptOnce).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up past the deadline with the local copy still pre-switch', async () => {
    const adoptOnce = jest.fn(async () => {});
    localNamesNewKeyWhen(() => false);
    const { now, sleep } = fakeClock();

    await expect(
      adoptPostSwitchState(adoptOnce, 'acc', NEW, { now, sleep, deadlineMs: 20_000, pollMs: 5_000 })
    ).resolves.toBe('pre-switch');
    // One adopt per poll inside the bound, none after it.
    expect(adoptOnce).toHaveBeenCalledTimes(4);
  });

  it('keeps polling through an adopt the outgoing guardian refuses', async () => {
    let calls = 0;
    const adoptOnce = jest.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new Error(
          'Refusing to overwrite local state: incoming commitment does not match on-chain commitment for account acc'
        );
      }
    });
    localNamesNewKeyWhen(() => calls >= 2);
    const { now, sleep } = fakeClock();

    await expect(adoptPostSwitchState(adoptOnce, 'acc', NEW, { now, sleep })).resolves.toBe('post-switch');
    expect(adoptOnce).toHaveBeenCalledTimes(2);
  });

  it('only reads when there is no outgoing guardian to adopt from', async () => {
    localNamesNewKeyWhen(() => false);
    const { now, sleep } = fakeClock();

    await expect(adoptPostSwitchState(undefined, 'acc', NEW, { now, sleep })).resolves.toBe('pre-switch');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops at once on an unknown state, adopting nothing', async () => {
    const adoptOnce = jest.fn(async () => {});
    mockGetGuardianCommitmentFromAccount.mockReturnValue('oldkey');
    mockCheckEndpointCommitment.mockResolvedValue('unreachable');

    await expect(adoptPostSwitchState(adoptOnce, 'acc', NEW)).resolves.toBe('unknown');
    expect(adoptOnce).not.toHaveBeenCalled();
  });
});
