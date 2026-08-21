import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ITransaction } from 'lib/miden/db/types';

import { TransactionSummaryBadge, useTransactionSummaryBadgeContent } from './TransactionSummaryBadge';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key })
}));

jest.mock('lib/miden/metadata', () => ({
  MIDEN_METADATA: { symbol: 'MIDEN', decimals: 6 },
  // Real values. A claim's secondary faucets are exactly the ones the wallet has
  // no metadata for, so the unresolved fallback is load-bearing here, not filler.
  DEFAULT_TOKEN_METADATA: { symbol: 'Unknown', decimals: 6 }
}));

// The native faucet is the ONE unresolved faucet that may read MIDEN; every
// other must read Unknown. Drive it per-test rather than through the real
// module's process-lifetime memo cache.
let mockNativeAssetId: string | null = null;

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNativeAssetId
}));

jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint) => String(amount)
}));

const mockState = { assetsMetadata: {} as Record<string, { symbol?: string; decimals?: number }> | undefined };

jest.mock('lib/store', () => ({
  useWalletStore: (selector?: (state: typeof mockState) => unknown) => (selector ? selector(mockState) : mockState)
}));

const baseTransaction = (overrides: Partial<ITransaction> = {}): ITransaction =>
  ({
    id: 'tx-1',
    type: 'send',
    accountId: 'acct',
    status: 0,
    initiatedAt: 0,
    displayIcon: 'SEND',
    ...overrides
  }) as ITransaction;

describe('TransactionSummaryBadge component', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  const renderInto = async (element: React.ReactElement) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    return { container, root };
  };

  it('renders the pill with both sides and an arrow when lhs and rhs are provided', async () => {
    const { container, root } = await renderInto(
      <TransactionSummaryBadge lhs="100 TST" rhs="mtst1a...uyph" className="mt-6" />
    );
    expect(container.textContent).toContain('100 TST');
    expect(container.textContent).toContain('mtst1a...uyph');
    // Arrow glyph is rendered.
    expect(container.querySelector('svg')).not.toBeNull();
    // Caller-provided className lands on the pill root.
    expect(container.querySelector('.mt-6')).not.toBeNull();
    act(() => root.unmount());
  });

  it.each([
    ['lhs null', null, 'rhs'],
    ['lhs undefined', undefined, 'rhs'],
    ['lhs false', false, 'rhs'],
    ['rhs null', 'lhs', null],
    ['rhs undefined', 'lhs', undefined],
    ['rhs false', 'lhs', false]
  ])('renders nothing when %s', async (_label, lhs, rhs) => {
    const { container, root } = await renderInto(
      <TransactionSummaryBadge lhs={lhs as React.ReactNode} rhs={rhs as React.ReactNode} />
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('');
    act(() => root.unmount());
  });
});

describe('useTransactionSummaryBadgeContent', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockState.assetsMetadata = {};
    mockNativeAssetId = null;
  });

  const Probe: React.FC<{ tx?: ITransaction }> = ({ tx }) => {
    const content = useTransactionSummaryBadgeContent(tx);
    if (!content) return <div data-testid="out">UNDEFINED</div>;
    return (
      <div data-testid="out">
        <span data-testid="lhs">{content.lhs}</span>
        <TransactionSummaryBadge lhs={content.lhs} rhs={content.rhs} />
      </div>
    );
  };

  const renderProbe = async (tx?: ITransaction) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe tx={tx} />);
    });
    return { container, root };
  };

  it('returns undefined when there is no transaction', async () => {
    const { container, root } = await renderProbe(undefined);
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('returns undefined for a transaction type with no variant', async () => {
    const { container, root } = await renderProbe(baseTransaction({ type: 'execute' }));
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('builds "{amount} {symbol} -> Consumed" for a consume with an amount', async () => {
    mockState.assetsMetadata = { 'faucet-1': { symbol: 'TST', decimals: 6 } };
    const { container, root } = await renderProbe(
      baseTransaction({ type: 'consume', amount: 7n, faucetId: 'faucet-1' })
    );
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('7 TST');
    expect(container.textContent).toContain('Consumed');
    act(() => root.unmount());
  });

  it('returns undefined for a consume without an amount', async () => {
    const { container, root } = await renderProbe(baseTransaction({ type: 'consume' }));
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  // A "Claim All" sweeps up every claimable note, so a batch spanning faucets is
  // the normal case, not an edge one. Listing only `assetTotals[0]` understates
  // what arrived — the row would say "20 AAA" for a claim that also brought 10 B.
  it('lists every faucet of a batch claim, not just the row faucet', async () => {
    mockState.assetsMetadata = { 'faucet-a': { symbol: 'AAA', decimals: 6 } };
    const { container, root } = await renderProbe(
      baseTransaction({
        type: 'consume',
        amount: 20n,
        faucetId: 'faucet-a',
        assetTotals: [
          { faucetId: 'faucet-a', amount: 20n },
          { faucetId: 'faucet-b', amount: 10n }
        ]
      })
    );

    // Secondary faucet has no metadata (the wallet has never held it) → Unknown,
    // NOT MIDEN: naming a foreign token after the native one misstates the asset.
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('20 AAA, 10 Unknown');
    act(() => root.unmount());
  });

  it('labels an unresolved faucet MIDEN only when it IS the native faucet', async () => {
    mockNativeAssetId = 'faucet-native';
    const { container, root } = await renderProbe(
      baseTransaction({
        type: 'consume',
        amount: 4n,
        faucetId: 'faucet-native',
        assetTotals: [
          { faucetId: 'faucet-native', amount: 4n },
          { faucetId: 'faucet-b', amount: 6n }
        ]
      })
    );

    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('4 MIDEN, 6 Unknown');
    act(() => root.unmount());
  });

  // Legacy rows predate `assetTotals`; they must still summarise from the scalar
  // pair rather than silently losing their pill.
  it('falls back to the scalar amount/faucet for a legacy consume row', async () => {
    mockState.assetsMetadata = { 'faucet-1': { symbol: 'TST', decimals: 6 } };
    const { container, root } = await renderProbe(
      baseTransaction({ type: 'consume', amount: 7n, faucetId: 'faucet-1', assetTotals: [] })
    );
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('7 TST');
    act(() => root.unmount());
  });

  // `ConsumeTransaction` produces exactly this row for a note with no faucet id:
  // a headline amount, no `assetTotals` (see `db/types.test.ts`). Summarising it
  // needs a token name, and the only one available would be the native symbol —
  // so it renders nothing rather than claiming an unidentified asset is MIDEN.
  it('renders no summary for a claim whose asset cannot be attributed to a faucet', async () => {
    const { container, root } = await renderProbe(
      baseTransaction({ type: 'consume', amount: 4n, faucetId: '', assetTotals: undefined })
    );

    expect(container.querySelector('[data-testid="lhs"]')).toBeNull();
    act(() => root.unmount());
  });

  it('builds content from faucet metadata, amount and recipient for a send', async () => {
    mockState.assetsMetadata = { 'faucet-1': { symbol: 'TST', decimals: 6 } };
    const { container, root } = await renderProbe(
      baseTransaction({ amount: 5000000n, faucetId: 'faucet-1', secondaryAccountId: 'mtst1aprecipient_addr1234' })
    );
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('5000000 TST');
    expect(container.textContent).not.toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('falls back to the MIDEN symbol when there is no faucet metadata', async () => {
    const { container, root } = await renderProbe(
      baseTransaction({ amount: 42n, secondaryAccountId: 'mtst1aprecipient_addr1234' })
    );
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('42 MIDEN');
    act(() => root.unmount());
  });

  it('returns undefined when the send has no amount', async () => {
    const { container, root } = await renderProbe(baseTransaction({ secondaryAccountId: 'mtst1aprecipient_addr1234' }));
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('returns undefined when the send has no recipient', async () => {
    const { container, root } = await renderProbe(baseTransaction({ amount: 5n }));
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('builds an earn-deposit summary with the market label and USDC fallback', async () => {
    const { container, root } = await renderProbe(
      baseTransaction({
        type: 'earn-deposit',
        amount: 750n,
        extraInputs: { marketUid: 'DUMMY_LENDING:11155111:0xabc' }
      })
    );
    // lhs = "{amount} {symbol}" with the USDC fallback symbol.
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('750 USDC');
    // rhs = the hyphenated market name derived from the marketUid lender key.
    expect(container.textContent).toContain('DUMMY-LENDING');
    expect(container.textContent).not.toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('uses faucet metadata and an unknown lender key for an earn-deposit summary', async () => {
    mockState.assetsMetadata = { 'earn-faucet': { symbol: 'mUSDC', decimals: 4 } };
    const { container, root } = await renderProbe(
      baseTransaction({
        type: 'earn-deposit',
        amount: 125_000n,
        faucetId: 'earn-faucet',
        extraInputs: { marketUid: 'NEW_LENDER:11155111:0xabc' }
      })
    );

    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('125000 mUSDC');
    expect(container.textContent).toContain('NEW-LENDER');
    act(() => root.unmount());
  });

  it('returns undefined for an earn-deposit with no marketUid', async () => {
    const { container, root } = await renderProbe(baseTransaction({ type: 'earn-deposit', amount: 750n }));
    expect(container.textContent).toContain('UNDEFINED');
    act(() => root.unmount());
  });

  it('tolerates an undefined assetsMetadata store slice', async () => {
    mockState.assetsMetadata = undefined;
    const { container, root } = await renderProbe(
      baseTransaction({ amount: 8n, faucetId: 'faucet-x', secondaryAccountId: 'mtst1aprecipient_addr1234' })
    );
    expect(container.querySelector('[data-testid="lhs"]')?.textContent).toBe('8 MIDEN');
    act(() => root.unmount());
  });
});
