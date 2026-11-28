import React from 'react';

import { act, cleanup, render } from '@testing-library/react';

import type { RelayAccountQuery } from 'lib/evm-relay/client';
import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';
import { CHAIN, EXECUTOR, RELAY_ADDRESS, SALT, USDC } from 'lib/evm-relay/testing';
import type { RelayAccount } from 'lib/evm-relay/types';
import type { IOneClickPhase } from 'lib/miden/db/types';
import { WalletStatus } from 'lib/shared/types';
import { nearTrackingFixture } from 'screens/near-intents-flow/testing';

import type { NearDepositRecord } from './near-pending-deposits';
import {
  DEPOSIT_ARRIVAL_WATCH_MS,
  PendingDepositArrivalWatcher,
  _resetAnnouncedDepositsForTest
} from './PendingDepositArrivalWatcher';

const mockFetchRelayAccount = jest.fn<Promise<RelayAccount>, [RelayAccountQuery]>();
const mockShowNotice = jest.fn();
const mockPlatform = { mobile: true, extension: false };
let mockDeposits: PendingRelayDeposit[] = [];
let mockPathname = '/';
let mockWallet: { status: WalletStatus; currentAccount: { publicKey: string } | null } = {
  status: WalletStatus.Ready,
  currentAccount: { publicKey: 'mtst1account' }
};
let mockRelayServed = true;
// The realm's relay config at read time, which can turn off before the page's snapshot does.
let mockRelayServedAtRead = true;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.mobile,
  isExtension: () => mockPlatform.extension
}));
jest.mock('lib/evm-relay/client', () => ({
  fetchRelayAccount: (query: RelayAccountQuery) => mockFetchRelayAccount(query)
}));
jest.mock('lib/evm-relay/pending-deposit', () => ({ usePendingRelayDeposits: () => mockDeposits }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectRelayChain: () => (mockRelayServed ? CHAIN : null),
  getRelayChain: () => (mockRelayServed && mockRelayServedAtRead ? CHAIN : null)
}));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: typeof mockWallet) => T) => selector(mockWallet)
}));
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: mockPathname }) }));
jest.mock('screens/send-flow/bridge-networks', () => ({ getBridgeNetworkByChainId: () => undefined }));
jest.mock('./deposit-arrival-notice', () => ({
  showDepositArrivalNotice: (notice: unknown) => mockShowNotice(notice)
}));
let mockNearDeposits: NearDepositRecord[] = [];
const mockUseNearDeposits = jest.fn();
jest.mock('./near-pending-deposits', () => ({
  ...jest.requireActual('./near-pending-deposits'),
  useNearDeposits: (accountPublicKey: string | undefined, enabled: boolean) => {
    mockUseNearDeposits(accountPublicKey, enabled);
    return mockNearDeposits;
  }
}));

const nearDeposit = (id: string, phase: IOneClickPhase): NearDepositRecord => ({
  id,
  startedAt: 1_000,
  tracking: nearTrackingFixture({ phase })
});

const deposit = (id: string, overrides: Partial<PendingRelayDeposit> = {}): PendingRelayDeposit => ({
  id,
  accountPublicKey: 'mtst1account',
  address: RELAY_ADDRESS,
  chainId: CHAIN.chainId,
  route: 'agglayer',
  token: { address: USDC, symbol: 'USDC', decimals: 6 },
  amount: '10',
  amountBaseUnits: '10000000',
  createdAt: 1,
  ...overrides
});

const relayAccount = (balance: bigint, executor = EXECUTOR): RelayAccount => ({
  chainId: CHAIN.chainId,
  address: RELAY_ADDRESS,
  mode: 'sponsor',
  executor,
  feeRecipient: null,
  needsAuthorization: false,
  authorizationNonce: 0,
  salt: SALT,
  sequence: 0n,
  feeTokens: [],
  allowedTargets: null,
  balances: [{ token: USDC, balance }]
});

let visibility: DocumentVisibilityState = 'visible';

const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

/** Lets the pending reads and their effects settle. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const nextRead = async () => {
  await act(async () => {
    jest.advanceTimersByTime(DEPOSIT_ARRIVAL_WATCH_MS);
  });
  await flush();
};

/** Answers the reads with these balances, one for each read, then the last one again. */
const answerBalances = (...balances: bigint[]) => {
  let index = 0;
  mockFetchRelayAccount.mockImplementation(async () => {
    const balance = balances[Math.min(index, balances.length - 1)] ?? 0n;
    index += 1;
    return relayAccount(balance);
  });
};

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

beforeEach(() => {
  jest.useFakeTimers();
  _resetAnnouncedDepositsForTest();
  mockPlatform.mobile = true;
  mockPlatform.extension = false;
  mockDeposits = [deposit('d1')];
  mockNearDeposits = [];
  mockPathname = '/';
  mockWallet = { status: WalletStatus.Ready, currentAccount: { publicKey: 'mtst1account' } };
  mockRelayServed = true;
  mockRelayServedAtRead = true;
  visibility = 'visible';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('PendingDepositArrivalWatcher', () => {
  it('announces a deposit once when a read sees it arrive after a read that saw it waiting', async () => {
    answerBalances(0n, 4000000n, 10000000n, 10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    expect(mockFetchRelayAccount).toHaveBeenCalledWith({
      chainId: CHAIN.chainId,
      address: RELAY_ADDRESS,
      tokens: [USDC]
    });
    expect(mockShowNotice).not.toHaveBeenCalled();

    // Partial: still not arrived.
    await nextRead();
    expect(mockShowNotice).not.toHaveBeenCalled();

    await nextRead();
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
    expect(mockShowNotice).toHaveBeenCalledWith({
      title: 'appName',
      body: 'depositFlowArrivalNotice',
      path: '/bridge/deposit?pending=d1',
      tag: 'deposit-arrived:d1'
    });

    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(4);
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
  });

  it('does not announce a deposit that had arrived at the first read', async () => {
    answerBalances(10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('announces each id once in a session, also after a new mount', async () => {
    answerBalances(0n, 10000000n, 0n, 10000000n);
    const first = render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
  });

  it('announces two deposits on one chain with one read for both', async () => {
    mockDeposits = [deposit('d1'), deposit('d2', { amountBaseUnits: '5000000' })];
    answerBalances(0n, 10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(2);
    expect(mockShowNotice).toHaveBeenCalledTimes(2);
    expect(mockShowNotice).toHaveBeenCalledWith(expect.objectContaining({ path: '/bridge/deposit?pending=d2' }));
  });

  it('reads nothing and announces nothing on the deposit screen', async () => {
    mockPathname = '/bridge/deposit';
    answerBalances(0n, 10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('starts from a new state after the deposit screen closes', async () => {
    answerBalances(0n, 10000000n);
    const view = render(<PendingDepositArrivalWatcher />);
    await flush();
    mockPathname = '/bridge/deposit';
    view.rerender(<PendingDepositArrivalWatcher />);
    await flush();
    mockPathname = '/';
    view.rerender(<PendingDepositArrivalWatcher />);
    await flush();
    // The deposit arrived while the deposit screen was open: no notice.
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(2);
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('stops reading when no pending deposit is left', async () => {
    answerBalances(0n);
    const view = render(<PendingDepositArrivalWatcher />);
    await flush();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(1);

    mockDeposits = [];
    view.rerender(<PendingDepositArrivalWatcher />);
    await nextRead();
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(1);
  });

  it('reads nothing with no pending deposit', async () => {
    mockDeposits = [];
    render(<PendingDepositArrivalWatcher />);
    await nextRead();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
  });

  it('reads nothing while the document is hidden, and reads again when it is visible', async () => {
    answerBalances(0n, 10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    setVisibility('hidden');
    await nextRead();
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await flush();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(2);
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while the wallet is locked', async () => {
    mockWallet = { status: WalletStatus.Locked, currentAccount: { publicKey: 'mtst1account' } };
    render(<PendingDepositArrivalWatcher />);
    await nextRead();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
  });

  it('reads nothing while the relay is off', async () => {
    mockRelayServed = false;
    render(<PendingDepositArrivalWatcher />);
    await nextRead();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
  });

  it('reads nothing when the relay stops serving the chain before the read', async () => {
    mockRelayServedAtRead = false;
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
  });

  it('starts no read while a read is still out', async () => {
    let answer: (account: RelayAccount) => void = () => {};
    mockFetchRelayAccount.mockImplementation(
      () =>
        new Promise<RelayAccount>(resolve => {
          answer = resolve;
        })
    );
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(relayAccount(0n));
    });
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(2);
  });

  it('drops a read that ends after the watch stopped', async () => {
    answerBalances(0n);
    const view = render(<PendingDepositArrivalWatcher />);
    await flush();
    let answer: (account: RelayAccount) => void = () => {};
    mockFetchRelayAccount.mockImplementation(
      () =>
        new Promise<RelayAccount>(resolve => {
          answer = resolve;
        })
    );
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(2);

    mockPathname = '/bridge/deposit';
    view.rerender(<PendingDepositArrivalWatcher />);
    await act(async () => {
      answer(relayAccount(10000000n));
    });
    await flush();
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('announces nothing for an answer that fails the guard or a read that fails', async () => {
    let call = 0;
    mockFetchRelayAccount.mockImplementation(async () => {
      call += 1;
      switch (call) {
        case 1:
          return relayAccount(0n);
        case 2:
          return relayAccount(10000000n, '0x00000000000000000000000000000000000000e2');
        default:
          throw new Error('offline');
      }
    });
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    await nextRead();
    expect(mockFetchRelayAccount).toHaveBeenCalledTimes(3);
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('announces on the extension too', async () => {
    mockPlatform.mobile = false;
    mockPlatform.extension = true;
    answerBalances(0n, 10000000n);
    render(<PendingDepositArrivalWatcher />);
    await flush();
    await nextRead();
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a platform with no notice path', async () => {
    mockPlatform.mobile = false;
    answerBalances(0n, 10000000n);
    const { container } = render(<PendingDepositArrivalWatcher />);
    await nextRead();
    expect(container).toBeEmptyDOMElement();
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
    expect(mockUseNearDeposits).not.toHaveBeenCalled();
  });
});

describe('PendingDepositArrivalWatcher for NEAR Intents deposits', () => {
  beforeEach(() => {
    // No relay deposit: only the NEAR rows drive the notice.
    mockDeposits = [];
  });

  it('announces a NEAR deposit once when 1Click sees its funds, with no network read', () => {
    mockNearDeposits = [nearDeposit('row-1', 'pending-deposit')];
    const view = render(<PendingDepositArrivalWatcher />);
    expect(mockUseNearDeposits).toHaveBeenLastCalledWith('mtst1account', true);
    expect(mockShowNotice).not.toHaveBeenCalled();

    mockNearDeposits = [nearDeposit('row-1', 'processing')];
    view.rerender(<PendingDepositArrivalWatcher />);
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
    expect(mockShowNotice).toHaveBeenCalledWith({
      title: 'appName',
      body: 'depositFlowArrivalNotice',
      path: '/receive/near-intents/row-1',
      tag: 'deposit-arrived:row-1'
    });

    mockNearDeposits = [nearDeposit('row-1', 'arriving')];
    view.rerender(<PendingDepositArrivalWatcher />);
    expect(mockShowNotice).toHaveBeenCalledTimes(1);
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
  });

  it('does not announce a deposit that 1Click had seen at the first read, or one that closed', () => {
    mockNearDeposits = [nearDeposit('seen', 'processing'), nearDeposit('closing', 'pending-deposit')];
    const view = render(<PendingDepositArrivalWatcher />);
    mockNearDeposits = [nearDeposit('seen', 'delivered'), nearDeposit('closing', 'expired')];
    view.rerender(<PendingDepositArrivalWatcher />);
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('does not announce a deposit whose page is on screen', () => {
    mockPathname = '/receive/near-intents/row-1';
    mockNearDeposits = [nearDeposit('row-1', 'depositing')];
    const view = render(<PendingDepositArrivalWatcher />);
    mockNearDeposits = [nearDeposit('row-1', 'known-deposit-tx')];
    view.rerender(<PendingDepositArrivalWatcher />);
    expect(mockShowNotice).not.toHaveBeenCalled();
  });

  it('reads no NEAR rows while the wallet is locked', () => {
    mockWallet = { status: WalletStatus.Locked, currentAccount: null };
    render(<PendingDepositArrivalWatcher />);
    expect(mockUseNearDeposits).toHaveBeenLastCalledWith(undefined, false);
  });
});
