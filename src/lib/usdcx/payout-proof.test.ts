import { pad } from 'viem';

import {
  GatewayPayoutSource,
  PayoutReadClient,
  scanUsdcxPayout,
  USDCX_PAYOUT_CHUNKS_PER_CHECK,
  USDCX_PAYOUT_LOG_CHUNK
} from './payout-proof';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

const MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const DEPOSITOR = '0xb21c91a0F4d4c03f4b6A0fC5214F06E431FF2B2d';
const DEPOSITOR_WORD = '0x000000000000000000000000b21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d';
const ARC_XRESERVE = '0x008888878f94C0d87defdf0B07f46B93C1934442';
const USDC = '0x3600000000000000000000000000000000000000';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const NOTE_ID = '0x' + 'ab12'.repeat(16);
const OTHER_NOTE_ID = '0x' + 'cd34'.repeat(16);
const SOURCE: GatewayPayoutSource = {
  gatewayMinter: MINTER,
  depositor: DEPOSITOR_WORD,
  sourceDomain: 26
};
const AMOUNT = 5_000_000n;

interface FakeLog {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  removed?: boolean;
  args: { sourceDomain: number; sourceDepositor: `0x${string}`; value: bigint };
}

const txHash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;

function mint(overrides: Partial<FakeLog> & { value?: bigint } = {}): FakeLog {
  const { value, args, ...rest } = overrides;
  return {
    blockNumber: 11_992_339n,
    logIndex: 0,
    transactionHash: txHash(1),
    args: { sourceDomain: 26, sourceDepositor: SOURCE.depositor, value: value ?? 2_436_500n, ...args },
    ...rest
  };
}

let inputs: Record<string, string>;
let head: bigint;
let logsByStart: Map<bigint, FakeLog[] | Error>;
const getLogs = jest.fn();
const getTransaction = jest.fn();
const client: PayoutReadClient = {
  getBlockNumber: jest.fn(async () => head),
  getLogs,
  getTransaction,
  readContract: jest.fn()
};

const scan = (overrides: Partial<Parameters<typeof scanUsdcxPayout>[0]> = {}) =>
  scanUsdcxPayout({
    chainId: 5042002,
    recipient: RECIPIENT,
    usdc: USDC,
    burnNoteId: NOTE_ID,
    amount: AMOUNT,
    fromBlock: 11_992_000n,
    source: SOURCE,
    client,
    ...overrides
  });

beforeEach(() => {
  inputs = { [txHash(1)]: `0xdeadbeef${NOTE_ID.slice(2).toUpperCase()}` };
  head = 11_999_999n;
  logsByStart = new Map([[11_992_000n, [mint()]]]);
  getTransaction
    .mockReset()
    .mockImplementation(async ({ hash }: { hash: string }) => ({ input: inputs[hash] ?? '0x' }));
  getLogs.mockReset().mockImplementation(async ({ fromBlock }: { fromBlock: bigint }) => {
    const answer = logsByStart.get(fromBlock) ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  });
});

it('accepts the mint whose calldata carries the note id', async () => {
  await expect(scan()).resolves.toEqual({
    payout: { transactionHash: txHash(1), blockNumber: '11992339', value: '2436500' }
  });
  expect(getLogs).toHaveBeenCalledWith(
    expect.objectContaining({
      address: MINTER,
      args: { token: USDC, recipient: RECIPIENT },
      fromBlock: 11_992_000n,
      toBlock: 11_999_999n
    })
  );
});

it('ignores a credit whose transaction lacks the note id', async () => {
  inputs[txHash(1)] = `0xdeadbeef${OTHER_NOTE_ID.slice(2)}`;
  await expect(scan()).resolves.toEqual({ scannedTo: 11_999_999n });
});

it("picks this burn's mint when two burns to one recipient are paid in one window", async () => {
  inputs[txHash(2)] = `0x${OTHER_NOTE_ID.slice(2)}`;
  logsByStart.set(11_992_000n, [mint({ transactionHash: txHash(2), value: 4_000_000n }), mint({ logIndex: 1 })]);
  const first = await scan();
  expect(first.payout?.transactionHash).toBe(txHash(1));
  const second = await scan({ burnNoteId: OTHER_NOTE_ID });
  expect(second.payout).toEqual({ transactionHash: txHash(2), blockNumber: '11992339', value: '4000000' });
});

it.each([
  ['a wrong source domain', mint({ args: { sourceDomain: 6, sourceDepositor: SOURCE.depositor, value: 1_000_000n } })],
  ['a wrong source depositor', mint({ args: { sourceDomain: 26, sourceDepositor: pad('0x01'), value: 1_000_000n } })],
  ['a zero value', mint({ value: 0n })],
  ['a value above the amount', mint({ value: AMOUNT + 1n })]
])('ignores %s', async (_name, log) => {
  logsByStart.set(11_992_000n, [log]);
  await expect(scan()).resolves.toEqual({ scannedTo: 11_999_999n });
});

it('scans at most five 10,000-block chunks and reports the last one', async () => {
  head = 12_500_000n;
  logsByStart = new Map();
  await expect(scan()).resolves.toEqual({ scannedTo: 11_992_000n + 5n * 10_000n - 1n });
  expect(USDCX_PAYOUT_LOG_CHUNK).toBe(10_000n);
  expect(USDCX_PAYOUT_CHUNKS_PER_CHECK).toBe(5);
  expect(getLogs.mock.calls.map(([call]) => [call.fromBlock, call.toBlock])).toEqual([
    [11_992_000n, 12_001_999n],
    [12_002_000n, 12_011_999n],
    [12_012_000n, 12_021_999n],
    [12_022_000n, 12_031_999n],
    [12_032_000n, 12_041_999n]
  ]);
});

it('keeps the cursor at the last chunk that answered when a later chunk throws', async () => {
  head = 12_500_000n;
  logsByStart = new Map([[12_012_000n, new Error('rate limited')]]);
  await expect(scan()).resolves.toEqual({ scannedTo: 12_011_999n });
  expect(getLogs).toHaveBeenCalledTimes(3);
  logsByStart = new Map([[11_992_000n, new Error('rate limited')]]);
  await expect(scan()).resolves.toEqual({});
});

it('reads nothing when the head is below fromBlock', async () => {
  head = 11_991_999n;
  await expect(scan()).resolves.toEqual({});
  expect(getLogs).not.toHaveBeenCalled();
});

describe('readGatewayPayoutSource', () => {
  const readContract = jest.fn();
  const sourceClient: PayoutReadClient = { ...client, readContract };

  beforeEach(() => {
    jest.resetModules();
    readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'gatewayMinter') return MINTER;
      if (functionName === 'getRemoteDomainDepositor') return DEPOSITOR;
      throw new Error(`unexpected read ${functionName}`);
    });
  });

  const load = async () => (await import('./payout-proof')).readGatewayPayoutSource;

  it('reads the minter and depositor from the Arc xReserve and caches them', async () => {
    const read = await load();
    const expected = { gatewayMinter: MINTER, depositor: DEPOSITOR_WORD, sourceDomain: 26 };
    await expect(read({ client: sourceClient })).resolves.toEqual(expected);
    await expect(read({ client: sourceClient })).resolves.toEqual(expected);
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ARC_XRESERVE }));
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'getRemoteDomainDepositor', args: [10007] })
    );
  });

  it('does not cache a failed source read', async () => {
    const read = await load();
    readContract.mockRejectedValueOnce(new Error('timeout'));
    await expect(read({ client: sourceClient })).rejects.toThrow('timeout');
    await expect(read({ client: sourceClient })).resolves.toMatchObject({ gatewayMinter: MINTER });
  });
});
