import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { confirmSensitiveAction } from 'lib/biometric';
import { bridgeEpochSend } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import { deserializeError, serializeError } from 'lib/intercom/helpers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { goBack, navigate } from 'lib/woozie';
import { isValidMidenAddress } from 'utils/miden';

import { dateTimeToRecallBlocks } from './RecallCalendarDrawer';
import { ReviewTransaction } from './ReviewTransaction';
import { clearSendDraft } from './send-draft';
import { enterSendFlow, settleSendFlow } from './send-telemetry';

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
  assessSpendingLimit: jest.fn(),
  readSpendingLimit: jest.fn()
};

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock; step: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// RpcClient lives on the lazy SDK subpath (mapped to wasmMock, which has no
// RpcClient). Provide a controllable class + expose its header fn.
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

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
  NetworkLogo: ({ kind }: any) => <span data-testid="network-logo" data-kind={kind} />
}));

// Set by a test that needs the mock challenge to hand back an authorization for a DIFFERENT
// account than the one the challenge itself was opened for - a stale/forged credential, which the
// real `SpendingLimitChallenge` never produces (its authorization always carries the challenge's
// own `source.accountId`) but which `runSameChainSend`/`runBridgeSend` must independently refuse.
let mockAuthorizationAccountOverride: string | undefined;

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
    const source = props.assessment ?? props.unpriced;
    return (
      <div data-testid="spending-limit-challenge">
        <span>{source.revision}</span>
        <span data-testid="challenge-kind">{props.assessment !== undefined ? 'assessment' : 'unpriced'}</span>
        <button
          type="button"
          onClick={() =>
            props.onResult({
              kind: props.assessment !== undefined ? 'usd' : 'unpriced',
              id: 'authorization-1',
              accountId: mockAuthorizationAccountOverride ?? source.accountId,
              revision: source.revision,
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

// The Miden Name lookup and the network deployment check. By default the network
// has no deployment, so the suites above see the plain address behaviour.
let mockNameSupported = false;
const resolveMidenNameMock = jest.fn<Promise<string | null>, [string, { signal?: AbortSignal }?]>();
jest.mock('lib/miden/name/config', () => ({
  ...jest.requireActual('lib/miden/name/config'),
  isMidenNameSupported: () => mockNameSupported
}));
jest.mock('lib/miden/name/resolver', () => ({
  resolveMidenName: (label: string, options?: { signal?: AbortSignal }) => resolveMidenNameMock(label, options)
}));

// The real `./send-telemetry` is kept: this page settling the flow the send form
// began is the whole point of that module, so it must not be stubbed out.
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
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

const breachAssessment = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'pubkey-1',
  usdAmount: 12345n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: 200 },
  ...overrides
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  mockAuthorizationAccountOverride = undefined;

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
  mockWalletStoreState.readSpendingLimit.mockReset();
  mockWalletStoreState.readSpendingLimit.mockResolvedValue({
    accountId: 'pubkey-1',
    limit: 100_000_000n,
    revision: 'revision-1',
    createdAt: 1,
    updatedAt: 2
  });

  // Base route state.
  mockSearch = '';
  mockFullPage = false;
  mockPublicKey = 'pubkey-1';
  mockBalanceData = undefined;
  mockTokensMeta = [];
  mockDetectedChain = 'miden';
  mockEpochQuote = { amount: undefined, loading: false, error: null };
  mockNameSupported = false;

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
    // The network is a plain value with its mark, not a chip; the fee has no inline note.
    expect(screen.getByTestId('network-logo')).toHaveAttribute('data-kind', 'miden');
    expect(screen.queryByText('networkFeeEstimateNote')).not.toBeInTheDocument();
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
    // The reclaim reassurance is one caption under the card, not a note in the expiration row.
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());
    expect(screen.getByTestId('review-recall-note').textContent).toBe('recallReturnsNote');
    expect(screen.queryByTestId('row-note')).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', [
      { faucetId: 'tok1', amount: 12345n }
    ]);
    expect(confirmMock).toHaveBeenCalledWith('Confirm your send');
    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'private', 12345n, 999, false);
    expect(requestSWMock).not.toHaveBeenCalled();
    expect(clearSendDraftMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-abc', 'replacestate');
  });

  it('uses strict authentication instead of the ordinary confirmation for a spending-limit breach', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('assessment');
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
        revision: 'revision-1'
      })
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('discards an authorization for a different account instead of sending against it', async () => {
    // `SpendingLimitChallenge` always mints an authorization bound to the account its own
    // assessment named; this plants a forged/stale one directly to prove `runSameChainSend`
    // refuses it on its own, the same way the dApp custom-transaction gate refuses forged fields.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    mockAuthorizationAccountOverride = 'pubkey-someone-else';
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
  });

  it('opens the unvalued challenge when the pre-check cannot price the transaction', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(mockWalletStoreState.readSpendingLimit).toHaveBeenCalledWith('pubkey-1');
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('falls back to the generic error when the pre-check itself cannot open the unpriced challenge', async () => {
    // Distinct from the "no configured limit" fallback above: here `readSpendingLimit` fails
    // outright (a storage fault), reached from `onSubmit`'s OWN catch rather than
    // `runSameChainSend`'s - the pre-check throws before either send path is ever entered.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('opens the unvalued challenge when the actual send cannot be priced', async () => {
    setValidRoute();
    initiateMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('opens the unvalued challenge from a rejection that actually crossed the intercom port', async () => {
    // Unlike the raw-object rejections above (the in-process shape mobile/desktop reject with),
    // this is what the extension's popup <-> SW port actually delivers: the real `serializeError`
    // followed by the real `deserializeError`, round-tripping a price-unavailable refusal through
    // the intercom wire format rather than assuming it survives untouched.
    setValidRoute();
    initiateMock.mockRejectedValue(
      deserializeError(
        serializeError({
          message: 'No current price is available for MDN',
          code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
          symbol: 'MDN'
        })
      )
    );
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('re-enables the submit button when the drawer authorize path cannot open the unpriced challenge', async () => {
    // `handleSpendingLimitResult` fires `runSameChainSend(authorization)` without awaiting it and
    // with no catch of its own - unlike `onSubmit`, which has a surrounding catch that would mask
    // this. This is the one call path where a throw inside `openUnpricedChallenge` used to leave
    // the button disabled forever with no visible error.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    initiateMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('falls back to a generic error when the price-unavailable pre-check has no configured limit to read', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    mockWalletStoreState.readSpendingLimit.mockResolvedValue(undefined);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
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
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
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

  it('discards a bridge authorization for a different account instead of bridging against it', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    mockAuthorizationAccountOverride = 'pubkey-someone-else';
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
  });

  it('re-enables the bridge submit button when the drawer authorize path cannot open the unpriced challenge', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    initiateB2AggBridgeMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('stringifies a non-Error bridge rejection instead of showing an empty message', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue('bridge relay unreachable');
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('review-error')).toHaveTextContent('bridge relay unreachable');
  });

  it('shows a real Error bridge rejection by its own message', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue(new Error('bridge relay timed out'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('review-error')).toHaveTextContent('bridge relay timed out');
  });

  it('opens the unvalued challenge when the actual bridge send cannot be priced', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('keeps the ordinary confirmation and sends no authorization for a below-limit bridge', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', [
      { faucetId: 'tok1', amount: 12345n }
    ]);
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
    const firstAssessment = breachAssessment({
      breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null }
    });
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
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(
      breachAssessment({ breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null } })
    );
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
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(
      breachAssessment({ breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null } })
    );
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
    const firstAssessment = breachAssessment();
    const finalAssessment = {
      ...firstAssessment,
      revision: 'revision-2',
      assessedAt: 121,
      breach: { ...firstAssessment.breach, spent: 95n, proposedTotal: 12440n, overBy: 12340n }
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
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());

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

  it('closes an open spending-limit challenge when the active account changes underneath it', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    const view = render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockPublicKey = 'pubkey-2';
    await act(async () => view.rerender(<ReviewTransaction />));

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
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

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - which is the distinction a source match could
  // not make, and how a banner once shipped behind an early return.
  it('names the network it will commit on', () => {
    // Without params the screen redirects and renders nothing, so the params are the test.
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    render(<ReviewTransaction />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// `send` telemetry flow. This page owns the terminal call for a flow the send
// form (a separate React tree) began.
// ---------------------------------------------------------------------------
describe('ReviewTransaction — send telemetry', () => {
  /** Throwing accessor so a missing handle names how many flows were begun. */
  const handleAt = (index: number): TelemetryHandle => {
    const handle = telemetryHandles[index];
    if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
    return handle;
  };

  /** Everything this suite handed to telemetry, for the privacy assertions. */
  const telemetryPayload = () =>
    JSON.stringify({
      begun: beginFlowMock.mock.calls,
      settled: telemetryHandles.map(handle => [
        handle.complete.mock.calls,
        handle.cancel.mock.calls,
        handle.fail.mock.calls,
        handle.step.mock.calls
      ])
    });

  const clickSubmit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
  };

  beforeEach(() => {
    // The outer beforeEach resets every mock, implementations included.
    beginFlowMock.mockImplementation((_flow: string) => {
      const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
      telemetryHandles.push(handle);
      return handle;
    });
    classifyErrorMock.mockImplementation((_error: unknown) => 'rpc');
    // The handle is module-scoped by design; drop any a previous test left open.
    settleSendFlow(flow => flow.cancel());
    beginFlowMock.mockClear();
    classifyErrorMock.mockClear();
    telemetryHandles.length = 0;
  });

  it('completes the flow the send form began, without beginning a second one', async () => {
    enterSendFlow();
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('send');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('begins a flow for a submit reached without one (deep link into review)', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledWith('send');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('reports a broad error kind when transaction creation fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setValidRoute();
    initiateMock.mockRejectedValue(new Error('rpc error: node unreachable at mtst1recipient'));
    enterSendFlow();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    // The caught error is classified, never forwarded.
    expect(classifyErrorMock).toHaveBeenCalledWith(expect.any(Error));
    expect(telemetryPayload()).not.toContain('node unreachable');
    consoleSpy.mockRestore();
  });

  it('gives a retry after a failed submit its own flow', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setValidRoute();
    initiateMock.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('tx-retry');
    enterSendFlow();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('cancels an open flow when the user leaves review without submitting', async () => {
    enterSendFlow();
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    unmount();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves a settled flow alone on unmount, so a completed send is never re-reported', async () => {
    enterSendFlow();
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();
    await clickSubmit();

    unmount();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('does not begin a flow for a review page that only ever redirects', async () => {
    mockSearch = '';
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('redirect')).toBeInTheDocument();
    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('never passes the recipient address or the amount to telemetry', async () => {
    mockSearch = 'amount=4200&to=mtst1recipientaddress&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, balance: 10_000 }];
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('mtst1recipientaddress');
    expect(telemetryPayload()).not.toContain('4200');
    expect(telemetryPayload()).not.toContain('tok1');
  });

  it('never passes the recipient address or the amount to telemetry when the submit fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSearch = 'amount=4200&to=mtst1recipientaddress&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, balance: 10_000 }];
    initiateMock.mockRejectedValue(new Error('rpc down'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(handleAt(0).fail).toHaveBeenCalledTimes(1);
    expect(telemetryPayload()).not.toContain('mtst1recipientaddress');
    expect(telemetryPayload()).not.toContain('4200');
    expect(telemetryPayload()).not.toContain('tok1');
    consoleSpy.mockRestore();
  });

  it('leaves the flow open across a spending-limit challenge and completes it once authorized', async () => {
    enterSendFlow();
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).step).toHaveBeenCalledWith('submitting');
    expect(telemetryPayload()).not.toContain('0xrecipient');
    expect(telemetryPayload()).not.toContain('tok1');
  });

  it('does not settle when the send itself raises a spending-limit challenge', async () => {
    enterSendFlow();
    setValidRoute();
    const assessment = breachAssessment();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(assessment);
    initiateMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: { ...assessment, revision: 'revision-2', assessedAt: 121 }
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).step).toHaveBeenCalledWith('submitting');
  });

  it('does not settle when the user cancels confirmation', async () => {
    enterSendFlow();
    setValidRoute();
    confirmMock.mockResolvedValue(false);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Miden Name recipient (the `name` URL value)
// ---------------------------------------------------------------------------
describe('ReviewTransaction — Miden Name recipient', () => {
  let warnSpy: jest.SpyInstance;
  const clickSubmit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
  };

  beforeEach(() => {
    mockNameSupported = true;
    mockSearch = 'amount=5&to=mtst1alice&tokenId=tok1&name=alice.miden';
    mockBalanceData = [VALID_TOKEN];
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('shows the name above the address when a new lookup gives the same address', async () => {
    resolveMidenNameMock.mockResolvedValue('mtst1alice');
    render(<ReviewTransaction />);
    await flush();

    expect(resolveMidenNameMock).toHaveBeenCalledWith('alice', expect.objectContaining({ signal: expect.anything() }));
    expect(screen.getByTestId('review-recipient-name').textContent).toBe('alice.miden');
    expect(screen.getByText('mtst1alice')).toBeInTheDocument();
  });

  it('drops the name when the new lookup gives a different address', async () => {
    resolveMidenNameMock.mockResolvedValue('mtst1mallory');
    render(<ReviewTransaction />);
    await flush();

    expect(screen.queryByTestId('review-recipient-name')).not.toBeInTheDocument();
    expect(screen.getByText('mtst1alice')).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops the name when the name is not found or the lookup fails', async () => {
    resolveMidenNameMock.mockResolvedValueOnce(null);
    const first = render(<ReviewTransaction />);
    await flush();
    expect(screen.queryByTestId('review-recipient-name')).not.toBeInTheDocument();
    first.unmount();

    resolveMidenNameMock.mockRejectedValueOnce(new Error('rpc down'));
    render(<ReviewTransaction />);
    await flush();
    expect(screen.queryByTestId('review-recipient-name')).not.toBeInTheDocument();
  });

  it('drops the name without a lookup on a network without a deployment', async () => {
    mockNameSupported = false;
    render(<ReviewTransaction />);
    await flush();

    expect(resolveMidenNameMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('review-recipient-name')).not.toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does no lookup when there is no name', async () => {
    mockSearch = 'amount=5&to=mtst1alice&tokenId=tok1';
    render(<ReviewTransaction />);
    await flush();

    expect(resolveMidenNameMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('review-recipient-name')).not.toBeInTheDocument();
  });

  it('signs the `to` address, never the name', async () => {
    confirmMock.mockResolvedValue(true);
    resolveMidenNameMock.mockResolvedValue('mtst1alice');
    render(<ReviewTransaction />);
    await flush();
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());

    await clickSubmit();

    expect(initiateMock).toHaveBeenCalledWith(
      'pubkey-1',
      'mtst1alice',
      'tok1',
      'private',
      12345n,
      999,
      false,
      undefined,
      'alice.miden'
    );
  });
});
