import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';
import type { RelayGasMode } from 'lib/evm-relay/types';
import type { DepositArrivalState } from 'lib/evm-relay/use-deposit-arrival';
import type { IOneClickTrackingData } from 'lib/miden/db/types';
import { NEAR_TEST_DEADLINE, nearTrackingFixture } from 'screens/near-intents-flow/testing';

import type { NearDepositRecord } from './near-pending-deposits';
import { PendingDepositHomeRow } from './PendingDepositHomeRow';

const mockNavigate = jest.fn();
const mockUseDepositArrival = jest.fn<DepositArrivalState, [PendingRelayDeposit | null]>();
let mockDeposits: PendingRelayDeposit[] | Promise<void> = [];
let mockServedChains = new Set<number>([8453]);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));
jest.mock('lib/evm-relay/pending-deposit', () => ({
  usePendingRelayDeposits: () => {
    if (mockDeposits instanceof Promise) throw mockDeposits;
    return mockDeposits;
  }
}));
jest.mock('lib/evm-relay/use-deposit-arrival', () => ({
  useDepositArrival: (deposit: PendingRelayDeposit | null) => mockUseDepositArrival(deposit)
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectRelayChain: (_snapshot: unknown, chainId: number) => (mockServedChains.has(chainId) ? { chainId } : null)
}));
jest.mock('screens/send-flow/bridge-networks', () => ({
  getBridgeNetworkByChainId: (chainId: number) => (chainId === 8453 ? { name: 'Base' } : undefined)
}));
let mockNearDeposits: NearDepositRecord[] = [];
const mockUseNearDeposits = jest.fn();
jest.mock('./near-pending-deposits', () => ({
  ...jest.requireActual('./near-pending-deposits'),
  useNearDeposits: (accountPublicKey: string, enabled: boolean) => {
    mockUseNearDeposits(accountPublicKey, enabled);
    return mockNearDeposits;
  }
}));

const NEAR_DEADLINE = Date.parse(NEAR_TEST_DEADLINE);

const nearDeposit = (
  id: string,
  startedAt: number,
  overrides: Partial<IOneClickTrackingData> = {}
): NearDepositRecord => ({ id, startedAt, tracking: nearTrackingFixture(overrides) });

const deposit = (id: string, overrides: Partial<PendingRelayDeposit> = {}): PendingRelayDeposit => ({
  id,
  accountPublicKey: 'mtst1account',
  address: '0x00000000000000000000000000000000000000aa',
  chainId: 8453,
  route: 'agglayer',
  token: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  amount: '70.25',
  amountBaseUnits: '70250000',
  createdAt: 2,
  ...overrides
});

const arrival = (state: DepositArrivalState['state']): DepositArrivalState => {
  const common: { needsAuthorization: boolean; mode: RelayGasMode; error: unknown } = {
    needsAuthorization: false,
    mode: 'sponsor',
    error: undefined
  };
  switch (state) {
    case 'waiting':
      return { state, balance: null, ...common };
    case 'partial':
      return { state, balance: 1n, ...common };
    case 'arrived':
      return { state, balance: 70250000n, ...common };
  }
};

beforeEach(() => {
  mockDeposits = [];
  mockNearDeposits = [];
  mockServedChains = new Set([8453]);
  mockUseDepositArrival.mockReturnValue(arrival('waiting'));
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('PendingDepositHomeRow', () => {
  it('shows no row when the account has no pending deposit', () => {
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.queryByTestId('pending-deposit-row')).not.toBeInTheDocument();
  });

  it('shows no row while the list loads', () => {
    mockDeposits = new Promise<void>(() => {});
    const { container } = render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the newest deposit as waiting, with its amount, token and network', () => {
    mockDeposits = [deposit('newest'), deposit('older', { createdAt: 1, amountBaseUnits: '5000000' })];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);

    const rows = screen.getAllByTestId('pending-deposit-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-state', 'waiting');
    expect(rows[0]).toHaveTextContent('depositFlowWaitingTitle');
    expect(rows[0]).toHaveTextContent('depositFlowPendingFrom {"amount":"70.25 USDC","network":"Base"}');
    expect(mockUseDepositArrival).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'newest' }));
  });

  it('keeps a partial deposit waiting', () => {
    mockDeposits = [deposit('newest')];
    mockUseDepositArrival.mockReturnValue(arrival('partial'));
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.getByTestId('pending-deposit-row')).toHaveAttribute('data-state', 'waiting');
  });

  it('shows a deposit whose funds arrived as received', () => {
    mockDeposits = [deposit('newest')];
    mockUseDepositArrival.mockReturnValue(arrival('arrived'));
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);

    const row = screen.getByTestId('pending-deposit-row');
    expect(row).toHaveAttribute('data-state', 'received');
    expect(row).toHaveTextContent('depositFlowPendingReceived');
  });

  it('opens the deposit screen on the deposit on a tap', () => {
    mockDeposits = [deposit('id 1')];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    fireEvent.click(screen.getByTestId('pending-deposit-row'));
    expect(mockNavigate).toHaveBeenCalledWith('/bridge/deposit?pending=id%201');
  });

  it('shows no row while the relay is off', () => {
    mockDeposits = [deposit('newest')];
    mockServedChains = new Set();
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.queryByTestId('pending-deposit-row')).not.toBeInTheDocument();
  });

  it('skips a deposit on a chain the relay does not serve and names a chain without a name by its id', () => {
    mockDeposits = [deposit('unserved', { chainId: 1, createdAt: 3 }), deposit('served', { chainId: 10 })];
    mockServedChains = new Set([10]);
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);

    expect(screen.getByTestId('pending-deposit-row')).toHaveTextContent('"network":"10"');
    expect(mockUseDepositArrival).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'served' }));
  });
});

describe('PendingDepositHomeRow with NEAR Intents deposits', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NEAR_DEADLINE - 60_000);
  });

  it('shows a waiting NEAR deposit with its quoted amount and chain, and opens its page on a tap', () => {
    mockNearDeposits = [nearDeposit('row 1', 1_000)];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    const row = screen.getByTestId('pending-deposit-row');
    expect(row).toHaveAttribute('data-state', 'waiting');
    expect(row).toHaveTextContent('depositFlowPendingFrom {"amount":"46 USDC","network":"Ethereum"}');
    expect(mockUseNearDeposits).toHaveBeenLastCalledWith('mtst1account', true);
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith('/receive/near-intents/row%201');
  });

  it('shows a NEAR deposit that 1Click saw as received', () => {
    mockNearDeposits = [nearDeposit('row-1', 1_000, { phase: 'processing' })];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.getByTestId('pending-deposit-row')).toHaveAttribute('data-state', 'received');
  });

  it('shows the newest of a relay record and a NEAR row', () => {
    mockDeposits = [deposit('relay', { createdAt: 2_000 })];
    mockNearDeposits = [nearDeposit('near', 1_000)];
    const { unmount } = render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.getByTestId('pending-deposit-row')).toHaveTextContent('"network":"Base"');
    unmount();

    mockNearDeposits = [nearDeposit('near', 3_000)];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.getAllByTestId('pending-deposit-row')).toHaveLength(1);
    expect(screen.getByTestId('pending-deposit-row')).toHaveTextContent('"network":"Ethereum"');
  });

  it('skips an expired or finished NEAR row for the next one, and drops a waiting row at its deadline', () => {
    mockNearDeposits = [
      nearDeposit('expired', 5_000, { phase: 'expired' }),
      nearDeposit('delivered', 4_000, { phase: 'delivered' }),
      nearDeposit('waiting', 3_000)
    ];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    fireEvent.click(screen.getByTestId('pending-deposit-row'));
    expect(mockNavigate).toHaveBeenCalledWith('/receive/near-intents/waiting');

    act(() => {
      jest.advanceTimersByTime(60_001);
    });
    expect(screen.queryByTestId('pending-deposit-row')).not.toBeInTheDocument();
  });

  it('shows no row when the only NEAR row expired', () => {
    jest.setSystemTime(NEAR_DEADLINE + 1);
    mockNearDeposits = [nearDeposit('waiting', 3_000)];
    render(<PendingDepositHomeRow accountPublicKey="mtst1account" />);
    expect(screen.queryByTestId('pending-deposit-row')).not.toBeInTheDocument();
  });

  it('reads the NEAR rows only while Home is the page on screen', () => {
    render(
      <PageActiveContext.Provider value={false}>
        <PendingDepositHomeRow accountPublicKey="mtst1account" />
      </PageActiveContext.Provider>
    );
    expect(mockUseNearDeposits).toHaveBeenLastCalledWith('mtst1account', false);
  });
});
