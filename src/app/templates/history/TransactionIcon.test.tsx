import React from 'react';

import { render } from '@testing-library/react';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import TransactionIcon, { getTransactionIconBackgroundColor } from './TransactionIcon';
import { bridgeStatusOf, isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

// `app/icons/v2` is the real barrel that switches an `IconName` onto one of
// ~100 SVG imports and pulls in `lib/miden-chain/constants`. Replace it with a
// marker `Icon` (exposing the `name`/`size`/`className` props the SWAP branch
// forwards) plus a minimal `IconName` enum, so the SWAP path is assertable
// without the barrel's heavy dependency graph.
jest.mock('app/icons/v2', () => ({
  __esModule: true,
  IconName: { Convert: 'convert', Close: 'close', Earn: 'earn' },
  Icon: ({ name, size, className }: { name: string; size?: string; className?: string }) => (
    <div data-testid="v2-icon" data-name={name} data-size={size} className={className} />
  )
}));

// `transactionUtils` imports date-fns, i18n and the Miden metadata/native-asset
// stack. Stub it down to the two symbols this component uses: a steerable
// `isFaucetRequest` (drives the faucet branch) and the color constants that
// feed the inline `backgroundColor` styles.
jest.mock('./transactionUtils', () => ({
  __esModule: true,
  bridgeStatusOf: jest.fn(() => 'confirmed'),
  isFaucetRequest: jest.fn(() => false),
  // Faithful to the real one-liner (`entry.earnDepositStatus ?? 'pending'`) so the
  // failed-lending-leg branch is exercised, not stubbed away.
  earnDepositSettlementOf: (entry: { earnDepositStatus?: string }) => entry.earnDepositStatus ?? 'pending',
  TRANSACTION_COLORS: { send: '#91ACC1', receive: '#99AC94', faucet: '#891DB1' }
}));

const mockIsFaucetRequest = isFaucetRequest as jest.MockedFunction<typeof isFaucetRequest>;
const mockBridgeStatusOf = bridgeStatusOf as jest.MockedFunction<typeof bridgeStatusOf>;

// The SVG imports (faucet / rotate / receive / send) resolve to the `svg`
// string host element via the jest svgMock, so each renders as a real
// `<svg class="…">` we can query and inspect.
const makeEntry = (overrides: Partial<IHistoryEntry> = {}): IHistoryEntry =>
  ({
    key: 'k1',
    address: 'addr-1',
    timestamp: 0,
    message: 'msg',
    type: HistoryEntryType.CompletedTransaction,
    txType: 'send',
    ...overrides
  }) as IHistoryEntry;

const root = (container: HTMLElement) => container.firstChild as HTMLElement;

beforeEach(() => {
  // Call history must start empty: several tests assert a branch short-circuits
  // *before* reaching `isFaucetRequest` / `bridgeStatusOf`.
  jest.clearAllMocks();
  mockIsFaucetRequest.mockReturnValue(false);
  mockBridgeStatusOf.mockReturnValue('confirmed');
});

describe('TransactionIcon', () => {
  describe('earn transaction branch', () => {
    it('renders the Earn glyph for an opened position even when its persisted icon is RECEIVE', () => {
      const { container, getByTestId } = render(
        <TransactionIcon entry={makeEntry({ txType: 'earn-deposit', transactionIcon: 'RECEIVE' })} size="lg" />
      );

      expect(root(container)).toHaveClass('w-18', 'h-18', 'rounded-10', 'bg-tx-earn');
      expect(getByTestId('v2-icon')).toHaveAttribute('data-name', 'earn');
      expect(getByTestId('v2-icon')).toHaveAttribute('data-size', 'lg');
    });

    it('renders the failed cross for a failed Smart Withdraw', () => {
      const { container } = render(
        <TransactionIcon entry={makeEntry({ txType: 'earn-withdraw', earnWithdrawPhase: 'failed' })} />
      );

      expect(root(container)).toHaveClass('bg-status-negative');
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('accents earn rows with the earn token and failed withdrawals with red', () => {
      expect(getTransactionIconBackgroundColor(makeEntry({ txType: 'earn-deposit' }))).toBe('var(--tx-earn)');
      expect(
        getTransactionIconBackgroundColor(makeEntry({ txType: 'earn-withdraw', earnWithdrawPhase: 'failed' }))
      ).toBe('#CC5D5D');
    });

    it('reddens a deposit whose lending leg settled failed (agrees with the Failed chip)', () => {
      // earnDepositStatus 'failed' with a non-FAILED transactionIcon: the Miden collateral
      // note landed but the Sepolia lending leg failed. The accent + glyph must go red so
      // they do not contradict the red "Failed" status chip the activity list renders.
      expect(
        getTransactionIconBackgroundColor(makeEntry({ txType: 'earn-deposit', earnDepositStatus: 'failed' }))
      ).toBe('#CC5D5D');
      const { container } = render(
        <TransactionIcon entry={makeEntry({ txType: 'earn-deposit', earnDepositStatus: 'failed' })} />
      );
      expect(root(container)).toHaveClass('bg-status-negative');
    });
  });

  it('renders a failed glyph for a terminal bridge failure', () => {
    mockBridgeStatusOf.mockReturnValue('failed');

    const { getByTestId, container } = render(
      <TransactionIcon entry={makeEntry({ txType: 'bridged-send', transactionIcon: 'SEND' })} />
    );

    expect(root(container)).toHaveClass('bg-status-negative');
    expect(getByTestId('v2-icon')).toHaveAttribute('data-name', 'close');
  });

  describe('bridge branch', () => {
    // Every bridge shape — outbound, inbound by txType, and inbound recognised
    // only by its provider stamp — resolves to the same slate swap square.
    it.each([
      ['bridged-send', { txType: 'bridged-send' as const }],
      ['bridged-receive', { txType: 'bridged-receive' as const }],
      ['a provider-stamped row', { bridgeInProvider: 'epoch' as const }]
    ])('renders the slate swap square for %s', (_label, overrides) => {
      const { container } = render(<TransactionIcon entry={makeEntry(overrides)} />);

      const wrapper = root(container);
      expect(wrapper).toHaveClass('rounded-10');
      expect(wrapper).toHaveStyle({ backgroundColor: '#777487' });
      expect(wrapper.querySelector('svg')).toHaveClass('w-4.5', 'h-4.5');
    });

    it('sizes the failure cross with the lg Icon', () => {
      mockBridgeStatusOf.mockReturnValue('failed');
      const { getByTestId } = render(<TransactionIcon entry={makeEntry({ txType: 'bridged-send' })} size="lg" />);

      expect(getByTestId('v2-icon')).toHaveAttribute('data-size', 'lg');
    });
  });

  describe('cancelled branch', () => {
    it('renders the grey cross and takes precedence over every other branch', () => {
      const { container } = render(
        <TransactionIcon entry={makeEntry({ isCancelled: true, txType: 'bridged-send', transactionIcon: 'FAILED' })} />
      );

      expect(root(container)).toHaveClass('bg-gray-400', 'rounded-10');
      expect(mockBridgeStatusOf).not.toHaveBeenCalled();
    });

    it('renders the FAILED square for a hard transaction failure', () => {
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'FAILED' })} />);

      expect(root(container)).toHaveClass('bg-[#CC5D5D]', 'rounded-10');
    });

    it('keeps the earn failure cross when the Miden side itself failed', () => {
      const { container } = render(
        <TransactionIcon entry={makeEntry({ txType: 'earn-withdraw', transactionIcon: 'FAILED' })} />
      );

      expect(root(container)).toHaveClass('bg-status-negative');
    });
  });

  // The accent feeds both the glyph and the detail-page section dividers, so it
  // has to agree with the glyph branch above for every row shape.
  describe('getTransactionIconBackgroundColor', () => {
    it('greys out a cancelled row ahead of anything else', () => {
      expect(getTransactionIconBackgroundColor(makeEntry({ isCancelled: true, transactionIcon: 'FAILED' }))).toBe(
        '#9E9E9E'
      );
    });

    it('reddens a hard failure', () => {
      expect(getTransactionIconBackgroundColor(makeEntry({ transactionIcon: 'FAILED' }))).toBe('#CC5D5D');
    });

    it.each([
      ['bridged-send', { txType: 'bridged-send' as const }],
      ['a provider-stamped row', { bridgeInProvider: 'epoch' as const }]
    ])('uses the slate bridge accent for %s', (_label, overrides) => {
      expect(getTransactionIconBackgroundColor(makeEntry(overrides))).toBe('#777487');
    });

    it('reddens a failed bridge', () => {
      mockBridgeStatusOf.mockReturnValue('failed');
      expect(getTransactionIconBackgroundColor(makeEntry({ txType: 'bridged-send' }))).toBe('#CC5D5D');
    });

    it('uses the faucet accent for a faucet request', () => {
      mockIsFaucetRequest.mockReturnValue(true);
      expect(getTransactionIconBackgroundColor(makeEntry({ transactionIcon: 'SEND' }))).toBe(TRANSACTION_COLORS.faucet);
    });

    it.each([
      ['SEND', TRANSACTION_COLORS.send],
      ['SWAP', 'var(--tx-swap)'],
      ['RECEIVE', TRANSACTION_COLORS.receive],
      [undefined, TRANSACTION_COLORS.receive]
    ])('maps transactionIcon %s onto its accent', (transactionIcon, expected) => {
      expect(getTransactionIconBackgroundColor(makeEntry({ transactionIcon: transactionIcon as never }))).toBe(
        expected
      );
    });
  });

  describe('pending / processing spinner branch', () => {
    it.each([
      ['PendingTransaction', HistoryEntryType.PendingTransaction],
      ['ProcessingTransaction', HistoryEntryType.ProcessingTransaction]
    ])('renders the spinning PendingIcon (no wrapper) for %s', (_label, type) => {
      const { container } = render(<TransactionIcon entry={makeEntry({ type })} />);

      const svg = root(container);
      expect(svg.tagName.toLowerCase()).toBe('svg');
      // Default size = 'sm' => pending sizing `w-6 h-6`, spin + white icon classes.
      expect(svg).toHaveClass('w-6', 'h-6', 'animate-spin', 'text-pure-white', '[&_path]:fill-pure-white');
      // Pending short-circuits before the faucet check.
      expect(mockIsFaucetRequest).not.toHaveBeenCalled();
    });

    it('uses the lg pending sizing when size="lg"', () => {
      const { container } = render(
        <TransactionIcon entry={makeEntry({ type: HistoryEntryType.PendingTransaction })} size="lg" />
      );

      const svg = root(container);
      expect(svg).toHaveClass('w-8', 'h-8', 'animate-spin');
      expect(svg).not.toHaveClass('w-6', 'h-6');
    });
  });

  describe('faucet-request branch', () => {
    it('renders the faucet circle + FaucetIcon when isFaucetRequest is true (sm)', () => {
      mockIsFaucetRequest.mockReturnValue(true);
      const entry = makeEntry({ transactionIcon: 'RECEIVE' });

      const { container } = render(<TransactionIcon entry={entry} />);

      const wrapper = root(container);
      expect(wrapper.tagName.toLowerCase()).toBe('div');
      expect(wrapper).toHaveClass('w-8.5', 'h-8.5', 'flex', 'items-center', 'justify-center', 'rounded-full');
      expect(wrapper).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.faucet });
      expect(mockIsFaucetRequest).toHaveBeenCalledWith(entry);

      const svg = wrapper.querySelector('svg') as SVGElement;
      expect(svg).toBeInTheDocument();
      // sm icon sizing + white-icon classes.
      expect(svg).toHaveClass('w-4.5', 'h-4.5', 'text-pure-white', '[&_path]:fill-pure-white');
    });

    it('uses the lg container/icon sizing when size="lg"', () => {
      mockIsFaucetRequest.mockReturnValue(true);
      const { container } = render(<TransactionIcon entry={makeEntry()} size="lg" />);

      const wrapper = root(container);
      expect(wrapper).toHaveClass('w-18', 'h-18');
      expect(wrapper.querySelector('svg')).toHaveClass('w-8', 'h-8');
    });

    it('takes precedence over the transactionIcon switch (SEND ignored when faucet)', () => {
      mockIsFaucetRequest.mockReturnValue(true);
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'SEND' })} />);

      // Faucet color, not the send color.
      expect(root(container)).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.faucet });
      expect(root(container)).not.toHaveStyle({ backgroundColor: TRANSACTION_COLORS.send });
    });
  });

  describe('transactionIcon switch', () => {
    it('renders the SEND circle + SendIcon with send color (sendIcon sizing)', () => {
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'SEND' })} />);

      const wrapper = root(container);
      expect(wrapper).toHaveClass('w-8.5', 'h-8.5', 'rounded-full', 'flex', 'items-center', 'justify-center');
      expect(wrapper).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.send });
      // sm sendIcon sizing is `w-3.5 h-3.5`.
      expect(wrapper.querySelector('svg')).toHaveClass('w-3.5', 'h-3.5', 'text-pure-white', '[&_path]:fill-pure-white');
    });

    it('renders the SEND icon at lg sizing (sendIcon w-8 h-8)', () => {
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'SEND' })} size="lg" />);

      expect(root(container)).toHaveClass('w-18', 'h-18');
      expect(root(container).querySelector('svg')).toHaveClass('w-8', 'h-8');
    });

    it('renders the SWAP square + Convert Icon (sm => Icon size "sm")', () => {
      const { getByTestId, container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'SWAP' })} />);

      const wrapper = root(container);
      // Swap uses a rounded square with the tx-swap background, not an inline color.
      expect(wrapper).toHaveClass(
        'w-8.5',
        'h-8.5',
        'rounded-10',
        'flex',
        'items-center',
        'justify-center',
        'bg-tx-swap'
      );
      expect(wrapper).not.toHaveAttribute('style');

      const icon = getByTestId('v2-icon');
      expect(icon).toHaveAttribute('data-name', 'convert');
      expect(icon).toHaveAttribute('data-size', 'sm');
      expect(icon).toHaveClass('[&_path]:stroke-pure-white');
    });

    it('maps size="lg" to Icon size "lg" for SWAP', () => {
      const { getByTestId } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'SWAP' })} size="lg" />);

      expect(getByTestId('v2-icon')).toHaveAttribute('data-size', 'lg');
    });

    it('renders the RECEIVE circle + ReceiveIcon with receive color (icon sizing)', () => {
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: 'RECEIVE' })} />);

      const wrapper = root(container);
      expect(wrapper).toHaveClass('w-8.5', 'h-8.5', 'rounded-full');
      expect(wrapper).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.receive });
      // RECEIVE uses `config.icon` (w-4.5 h-4.5), unlike SEND's sendIcon.
      expect(wrapper.querySelector('svg')).toHaveClass('w-4.5', 'h-4.5', 'text-pure-white', '[&_path]:fill-pure-white');
    });

    it('falls through to the RECEIVE default when transactionIcon is undefined', () => {
      const { container } = render(<TransactionIcon entry={makeEntry({ transactionIcon: undefined })} />);

      const wrapper = root(container);
      expect(wrapper).toHaveClass('rounded-full');
      expect(wrapper).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.receive });
    });

    it('falls through to the RECEIVE default for an unknown transactionIcon value', () => {
      const { container } = render(
        // Cast: exercise the switch `default` with a value outside the union.
        <TransactionIcon entry={makeEntry({ transactionIcon: 'UNKNOWN' as never })} />
      );

      expect(root(container)).toHaveStyle({ backgroundColor: TRANSACTION_COLORS.receive });
    });
  });
});
