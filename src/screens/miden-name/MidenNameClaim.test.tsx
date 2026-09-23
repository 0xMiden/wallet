import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import type { MidenNameQuote } from 'lib/miden/name/reads';
import { SpendingLimitAuthorizationRequiredError } from 'lib/miden/spending-limits/types';

import { MidenNameClaim } from './MidenNameClaim';

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
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

jest.mock('app/hooks/useBackWithFallback', () => ({
  useBackWithFallback: () => jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isMobile: jest.fn(() => false)
}));

const mockHapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: () => mockHapticMedium()
}));

jest.mock('lib/mobile/useNavbarHidden', () => ({ useNavbarHidden: () => true }));
jest.mock('components/NetworkModeBanner', () => ({ NetworkModeBanner: () => null }));
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { CheckboxCircleFill: 'checkbox-circle-fill', ChevronLeft: 'chevron-left', Close: 'close' }
}));

jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals: number) => String(Number(amount) / 10 ** decimals)
}));

const mockFetchMidenNameQuote = jest.fn<Promise<MidenNameQuote>, [string]>();
jest.mock('lib/miden/name/reads', () => ({
  fetchMidenNameQuote: (label: string) => mockFetchMidenNameQuote(label)
}));

const mockAssertPreconditions = jest.fn();
jest.mock('lib/miden/name/guard', () => ({
  assertRegistrationPreconditions: (...args: unknown[]) => mockAssertPreconditions(...args)
}));

const mockBuildRequest = jest.fn();
jest.mock('lib/miden/name/note', () => ({
  buildRegisterNameRequest: (...args: unknown[]) => mockBuildRequest(...args),
  registerNameRowAccounts: () => ({
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry'
  })
}));

const mockInitiateRegister = jest.fn();
jest.mock('lib/miden/transaction/initiate', () => ({
  initiateRegisterNameTransaction: (...args: unknown[]) => mockInitiateRegister(...args)
}));

const mockRequestSWProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  requestSWTransactionProcessing: () => mockRequestSWProcessing(),
  startBackgroundTransactionProcessing: jest.fn()
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => true }));

let mockNativeBalance = 100;
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'mtst1account', name: 'Account 1' }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({
    data: [{ tokenId: 'mtst1miden', balance: mockNativeBalance, metadata: { decimals: 6, symbol: 'MIDEN' } }],
    isLoading: false
  })
}));
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'mtst1miden' }));
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => 100 }));
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({ useNetworkFeeEstimate: () => '0.003 MIDEN' }));

const mockStore = { assessSpendingLimit: jest.fn(), readSpendingLimit: jest.fn() };
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: typeof mockStore) => T) => selector(mockStore)
}));

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: SpendingLimitChallengeProps) => (
    <div data-testid="spending-limit-challenge">
      <button
        type="button"
        onClick={() =>
          props.onResult({
            kind: 'usd',
            id: 'authorization-1',
            accountId: props.assessment?.accountId ?? 'mtst1account',
            usdAmount: 1n,
            revision: 'revision-1',
            issuedAt: 100,
            expiresAt: 220,
            spendsDigest: 'digest'
          })
        }
      >
        authorize-limit
      </button>
    </div>
  )
}));

function quote(label: string, overrides: Partial<MidenNameQuote> = {}): MidenNameQuote {
  return {
    label,
    available: true,
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    scriptAllowed: true,
    blockNum: 1,
    ...overrides
  };
}

const REQUEST = {
  requestBytes: new Uint8Array([1, 2, 3]),
  registrationNoteId: '0xnote',
  reclaimHeight: 1300,
  builtAtBlock: 1000
};

async function typeLabel(value: string) {
  fireEvent.change(screen.getByTestId('miden-name-input'), { target: { value } });
  await act(async () => {
    jest.advanceTimersByTime(400);
    await Promise.resolve();
  });
}

describe('MidenNameClaim', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockNativeBalance = 100;
    mockFetchMidenNameQuote.mockResolvedValue(quote('alice'));
    mockAssertPreconditions.mockResolvedValue(quote('alice'));
    mockBuildRequest.mockResolvedValue(REQUEST);
    mockInitiateRegister.mockResolvedValue('tx-1');
    mockStore.assessSpendingLimit.mockResolvedValue(undefined);
    mockStore.readSpendingLimit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the rules hint and a disabled CTA before any input', () => {
    render(<MidenNameClaim />);
    expect(screen.getByText('midenNameRules')).toBeInTheDocument();
    expect(screen.getByTestId('miden-name-claim-cta')).toBeDisabled();
    expect(screen.getByTestId('miden-name-claim-cta')).toHaveTextContent('midenNameClaimCta');
  });

  it('shows the invalid copy and reads nothing', async () => {
    render(<MidenNameClaim />);
    await typeLabel('al!ce');
    expect(screen.getByTestId('miden-name-input-error')).toHaveTextContent('midenNameInvalidChars');
    expect(mockFetchMidenNameQuote).not.toHaveBeenCalled();
  });

  it('shows the checking copy while the quote is read', async () => {
    mockFetchMidenNameQuote.mockReturnValue(new Promise(() => undefined));
    render(<MidenNameClaim />);
    await typeLabel('alice');
    expect(screen.getByTestId('miden-name-availability')).toHaveTextContent('midenNameChecking');
    expect(screen.getByTestId('miden-name-claim-cta')).toBeDisabled();
  });

  it.each<[string, Partial<MidenNameQuote>, string]>([
    ['available', {}, 'midenNameAvailable_alice.miden'],
    ['taken', { available: false }, 'midenNameTaken_alice.miden'],
    ['unsupported', { scriptAllowed: false }, 'midenNameRegistryUnavailable']
  ])('shows the %s copy', async (_name, overrides, copy) => {
    mockFetchMidenNameQuote.mockResolvedValue(quote('alice', overrides));
    render(<MidenNameClaim />);
    await typeLabel('alice');
    expect(screen.getByTestId('miden-name-availability')).toHaveTextContent(copy);
  });

  it('shows the error copy when the read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetchMidenNameQuote.mockRejectedValue(new Error('rpc down'));
    render(<MidenNameClaim />);
    await typeLabel('alice');
    expect(screen.getByTestId('miden-name-availability')).toHaveTextContent('midenNameServiceUnavailable');
    warn.mockRestore();
  });

  it('shows price, fees, total and the account, and enables the CTA', async () => {
    render(<MidenNameClaim />);
    await typeLabel('Alice');
    expect(screen.getByTestId('miden-name-price')).toHaveTextContent('midenNamePrice_5+');
    expect(screen.getByTestId('miden-name-price')).toHaveTextContent('20 MIDEN');
    expect(screen.getByTestId('miden-name-network-fee')).toHaveTextContent('0.00021 MIDEN');
    expect(screen.getByTestId('miden-name-tx-fee')).toHaveTextContent('0.003 MIDEN');
    // 20 + 0.00021 + 30 x 100 base units.
    expect(screen.getByTestId('miden-name-total')).toHaveTextContent('20.00321 MIDEN');
    expect(screen.getByTestId('miden-name-goes-to')).toHaveTextContent('Account 1');
    const cta = screen.getByTestId('miden-name-claim-cta');
    expect(cta).toBeEnabled();
    expect(cta).toHaveTextContent('midenNameClaimName_alice.miden_20 MIDEN');
  });

  it('disables the CTA when the balance does not cover price + network fee + fee reserve', async () => {
    mockNativeBalance = 20;
    render(<MidenNameClaim />);
    await typeLabel('alice');
    expect(screen.getByTestId('miden-name-claim-cta')).toBeDisabled();
    expect(screen.getByTestId('miden-name-insufficient')).toHaveTextContent('midenNameInsufficientBalance');
  });

  it('checks, builds, queues, starts processing and replaces the form with the status page', async () => {
    render(<MidenNameClaim />);
    await typeLabel('alice');
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-claim-cta'));
    });

    expect(mockHapticMedium).toHaveBeenCalled();
    expect(mockAssertPreconditions).toHaveBeenCalledWith('alice', 20_000_000n);
    expect(mockBuildRequest).toHaveBeenCalledWith({
      senderAccountId: 'mtst1account',
      label: 'alice',
      priceBaseUnits: 20_000_000n
    });
    expect(mockInitiateRegister).toHaveBeenCalledWith({
      accountId: 'mtst1account',
      label: 'alice',
      priceBaseUnits: 20_000_000n,
      networkFeeBaseUnits: 210n,
      request: REQUEST,
      delegateTransaction: true,
      spendingLimitAuthorization: undefined
    });
    expect(mockRequestSWProcessing).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name/status/tx-1', 'replace');
  });

  it('shows the taken copy when the fresh check refuses the name', async () => {
    const error = new Error('taken');
    error.name = 'MidenNameTakenError';
    mockAssertPreconditions.mockRejectedValue(error);
    render(<MidenNameClaim />);
    await typeLabel('alice');
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-claim-cta'));
    });
    expect(screen.getByTestId('miden-name-error')).toHaveTextContent('midenNameTaken_alice.miden');
    expect(mockBuildRequest).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the spending-limit challenge and re-submits the SAME request object', async () => {
    const assessment = {
      accountId: 'mtst1account',
      usdAmount: 1_000_000_000n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 1n, proposedTotal: 1_000_000_001n, limit: 2n, overBy: 999_999_999n, resetAt: 200 }
    };
    mockInitiateRegister.mockRejectedValueOnce(new SpendingLimitAuthorizationRequiredError(assessment));
    render(<MidenNameClaim />);
    await typeLabel('alice');
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-claim-cta'));
    });

    expect(await screen.findByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
    });

    await waitFor(() => expect(mockInitiateRegister).toHaveBeenCalledTimes(2));
    expect(mockBuildRequest).toHaveBeenCalledTimes(1);
    const first = mockInitiateRegister.mock.calls[0]?.[0];
    const second = mockInitiateRegister.mock.calls[1]?.[0];
    expect(second.request).toBe(first.request);
    expect(second.spendingLimitAuthorization).toMatchObject({ id: 'authorization-1' });
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name/status/tx-1', 'replace');
  });

  it('opens the challenge from the pre-check without queueing', async () => {
    mockStore.assessSpendingLimit.mockResolvedValue({
      accountId: 'mtst1account',
      usdAmount: 1n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 1n, proposedTotal: 2n, limit: 1n, overBy: 1n, resetAt: null }
    });
    render(<MidenNameClaim />);
    await typeLabel('alice');
    await act(async () => {
      fireEvent.click(screen.getByTestId('miden-name-claim-cta'));
    });
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(mockStore.assessSpendingLimit).toHaveBeenCalledWith('mtst1account', [
      { faucetId: 'mtst1miden', amount: 20_000_000n }
    ]);
    expect(mockInitiateRegister).not.toHaveBeenCalled();
  });
});
