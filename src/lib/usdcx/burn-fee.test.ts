import { isAddress } from 'viem';

import type { TxAssetView } from 'app/confirm/decode';

import { estimateUsdcxBurnFeeReserve, USDCX_BURN_FEE_LOCK_WAIT_MS, USDCX_BURN_FEE_PROBE_RECIPIENT } from './burn-fee';

const NATIVE = 'mm1native';
const OTHER = 'mm1other';
const REQUEST_BYTES = new Uint8Array([1, 2, 3]);

const mockDryRun = jest.fn();
const mockProxySyncState = jest.fn();
const mockGetMidenClient = jest.fn();
const mockNativeAsset = jest.fn<Promise<string>, []>();
const mockSimulate = jest.fn();
const mockView = jest.fn<TxAssetView | undefined, [unknown]>();
const mockBuild = jest.fn();
const mockDestination = jest.fn();
const mockInitBridgeConfig = jest.fn<Promise<void>, []>();
let mockInlineRealm = true;

// A FIFO mutex like the real one: a hold runs only once every earlier hold has settled. Each hold
// it hands out and the options each acquisition passed are recorded.
const mockLock = {
  tail: Promise.resolve() as Promise<unknown>,
  holds: [] as object[],
  options: [] as unknown[]
};
async function mockWithWasmClientLock<T>(operation: (hold: object) => Promise<T>, options?: unknown): Promise<T> {
  mockLock.options.push(options);
  const previous = mockLock.tail;
  let release: () => void = () => {};
  mockLock.tail = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  const hold = { mock: `hold-${mockLock.holds.length}` };
  mockLock.holds.push(hold);
  try {
    return await operation(hold);
  } finally {
    release();
  }
}
/** Holds the lock as another flow would, until the returned release is called. */
function mockOccupyLock(): () => void {
  let release: () => void = () => {};
  const busy = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = mockLock.tail;
  mockLock.tail = previous.then(() => busy);
  return release;
}

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    dryRunTransaction: (...args: unknown[]) => mockDryRun(...args),
    syncState: (...args: unknown[]) => mockProxySyncState(...args)
  },
  runsWasmInThisRealm: () => mockInlineRealm
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  withWasmClientLock: (operation: (hold: object) => Promise<unknown>, options?: unknown) =>
    mockWithWasmClientLock(operation, options)
}));
// simulateCustomTransaction imports the request's notes and syncs before it executes; the probe must never route
// through it.
jest.mock('lib/miden/back/simulate-custom-tx', () => ({
  simulateCustomTransaction: (...args: unknown[]) => mockSimulate(...args)
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (ref: string) => ({ toString: () => `hex:${ref}` }) }));
jest.mock('app/confirm/decode', () => ({ simulatedBytesToView: (result: unknown) => mockView(result) }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: () => mockNativeAsset() }));
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: () => mockInitBridgeConfig() }));
jest.mock('lib/shared/helpers', () => ({ u8ToB64: () => 'request-b64' }));
jest.mock('./burn', () => ({ buildUsdcxBurnRequest: (...args: unknown[]) => mockBuild(...args) }));
jest.mock('./constant', () => ({ getUsdcxDestination: (chainId: number) => mockDestination(chainId) }));

function view(fee: TxAssetView['fee'], outgoing: TxAssetView['outgoing']): TxAssetView {
  return {
    outgoing,
    incoming: [],
    outgoingNfts: [],
    incomingNfts: [],
    unlistedAssets: 0,
    inputNotesConsumed: 0,
    outputNotesCreated: 1,
    fee,
    storageChanged: true
  };
}

const measuredView = () => view({ faucetId: NATIVE, amount: 252n }, [{ faucetId: NATIVE, amount: 1n }]);
const measured = (reserve: bigint) => ({ outcome: 'measured', reserve });
const BUSY = { outcome: 'busy' };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('estimateUsdcxBurnFeeReserve', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLock.tail = Promise.resolve();
    mockLock.holds = [];
    mockLock.options = [];
    mockInlineRealm = true;
    mockInitBridgeConfig.mockResolvedValue(undefined);
    mockNativeAsset.mockResolvedValue(NATIVE);
    mockDestination.mockReturnValue({ domain: 0 });
    mockBuild.mockReturnValue({ burnNoteId: 'note', requestBytes: REQUEST_BYTES });
    mockDryRun.mockResolvedValue({ executedBytes: 'executed' });
    mockSimulate.mockResolvedValue({ executedBytes: 'executed' });
    mockView.mockReturnValue(measuredView());
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each([
    ['the inline client', true],
    ['the offscreen document', false]
  ])(
    'dry-runs the probe on %s through the proxy, under its own hold, with no sync and no client of its own',
    async (_realm, inline) => {
      mockInlineRealm = inline;

      await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(315n));

      expect(mockSimulate).not.toHaveBeenCalled();
      expect(mockDryRun).toHaveBeenCalledTimes(1);
      expect(mockDryRun).toHaveBeenCalledWith('hex:mm1sender', REQUEST_BYTES, mockLock.holds[0]);
      expect(mockView).toHaveBeenCalledWith({ executedBytes: 'executed' });
      expect(mockProxySyncState).not.toHaveBeenCalled();
      expect(mockGetMidenClient).not.toHaveBeenCalled();
      // The dry run's deadline starts once the lock is held: inline it is the hold's own ceiling, offscreen the
      // proxy's deadline on the forwarded op bounds it and the hold keeps the default ceiling.
      const options = mockLock.options[0] as { watchdogMs?: number; label?: string } | undefined;
      expect(options?.label).toEqual(expect.any(String));
      expect(typeof options?.watchdogMs === 'number').toBe(inline);
    }
  );

  it('runs one dry run for concurrent estimates of the same account and chain, and a fresh one afterwards', async () => {
    let finish: ((result: { executedBytes: string }) => void) | undefined;
    mockDryRun.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );

    const first = estimateUsdcxBurnFeeReserve('mm1sender', 1);
    const second = estimateUsdcxBurnFeeReserve('mm1sender', 1);
    await flush();
    finish?.({ executedBytes: 'executed' });

    await expect(Promise.all([first, second])).resolves.toEqual([measured(315n), measured(315n)]);
    expect(mockSimulate).not.toHaveBeenCalled();
    expect(mockDryRun).toHaveBeenCalledTimes(1);
    expect(mockLock.options).toHaveLength(1);

    // Only the in-flight estimate is shared: a later one, or one for another chain, measures again.
    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(315n));
    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 2)).resolves.toEqual(measured(315n));
    expect(mockDryRun).toHaveBeenCalledTimes(3);
  });

  it('answers busy, not failed, without a dry run when the WASM lock stays busy past its wait deadline', async () => {
    jest.useFakeTimers();
    const release = mockOccupyLock();

    const estimate = estimateUsdcxBurnFeeReserve('mm1sender', 1);
    await jest.advanceTimersByTimeAsync(USDCX_BURN_FEE_LOCK_WAIT_MS);

    await expect(estimate).resolves.toEqual(BUSY);
    // The hold it queued for runs once the lock frees, and does nothing.
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLock.holds).toHaveLength(1);
    expect(mockDryRun).not.toHaveBeenCalled();
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'configuration_failed',
      () => mockInitBridgeConfig.mockRejectedValueOnce(new Error('private-account secret amount=123'))
    ],
    [
      'configuration_failed',
      () =>
        mockDestination.mockImplementationOnce(() => {
          throw new Error('private-route');
        })
    ],
    ['native_asset_failed', () => mockNativeAsset.mockRejectedValueOnce(new Error('private-asset'))],
    [
      'request_build_failed',
      () =>
        mockBuild.mockImplementationOnce(() => {
          throw new Error('private-account');
        })
    ],
    ['dry_run_failed', () => mockDryRun.mockRejectedValueOnce(new Error('private-node amount=123'))],
    ['result_decode_failed', () => mockView.mockReturnValueOnce(undefined)],
    [
      'result_decode_failed',
      () =>
        mockView.mockImplementationOnce(() => {
          throw new Error('private-bytes');
        })
    ],
    ['probe_mismatch', () => mockView.mockReturnValueOnce(view(undefined, []))]
  ])('returns only the closed %s failure for its producer', async (failure, prepare) => {
    prepare();
    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual({ outcome: 'failed', failure });
  });

  it('builds the probe for a fixed, well-formed placeholder recipient', async () => {
    await estimateUsdcxBurnFeeReserve('mm1sender', 1);

    expect(isAddress(USDCX_BURN_FEE_PROBE_RECIPIENT)).toBe(true);
    expect(mockBuild).toHaveBeenCalledWith('mm1sender', 1n, USDCX_BURN_FEE_PROBE_RECIPIENT, 0);
  });

  it('counts native outputs beyond the burned amount as cost', async () => {
    mockView.mockReturnValue(
      view({ faucetId: NATIVE, amount: 100n }, [
        { faucetId: NATIVE, amount: 1n },
        { faucetId: NATIVE, amount: 60n },
        { faucetId: OTHER, amount: 999n }
      ])
    );

    // 100 + 60 = 160, plus 40 headroom.
    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(200n));
  });

  it('rounds the headroom up', async () => {
    mockView.mockReturnValue(view({ faucetId: NATIVE, amount: 7n }, [{ faucetId: NATIVE, amount: 1n }]));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(9n));
  });

  it('answers a measured zero when the dry run succeeds and the burn costs nothing in the native asset', async () => {
    mockView.mockReturnValue(view({ faucetId: OTHER, amount: 50n }, [{ faucetId: NATIVE, amount: 1n }]));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(0n));
  });

  // The probe's own unit always leaves as a native output, so a dry run that shows less matched the wrong faucet.
  it.each([
    [
      'neither the fee nor any output is native',
      view({ faucetId: OTHER, amount: 50n }, [{ faucetId: OTHER, amount: 1n }])
    ],
    ['the fee is native but the burned unit is not', view({ faucetId: NATIVE, amount: 252n }, [])]
  ])('answers failed, not a measured cost, when %s', async (_case, dryRunView) => {
    mockView.mockReturnValue(dryRunView);

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual({
      outcome: 'failed',
      failure: 'probe_mismatch'
    });
  });

  it('answers failed when the dry run fails', async () => {
    mockDryRun.mockRejectedValue(new Error('the execution failed'));

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual({
      outcome: 'failed',
      failure: 'dry_run_failed'
    });
    expect(mockView).not.toHaveBeenCalled();
  });

  it('rethrows a trap from the dry run instead of reading it as a failed estimate', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    mockDryRun.mockRejectedValue(trap);

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).rejects.toBe(trap);
  });

  it('answers failed, through its guard, when the dry run gives nothing to decode', async () => {
    mockView.mockReturnValue(undefined);

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual({
      outcome: 'failed',
      failure: 'result_decode_failed'
    });
    // Without the guard the read of the missing view throws and the catch-all answers failed with a warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('hydrates the bridge config before it reads the destination', async () => {
    let hydrated = false;
    mockInitBridgeConfig.mockImplementation(async () => {
      hydrated = true;
    });
    mockDestination.mockImplementation(() => {
      if (!hydrated) throw new Error('the bridge config is not hydrated');
      return { domain: 0 };
    });

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 1)).resolves.toEqual(measured(315n));
  });

  it('answers failed when the destination is not configured', async () => {
    mockDestination.mockImplementation(() => {
      throw new Error('USDCx withdrawal is not configured for chain 5');
    });

    await expect(estimateUsdcxBurnFeeReserve('mm1sender', 5)).resolves.toEqual({
      outcome: 'failed',
      failure: 'configuration_failed'
    });
    expect(mockDryRun).not.toHaveBeenCalled();
    expect(mockSimulate).not.toHaveBeenCalled();
  });
});
