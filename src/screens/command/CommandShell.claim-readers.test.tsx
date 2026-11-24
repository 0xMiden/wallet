import React from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';

import type { SerializedConsumableNote } from 'lib/shared/types';

import { CommandShell } from './CommandShell';

const mockStorageGet = jest.fn();
const mockReadHoldingTransactions = jest.fn(async (_address: string) => []);
const mockRequest = jest.fn(async () => ({ notes: [] }));
const mockAccount = { publicKey: 'account-a' };
const mockBalances = { data: [], isLoading: false };
const mockEmptyNotes: SerializedConsumableNote[] = [];
const mockWalletState = {
  extensionClaimableNotes: mockEmptyNotes,
  assetsMetadata: {},
  tokenMetadataOverrides: {},
  tokenPrices: {},
  setExtensionClaimableNotes: jest.fn((notes: SerializedConsumableNote[]) => {
    mockWalletState.extensionClaimableNotes = notes;
  }),
  setAssetsMetadata: jest.fn()
};
const mockHiddenIds = new Set<string>();

let mockEffectiveNetwork = 'devnet';
let mockEffectiveRpc = 'https://rpc-a';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveRpcUrl: () => mockEffectiveRpc
}));
jest.mock('lib/platform', () => ({
  isExtension: () => true,
  hasExtensionRuntime: () => true,
  isIOS: () => false,
  isMobile: () => false,
  isAndroid: () => false
}));
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((select: (state: typeof mockWalletState) => unknown) => select(mockWalletState), {
    getState: () => mockWalletState
  }),
  getIntercom: () => ({ request: mockRequest })
}));
jest.mock('lib/miden/activity', () => ({
  getNoteHoldingTransactions: (address: string) => mockReadHoldingTransactions(address),
  getFailedTransactions: async () => [],
  getUnconfirmedTransactions: async () => [],
  isFailedClaim: () => false,
  verifyStuckTransactionsFromNode: async () => 0
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useAllBalances: () => mockBalances,
  useAllTokensBaseMetadata: () => [],
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));
jest.mock('lib/miden/front/assets', () => ({
  useTokensMetadata: () => ({
    allTokensBaseMetadataRef: { current: {} },
    fetchMetadata: async () => undefined,
    setTokensBaseMetadata: async () => undefined
  })
}));
jest.mock('lib/swr', () => ({
  useRetryableSWR: () => ({ data: undefined, mutate: jest.fn(), isLoading: false, isValidating: false })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({
  useActivityHiddenNotes: () => ({ ids: mockHiddenIds, loaded: true, failed: false, hide: jest.fn() })
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'native' }));
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => 0,
  useClaimFloorBaseFee: () => 0
}));
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => false,
  isDelegateProofEnabled: () => false
}));
let mockHidden = false;
jest.mock('./useCommandPrivacy', () => ({ useCommandPrivacy: () => [mockHidden, jest.fn()] }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => undefined }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/templates/HomePrompts', () => ({
  __esModule: true,
  default: ({ fundingNotes, claimableNotes }: { fundingNotes?: unknown[]; claimableNotes?: unknown[] }) => (
    <>
      <output data-testid="funding-notes">{fundingNotes === undefined ? 'unverified' : fundingNotes.length}</output>
      <output data-testid="manual-notes">{claimableNotes === undefined ? 'unloaded' : claimableNotes.length}</output>
    </>
  )
}));
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: ({ renderEntries }: { renderEntries: (view: unknown) => React.ReactNode }) =>
    renderEntries({ entries: [], initialLoading: false, loadError: false, hasMore: false })
}));
jest.mock('app/templates/history/PendingActivityCard', () => ({
  PendingActivityCard: ({ item }: { item: { note: { id: string } } }) => <button>{item.note.id}</button>
}));
jest.mock('./CommandPortfolio', () => ({
  CommandPortfolio: ({ prompts, recentActions }: { prompts: React.ReactNode; recentActions: React.ReactNode }) => (
    <>
      {prompts}
      {recentActions}
    </>
  )
}));
jest.mock('./CommandHeader', () => ({ CommandHeader: () => null }));
jest.mock('./CommandDock', () => ({ CommandDock: () => null }));
jest.mock('./CommandPalette', () => ({ CommandPalette: () => null }));

const scope = { accountId: 'account-a', network: 'devnet', rpcUrl: 'https://rpc-a' };
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const pendingNote: SerializedConsumableNote = {
  id: 'note-a',
  faucetId: 'token',
  amountBaseUnits: '1000000',
  senderAddress: 'sender',
  noteType: 'private',
  standardPayment: true,
  receivedAt: 100,
  metadata: { decimals: 6, symbol: 'TKN', name: 'Token' }
};

afterEach(() => {
  cleanup();
  mockAccount.publicKey = 'account-a';
  mockWalletState.extensionClaimableNotes = mockEmptyNotes;
  mockHidden = false;
  mockEffectiveNetwork = 'devnet';
  mockEffectiveRpc = 'https://rpc-a';
  jest.useRealTimers();
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
  else Reflect.deleteProperty(globalThis, 'chrome');
  jest.clearAllMocks();
});

it('uses one current-account extension storage and holding-row reader across the real Command dashboard', async () => {
  jest.useFakeTimers();
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {},
      storage: {
        local: {
          get: mockStorageGet.mockImplementation((_key: string, receive: (result: object) => void) => receive({}))
        }
      }
    }
  });

  const view = render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  await act(async () => Promise.resolve());
  expect(screen.getByTestId('funding-notes')).toHaveTextContent('unverified');
  expect(mockStorageGet).toHaveBeenCalledTimes(1);
  expect(mockReadHoldingTransactions).toHaveBeenCalledTimes(1);
  expect(mockReadHoldingTransactions).toHaveBeenCalledWith('account-a');

  await act(async () => {
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
  });
  expect(mockStorageGet).toHaveBeenCalledTimes(2);
  expect(mockReadHoldingTransactions).toHaveBeenCalledTimes(2);
  view.unmount();
});

it('keeps a cached manual claim visible without using it for funding, then shows one live claim card and funding read', async () => {
  jest.useFakeTimers();
  mockWalletState.extensionClaimableNotes = [pendingNote];
  let stamp = 1;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {},
      storage: {
        local: {
          get: mockStorageGet.mockImplementation((_key: string, receive: (result: object) => void) =>
            receive({ miden_sync_data: { accountPublicKey: 'account-a', syncedAt: stamp, notes: [pendingNote] } })
          )
        }
      }
    }
  });
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  expect(screen.getByTestId('manual-notes')).toHaveTextContent('1');
  expect(screen.getByTestId('funding-notes')).toHaveTextContent('unverified');
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText('note-a')).toBeInTheDocument();

  await act(async () => {
    stamp = 2;
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
  });
  expect(screen.getByTestId('manual-notes')).toHaveTextContent('1');
  expect(screen.getByTestId('funding-notes')).toHaveTextContent('1');
  expect(mockStorageGet).toHaveBeenCalledTimes(2);
  expect(mockReadHoldingTransactions).toHaveBeenCalledTimes(2);
});

it('keeps the Home reader while masked Recent Actions mounts no claim-card reader', async () => {
  jest.useFakeTimers();
  mockHidden = true;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {},
      storage: {
        local: {
          get: mockStorageGet.mockImplementation((_key: string, receive: (result: object) => void) => receive({}))
        }
      }
    }
  });
  render(
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  await act(async () => Promise.resolve());
  expect(screen.getByTestId('funding-notes')).toHaveTextContent('unverified');
  expect(mockStorageGet).toHaveBeenCalledTimes(1);
  expect(mockReadHoldingTransactions).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
  });
  expect(mockStorageGet).toHaveBeenCalledTimes(2);
  expect(mockReadHoldingTransactions).toHaveBeenCalledTimes(2);
});

it('withholds an old same-account claim action while the effective RPC has advanced before the shell scope rerenders', async () => {
  mockWalletState.extensionClaimableNotes = [pendingNote];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {},
      storage: {
        local: {
          get: mockStorageGet.mockImplementation((_key: string, receive: (result: object) => void) =>
            receive({ miden_sync_data: { accountPublicKey: 'account-a', syncedAt: 1, notes: [pendingNote] } })
          )
        }
      }
    }
  });
  const dashboard = () => (
    <CommandShell scope={scope} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  const view = render(dashboard());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole('button', { name: 'note-a' })).toBeInTheDocument();
  const priorReads = mockStorageGet.mock.calls.length;
  mockEffectiveRpc = 'https://rpc-b';
  view.rerender(dashboard());
  expect(screen.queryByRole('button', { name: 'note-a' })).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'activityFetchingHistoryAndNotes' })).toBeInTheDocument();
  expect(mockStorageGet).toHaveBeenCalledTimes(priorReads + 1);
});

it('drops an old account read after dashboard A to B to A and starts a new scoped owner', async () => {
  const replies: ((result: object) => void)[] = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {},
      storage: {
        local: {
          get: mockStorageGet.mockImplementation((_key: string, reply: (result: object) => void) => replies.push(reply))
        }
      }
    }
  });
  const dashboard = (accountId: string) => (
    <CommandShell scope={{ ...scope, accountId }} route={{ kind: 'dashboard' }}>
      {null}
    </CommandShell>
  );
  const view = render(dashboard('account-a'));
  expect(mockStorageGet).toHaveBeenCalledTimes(1);
  mockAccount.publicKey = 'account-b';
  view.rerender(dashboard('account-b'));
  expect(mockStorageGet).toHaveBeenCalledTimes(2);
  mockAccount.publicKey = 'account-a';
  view.rerender(dashboard('account-a'));
  expect(mockStorageGet).toHaveBeenCalledTimes(3);
  const oldReply = replies[0];
  const currentReply = replies[2];
  if (!oldReply || !currentReply) throw new Error('Missing scoped storage replies');
  act(() => oldReply({ miden_sync_data: { accountPublicKey: 'account-a', notes: [pendingNote], syncedAt: 1 } }));
  expect(mockWalletState.setExtensionClaimableNotes).not.toHaveBeenCalled();
  act(() => currentReply({ miden_sync_data: { accountPublicKey: 'account-a', notes: [], syncedAt: 2 } }));
  expect(mockWalletState.setExtensionClaimableNotes).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('manual-notes')).toHaveTextContent('0');
  expect(screen.queryByText('note-a')).not.toBeInTheDocument();
});
