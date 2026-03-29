import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import Explore from './Explore';

const mockInitiateConsumeTransaction = jest.fn();
const mockMutateClaimableNotes = jest.fn();
const mockUseClaimableNotes = jest.fn();
const mockUseRetryableSWR = jest.fn();
const mockOpenTransactionModal = jest.fn();

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: false })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'faucet-1'
}));

jest.mock('app/icons/faucet.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/icons/receive.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/icons/send.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/layouts/PageLayout/Footer', () => () => null);

jest.mock('app/layouts/PageLayout/Header', () => () => null);

jest.mock('app/templates/AddressChip', () => () => null);

jest.mock('components/ChainInstabilityBanner', () => ({
  ChainInstabilityBanner: () => null
}));

jest.mock('components/ConnectivityIssueBanner', () => ({
  ConnectivityIssueBanner: () => null
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/activity', () => ({
  getFailedConsumeTransactions: jest.fn(),
  hasQueuedTransactions: jest.fn(),
  initiateConsumeTransaction: (...args: any[]) => mockInitiateConsumeTransaction(...args),
  startBackgroundTransactionProcessing: jest.fn()
}));

jest.mock('lib/miden-chain/faucet', () => ({
  getFaucetUrl: jest.fn(() => 'https://faucet.test')
}));

jest.mock('lib/miden/front', () => ({
  setFaucetIdSetting: jest.fn(),
  useAccount: () => ({ publicKey: 'acc-1' }),
  useAllBalances: () => ({ data: [] }),
  useAllTokensBaseMetadata: () => ({}),
  useMidenContext: () => ({ signTransaction: jest.fn() }),
  useNetwork: () => ({ id: 'devnet' })
}));

jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => mockUseClaimableNotes()
}));

jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => true,
  isDelegateProofEnabled: () => false
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: () => jest.fn()
}));

jest.mock('lib/woozie', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  navigate: jest.fn()
}));

jest.mock('lib/mobile/faucet-webview', () => ({
  openFaucetWebview: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false
}));

jest.mock('lib/store', () => {
  const useWalletStore = (selector: (state: { isTransactionModalDismissedByUser: boolean }) => boolean) =>
    selector({ isTransactionModalDismissedByUser: false });
  useWalletStore.getState = () => ({ openTransactionModal: mockOpenTransactionModal });
  return { useWalletStore };
});

jest.mock('utils/miden', () => ({
  isHexAddress: () => false
}));

jest.mock('./Explore/MainBanner', () => () => null);

jest.mock('./Explore/Tokens', () => () => null);

describe('Explore auto-consume', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleWarnSpy: jest.SpyInstance;

  const createMockNote = (overrides = {}) => ({
    id: 'note-123',
    faucetId: 'faucet-1',
    amount: '1000',
    senderAddress: 'sender-1',
    isBeingClaimed: false,
    ...overrides
  });

  const setupSWR = (failedData: unknown) => {
    mockUseRetryableSWR.mockImplementation((key: unknown) => {
      if (Array.isArray(key) && key[0] === 'failed-transactions') {
        return { data: failedData };
      }
      if (Array.isArray(key) && key[0] === 'has-queued-transactions') {
        return { data: false };
      }
      return { data: undefined };
    });
  };

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleWarnSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('does not auto-consume while failed consume transactions are loading', async () => {
    setupSWR(undefined);
    mockUseClaimableNotes.mockReturnValue({ data: [createMockNote()], mutate: mockMutateClaimableNotes });

    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    await act(async () => {
      testRoot!.render(<Explore />);
    });

    await act(async () => {});

    expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
  });

  it('skips auto-consume for notes with failed consume transactions', async () => {
    setupSWR([{ noteId: 'note-123' }]);
    mockUseClaimableNotes.mockReturnValue({ data: [createMockNote()], mutate: mockMutateClaimableNotes });

    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    await act(async () => {
      testRoot!.render(<Explore />);
    });

    await act(async () => {});

    expect(mockInitiateConsumeTransaction).not.toHaveBeenCalled();
  });
});
