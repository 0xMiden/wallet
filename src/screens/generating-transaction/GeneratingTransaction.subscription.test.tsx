import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { GeneratingTransactionPage } from './GeneratingTransaction';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({ useNetworkFeeEstimate: () => undefined }));
jest.mock('components/ScreenHeader', () => ({ ScreenHeader: () => null }));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ signTransaction: jest.fn() }) }));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/mobile/external-browser', () => ({ openExternalUrl: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), Redirect: () => <div data-testid="redirect" /> }));
jest.mock('lib/analytics', () => ({ useAnalytics: () => ({ pageEvent: jest.fn() }) }));
jest.mock('lib/miden/activity', () => ({
  bridgeProviderOf: () => undefined,
  isRequeueableTransaction: () => false,
  isUnverifiableSendRetryError: () => false,
  requestSWTransactionProcessing: jest.fn(),
  requeueFailedTransaction: jest.fn(),
  safeGenerateTransactionsLoop: jest.fn()
}));
jest.mock('./components', () => ({ TransactionHeroIcon: () => null, TransactionStepRow: () => null }));
jest.mock('./TransactionSuccess', () => ({ TransactionSuccess: () => <div data-testid="completed-receipt" /> }));
jest.mock('./TransactionSummaryBadge', () => ({
  TransactionSummaryBadge: () => null,
  useTransactionSummaryBadgeContent: () => undefined
}));

const store = { accounts: [], currentAccount: undefined, lastCompletedTxHash: null, setLastCompletedTxHash: jest.fn() };
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((select: (state: typeof store) => unknown) => select(store), { getState: () => store })
}));

afterEach(() => jest.restoreAllMocks());

it('keeps the receipt mounted during the first read failure and recovers without another write', async () => {
  const error = new Error('temporary read failure');
  const logError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await transactions.put({
    id: 'recovering-receipt',
    accountId: 'account-1',
    initiatedAt: 1,
    type: 'send',
    displayIcon: 'SEND',
    status: ITransactionStatus.Completed
  });
  jest.spyOn(transactions, 'where').mockImplementationOnce(() => {
    throw error;
  });
  const view = render(<GeneratingTransactionPage txId="recovering-receipt" />);
  await waitFor(() => expect(logError).toHaveBeenCalledWith('[useTransactionRow] Failed to read transaction:', error));
  expect(view.queryByTestId('redirect')).toBeNull();
  await waitFor(() => expect(view.queryByTestId('completed-receipt')).not.toBeNull(), { timeout: 2500 });
  expect(view.queryByTestId('redirect')).toBeNull();
});

it('still handles a successfully read unknown transaction as missing', async () => {
  const view = render(<GeneratingTransactionPage txId="unknown" />);
  await waitFor(() => expect(view.queryByTestId('redirect')).not.toBeNull());
});
