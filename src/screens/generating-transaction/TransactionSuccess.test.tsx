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

    expect(container.textContent).toContain('Transaction Complete!');
    expect(container.textContent).toContain('transactionSuccessDescription');
    // No amount, no destination, no txHash → no receipt rows, no amount block.
    expect(container.textContent).not.toContain('Total Paid');
    expect(container.textContent).not.toContain('Source TX');
    expect(container.querySelectorAll('button[aria-label="viewOnMidenscan"]')).toHaveLength(0);

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
    expect(container.textContent).toContain('Source TX');

    // The source-tx row is clickable → wired to onViewExplorer.
    const explorerButton = container.querySelector('button[aria-label="viewOnMidenscan"]') as HTMLButtonElement;
    expect(explorerButton).not.toBeNull();
    act(() => explorerButton.click());
    expect(onViewExplorer).toHaveBeenCalledTimes(1);

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
    expect(container.textContent).toContain('Source TX');
    expect(container.querySelectorAll('button[aria-label="viewOnMidenscan"]')).toHaveLength(0);
    act(() => root.unmount());
  });

  it('renders the bridged arrival line and a FAST badge for an epoch bridged send', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          amount: 100n,
          extraInputs: { destinationAddress: '0xethdest1234', destinationNetwork: 1, provider: 'epoch' }
        })}
        onDoneClick={() => {}}
      />
    );
    expect(container.textContent).toContain('Arriving on Ethereum');
    expect(container.textContent).toContain('FAST');
    // Destination address comes from the bridged inputs.
    expect(container.textContent).toContain('to');
    act(() => root.unmount());
  });

  it('renders a SLOW badge for an agglayer bridged send', async () => {
    const { container, root } = await renderInto(
      <TransactionSuccess
        transaction={baseTransaction({
          amount: 100n,
          extraInputs: { destinationAddress: '0xethdest1234', destinationNetwork: 1, provider: 'agglayer' }
        })}
        onDoneClick={() => {}}
      />
    );
    expect(container.textContent).toContain('SLOW');
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
