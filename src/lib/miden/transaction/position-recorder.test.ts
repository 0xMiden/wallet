import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { POSITION_PRICE_DEADLINE_MS, recordPositionEvents, rowFlows } from './position-recorder';
import { readVaultHoldings } from './vault-read';
import { ITransaction, ITransactionStatus } from '../db/types';
import { readPositionEvents } from '../position-events';
import { db, Table, transactions } from '../repo';
import { identifyValuedAsset, loadValuationContext } from '../spending-limits/valuation';

const mockNetwork = jest.fn<string, []>(() => 'mainnet');
const mockProvenBadgeNetwork = jest.fn<string | undefined, []>(() => mockNetwork());
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => mockNetwork(),
  provenBadgeNetwork: () => mockProvenBadgeNetwork()
}));
jest.mock('lib/miden/swap/tokens', () => ({ canonicalFaucetId: (id: string) => id.toLowerCase() }));
jest.mock('./vault-read', () => ({ readVaultHoldings: jest.fn() }));
jest.mock('../spending-limits/valuation', () => ({ identifyValuedAsset: jest.fn(), loadValuationContext: jest.fn() }));
const mockCache = jest.fn();
jest.mock('lib/prices/usd', () => ({
  ...jest.requireActual('lib/prices/usd'),
  readCachedUsdPrice: (symbol: string) => mockCache(symbol)
}));

const held = jest.mocked(readVaultHoldings);
const identify = jest.mocked(identifyValuedAsset);
const context = jest.mocked(loadValuationContext);
const COMPLETED_AT = 1_800_000_000;

const row = (changes: Partial<ITransaction>): ITransaction => ({
  id: 'tx-1',
  type: 'consume',
  accountId: 'account-a',
  status: ITransactionStatus.Completed,
  initiatedAt: COMPLETED_AT - 30,
  completedAt: COMPLETED_AT,
  displayMessage: '',
  displayIcon: 'DEFAULT',
  ...changes
});

beforeEach(async () => {
  await db.table(Table.PositionEvents).clear();
  await transactions.clear();
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
  mockProvenBadgeNetwork.mockImplementation(() => mockNetwork());
  held.mockResolvedValue(new Map([['faucet-a', 7n]]));
  context.mockResolvedValue({
    network: 'mainnet',
    nativeId: 'fee',
    nativeIdentityCause: undefined,
    nativeMetadata: undefined
  });
  identify.mockImplementation(async faucetId => ({
    faucetId,
    symbol: 'AAA',
    decimals: 6,
    priceSymbol: faucetId === 'faucet-u' ? 'USDCX' : 'AAA'
  }));
  mockCache.mockResolvedValue({ priceMicro: 2_000_000n, fetchedAt: COMPLETED_AT - 30 });
});

describe('rowFlows', () => {
  it('reads arrivals from a consume and departures from each outgoing type, with the fee leaving in its own asset', () => {
    expect(
      rowFlows(
        row({
          assetTotals: [
            { faucetId: 'FAUCET-A', amount: 5n },
            { faucetId: 'faucet-a', amount: 2n },
            { faucetId: 'fee', amount: 3n }
          ],
          feeFaucetId: 'fee',
          feeAmount: 1n
        })
      )
    ).toEqual(
      new Map([
        ['faucet-a', { arrived: 7n, departed: 0n }],
        ['fee', { arrived: 3n, departed: 1n }]
      ])
    );
    expect(rowFlows(row({ assetTotals: [], faucetId: 'faucet-a', amount: 4n }))).toEqual(
      new Map([['faucet-a', { arrived: 4n, departed: 0n }]])
    );
    for (const type of ['send', 'swap', 'bridged-send', 'earn-deposit'] as const) {
      expect(rowFlows(row({ type, faucetId: 'faucet-a', amount: 4n }))).toEqual(
        new Map([['faucet-a', { arrived: 0n, departed: 4n }]])
      );
    }
    expect(rowFlows(row({ type: 'register-name', faucetId: 'faucet-a', amount: 4n }))).toEqual(
      new Map([['faucet-a', { arrived: 0n, departed: 4n }]])
    );
    expect(
      rowFlows(row({ type: 'execute', faucetId: 'faucet-a', amount: 4n, feeFaucetId: 'fee', feeAmount: 2n }))
    ).toEqual(new Map([['fee', { arrived: 0n, departed: 2n }]]));
    expect(
      rowFlows(
        row({
          type: 'execute',
          spentAssetTotals: [{ faucetId: 'faucet-a', amount: 5n }],
          feeFaucetId: 'fee',
          feeAmount: 2n
        })
      )
    ).toEqual(
      new Map([
        ['faucet-a', { arrived: 0n, departed: 5n }],
        ['fee', { arrived: 0n, departed: 2n }]
      ])
    );
    expect(rowFlows(row({ type: 'send', faucetId: 'faucet-a', amount: 0n }))).toEqual(new Map());
  });
});

describe('recordPositionEvents', () => {
  it('records each faucet with the vault after the event and the quote cached before it', async () => {
    await transactions.add(
      row({ assetTotals: [{ faucetId: 'faucet-a', amount: 5n }], feeFaucetId: 'faucet-u', feeAmount: 1n })
    );
    held.mockResolvedValue(new Map([['faucet-a', 7n]]));
    await recordPositionEvents('tx-1');

    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-a')).toEqual([
      expect.objectContaining({
        key: 'tx-1:faucet-a',
        eventAt: COMPLETED_AT * 1000,
        arrived: 5n,
        departed: 0n,
        heldAfter: 7n,
        decimals: 6,
        quote: { priceMicro: 2_000_000n, kind: 'market', observedAt: (COMPLETED_AT - 30) * 1000 }
      })
    ]);
    // A departure needs no price; an absent faucet reads as an empty holding.
    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-u')).toEqual([
      expect.objectContaining({ departed: 1n, heldAfter: 0n, decimals: null, quote: null })
    ]);
    expect(mockCache).toHaveBeenCalledTimes(1);
  });

  it('prices USDCx at its fixed quote and leaves an unidentified or uncached arrival unpriced', async () => {
    await transactions.add(
      row({
        assetTotals: [
          { faucetId: 'faucet-u', amount: 1n },
          { faucetId: 'faucet-x', amount: 1n },
          { faucetId: 'faucet-a', amount: 1n }
        ]
      })
    );
    identify.mockImplementation(async faucetId => {
      if (faucetId === 'faucet-x') throw new Error('unknown');
      return { faucetId, symbol: 'S', decimals: 6, priceSymbol: faucetId === 'faucet-u' ? 'USDCX' : 'AAA' };
    });
    mockCache.mockResolvedValue(undefined);
    held.mockResolvedValue(null);
    await recordPositionEvents('tx-1');

    const [usdcx] = await readPositionEvents('account-a', 'mainnet', 'faucet-u');
    expect(usdcx).toMatchObject({ quote: { priceMicro: 1_000_000n, kind: 'fixed' }, heldAfter: null });
    expect((await readPositionEvents('account-a', 'mainnet', 'faucet-x'))[0]).toMatchObject({
      decimals: null,
      quote: null
    });
    expect((await readPositionEvents('account-a', 'mainnet', 'faucet-a'))[0]).toMatchObject({
      decimals: 6,
      quote: null
    });
  });

  it('records nothing off mainnet, for a row that is not completed, restored or recovered, or twice', async () => {
    await transactions.add(row({ id: 'queued', status: ITransactionStatus.Queued, faucetId: 'faucet-a', amount: 1n }));
    await transactions.add(row({ id: 'restored', restoredFromBackup: true, faucetId: 'faucet-a', amount: 1n }));
    await transactions.add(row({ id: 'recovered', recovered: true, faucetId: 'faucet-a', amount: 1n }));
    await transactions.add(row({ id: 'live', faucetId: 'faucet-a', amount: 1n }));
    for (const id of ['queued', 'restored', 'recovered', 'missing']) await recordPositionEvents(id);
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    await recordPositionEvents('live');
    expect(await db.table(Table.PositionEvents).count()).toBe(0);

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
    mockProvenBadgeNetwork.mockReturnValue(undefined);
    await recordPositionEvents('live');
    expect(await db.table(Table.PositionEvents).count()).toBe(0);

    mockProvenBadgeNetwork.mockImplementation(() => mockNetwork());
    await recordPositionEvents('live');
    held.mockResolvedValue(new Map([['faucet-a', 99n]]));
    await recordPositionEvents('live');
    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-a')).toEqual([
      expect.objectContaining({ txId: 'live', heldAfter: 7n })
    ]);
  });

  it('never throws, and records unpriced when the valuation context cannot load', async () => {
    await transactions.add(row({ faucetId: 'faucet-a', amount: 1n }));
    context.mockRejectedValue(new Error('no sdk'));
    await recordPositionEvents('tx-1');
    expect((await readPositionEvents('account-a', 'mainnet', 'faucet-a'))[0]).toMatchObject({ quote: null });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    held.mockRejectedValue(new Error('5 tokens'));
    await transactions.add(row({ id: 'tx-2', faucetId: 'faucet-a', amount: 1n }));
    await expect(recordPositionEvents('tx-2')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[position] recording failed (non-fatal)', 'Error');
    warn.mockRestore();
  });

  it('does not load valuation context for a departure-only row', async () => {
    await transactions.add(row({ type: 'send', faucetId: 'faucet-a', amount: 1n }));
    context.mockClear();
    identify.mockClear();

    await recordPositionEvents('tx-1');

    expect(context).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-a')).toEqual([
      expect.objectContaining({ departed: 1n, decimals: null, quote: null })
    ]);
  });

  it('records arrivals unpriced when row valuation exceeds the deadline', async () => {
    await transactions.add(
      row({
        assetTotals: [
          { faucetId: 'faucet-a', amount: 1n },
          { faucetId: 'faucet-b', amount: 2n }
        ]
      })
    );
    identify.mockImplementation(() => new Promise(() => {}));

    const result = await Promise.race([
      recordPositionEvents('tx-1').then(() => 'recorded' as const),
      new Promise<'still-waiting'>(resolve =>
        setTimeout(() => resolve('still-waiting'), POSITION_PRICE_DEADLINE_MS + 500)
      )
    ]);

    expect(result).toBe('recorded');
    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-a')).toEqual([
      expect.objectContaining({ arrived: 1n, decimals: null, quote: null })
    ]);
    expect(await readPositionEvents('account-a', 'mainnet', 'faucet-b')).toEqual([
      expect.objectContaining({ arrived: 2n, decimals: null, quote: null })
    ]);
  });
});
