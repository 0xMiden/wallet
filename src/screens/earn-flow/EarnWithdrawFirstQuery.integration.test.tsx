import React, { useRef } from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PageActiveContext, PageMountedByReturnContext, PageRevealedByLayerContext } from 'app/layouts/page-active';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { clearEarnSubmissionLocksForTests } from 'lib/epoch/earn-submission-lock';
import type { EarnWithdrawalQuote } from 'lib/epoch/earn-withdraw-quote';
import { ensureEpochSmartAccount } from 'lib/epoch/sdk';
import { PREPARED_FAUCET, PREPARED_OWNER, PREPARED_RECIPIENT, PREPARED_TOKEN } from 'lib/epoch/testing/earn-prepared';
import { ITransactionStatus } from 'lib/miden/db/types';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getProviderReceiptBackend, installProviderReceiptBackend } from 'lib/miden/recovery/receipt-backend';
import { fromSerializable } from 'lib/miden/recovery/serialization';
import { projectRecoveryTransaction, validateRecoveryReceipt } from 'lib/miden/recovery/transaction-record';
import * as Repo from 'lib/miden/repo';
import { assertStorageHealthy } from 'lib/miden/storage-health';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { HistoryAction, LocationProvider, type LocationState, navigate, Provider, useLocation } from 'lib/woozie';

import EarnWithdrawReview from './EarnWithdrawReview';
import { EarnWithdrawStatus } from './EarnWithdrawStatus';
import type { EarnPosition } from './types';

const mockCreatedIds: string[] = [];
const mockExecuteActions = jest.fn();
const mockMutate = jest.fn().mockResolvedValue(undefined);
let mockLastLocation: LocationState | undefined;

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  ...jest.requireActual<typeof import('@epoch-protocol/epoch-intents-sdk')>('@epoch-protocol/epoch-intents-sdk'),
  EpochIntentSDK: class {
    helpers = { executeActions: mockExecuteActions };
  }
}));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual<typeof import('@miden-sdk/miden-sdk')>('@miden-sdk/miden-sdk'),
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('Invalid fixture account');
      return { toString: () => value };
    }
  }
}));
jest.mock('lib/epoch', () => ({
  gaslessEarnWithdrawalToMiden: jest.fn(
    (...args: Parameters<typeof import('lib/epoch/earn-withdraw').gaslessEarnWithdrawalToMiden>) =>
      jest
        .requireActual<typeof import('lib/epoch/earn-withdraw')>('lib/epoch/earn-withdraw')
        .gaslessEarnWithdrawalToMiden(...args)
  )
}));
jest.mock('lib/miden/swap/tokens', () => ({
  ...jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens'),
  tokenQuote: () => undefined
}));
jest.mock('lib/epoch/sdk', () => ({ ensureEpochSmartAccount: jest.fn(), getEpochReadOnlySdk: jest.fn() }));
jest.mock('lib/epoch/bridge', () => ({ normalizeMidenIdToHex: (value: string) => value }));
jest.mock('lib/epoch/evm-account', () => ({
  buildVaultEvmWalletClient: jest.fn(() => ({})),
  assertVaultEvmAccountCurrent: jest.fn()
}));
jest.mock('lib/epoch/earn-withdraw-quote', () => ({
  ...jest.requireActual<typeof import('lib/epoch/earn-withdraw-quote')>('lib/epoch/earn-withdraw-quote'),
  quoteEarnWithdrawal: jest.fn(async () => mockQuote()),
  assertWithdrawalReviewCurrent: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('lib/remote-config/values', () => {
  const fixtures = jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>(
    'lib/epoch/testing/bridge-config'
  );
  const values = fixtures.remoteConfigValuesMock();
  values.getEvmUsdc.mockReturnValue({ ...fixtures.TEST_EVM_USDC, decimals: 6 });
  values.findEvmUsdc.mockReturnValue({ ...fixtures.TEST_EVM_USDC, decimals: 6 });
  return values;
});

// Only observe creation; both row writes remain the production implementations on the real Repo.
jest.mock('lib/miden/activity', () => ({
  initiateEarnWithdrawTransaction: async (
    ...args: Parameters<typeof import('lib/miden/transaction/initiate').initiateEarnWithdrawTransaction>
  ) => {
    const id = await jest
      .requireActual<typeof import('lib/miden/transaction/initiate')>('lib/miden/transaction/initiate')
      .initiateEarnWithdrawTransaction(...args);
    mockCreatedIds.push(id);
    return id;
  },
  markEarnWithdrawNotSent: (
    ...args: Parameters<typeof import('lib/miden/transaction/complete').markEarnWithdrawNotSent>
  ) =>
    jest
      .requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .markEarnWithdrawNotSent(...args),
  prepareEarnWithdrawExecution: jest.fn(),
  markEarnWithdrawAccepted: jest.fn(),
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: jest.fn(),
  updateEarnWithdrawPhase: jest.fn(),
  findPendingBridgeInByEarnWithdrawTxId: jest.fn()
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => '0xabcdef1234567890abcdef12345678',
  getNativeAssetIdSync: () => '0xabcdef1234567890abcdef12345678',
  getNativeAssetMetadataSync: () => null,
  getSdkSyncedNativeAssetIdSync: () => null,
  captureNativeAssetSnapshot: () => ({ scope: 'testnet', revision: 1 })
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: PREPARED_RECIPIENT, evmAddress: PREPARED_OWNER })
}));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: { assetsMetadata: Record<string, AssetMetadata> }) => T) =>
    selector({ assetsMetadata: {} })
}));
jest.mock('./useEarnPositions', () => ({
  ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
  useEarnPositions: () => ({ positions: [mockPosition], isLoading: false, refetch: jest.fn() })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => PREPARED_FAUCET }));
jest.mock('lib/dexie-live-query', () => {
  const actual = jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query');
  return { ...actual, subscribeToLiveQuery: jest.fn(actual.subscribeToLiveQuery) };
});
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
jest.mock('swr', () => ({ useSWRConfig: () => ({ mutate: mockMutate }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/NetworkModeBanner', () => ({ NetworkModeBanner: () => null }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('components/Button', () => ({
  Button: ({ children, title, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));
jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({ children, footer }: React.PropsWithChildren<{ footer?: React.ReactNode }>) => (
    <section>
      {children}
      {footer}
    </section>
  )
}));
jest.mock('screens/generating-transaction/components', () => ({ TransactionHeroIcon: () => null }));
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals: number) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').formatBigInt(amount, decimals)
}));

const mockPosition: EarnPosition = {
  id: 'position-1',
  vaultId: 'vault-1',
  owner: PREPARED_OWNER,
  marketUid: `DUMMY_LENDING:11155111:${PREPARED_TOKEN}`,
  chainId: '11155111',
  underlyingAddress: PREPARED_TOKEN,
  withdrawable: '20',
  decimals: 6,
  protocol: 'Aave',
  epochProtocol: 'dummy-lending',
  asset: 'USDC',
  network: 'Sepolia',
  amount: '$20',
  depositedAmount: '$20',
  rewards: '$0',
  age: '1d',
  activeDuration: '1 day active',
  apy: '0%',
  dailyAverage: '$0',
  started: 'Jan 1',
  yearlyEstimate: '$0',
  withdrawTime: '~1 minute',
  route: 'Miden -> Aave (Sepolia)',
  stale: false,
  chartData: []
};
const mockQuote = (): EarnWithdrawalQuote => ({
  position: mockPosition,
  accountId: PREPARED_RECIPIENT,
  amount: '10',
  amountAtomic: '10000000',
  availableAtomic: '20000000',
  scope: 'testnet',
  nativeRevision: 1,
  allocatorUrl: 'https://allocator.test',
  destinationFaucetId: PREPARED_FAUCET,
  destinationSymbol: 'USDCX',
  destinationDecimals: 6,
  expectedAtomic: '10000000',
  minimumAtomic: '9900000',
  expiresAt: Date.now() + 60000
});
const failure = new Error('Fresh withdrawal setup refused');
const reviewPath = '/earn/positions/position-1/withdraw/review';
const statusPath = (id: string) => `/earn/withdraw-status/${encodeURIComponent(id)}`;

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Delay subscription startup, never a promise inside Dexie's read-only liveQuery transaction.
function nextStatusRead() {
  const scheduled = deferred();
  const release = deferred();
  const delivered = deferred();
  const rows: unknown[] = [];
  const actual = jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query');
  jest
    .mocked(subscribeToLiveQuery)
    .mockImplementationOnce(
      <T,>(query: () => T | Promise<T>, observer: { next: (value: T) => void; error: (error: unknown) => void }) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        scheduled.resolve();
        void release.promise
          .then(() => {
            if (disposed) return;
            unsubscribe = actual.subscribeToLiveQuery(query, {
              next: value => {
                if (rows.length === 0) jest.useFakeTimers();
                rows.push(value);
                observer.next(value);
                delivered.resolve();
              },
              error: error => {
                observer.error(error);
                delivered.reject(error);
              }
            });
          })
          .catch(error => {
            if (disposed) return;
            observer.error(error);
            delivered.reject(error);
          });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      }
    );
  return { scheduled, release, delivered, rows };
}

function FlowRoute({ retainStatus = false }: { retainStatus?: boolean }) {
  const location = useLocation();
  mockLastLocation = location;
  const match = /^\/earn\/withdraw-status\/([^/]+)$/.exec(location.pathname);
  const kept = useRef<{ txId: string; location: LocationState }>();
  if (match) kept.current = { txId: decodeURIComponent(match[1]!), location };
  const shown = Boolean(match);
  if (kept.current && (shown || retainStatus)) {
    // Mirrors MobilePageLayers' retained snapshot and real active context, without animation timing.
    return (
      <LocationProvider snapshot={shown ? location : kept.current.location}>
        <PageActiveContext.Provider value={shown}>
          <div data-testid="retained-status" hidden={!shown}>
            <EarnWithdrawStatus txId={kept.current.txId} />
          </div>
        </PageActiveContext.Provider>
      </LocationProvider>
    );
  }
  return location.pathname === reviewPath ? <EarnWithdrawReview positionId="position-1" /> : <div>Other page</div>;
}

async function deliver(read: ReturnType<typeof nextStatusRead>) {
  await act(async () => {
    read.release.resolve();
    await read.delivered.promise;
  });
}

async function pastFailure() {
  await gaslessEarnWithdrawalToMiden({
    midenAccountPublicKey: PREPARED_RECIPIENT,
    evmAddress: PREPARED_OWNER,
    marketUid: mockPosition.marketUid,
    underlyingAddress: PREPARED_TOKEN,
    amount: '10',
    underlyingDecimals: 6,
    protocol: 'dummy-lending',
    chainId: 11155111
  }).catch(error => {
    if (error !== failure) throw error;
  });
  const id = mockCreatedIds[mockCreatedIds.length - 1];
  if (!id) throw new Error('The actual withdrawal producer created no row');
  return id;
}

function setEntry(id: string, marker: string | undefined, action: HistoryAction.Push | HistoryAction.Replace) {
  navigate(
    { pathname: statusPath(id), state: marker === undefined ? undefined : { newSubmissionTxId: marker } },
    action
  );
}

describe('Earn withdrawal first-query reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatedIds.length = 0;
    mockLastLocation = undefined;
    jest.mocked(ensureEpochSmartAccount).mockReset().mockRejectedValue(failure);
    navigate({ pathname: reviewPath, search: '?amount=10' }, HistoryAction.Replace);
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    clearEarnSubmissionLocksForTests();
    jest
      .mocked(subscribeToLiveQuery)
      .mockImplementation(
        jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query').subscribeToLiveQuery
      );
  });

  it('reports a new Review submission whose actual producer fails before the first row query', async () => {
    const entered = deferred();
    const releaseProducer = deferred();
    const read = nextStatusRead();
    jest.mocked(ensureEpochSmartAccount).mockImplementationOnce(async () => {
      entered.resolve();
      await releaseProducer.promise;
      throw failure;
    });
    try {
      await act(async () => {
        render(
          <Provider>
            <FlowRoute />
          </Provider>
        );
      });
      const confirm = screen.getByRole('button', { name: 'withdraw' });
      expect(confirm).toBeEnabled();
      await act(async () => {
        fireEvent.click(confirm);
        await entered.promise;
      });
      await read.scheduled.promise;
      const id = mockCreatedIds[0];
      if (!id) throw new Error('The actual Review submission created no row');
      expect(mockCreatedIds).toHaveLength(1);
      expect(mockLastLocation?.pathname).toBe(statusPath(id));
      expect(mockLastLocation?.trigger).toBe(HistoryAction.Push);
      expect(read.rows).toEqual([]);
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
      await act(async () => {
        releaseProducer.resolve();
        await expect(jest.mocked(gaslessEarnWithdrawalToMiden).mock.results[0]!.value).rejects.toBe(failure);
      });
      expect(await Repo.transactions.get(id)).toMatchObject({
        id,
        type: 'earn-withdraw',
        status: ITransactionStatus.Completed,
        extraInputs: {
          phase: 'failed',
          submissionState: 'preparing',
          error: failure.message,
          protocol: 'dummy-lending',
          chainId: 11155111
        }
      });
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(read.rows).toEqual([]);
      await deliver(read);
      expect(read.rows).toEqual([
        expect.objectContaining({ id, extraInputs: expect.objectContaining({ phase: 'failed' }) })
      ]);
      expect(screen.getByText(failure.message)).toBeVisible();
      act(() => jest.advanceTimersByTime(999));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
      act(() => jest.advanceTimersByTime(1));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_failed', 'status_screen']]);
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_earn_withdraw_failed', 'status_screen']]);
    } finally {
      releaseProducer.resolve();
      read.release.resolve();
    }
  });

  it('keeps a historical first failed query quiet after loading and reopening', async () => {
    const id = await pastFailure();
    setEntry(id, undefined, HistoryAction.Replace);
    for (let opening = 0; opening < 2; opening += 1) {
      const read = nextStatusRead();
      const view = render(
        <Provider>
          <FlowRoute />
        </Provider>
      );
      await read.scheduled.promise;
      expect(read.rows).toEqual([]);
      await deliver(read);
      expect(screen.getByText(failure.message)).toBeVisible();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
      view.unmount();
      jest.useRealTimers();
    }
  });

  it.each([
    ['Pop with a saved matching marker', 'pop', true, false],
    ['reload with a saved matching marker', 'reload', true, false],
    ['Replace with a matching marker', 'replace', true, false],
    ['Push with a mismatched marker', 'push', false, false],
    ['a revealed return mount on Push with a matching marker', 'push', true, true]
  ] satisfies [string, 'pop' | 'reload' | 'replace' | 'push', boolean, boolean][])(
    'keeps %s quiet',
    async (_name, arrival, matches, revealed) => {
      const id = await pastFailure();
      setEntry(id, matches ? id : 'other-row', arrival === 'push' ? HistoryAction.Push : HistoryAction.Replace);
      if (arrival === 'pop')
        window.dispatchEvent(new PopStateEvent(HistoryAction.Pop, { state: window.history.state }));
      // A new document retains serialized state, but never the old runtime history expando.
      if (arrival === 'reload') Reflect.deleteProperty(window.history, 'lastAction');
      const read = nextStatusRead();
      render(
        <Provider>
          <PageMountedByReturnContext.Provider value={arrival === 'pop' || revealed}>
            <PageRevealedByLayerContext.Provider value={revealed}>
              <FlowRoute />
            </PageRevealedByLayerContext.Provider>
          </PageMountedByReturnContext.Provider>
        </Provider>
      );
      await read.scheduled.promise;
      await deliver(read);
      expect(mockLastLocation?.trigger).toBe(
        arrival === 'reload'
          ? null
          : arrival === 'push'
            ? HistoryAction.Push
            : arrival === 'pop'
              ? HistoryAction.Pop
              : HistoryAction.Replace
      );
      expect(screen.getByText(failure.message)).toBeVisible();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    }
  );

  it('does not reuse an old Push qualification when the same hidden status node returns by Pop', async () => {
    const id = await pastFailure();
    setEntry(id, id, HistoryAction.Push);
    const entryState: unknown = window.history.state;
    const read = nextStatusRead();
    render(
      <Provider>
        <FlowRoute retainStatus />
      </Provider>
    );
    await read.scheduled.promise;
    const node = screen.getByTestId('retained-status');
    act(() => navigate('/other-page', HistoryAction.Push));
    expect(screen.getByTestId('retained-status')).toBe(node);
    expect(node).not.toBeVisible();
    await deliver(read);
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    act(() => {
      navigate({ pathname: statusPath(id), state: entryState }, HistoryAction.Replace);
      window.dispatchEvent(new PopStateEvent(HistoryAction.Pop, { state: entryState }));
    });
    expect(screen.getByTestId('retained-status')).toBe(node);
    expect(mockLastLocation?.trigger).toBe(HistoryAction.Pop);
    expect(screen.getByText(failure.message)).toBeVisible();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
  });
});

let previousReceiptBackend: ReturnType<typeof getProviderReceiptBackend>;
const retainedReceipts = new Map<string, ReturnType<typeof validateRecoveryReceipt>>();

async function acknowledgeSyntheticReceipt(value: unknown, expectedEpoch: number): Promise<void> {
  assertStorageHealthy(expectedEpoch);
  const row = validateRecoveryReceipt(fromSerializable(value));
  const persisted = await Repo.transactions.get(row.id);
  if (!persisted) throw new Error('Synthetic receipt owner requires a persisted row');
  expect(projectRecoveryTransaction(persisted)).toMatchObject(row);
  assertStorageHealthy(expectedEpoch);
  retainedReceipts.set(row.id, row);
}

beforeEach(() => {
  previousReceiptBackend = getProviderReceiptBackend();
  retainedReceipts.clear();
  installProviderReceiptBackend(acknowledgeSyntheticReceipt);
});

afterEach(() => {
  installProviderReceiptBackend(previousReceiptBackend);
});
