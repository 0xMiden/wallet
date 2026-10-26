import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { getBlockTimestamps } from './block-timestamps';

const mockGetBlockHeaderByNumber = jest.fn();
const mockReady = jest.fn();
let mockRpcUrl = '';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Endpoint: jest.fn().mockImplementation((url: string) => ({ url })),
  RpcClient: jest.fn().mockImplementation((endpoint: { url: string }) => ({
    getBlockHeaderByNumber: (block: number) => mockGetBlockHeaderByNumber(block, endpoint.url)
  }))
}));
jest.mock('./constants', () => ({ ensureSdkWasmReady: () => mockReady() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockRpcUrl }));

const header = (timestamp: number) => ({ timestamp: () => timestamp });
let endpoint = 0;

beforeEach(() => {
  jest.clearAllMocks();
  // A fresh endpoint per test starts from an empty cache.
  endpoint += 1;
  mockRpcUrl = `https://rpc-${endpoint}.test`;
  mockReady.mockResolvedValue(undefined);
  mockGetBlockHeaderByNumber.mockImplementation(async (block: number) => header(block * 10));
});

it('reads each block once and serves repeats from the cache', async () => {
  await expect(getBlockTimestamps([7, 8, 7], mockRpcUrl)).resolves.toEqual(
    new Map([
      [7, 70],
      [8, 80]
    ])
  );
  await expect(getBlockTimestamps([8], mockRpcUrl)).resolves.toEqual(new Map([[8, 80]]));
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(2);
});

it('leaves a failed block out and asks for it again only after the cooldown', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  mockGetBlockHeaderByNumber.mockRejectedValueOnce(new Error('node down'));
  await expect(getBlockTimestamps([5], mockRpcUrl)).resolves.toEqual(new Map());
  await expect(getBlockTimestamps([5], mockRpcUrl)).resolves.toEqual(new Map());
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(1);

  now.mockReturnValue(1_060_000);
  await expect(getBlockTimestamps([5], mockRpcUrl)).resolves.toEqual(new Map([[5, 50]]));
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(2);
  now.mockRestore();
  warn.mockRestore();
});

it('dates up to 64 blocks in one call, eight lookups at a time', async () => {
  let inFlight = 0;
  let mostInFlight = 0;
  mockGetBlockHeaderByNumber.mockImplementation(async (block: number) => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 0));
    inFlight -= 1;
    return header(block * 10);
  });
  const blocks = Array.from({ length: 70 }, (_, index) => index + 1);
  expect((await getBlockTimestamps(blocks, mockRpcUrl)).size).toBe(64);
  expect(mostInFlight).toBe(8);
  expect((await getBlockTimestamps(blocks, mockRpcUrl)).size).toBe(70);
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(70);
  // Both calls share the endpoint's one client.
  expect(RpcClient).toHaveBeenCalledTimes(1);
});

it('starts a new cache when the RPC endpoint changes', async () => {
  await getBlockTimestamps([3], mockRpcUrl);
  mockRpcUrl = `${mockRpcUrl}/other`;
  mockGetBlockHeaderByNumber.mockResolvedValueOnce(header(999));
  await expect(getBlockTimestamps([3], mockRpcUrl)).resolves.toEqual(new Map([[3, 999]]));
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(2);
});

it('queries the endpoint it started on and returns nothing once the wallet moved to another', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const startUrl = mockRpcUrl;
  let resolveHeader: (value: ReturnType<typeof header>) => void = () => {};
  let rejectHeader: (error: Error) => void = () => {};
  mockGetBlockHeaderByNumber
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveHeader = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHeader = reject;
        })
    );
  const stale = getBlockTimestamps([1, 2], mockRpcUrl);
  mockRpcUrl = `${startUrl}/switched`;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mockGetBlockHeaderByNumber).toHaveBeenNthCalledWith(1, 1, startUrl);
  expect(mockGetBlockHeaderByNumber).toHaveBeenNthCalledWith(2, 2, startUrl);

  // The new endpoint dates block 1 before the old lookup settles.
  await expect(getBlockTimestamps([1], mockRpcUrl)).resolves.toEqual(new Map([[1, 10]]));
  resolveHeader(header(1234));
  rejectHeader(new Error('late failure'));
  await expect(stale).resolves.toEqual(new Map());

  // Neither the late result nor the late failure was filed under the new endpoint.
  await expect(getBlockTimestamps([1, 2], mockRpcUrl)).resolves.toEqual(
    new Map([
      [1, 10],
      [2, 20]
    ])
  );
  warn.mockRestore();
});

it('never throws when the RPC client cannot be created, and cools those blocks down', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockReady.mockRejectedValueOnce(new Error('wasm failed to load'));
  await expect(getBlockTimestamps([4], mockRpcUrl)).resolves.toEqual(new Map());
  await expect(getBlockTimestamps([4], mockRpcUrl)).resolves.toEqual(new Map());
  expect(mockReady).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('[block-timestamps] Could not create the RPC client', expect.any(Error));
  warn.mockRestore();
});

it('drops the cache once it holds more than 4096 blocks', async () => {
  for (let start = 0; start < 4_160; start += 64) {
    await getBlockTimestamps(
      Array.from({ length: 64 }, (_, index) => start + index),
      mockRpcUrl
    );
  }
  mockGetBlockHeaderByNumber.mockClear();
  await expect(getBlockTimestamps([0], mockRpcUrl)).resolves.toEqual(new Map([[0, 0]]));
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(1);
});

it('keeps at most eight requests outstanding against a node that accepts requests and never answers', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
  mockGetBlockHeaderByNumber.mockImplementation(() => new Promise(() => {}));
  const blocks = Array.from({ length: 12 }, (_, index) => index + 1);
  try {
    for (let lap = 1; lap <= 5; lap += 1) {
      const lookup = getBlockTimestamps(blocks, mockRpcUrl);
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(lookup).resolves.toEqual(new Map());
      // Every lap starts after the cooldown of the lap before.
      now.mockReturnValue(2_000_000 + lap * 60_001);
    }
    expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(8);
    expect(RpcClient).toHaveBeenCalledTimes(1);

    // Another endpoint starts with a fresh client and no outstanding requests.
    mockGetBlockHeaderByNumber.mockImplementation(async (block: number) => header(block * 10));
    mockRpcUrl = `${mockRpcUrl}/recovered`;
    const recovered = getBlockTimestamps([1], mockRpcUrl);
    await jest.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toEqual(new Map([[1, 10]]));
    expect(RpcClient).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    warn.mockRestore();
    jest.useRealTimers();
  }
});

it('lets no result from an earlier visit to an endpoint fill a later visit to the same URL', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
  const firstUrl = mockRpcUrl;
  const late: Array<() => void> = [];
  mockGetBlockHeaderByNumber.mockImplementation(
    (block: number) =>
      new Promise(resolve => {
        late.push(() => resolve(header(block * 10)));
      })
  );
  try {
    const firstVisit = getBlockTimestamps(
      Array.from({ length: 8 }, (_, index) => index + 1),
      mockRpcUrl
    );
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(firstVisit).resolves.toEqual(new Map());

    mockRpcUrl = `${firstUrl}/other`;
    await getBlockTimestamps([], mockRpcUrl);
    mockRpcUrl = firstUrl;
    await getBlockTimestamps([], mockRpcUrl);
    late.forEach(resolve => resolve());
    await jest.advanceTimersByTimeAsync(0);

    // The first visit's requests settled after the return, freeing only the capacity they held.
    mockGetBlockHeaderByNumber.mockClear();
    mockGetBlockHeaderByNumber.mockImplementation(() => new Promise(() => {}));
    now.mockReturnValue(3_000_000 + 60_001);
    const secondVisit = getBlockTimestamps(
      Array.from({ length: 20 }, (_, index) => index + 1),
      mockRpcUrl
    );
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(secondVisit).resolves.toEqual(new Map());
    expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(8);
  } finally {
    now.mockRestore();
    warn.mockRestore();
    jest.useRealTimers();
  }
});

it('looks nothing up for blocks read on an endpoint the wallet has since left', async () => {
  const readUrl = mockRpcUrl;
  mockRpcUrl = `${readUrl}/switched`;
  await expect(getBlockTimestamps([5], readUrl)).resolves.toEqual(new Map());
  expect(mockReady).not.toHaveBeenCalled();
  expect(mockGetBlockHeaderByNumber).not.toHaveBeenCalled();

  // Blocks read on the current endpoint are dated there.
  await expect(getBlockTimestamps([5], mockRpcUrl)).resolves.toEqual(new Map([[5, 50]]));
});

it('counts requests still hanging from an earlier visit when the wallet comes back to that endpoint', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const now = jest.spyOn(Date, 'now').mockReturnValue(4_000_000);
  const firstUrl = mockRpcUrl;
  mockGetBlockHeaderByNumber.mockImplementation(() => new Promise(() => {}));
  try {
    const firstVisit = getBlockTimestamps(
      Array.from({ length: 8 }, (_, index) => index + 1),
      firstUrl
    );
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(firstVisit).resolves.toEqual(new Map());

    mockRpcUrl = `${firstUrl}/other`;
    await getBlockTimestamps([], mockRpcUrl);
    mockRpcUrl = firstUrl;
    mockGetBlockHeaderByNumber.mockClear();
    const secondVisit = getBlockTimestamps(
      Array.from({ length: 8 }, (_, index) => index + 101),
      firstUrl
    );
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(secondVisit).resolves.toEqual(new Map());
    // The first visit's eight requests still hang, so the endpoint has no room for another.
    expect(mockGetBlockHeaderByNumber).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    warn.mockRestore();
    jest.useRealTimers();
  }
});

it('returns nothing once the wallet has moved, even when no lookup has started on the new endpoint', async () => {
  const readUrl = mockRpcUrl;
  let resolveSecond: (value: ReturnType<typeof header>) => void = () => {};
  mockGetBlockHeaderByNumber
    .mockImplementationOnce(async () => header(10))
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSecond = resolve;
        })
    );
  const lookup = getBlockTimestamps([1, 2], readUrl);
  await new Promise(resolve => setTimeout(resolve, 0));
  // Block 1 was dated before the wallet moved; block 2 is still pending.
  mockRpcUrl = `${readUrl}/moved`;
  resolveSecond(header(20));
  await expect(lookup).resolves.toEqual(new Map());
});

it('files neither a result nor a cooldown for a request that settles after the wallet moved away', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const readUrl = mockRpcUrl;
  let resolveFirst: (value: ReturnType<typeof header>) => void = () => {};
  let rejectSecond: (error: Error) => void = () => {};
  mockGetBlockHeaderByNumber
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        })
    );
  const lookup = getBlockTimestamps([1, 2], readUrl);
  await new Promise(resolve => setTimeout(resolve, 0));
  mockRpcUrl = `${readUrl}/moved`;
  resolveFirst(header(1234));
  rejectSecond(new Error('late failure'));
  await expect(lookup).resolves.toEqual(new Map());

  // Back on the endpoint with no lookup in between: neither late settlement was filed, so both blocks are read again.
  mockRpcUrl = readUrl;
  mockGetBlockHeaderByNumber.mockClear();
  await expect(getBlockTimestamps([1, 2], readUrl)).resolves.toEqual(
    new Map([
      [1, 10],
      [2, 20]
    ])
  );
  expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

it('cools nothing down when the RPC client fails to start after the wallet moved away', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const readUrl = mockRpcUrl;
  let rejectReady: (error: Error) => void = () => {};
  mockReady.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectReady = reject;
      })
  );
  const lookup = getBlockTimestamps([4], readUrl);
  mockRpcUrl = `${readUrl}/moved`;
  rejectReady(new Error('wasm failed to load'));
  await expect(lookup).resolves.toEqual(new Map());

  mockRpcUrl = readUrl;
  await expect(getBlockTimestamps([4], readUrl)).resolves.toEqual(new Map([[4, 40]]));
  warn.mockRestore();
});
