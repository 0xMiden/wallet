import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { confirmSensitiveAction } from 'lib/biometric';
import { bridgeEpochSend } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { goBack, navigate } from 'lib/woozie';
import { isValidMidenAddress } from 'utils/miden';

import { dateTimeToRecallBlocks } from './RecallCalendarDrawer';
import { ReviewTransaction } from './ReviewTransaction';
import { clearSendDraft } from './send-draft';

// ---------------------------------------------------------------------------
// Mutable per-test state read by the hook mocks. All prefixed with `mock` so
// they are legal to reference from hoisted jest.mock factories.
// ---------------------------------------------------------------------------
let mockSearch = '';
let mockFullPage = false;
let mockPublicKey: string | null = 'pubkey-1';
let mockBalanceData: any[] | undefined;
let mockTokensMeta: any[] = [];
let mockDetectedChain: 'miden' | 'ethereum' = 'miden';
let mockEpochQuote: { amount?: string; loading: boolean; error: null } = {
  amount: undefined,
  loading: false,
  error: null
};

const mockWalletStoreState = {
  setLastCompletedTxHash: jest.fn(),
  assessSpendingLimit: jest.fn()
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// RpcClient lives on the lazy SDK subpath (mapped to wasmMock, which has no
// RpcClient). Provide a controllable class + expose its header fn.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const getBlockHeaderByNumber = jest.fn();
  class RpcClient {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    getBlockHeaderByNumber() {
      return getBlockHeaderByNumber();
    }
  }
  return { RpcClient, __getBlockHeaderByNumber: getBlockHeaderByNumber };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: mockFullPage })
}));

jest.mock('./SendStepLayout', () => ({
  SendStepLayout: ({ title, onBack, children, footer }: any) => (
    <div data-testid="review-layout">
      <h1>{title}</h1>
      <button data-testid="back-btn" aria-label="back" onClick={onBack}>
        back
      </button>
      <div data-testid="hero">{children}</div>
      <div data-testid="footer">{footer}</div>
    </div>
  )
}));
jest.mock('components/NetworkChip', () => ({
  NetworkChip: ({ label }: any) => <span data-testid="network-chip">{label}</span>
}));

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
    return (
      <div data-testid="spending-limit-challenge">
        <span>{props.assessment.revision}</span>
        <button
          type="button"
          onClick={() =>
            props.onResult({
              id: 'authorization-1',
              accountId: props.assessment.accountId,
              faucetId: props.assessment.faucetId,
              amount: props.assessment.amount,
              revision: props.assessment.revision,
              issuedAt: 120,
              expiresAt: 240
            })
          }
        >
          authorize-limit
        </button>
        <button type="button" onClick={() => props.onResult(undefined)}>
          cancel-limit
        </button>
      </div>
    );
  }
}));

jest.mock('components/ui/DetailCard', () => ({
  DetailCard: ({ children }: any) => <div data-testid="rows">{children}</div>,
  DetailRow: ({ label, children, action, sub }: any) => (
    <div data-testid="review-row">
      <span data-testid="row-label">{label}</span>
      {children !== undefined && <span data-testid="row-children">{children}</span>}
      {action && (
        <button data-testid="row-edit" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {sub !== undefined && <span data-testid="row-note">{sub}</span>}
    </div>
  )
}));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <span data-testid="token-logo" /> }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, variant: _variant, isLoading: _isLoading, ...rest }: any) => (
    <button type="button" {...rest}>
      {title}
    </button>
  )
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: jest.fn()
}));

jest.mock('lib/agglayer/b2agg', () => ({
  initiateB2AggBridge: jest.fn()
}));

jest.mock('lib/agglayer/b2agg/constant', () => ({
  EVM_AGGLAYER_NETWORK_ID: 11155111
}));

jest.mock('lib/epoch', () => ({
  bridgeEpochSend: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  toAdaptiveFixed: (v: number) => v.toFixed(2),
  stringToBigInt: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  initiateSendTransaction: jest.fn(),
  requestSWTransactionProcessing: jest.fn()
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: mockPublicKey }),
  useAllBalances: () => ({ data: mockBalanceData }),
  useAllTokensBaseMetadata: () => mockTokensMeta
}));

jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: {}
}));

jest.mock('lib/miden/types', () => ({
  NoteTypeEnum: { Public: 'public', Private: 'private' }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(),
  getRpcEndpoint: jest.fn(() => 'https://rpc.example')
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => false)
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: jest.fn(() => false)
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockWalletStoreState) => unknown) =>
      selector ? selector(mockWalletStoreState) : mockWalletStoreState,
    { getState: () => mockWalletStoreState }
  )
}));

jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn(),
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' },
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">redirect:{to}</div>,
  useLocation: () => ({ search: mockSearch })
}));

jest.mock('utils/miden', () => {
  const validate = jest.fn(() => true);
  return {
    isValidMidenAddress: validate,
    isValidRecipientAddress: validate,
    detectAddressChain: () => mockDetectedChain
  };
});

jest.mock('./RecallCalendarDrawer', () => ({
  SECONDS_PER_BLOCK: 3,
  dateTimeToRecallBlocks: jest.fn(() => 999),
  RecallCalendarDrawer: (props: any) => (
    <div data-testid="recall-drawer" data-open={String(props.open)} data-recall-time={props.recallTime} />
  )
}));

jest.mock('./send-draft', () => ({
  clearSendDraft: jest.fn()
}));

jest.mock('./useEpochQuote', () => ({
  useEpochQuote: () => mockEpochQuote
}));

// ---------------------------------------------------------------------------
// Typed handles to the mocks
// ---------------------------------------------------------------------------
const confirmMock = confirmSensitiveAction as jest.Mock;
const initiateB2AggBridgeMock = initiateB2AggBridge as jest.Mock;
const bridgeEpochSendMock = bridgeEpochSend as jest.Mock;
const stringToBigIntMock = stringToBigInt as jest.Mock;
const initiateMock = initiateSendTransaction as jest.Mock;
const requestSWMock = requestSWTransactionProcessing as jest.Mock;
const isExtensionMock = isExtension as jest.Mock;
const isDelegateProofEnabledMock = isDelegateProofEnabled as jest.Mock;
const isValidMidenAddressMock = isValidMidenAddress as jest.Mock;
const goBackMock = goBack as jest.Mock;
const navigateMock = navigate as jest.Mock;
const clearSendDraftMock = clearSendDraft as jest.Mock;
const dateTimeToRecallBlocksMock = dateTimeToRecallBlocks as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

function deferred<T = unknown>() {
  let resolve!: (v?: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (v?: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const VALID_TOKEN = {
  tokenId: 'tok1',
  metadata: { symbol: 'MDN', decimals: 8 },
  balance: 100,
  fiatPrice: 2
};

// Same token, but its faucet never resolved — so `metadata.decimals` is the
// unknown-token placeholder's guess of 6 rather than anything the faucet said.
const UNSCALED_TOKEN = {
  tokenId: 'tok1',
  metadata: { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true },
  balance: 100,
  fiatPrice: 0
};

const setValidRoute = () => {
  mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
  mockBalanceData = [VALID_TOKEN];
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();

  // Base implementations (resetAllMocks wipes impls).
  confirmMock.mockResolvedValue(true);
  stringToBigIntMock.mockReturnValue(12345n);
  initiateMock.mockResolvedValue('tx-abc');
  initiateB2AggBridgeMock.mockResolvedValue('tx-bridge');
  bridgeEpochSendMock.mockResolvedValue({ txId: 'tx-epoch' });
  dateTimeToRecallBlocksMock.mockReturnValue(999);
  isExtensionMock.mockReturnValue(false);
  isDelegateProofEnabledMock.mockReturnValue(false);
  isValidMidenAddressMock.mockReturnValue(true);
  mockWalletStoreState.setLastCompletedTxHash.mockReset();
  mockWalletStoreState.assessSpendingLimit.mockResolvedValue(undefined);

  // Base route state.
  mockSearch = '';
  mockFullPage = false;
  mockPublicKey = 'pubkey-1';
  mockBalanceData = undefined;
  mockTokensMeta = [];
  mockDetectedChain = 'miden';
  mockEpochQuote = { amount: undefined, loading: false, error: null };

  delete process.env.MIDEN_E2E_TEST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
});

// ---------------------------------------------------------------------------
// Deep-link redirect guards
// ---------------------------------------------------------------------------
describe('ReviewTransaction — redirect guards', () => {
  it('redirects to /send when required params are missing', async () => {
    mockSearch = ''; // no tokenId, empty amount, empty to
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the amount is not greater than zero', async () => {
    mockSearch = 'amount=0&to=0xrecipient&tokenId=tok1';
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the recipient address is invalid', async () => {
    mockSearch = 'amount=5&to=bad&tokenId=tok1';
    isValidMidenAddressMock.mockReturnValue(false);
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when a deep link tries to send to the current account', async () => {
    mockSearch = 'amount=5&to=pubkey-1&tokenId=tok1';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when balances are loaded but the token id has no match', async () => {
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, tokenId: 'other' }];
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the amount exceeds the token balance', async () => {
    mockSearch = 'amount=500&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [VALID_TOKEN]; // balance 100 < 500
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
describe('ReviewTransaction — rendering', () => {
  it('renders header, hero and detail rows, seeding the 7-day expiration', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByRole('heading', { level: 1, name: 'reviewDetails' })).toBeInTheDocument();
    expect(screen.getByTestId('back-btn')).toBeInTheDocument();
    expect(screen.getByTestId('network-chip')).toHaveTextContent('miden');
    // Both the amount and its fiat subtitle live inside the review-amount hero —
    // scoping to it is what proves they render together, not just somewhere on the page.
    const hero = within(screen.getByTestId('review-amount'));
    expect(hero.getByText('5 MDN')).toBeInTheDocument();
    // The fiat subtitle renders under the hero value once the token's price is known.
    expect(hero.getByText('approxFiatValue')).toBeInTheDocument();
    // Recipient row value.
    expect(screen.getByText('0xrecipient')).toBeInTheDocument();

    // Seeding effect ran -> recallDate seeded -> capitalized relative
    // label + reclaim note both present.
    await waitFor(() => expect(screen.getByTestId('row-note')).toBeInTheDocument());
    expect(screen.getByTestId('row-note').textContent).toBe('recallReturnsNote');
    expect(screen.getByText(/^In .+/)).toBeInTheDocument();
    // Relative blocks-until-recall — no block height involved (#308).
    expect(dateTimeToRecallBlocksMock).toHaveBeenCalledWith(expect.any(Date));
  });

  it('renders with an undefined token when balances have not loaded (hero symbol empty)', async () => {
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    mockBalanceData = undefined; // token undefined but tokenInvalid guard is skipped
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('review-amount').textContent).toBe('5 ');

    // onSubmit early-returns because there is no token: nothing fires.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('invokes goBack from the header back button', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    fireEvent.click(screen.getByTestId('back-btn'));
    expect(goBackMock).toHaveBeenCalledTimes(1);
  });

  it('opens the recall calendar drawer via the expiration Edit link', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('recall-drawer').getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByTestId('row-edit'));
    await flush();
    expect(screen.getByTestId('recall-drawer').getAttribute('data-open')).toBe('true');
  });

  it.each([
    [40, 'expiresInSeconds'], // 40 blocks * 3s = 120s  (< 180 → seconds)
    [400, 'expiresInMinutes'] // 400 blocks * 3s = 1200s (< 1800 → minutes)
  ])('renders the precise expiration label derived from recallBlocks=%d', async (blocks, expectedLabel) => {
    // The label reads the relative recall offset (recallBlocks), NOT the picked
    // absolute instant, so it always matches the window the send will apply.
    dateTimeToRecallBlocksMock.mockReturnValue(blocks);
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    unmount();
  });

  it('never shows "None" while a recall offset is attached (label derives from the offset, not the clock)', async () => {
    // recallBlocks set → P2IDE, so the note IS recallable — the label must surface
    // the window and never "None" (which would imply a plain P2ID). Being offset-
    // derived, it also can't count down to "None" or snap backwards as time passes.
    dateTimeToRecallBlocksMock.mockReturnValue(1); // 1 block * 3s = 3s window
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    expect(screen.queryByText('none')).not.toBeInTheDocument();
    expect(screen.getByText('expiresInSeconds')).toBeInTheDocument();
    unmount();
  });

  it('renders the slow bridge route without a Miden expiration row', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('Sepolia')).toBeInTheDocument();
    expect(screen.getByText('slow slowArrival')).toBeInTheDocument();
    expect(screen.queryByTestId('row-note')).not.toBeInTheDocument();
    expect(dateTimeToRecallBlocksMock).not.toHaveBeenCalled();
  });

  it('renders the fast bridge route loading state from the Epoch quote', async () => {
    mockDetectedChain = 'ethereum';
    mockEpochQuote = { amount: '4.8', loading: true, error: null };
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];

    const { container } = render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('fast fastArrival')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Submit pipeline
// ---------------------------------------------------------------------------
describe('ReviewTransaction — onSubmit', () => {
  const clickSubmit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
  };

  // This screen is reachable by URL and re-derives its own token, so it cannot
  // rely on the amount screen having refused. Every conversion below it runs
  // `stringToBigInt(amount, token.decimals)`: at the placeholder's guessed 6, a
  // "5" typed for an 18-decimal faucet authorises a transfer a trillion times
  // smaller than the one being confirmed, irreversibly.
  describe('a token whose scale never resolved', () => {
    beforeEach(() => {
      setValidRoute();
      mockBalanceData = [UNSCALED_TOKEN];
    });

    it('refuses to submit and says why, instead of converting by a guess', async () => {
      render(<ReviewTransaction />);
      await flush();

      await clickSubmit();

      expect(confirmMock).not.toHaveBeenCalled();
      expect(initiateMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('review-error').textContent).toBe('unknownTokenScale');
    });

    it('disables the CTA rather than waiting for the press to reject it', async () => {
      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    });

    it('leaves an ordinary token CTA alone', async () => {
      mockBalanceData = [VALID_TOKEN];
      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
      expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
    });
  });

  it('runs the full private send pipeline (non-extension, popup route)', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();
    // Wait until the recall blocks have been seeded.
    await waitFor(() => expect(screen.getByTestId('row-note')).toBeInTheDocument());

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', 'tok1', 12345n);
    expect(confirmMock).toHaveBeenCalledWith('Confirm your send');
    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'private', 12345n, 999, false);
    expect(requestSWMock).not.toHaveBeenCalled();
    expect(clearSendDraftMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-abc', 'replacestate');
  });

  it('uses strict authentication instead of the ordinary confirmation for a spending-limit breach', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue({
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: 200 }]
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateMock).toHaveBeenCalledWith(
      'pubkey-1',
      '0xrecipient',
      'tok1',
      'private',
      12345n,
      999,
      false,
      expect.objectContaining({
        id: 'authorization-1',
        accountId: 'pubkey-1',
        faucetId: 'tok1',
        amount: 12345n,
        revision: 'revision-1'
      })
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('bridges over the Slow route with the faucet of the token being sent', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockResolvedValue('tx-agg');
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        faucetId: 'tok1',
        destinationAddress: '0xrecipient',
        senderPublicKey: 'pubkey-1'
      })
    );
  });

  it('uses strict authentication before building an Agglayer bridge request', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue({
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: 200 }]
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        faucetId: 'tok1',
        senderPublicKey: 'pubkey-1',
        spendingLimitAuthorization: expect.objectContaining({ id: 'authorization-1', revision: 'revision-1' })
      })
    );
  });

  it('keeps the ordinary confirmation and sends no authorization for a below-limit bridge', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', 'tok1', 12345n);
    expect(confirmMock).toHaveBeenCalledWith('Confirm your send');
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        senderPublicKey: 'pubkey-1',
        spendingLimitAuthorization: undefined
      })
    );
  });

  it('reopens an Epoch bridge challenge when external preparation outlives authorization', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];
    const firstAssessment = {
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '7d', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null }]
    };
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(firstAssessment);
    bridgeEpochSendMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: { ...firstAssessment, revision: 'revision-2', assessedAt: 240 }
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(bridgeEpochSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spendingLimitAuthorization: expect.objectContaining({ id: 'authorization-1', revision: 'revision-1' })
      })
    );
    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('cancels a spending-limit challenge without queueing or losing the review draft', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue({
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '7d', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null }]
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(initiateMock).not.toHaveBeenCalled();
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('cancels a bridge challenge before any external bridge work', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue({
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '7d', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null }]
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));
    await flush();

    expect(bridgeEpochSendMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('reopens the challenge with the final atomic assessment when authorization expires or loses a race', async () => {
    setValidRoute();
    const firstAssessment = {
      accountId: 'pubkey-1',
      faucetId: 'tok1',
      amount: 12345n,
      revision: 'revision-1',
      assessedAt: 100,
      breaches: [{ period: '24h', spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: 200 }]
    };
    const finalAssessment = {
      ...firstAssessment,
      revision: 'revision-2',
      assessedAt: 121,
      breaches: [{ ...firstAssessment.breaches[0], spent: 95n, proposedTotal: 12440n, overBy: 12340n }]
    };
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(firstAssessment);
    initiateMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: finalAssessment
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('nudges the service worker and uses the full-page route on extension', async () => {
    setValidRoute();
    mockFullPage = true;
    isExtensionMock.mockReturnValue(true);
    render(<ReviewTransaction />);
    await flush();
    await waitFor(() => expect(screen.getByTestId('row-note')).toBeInTheDocument());

    await clickSubmit();

    expect(requestSWMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction-full/tx-abc', 'replacestate');
  });

  it('forwards the delegate-proof flag from settings', async () => {
    setValidRoute();
    isDelegateProofEnabledMock.mockReturnValue(true);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    const call = initiateMock.mock.calls[0];
    expect(call[6]).toBe(true);
  });

  it('aborts when biometric confirmation is declined', async () => {
    setValidRoute();
    confirmMock.mockResolvedValue(false);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    // isSubmitting was reset, so a subsequent confirmed attempt goes through.
    confirmMock.mockResolvedValue(true);
    await clickSubmit();
    expect(initiateMock).toHaveBeenCalledTimes(1);
  });

  it('logs and resets when transaction creation throws', async () => {
    setValidRoute();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    initiateMock.mockRejectedValue(new Error('create failed'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(consoleSpy).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    // isSubmitting reset -> retry works.
    initiateMock.mockResolvedValue('tx-retry');
    await clickSubmit();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-retry', 'replacestate');
    consoleSpy.mockRestore();
  });

  it('no-ops when there is no public key', async () => {
    setValidRoute();
    mockPublicKey = null;
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('ignores a second submit while the first is still in flight', async () => {
    setValidRoute();
    const confirmD = deferred<boolean>();
    confirmMock.mockReturnValue(confirmD.promise);
    render(<ReviewTransaction />);
    await flush();

    // First click: sets isSubmitting, then awaits the pending confirmation.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    // Second click: guarded out because isSubmitting is now true.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    await act(async () => {
      confirmD.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(initiateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// E2E-only share-privately hook
// ---------------------------------------------------------------------------
describe('ReviewTransaction — E2E share-privately hook', () => {
  it('does not expose the setter outside the E2E harness', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();
    expect((globalThis as any).__TEST_SET_SHARE_PRIVATELY__).toBeUndefined();
  });

  it('exposes a setter that flips the send to PUBLIC, then cleans up on unmount', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    const setter = (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
    expect(typeof setter).toBe('function');

    await act(async () => {
      setter(false);
    });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();

    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'public', 12345n, 999, false);

    unmount();
    expect((globalThis as any).__TEST_SET_SHARE_PRIVATELY__).toBeUndefined();
  });
});
