import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { gaslessEarnWithdrawalToMiden } from 'lib/epoch';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { goBack, navigate } from 'lib/woozie';

import { EARN_PLACEHOLDER } from './earn-mapping';
import EarnWithdrawReview from './EarnWithdrawReview';
import type { EarnPosition } from './types';

const mockAccount: { publicKey: string; evmAddress?: string } = {
  publicKey: 'miden-account',
  evmAddress: '0x1111111111111111111111111111111111111111'
};
let mockPositions: EarnPosition[] = [];

// `PageHeader` (real, unmocked below) calls `useTranslation` for its back
// button's accessible name; without this the un-initialized react-i18next
// instance warns on every render and `t('back')` falls back to the key.
// Mocking it keeps that fallback deterministic instead of implicit.
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

// A load that did not fully succeed is driven per test; the default is a clean load.
let mockLoadState: { isLoading: boolean; error?: string } = { isLoading: false };
const mockRefetch = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

jest.mock('lib/epoch', () => ({
  gaslessEarnWithdrawalToMiden: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn()
}));

jest.mock('./useEarnPositions', () => ({
  ...jest.requireActual<typeof import('./useEarnPositions')>('./useEarnPositions'),
  useEarnPositions: () => ({
    summary: { totalRewards: '', blendedApy: '', totalDeposited: '', estimatedRewards: '' },
    positions: mockPositions,
    vaults: [],
    ...mockLoadState,
    refetch: mockRefetch
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { ChevronLeft: 'ChevronLeft' }
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    disabled,
    accent
  }: {
    title?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    accent?: string;
  }) => (
    <button type="button" data-accent={accent} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo">{symbol}</span>
}));

const position: EarnPosition = {
  id: 'position-1',
  vaultId: 'vault-1',
  owner: '0x1111111111111111111111111111111111111111',
  marketUid: 'DUMMY_LENDING:11155111:0xasset',
  chainId: '11155111',
  underlyingAddress: '0xasset',
  withdrawable: '42.25',
  decimals: 6,
  protocol: 'Aave',
  asset: 'USDC',
  network: 'Sepolia',
  amount: '$42.25',
  depositedAmount: '$40.00',
  rewards: '+$2.25',
  age: '1d',
  activeDuration: '1 day active',
  apy: '5%',
  dailyAverage: '+$0.01',
  started: 'Jul 28',
  yearlyEstimate: '+$2 / yr',
  withdrawTime: '~1 minute',
  route: 'Miden -> Aave (Sepolia)',
  chartData: [{ label: 'now', value: 42.25 }]
};

describe('EarnWithdrawReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.evmAddress = position.owner;
    mockPositions = [position];
    jest.mocked(isMobile).mockReturnValue(false);
    jest.mocked(gaslessEarnWithdrawalToMiden).mockResolvedValue({
      txId: 'tx-id',
      nonce: 'owner:1',
      gaslessUsed: true
    });
  });

  it('renders the selected position and the full-withdraw route details', () => {
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByTestId('earn-withdraw-review-page')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('Aave • USDC');
    // The network pill goes through the same translation key as EarnVaultDetail's,
    // rather than a hard-coded "{asset} on {network}" English string.
    expect(screen.getByText('earnAssetOnNetwork')).toBeInTheDocument();
    expect(screen.getByText('42.25')).toBeInTheDocument();
    expect(screen.getByTestId('token-logo')).toHaveTextContent('USDC');
    expect(screen.getByText('Aave (Sepolia) -> Miden')).toBeInTheDocument();
    expect(screen.getByText('earnFullPositionGasless')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('gives the withdraw confirm the earn flow colour', () => {
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByRole('button', { name: 'withdraw' })).toHaveAttribute('data-accent', 'earn');
  });

  it('falls back to an empty position and disables withdrawal for an unknown id', () => {
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByText('0.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeDisabled();
  });

  it('submits the full position and routes as soon as the tracking row exists', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(async args => {
      args.onRowCreated?.('tx/1');
      return { txId: 'tx/1', nonce: 'owner:1', gaslessUsed: true };
    });
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(hapticLight).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1));
    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledWith({
      midenAccountPublicKey: 'miden-account',
      evmAddress: position.owner,
      marketUid: position.marketUid,
      underlyingAddress: position.underlyingAddress,
      amount: '42.25',
      underlyingDecimals: 6,
      onRowCreated: expect.any(Function)
    });
    expect(navigate).toHaveBeenCalledWith('/earn/withdraw-status/tx%2F1');
  });

  it('rejects a position not owned by the current wallet account', async () => {
    mockAccount.evmAddress = '0x2222222222222222222222222222222222222222';
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('handles an account without a derived EVM address', async () => {
    mockAccount.evmAddress = undefined;
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnWithdrawNotOwned')).toBeInTheDocument();
    expect(gaslessEarnWithdrawalToMiden).not.toHaveBeenCalled();
  });

  it('surfaces SDK errors and restores the CTA', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue(new Error('intent unavailable'));
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('intent unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeEnabled();
  });

  it('uses the fallback message for non-Error failures', async () => {
    jest.mocked(gaslessEarnWithdrawalToMiden).mockRejectedValue('failed');
    render(<EarnWithdrawReview positionId="position-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'withdraw' }));

    expect(await screen.findByText('earnGaslessWithdrawalFailed')).toBeInTheDocument();
  });

  // Double-tapping the CTA must not submit two redemption intents.
  it('ignores a second tap while the first withdrawal is in flight', async () => {
    let release: (value: { txId: string; nonce: string; gaslessUsed: boolean }) => void = () => {};
    jest.mocked(gaslessEarnWithdrawalToMiden).mockImplementation(() => new Promise(resolve => (release = resolve)));
    render(<EarnWithdrawReview positionId="position-1" />);

    const cta = screen.getByRole('button', { name: 'withdraw' });
    fireEvent.click(cta);
    fireEvent.click(cta);

    expect(gaslessEarnWithdrawalToMiden).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ txId: 'tx-1', nonce: 'owner:1', gaslessUsed: true });
    });
  });

  it('uses mobile footer padding in the mobile app', () => {
    jest.mocked(isMobile).mockReturnValue(true);
    render(<EarnWithdrawReview positionId="position-1" />);

    const footer = screen.getByRole('button', { name: 'withdraw' }).parentElement;
    expect(footer).toHaveClass('px-8');
    expect(footer).not.toHaveClass('px-6');
  });

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - which is the distinction a source match could
  // not make, and how a banner once shipped behind an early return.
  it('names the network it will commit on', () => {
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

describe('EarnWithdrawReview after a failed load', () => {
  beforeEach(() => {
    mockPositions = [position];
  });
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it('says a per-owner positions failure too, which is not a request failure', () => {
    mockLoadState = { isLoading: false, error: 'owner unavailable' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
  });

  it('says the load failed, with Retry, instead of offering to withdraw a placeholder position', () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toHaveTextContent('earnPositionsLoadError');
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure said while a retry is loading, and names only the route in the header', () => {
    mockLoadState = { isLoading: true, error: 'boom' };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^withdraw$/);
    expect(screen.queryByText(/earnAssetOnNetwork/)).toBeNull();
  });

  it('draws nothing it has not loaded during a first load with no error', () => {
    mockLoadState = { isLoading: true };
    render(<EarnWithdrawReview positionId="unknown" />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'withdraw' })).toBeNull();
    expect(screen.queryByText('earnWithdrawAmount')).toBeNull();
  });

  it('keeps a position it already has, under the notice', () => {
    mockLoadState = { isLoading: false, error: 'boom' };
    render(<EarnWithdrawReview positionId="position-1" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'withdraw' })).toBeInTheDocument();
  });
});

const MISSING_LOAD_STATES: Array<[string, { isLoading: boolean; error?: string }]> = [
  ['a failed load', { isLoading: false, error: 'boom' }],
  ['a load in flight', { isLoading: true }],
  ['a settled load without it', { isLoading: false }]
];

describe('EarnWithdrawReview with no position to name', () => {
  afterEach(() => {
    mockLoadState = { isLoading: false };
  });

  it.each(MISSING_LOAD_STATES)('keeps a route heading and no placeholder name after %s', (_state, loadState) => {
    mockLoadState = loadState;
    render(<EarnWithdrawReview positionId="unknown" />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/^withdraw$/);
    expect(screen.queryByText(`${EARN_PLACEHOLDER} • ${EARN_PLACEHOLDER}`)).toBeNull();
    expect(screen.queryByText(/earnAssetOnNetwork/)).toBeNull();
  });
});
