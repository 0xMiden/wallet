import React from 'react';

import { render, screen } from '@testing-library/react';

import { SwapTransaction } from 'lib/miden/db/types';
import { TOKEN_IETH, TOKEN_IMIDEN } from 'lib/miden/swap/tokens';

import { SwapSuccess } from './SwapSuccess';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { amount?: string }) => (opts?.amount ? `${key}:${opts.amount}` : key)
  })
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (amount: bigint) => String(amount) }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { assetsMetadata: unknown }) => unknown) => selector({ assetsMetadata: {} })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ status: 'loading', config: null, derived: null, lastFetch: null })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));

// The pill and the fee row have their own suites; this one reads the reserved-funds sentence.
jest.mock('../TransactionSummaryBadge', () => ({
  ...jest.requireActual('../TransactionSummaryBadge'),
  useTransactionSummaryBadgeContent: () => undefined
}));
jest.mock('./TransactionSuccessLayout', () => ({
  TransactionSuccessLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SuccessSummaryPill: () => null,
  ReceiptRows: () => null,
  useReceiptFeeText: () => undefined
}));

const swapTx = (faucetId: string): SwapTransaction =>
  ({
    id: 'tx-1',
    type: 'swap',
    faucetId,
    amount: 5n,
    extraInputs: { requestedFaucetId: TOKEN_IMIDEN.faucetId, requestedAmount: 3n }
  }) as unknown as SwapTransaction;

describe('SwapSuccess', () => {
  it('names the registry iETH "Test iETH" in the reserved-funds sentence when iETH is the offered side (#477)', () => {
    render(<SwapSuccess transaction={swapTx(TOKEN_IETH.faucetId)} onDoneClick={jest.fn()} />);

    expect(screen.getByText('swapOrderReservedNote:5 Test iETH')).toBeInTheDocument();
  });

  it('leaves another offered token on its symbol', () => {
    render(<SwapSuccess transaction={swapTx(TOKEN_IMIDEN.faucetId)} onDoneClick={jest.fn()} />);

    expect(screen.getByText('swapOrderReservedNote:5 IMIDEN')).toBeInTheDocument();
  });
});
