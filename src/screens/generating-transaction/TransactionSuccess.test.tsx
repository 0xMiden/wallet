import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ITransaction } from 'lib/miden/db/types';

import { TransactionSuccess } from './TransactionSuccess';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key })
}));

jest.mock('components/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="done-button" onClick={onClick}>
      {children}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
    <div data-testid="screen-header">
      <span>{title}</span>
      <button aria-label="header-close" onClick={onClose} />
    </div>
  )
}));

const mockMidenMeta: { symbol: string | undefined; decimals: number } = { symbol: 'MIDEN', decimals: 6 };

jest.mock('lib/miden/metadata', () => ({
  get MIDEN_METADATA() {
    return mockMidenMeta;
  }
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

describe('TransactionSuccess', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockState.assetsMetadata = {};
    mockMidenMeta.symbol = 'MIDEN';
  });

  const renderInto = async (element: React.ReactElement) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    return { container, root };
  };

  it('renders the bare success screen with no receipt rows when no transaction data', async () => {
    const { container, root } = await renderInto(<TransactionSuccess onDoneClick={() => {}} />);

    // No transaction → generic title (send-typed transactions get "Payment Sent!").
    expect(container.textContent).toContain('Transaction Complete!');
    // No amount, no destination, no txHash → no receipt rows, no amount block.
    expect(container.textContent).not.toContain('Total Paid');
    expect(container.textContent).not.toContain('Transaction ID');
    expect(container.querySelectorAll('button[aria-label="viewOnMidenscan"]')).toHaveLength(0);

    act(() => root.unmount());
  });

  it('pins the completion CTAs outside the scroll region so they are never clipped (#463)', async () => {
    // A send transaction with a hash renders BOTH the primary (Done) and the
    // secondary (View in Activities) CTA — the latter is the one the report says
    // gets clipped in the ~360x600 popup. They must live OUTSIDE the scrollable
    // receipt body, in a non-shrinking footer, so a short viewport scrolls the
    // body instead of pushing the buttons off-screen.
    const { container, root } = await renderInto(
      <TransactionSuccess
        onDoneClick={() => {}}
        transaction={baseTransaction({ type: 'send', status: 2, transactionId: '0xabcdef', amount: 1000000n })}
      />
    );

    const scrollRegion = container.querySelector('.overflow-y-auto');
    expect(scrollRegion).not.toBeNull();

    const ctas = container.querySelectorAll('[data-testid="done-button"]');
    expect(ctas.length).toBeGreaterThan(0);
    ctas.forEach(cta => {
      // The CTA must NOT be inside the scroll body (or a short popup clips it)...
      expect(scrollRegion!.contains(cta)).toBe(false);
      // ...and must sit in a shrink-0 footer that can't be compressed away.
      expect(cta.closest('.shrink-0')).not.toBeNull();
    });

    act(() => root.unmount());
  });

  it('renders amount, destination and source-tx rows for a fully-populated transaction', async () => {
    mockState.assetsMetadata = { 'faucet-1': { symbol: 'TST', decimals: 6 } };
    const onViewExplorer = jest.fn();
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          amount: 12345n,
          faucetId: 'faucet-1',
          secondaryAccountId: 'mtst1aprecipient_addr1234'
        })}
        txHash="0xabcdef1234567890"
        onDoneClick={() => {}}
        onViewExplorer={onViewExplorer}
      />
    );

    expect(container.textContent).toContain('to');
    expect(container.textContent).toContain('Total Paid');
    expect(container.textContent).toContain('12345 TST');
    expect(container.textContent).toContain('Transaction ID');

    // The source-tx row is clickable → wired to onViewExplorer.
    const explorerButton = container.querySelector('button[aria-label="viewOnMidenscan"]') as HTMLButtonElement;
    expect(explorerButton).not.toBeNull();
    act(() => explorerButton.click());
    expect(onViewExplorer).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('relabels the receipt for a consume: From, Total Consumed and Notes Consumed rows', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          type: 'consume',
          amount: 5n,
          secondaryAccountId: 'mtst1apsender_addr1234',
          noteId: '0xnote1aaaaaaaa',
          noteIds: ['0xnote1aaaaaaaa', '0xnote2bbbbbbbb']
        })}
        txHash="0xabcdef1234567890"
        onDoneClick={() => {}}
      />
    );

    expect(container.textContent).toContain('from');
    expect(container.textContent).not.toContain('Total Paid');
    expect(container.textContent).toContain('Total Consumed');
    expect(container.textContent).toContain('Notes Consumed');
    // Both claimed note ids render, truncated, in the Notes Consumed row.
    expect(container.textContent).toContain('0xnote…aaaa');
    expect(container.textContent).toContain('0xnote…bbbb');
    // The summary pill's right side reads "Consumed" instead of an address.
    expect(container.textContent).toContain('Consumed');
    expect(container.textContent).toContain('Transaction ID');

    act(() => root.unmount());
  });

  it('falls back to MIDEN symbol when the faucet has no metadata', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction({ amount: 7n })} onDoneClick={() => {}} />
    );
    expect(container.textContent).toContain('7 MIDEN');
    act(() => root.unmount());
  });

  it('renders the source-tx row as static text (no button) when onViewExplorer is absent', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction()} txHash="0xdeadbeef0000" onDoneClick={() => {}} />
    );
    expect(container.textContent).toContain('Transaction ID');
    expect(container.querySelectorAll('button[aria-label="viewOnMidenscan"]')).toHaveLength(0);
    act(() => root.unmount());
  });

  it('renders a Fast route row for an epoch bridged send', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          amount: 100n,
          extraInputs: { destinationAddress: '0xethdest1234', destinationNetwork: 1, provider: 'epoch' }
        })}
        onDoneClick={() => {}}
      />
    );
    // Destination address comes from the bridged inputs.
    expect(container.textContent).toContain('to');
    // Bridge sends carry a Route row: speed value + provider sub-line.
    expect(container.textContent).toContain('Route');
    expect(container.textContent).toContain('Fast');
    expect(container.textContent).toContain('Via Epoch');
    act(() => root.unmount());
  });

  it('renders a Slow route row for an agglayer bridged send', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          amount: 100n,
          extraInputs: { destinationAddress: '0xethdest1234', destinationNetwork: 1, provider: 'agglayer' }
        })}
        onDoneClick={() => {}}
      />
    );
    expect(container.textContent).toContain('Slow');
    expect(container.textContent).toContain('Via Agglayer');
    act(() => root.unmount());
  });

  it.each([
    ['undefined extraInputs', undefined],
    ['string extraInputs', 'not-an-object'],
    ['number extraInputs', 5],
    ['object missing destinationAddress', {}],
    ['destinationAddress not a string', { destinationAddress: 123, destinationNetwork: 1, provider: 'epoch' }],
    ['destinationNetwork not a number', { destinationAddress: '0x', destinationNetwork: 'x', provider: 'epoch' }],
    ['unknown provider', { destinationAddress: '0x', destinationNetwork: 1, provider: 'other' }]
  ])('does not treat %s as a bridged send', async (_label, extraInputs) => {
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction({ amount: 100n, extraInputs })} onDoneClick={() => {}} />
    );
    expect(container.textContent).not.toContain('Arriving on Ethereum');
    expect(container.textContent).not.toContain('FAST');
    expect(container.textContent).not.toContain('SLOW');
    act(() => root.unmount());
  });

  it('invokes onDoneClick from both the Done button and the header close', async () => {
    const onDoneClick = jest.fn();
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction()} onDoneClick={onDoneClick} />
    );

    const doneButton = container.querySelector('[data-testid="done-button"]') as HTMLButtonElement;
    act(() => doneButton.click());
    expect(onDoneClick).toHaveBeenCalledTimes(1);

    const closeButton = container.querySelector('button[aria-label="header-close"]') as HTMLButtonElement;
    act(() => closeButton.click());
    expect(onDoneClick).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });

  it('falls back to the MDN literal when neither the faucet nor MIDEN_METADATA carries a symbol', async () => {
    mockMidenMeta.symbol = undefined;
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction({ amount: 3n })} onDoneClick={() => {}} />
    );
    expect(container.textContent).toContain('3 MDN');
    act(() => root.unmount());
  });

  it('handles an undefined assetsMetadata store slice without throwing', async () => {
    mockState.assetsMetadata = undefined;
    const { container, root } = await renderInto(
      <TransactionSuccess transaction={baseTransaction({ amount: 9n, faucetId: 'faucet-x' })} onDoneClick={() => {}} />
    );
    expect(container.textContent).toContain('9 MIDEN');
    act(() => root.unmount());
  });
});
