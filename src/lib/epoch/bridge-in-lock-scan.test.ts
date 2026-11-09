import { getAllocatorId } from '@epoch-protocol/epoch-intents-sdk';

import {
  collectBridgeInSponsors,
  compactLockId,
  compactLockToken,
  lockScanAddresses,
  readCompactLockState,
  scanLockedBridgeFunds
} from './bridge-in-lock-scan';

const MULTICALL3 = { address: '0xcA11bde05977b3631167028862bE2a173976CA11' };
interface MockClient {
  chain: { id: number; contracts: { multicall3?: { address: string } } };
  multicall: jest.Mock;
  readContract: jest.Mock;
}
const mockClient: MockClient = {
  chain: { id: 11155111, contracts: { multicall3: MULTICALL3 } },
  multicall: jest.fn(),
  readContract: jest.fn()
};
const mockCreatePublicClient = jest.fn((..._args: unknown[]) => mockClient);
jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: (...args: unknown[]) => mockCreatePublicClient(...args)
}));

const mockResolveConfig = jest.fn();
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/services/shared.js', () => ({
  resolveServiceConfiguration: (...args: unknown[]) => mockResolveConfig(...args)
}));

const mockSnapshot = { config: { 'bridge-providers': { epoch: { allocatorUrl: 'https://allocator' } } } };
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: async () => mockSnapshot }));

const USDC = {
  key: 'USDC',
  address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  chainId: 11155111,
  symbol: 'USDC',
  decimals: 6
};
const ETH = {
  key: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  chainId: 11155111,
  symbol: 'ETH',
  decimals: 18
};
const mockTokens = new Map<number, unknown[]>();
jest.mock('lib/remote-config/values', () => ({
  selectEpochChainIds: () => [...mockTokens.keys()],
  selectEpochTokens: (_s: unknown, chainId: number) => mockTokens.get(chainId) ?? []
}));

jest.mock('./client', () => ({
  epochRpcChain: (id: number) => ({ id, rpcUrls: { default: { http: ['https://rpc.example'] } } })
}));

interface Row {
  type: string;
  restoredFromBackup?: boolean;
  extraInputs: { provider: string; sourceAddress: string };
}
let mockRows: Row[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: () => ({ equals: (type: string) => ({ toArray: async () => mockRows.filter(row => row.type === type) }) })
  }
}));

const ALLOCATOR = '0x0000000000ABcdeF0123456789aBcdeF01234567';
const COMPACT = '0x00000000000000171ede64904551eedf3c6c9788';
const OWNER = '0x00000000000000000000000000000000000000AA';
const OTHER = '0x00000000000000000000000000000000000000bb';

// The lock id as The Compact defines it, written out here so the test does not reuse the code under test.
function expectedLockId(allocator: string, resetPeriod: bigint, scope: bigint, token: string): bigint {
  const leadingZeroNibbles = allocator.slice(2).match(/^0*/)?.[0].length ?? 0;
  const compactFlag = leadingZeroNibbles >= 18 ? 15n : leadingZeroNibbles >= 4 ? BigInt(leadingZeroNibbles - 3) : 0n;
  const allocatorId = (compactFlag << 88n) | (BigInt(allocator) & ((1n << 88n) - 1n));
  const lockTag = (scope << 95n) | (resetPeriod << 92n) | allocatorId;
  return (lockTag << 160n) | BigInt(token);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTokens.clear();
  mockTokens.set(11155111, [USDC, ETH]);
  mockClient.chain.contracts = { multicall3: MULTICALL3 };
  mockResolveConfig.mockResolvedValue({
    compactAddress: COMPACT,
    allocatorAddress: ALLOCATOR,
    compactLockResetPeriod: 4,
    compactLockScope: 1
  });
  mockRows = [];
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('lock ids', () => {
  it('derives the lock id from the allocator, reset period, scope and token', () => {
    expect(getAllocatorId(ALLOCATOR)).toBe((7n << 88n) | (BigInt(ALLOCATOR) & ((1n << 88n) - 1n)));
    expect(compactLockId(ALLOCATOR, 4, 1, USDC.address)).toBe(expectedLockId(ALLOCATOR, 4n, 1n, USDC.address));
    // The native coin is the zero address: the lock id is the lock tag alone.
    expect(compactLockId(ALLOCATOR, 4, 1, ETH.address)).toBe(expectedLockId(ALLOCATOR, 4n, 1n, ETH.address));
  });

  it('reads the token back from a lock id', () => {
    expect(compactLockToken(compactLockId(ALLOCATOR, 4, 1, USDC.address))).toBe(USDC.address);
    expect(compactLockToken(compactLockId(ALLOCATOR, 4, 1, ETH.address).toString())).toBe(ETH.address);
  });
});

describe('scanLockedBridgeFunds', () => {
  const usdcLock = expectedLockId(ALLOCATOR, 4n, 1n, USDC.address);
  const ethLock = expectedLockId(ALLOCATOR, 4n, 1n, ETH.address);

  it('reads every token of a chain in one multicall per address', async () => {
    mockClient.multicall.mockResolvedValue([
      { status: 'success', result: 2500000n },
      { status: 'success', result: 0n }
    ]);

    const [scan] = await scanLockedBridgeFunds([OWNER]);

    expect(mockResolveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiBaseUrl: 'https://allocator' }),
      11155111
    );
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
    expect(mockClient.multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        contracts: [
          expect.objectContaining({ address: COMPACT, functionName: 'balanceOf', args: [OWNER, usdcLock] }),
          expect.objectContaining({ address: COMPACT, functionName: 'balanceOf', args: [OWNER, ethLock] })
        ]
      })
    );
    expect(mockClient.readContract).not.toHaveBeenCalled();
    expect(scan?.entries).toEqual([
      { chainId: 11155111, token: USDC, lockId: usdcLock.toString(), read: { state: 'ok', balance: 2500000n } },
      { chainId: 11155111, token: ETH, lockId: ethLock.toString(), read: { state: 'ok', balance: 0n } }
    ]);
  });

  it('gives a failed read, never zero, for a call or a multicall that failed', async () => {
    mockClient.multicall.mockResolvedValueOnce([
      { status: 'failure', error: new Error('reverted') },
      { status: 'success', result: 5n }
    ]);
    const [partial] = await scanLockedBridgeFunds([OWNER]);
    expect(partial?.entries.map(entry => entry.read)).toEqual([{ state: 'failed' }, { state: 'ok', balance: 5n }]);

    mockClient.multicall.mockRejectedValueOnce(new Error('rpc down'));
    const [failed] = await scanLockedBridgeFunds([OWNER]);
    expect(failed?.entries.map(entry => entry.read)).toEqual([{ state: 'failed' }, { state: 'failed' }]);
  });

  it('marks every token of a chain unknown when the allocator settings cannot be read', async () => {
    mockResolveConfig.mockRejectedValue(new Error('health down'));

    const [scan] = await scanLockedBridgeFunds([OWNER]);

    expect(mockClient.multicall).not.toHaveBeenCalled();
    expect(scan?.entries).toEqual([
      { chainId: 11155111, token: USDC, read: { state: 'failed' } },
      { chainId: 11155111, token: ETH, read: { state: 'failed' } }
    ]);
  });

  it('reads lock by lock on a chain without multicall3', async () => {
    mockClient.chain.contracts = {};
    mockClient.readContract.mockResolvedValueOnce(7n).mockRejectedValueOnce(new Error('timeout'));

    const [scan] = await scanLockedBridgeFunds([OWNER]);

    expect(mockClient.multicall).not.toHaveBeenCalled();
    expect(mockClient.readContract).toHaveBeenCalledTimes(2);
    expect(scan?.entries.map(entry => entry.read)).toEqual([{ state: 'ok', balance: 7n }, { state: 'failed' }]);
  });

  it('scans each address on each chain, and nothing without an address', async () => {
    mockTokens.set(8453, [{ ...USDC, chainId: 8453 }]);
    mockClient.multicall.mockResolvedValue([{ status: 'success', result: 1n }]);

    await expect(scanLockedBridgeFunds([])).resolves.toEqual([]);
    const scans = await scanLockedBridgeFunds([OWNER, OTHER]);

    expect(scans.map(scan => scan.address)).toEqual([OWNER, OTHER]);
    expect(mockClient.multicall).toHaveBeenCalledTimes(4);
    expect(scans[1]?.entries.map(entry => entry.chainId)).toEqual([11155111, 11155111, 8453]);
  });
});

describe('addresses to scan', () => {
  const row = (sourceAddress: string, extra: Partial<Row> = {}, provider = 'epoch'): Row => ({
    type: 'bridged-receive',
    extraInputs: { provider, sourceAddress },
    ...extra
  });

  it('collects each Fast bridge-in address once, without restored rows or other providers', async () => {
    mockRows = [
      row(OWNER.toLowerCase()),
      row(OWNER),
      row(OTHER, { restoredFromBackup: true }),
      row(OTHER, {}, 'agglayer'),
      row('not-an-address'),
      { type: 'send', extraInputs: { provider: 'epoch', sourceAddress: OTHER } }
    ];

    await expect(collectBridgeInSponsors()).resolves.toEqual([OWNER]);
  });

  it('puts the connected wallet first and never twice', () => {
    expect(lockScanAddresses(OTHER, [OWNER, OTHER])).toEqual([OTHER, OWNER]);
    expect(lockScanAddresses(OTHER.toUpperCase().replace('0X', '0x'), [OWNER])).toEqual([OTHER, OWNER]);
    expect(lockScanAddresses(undefined, [OWNER])).toEqual([OWNER]);
  });
});

describe('readCompactLockState', () => {
  it('reads the balance and the forced withdrawal of one lock', async () => {
    mockClient.readContract.mockResolvedValueOnce(9n).mockResolvedValueOnce([1, 4900n]);

    await expect(readCompactLockState(11155111, OWNER, 42n)).resolves.toEqual({
      balance: 9n,
      withdrawal: { status: 'Pending', withdrawableAt: 4900 }
    });
  });

  it('leaves out a read that failed', async () => {
    mockClient.readContract.mockRejectedValueOnce(new Error('rpc')).mockResolvedValueOnce([0, 0n]);

    await expect(readCompactLockState(11155111, OWNER, 42n)).resolves.toEqual({
      balance: undefined,
      withdrawal: { status: 'Disabled' }
    });
  });
});
