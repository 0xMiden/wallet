import React from 'react';

import { render } from '@testing-library/react';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import { bridgeStatusOf, isFaucetRequest, TRANSACTION_COLORS } from './transactionUtils';

// `app/icons/v2` is the real barrel that switches an `IconName` onto one of
// ~100 SVG imports and pulls in `lib/miden-chain/constants`. Replace it with a
// marker `Icon` (exposing the `name`/`size`/`className` props the SWAP branch
// forwards) plus a minimal `IconName` enum, so the SWAP path is assertable
// without the barrel's heavy dependency graph.
jest.mock('app/icons/v2', () => ({
  __esModule: true,
  IconName: { Convert: 'convert', Close: 'close' },
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
  mockIsFaucetRequest.mockReturnValue(false);
  mockBridgeStatusOf.mockReturnValue('confirmed');
});

describe('TransactionIcon', () => {
  it('renders a failed glyph for a terminal bridge failure', () => {
    mockBridgeStatusOf.mockReturnValue('failed');

    const { getByTestId, container } = render(
      <TransactionIcon entry={makeEntry({ txType: 'bridged-send', transactionIcon: 'SEND' })} />
    );

    expect(root(container)).toHaveClass('bg-status-negative');
    expect(getByTestId('v2-icon')).toHaveAttribute('data-name', 'close');
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
