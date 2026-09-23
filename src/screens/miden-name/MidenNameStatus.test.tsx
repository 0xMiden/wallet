import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStatus,
  MidenNameFailure,
  MidenNamePhase,
  RegisterNameTransaction
} from 'lib/miden/db/types';

import { MidenNameStatus } from './MidenNameStatus';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isMobile: jest.fn(() => false)
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
jest.mock('lib/mobile/useNavbarHidden', () => ({ useNavbarHidden: () => true }));
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Checkmark: 'checkmark', Close: 'close', ChevronLeft: 'chevron-left' }
}));
jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-icon">{state}</div>
}));
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals: number) => String(Number(amount) / 10 ** decimals)
}));

const mockRows = new Map<string, ITransaction>();
let mockLoaded = true;
jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: (id: string) => ({ row: mockRows.get(id), loaded: mockLoaded })
}));

jest.mock('lib/miden/front', () => ({
  useAllAccounts: () => [{ publicKey: 'mtst1account', name: 'Account 1' }]
}));
const mockSignTransaction = jest.fn();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

const mockInitiateConsume = jest.fn();
const mockTagConsume = jest.fn();
jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeTransactionFromId: (...args: unknown[]) => mockInitiateConsume(...args),
  tagConsumeAsMidenNameClaim: (...args: unknown[]) => mockTagConsume(...args)
}));

const mockRequestSWProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  requestSWTransactionProcessing: () => mockRequestSWProcessing(),
  startBackgroundTransactionProcessing: jest.fn()
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));

interface RowOptions {
  phase: MidenNamePhase;
  status?: ITransactionStatus;
  failure?: MidenNameFailure;
  deliveryNoteId?: string;
  claimTxId?: string;
  lastError?: string;
}

function registerRow({
  phase,
  status = ITransactionStatus.Completed,
  failure,
  deliveryNoteId,
  claimTxId,
  lastError
}: RowOptions): ITransaction {
  const row: ITransaction = new RegisterNameTransaction({
    accountId: 'mtst1account',
    label: 'alice',
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: '0xnote',
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  row.id = 'reg-1';
  row.extraInputs = { ...row.extraInputs, phase, failure, deliveryNoteId, claimTxId, lastError };
  row.status = status;
  return row;
}

function claimRow(id: string, status: ITransactionStatus): ITransaction {
  const row: ITransaction = new ConsumeTransaction('mtst1account', {
    id: '0xdelivery',
    faucetId: '',
    amount: '',
    senderAddress: '',
    isBeingClaimed: false,
    type: 'unknown'
  });
  row.id = id;
  row.status = status;
  return row;
}

const stepState = (id: string) =>
  screen.getByTestId(`miden-name-step-${id}`).querySelector('[data-state]')?.getAttribute('data-state');

describe('MidenNameStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockLoaded = true;
    mockInitiateConsume.mockResolvedValue('claim-2');
    mockTagConsume.mockResolvedValue(undefined);
  });

  it('redirects home for an unknown id', () => {
    render(<MidenNameStatus txId="nope" />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
  });

  it('redirects home for a row that is not a registration', () => {
    mockRows.set('claim-1', claimRow('claim-1', ITransactionStatus.Completed));
    render(<MidenNameStatus txId="claim-1" />);
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
  });

  it('shows a spinner until the row is read', () => {
    mockLoaded = false;
    render(<MidenNameStatus txId="reg-1" />);
    expect(screen.queryByTestId('redirect')).not.toBeInTheDocument();
    expect(screen.queryByTestId('miden-name-status-page')).not.toBeInTheDocument();
  });

  it('shows the name, the price and account, and four steps with the last one coming soon', () => {
    mockRows.set('reg-1', registerRow({ phase: 'submitted' }));
    render(<MidenNameStatus txId="reg-1" />);
    expect(screen.getByTestId('miden-name-status-hero')).toHaveTextContent('alice.miden');
    expect(screen.getByTestId('miden-name-status-hero')).toHaveTextContent(
      'midenNameStatusSubtitle_20 MIDEN_Account 1'
    );
    expect(stepState('request-sent')).toBe('complete');
    expect(stepState('issued')).toBe('active');
    expect(stepState('adding')).toBe('pending');
    expect(stepState('publishing')).toBe('disabled');
    expect(screen.getByTestId('miden-name-step-publishing')).toHaveTextContent('midenNameComingSoon');
    expect(screen.getByTestId('hero-icon')).toHaveTextContent('processing');
    expect(screen.getByTestId('miden-name-status-done')).toHaveTextContent('hide');
  });

  it.each<[MidenNameFailure, string]>([
    ['tx-failed', 'midenNameFailedTx'],
    ['taken', 'midenNameFailedTaken'],
    ['expired', 'midenNameFailedExpired'],
    ['discarded', 'midenNameFailedDiscarded']
  ])('shows the failure copy for %s and a Done button', (failure, copy) => {
    mockRows.set('reg-1', registerRow({ phase: 'failed', failure }));
    render(<MidenNameStatus txId="reg-1" />);
    expect(screen.getByTestId('miden-name-failure')).toHaveTextContent(copy);
    expect(screen.getByTestId('hero-icon')).toHaveTextContent('failed');
    expect(screen.getByTestId('miden-name-status-done')).toHaveTextContent('midenNameDone');
    expect(screen.queryByTestId('miden-name-retry-claim')).not.toBeInTheDocument();
  });

  it('shows success when the name is owned', () => {
    mockRows.set('reg-1', registerRow({ phase: 'owned', claimTxId: 'claim-1' }));
    mockRows.set('claim-1', claimRow('claim-1', ITransactionStatus.Completed));
    render(<MidenNameStatus txId="reg-1" />);
    expect(stepState('adding')).toBe('complete');
    expect(screen.getByTestId('hero-icon')).toHaveTextContent('success');
    expect(screen.queryByTestId('miden-name-failure')).not.toBeInTheDocument();
  });

  it('Retry claim queues a manual consume, tags it as the claim and starts processing', async () => {
    mockRows.set(
      'reg-1',
      registerRow({ phase: 'issued', deliveryNoteId: '0xdelivery', claimTxId: 'claim-1', lastError: 'boom' })
    );
    mockRows.set('claim-1', claimRow('claim-1', ITransactionStatus.Failed));
    render(<MidenNameStatus txId="reg-1" />);
    expect(stepState('adding')).toBe('failed');
    expect(screen.getByTestId('miden-name-failure')).toHaveTextContent('midenNameFailedClaim');

    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-retry-claim'));
    });

    expect(mockInitiateConsume).toHaveBeenCalledWith('mtst1account', '0xdelivery', false, true);
    expect(mockTagConsume).toHaveBeenCalledWith('claim-2', 'alice', 'reg-1');
    expect(mockTagConsume.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockInitiateConsume.mock.invocationCallOrder[0] ?? 0
    );
    expect(mockRequestSWProcessing).toHaveBeenCalled();
  });

  it('follows the retried claim row once it is queued', async () => {
    mockRows.set('reg-1', registerRow({ phase: 'claiming', deliveryNoteId: '0xdelivery', claimTxId: 'claim-1' }));
    mockRows.set('claim-1', claimRow('claim-1', ITransactionStatus.Failed));
    mockRows.set('claim-2', claimRow('claim-2', ITransactionStatus.Queued));
    render(<MidenNameStatus txId="reg-1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-retry-claim'));
    });
    expect(stepState('adding')).toBe('active');
    expect(screen.queryByTestId('miden-name-retry-claim')).not.toBeInTheDocument();
  });

  it('shows the retry error when the consume cannot be queued', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockInitiateConsume.mockRejectedValue(new Error('Note with id 0xdelivery not found'));
    mockRows.set('reg-1', registerRow({ phase: 'failed', failure: 'claim-failed', deliveryNoteId: '0xdelivery' }));
    render(<MidenNameStatus txId="reg-1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-retry-claim'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('not found');
    expect(mockTagConsume).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('Hide goes home', () => {
    mockRows.set('reg-1', registerRow({ phase: 'requested', status: ITransactionStatus.Queued }));
    render(<MidenNameStatus txId="reg-1" />);
    fireEvent.click(screen.getByTestId('miden-name-status-done'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
