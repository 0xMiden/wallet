import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { confirmSensitiveAction } from 'lib/biometric';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSpeculateInvalidate,
  requestSWTransactionProcessing
} from 'lib/miden/activity';
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
  setLastCompletedTxHash: jest.fn()
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

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title, onBack, backLabel }: any) => (
    <div data-testid="screen-header">
      <span>{title}</span>
      <button data-testid="back-btn" aria-label={backLabel} onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('components/review', () => ({
  ReviewAmount: ({ symbol, amount, label }: any) => (
    <div data-testid="review-amount">
      {label}|{amount}|{symbol}
    </div>
  ),
  ReviewLayout: ({ hero, children, primary, error }: any) => (
    <div data-testid="review-layout">
      <div data-testid="hero">{hero}</div>
      <div data-testid="rows">{children}</div>
      <button data-testid={primary['data-testid']} onClick={primary.onPress} disabled={primary.disabled}>
        {primary.label}
      </button>
      {error !== undefined && <div data-testid="review-error">{error}</div>}
    </div>
  ),
  ReviewRow: ({ label, value, children, onEdit, editLabel, note }: any) => (
    <div data-testid="review-row">
      <span data-testid="row-label">{label}</span>
      {value !== undefined && <span data-testid="row-value">{value}</span>}
      {children !== undefined && <span data-testid="row-children">{children}</span>}
      {onEdit && (
        <button data-testid="row-edit" onClick={onEdit}>
          {editLabel}
        </button>
      )}
      {note !== undefined && <span data-testid="row-note">{note}</span>}
    </div>
  )
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: jest.fn()
}));

jest.mock('lib/agglayer/b2agg', () => ({
  initiateB2AggBridge: jest.fn()
}));

jest.mock('lib/agglayer/b2agg/constant', () => ({
  EVM_AGGLAYER_NETWORK_ID: 11155111,
  MIDEN_AGGLAYER_FAUCET_ID: 'agglayer-faucet',
  getAgglayerFaucetId: () => 'agglayer-faucet'
}));

jest.mock('lib/epoch', () => ({
  bridgeEpochSend: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  initiateSendTransaction: jest.fn(),
  requestSpeculateInvalidate: jest.fn(),
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
  accountIdStringToSdk: () => ({ toString: () => 'sdk-faucet' }),
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
const stringToBigIntMock = stringToBigInt as jest.Mock;
const initiateMock = initiateSendTransaction as jest.Mock;
const requestSpeculateInvalidateMock = requestSpeculateInvalidate as jest.Mock;
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
  dateTimeToRecallBlocksMock.mockReturnValue(999);
  isExtensionMock.mockReturnValue(false);
  isDelegateProofEnabledMock.mockReturnValue(false);
  isValidMidenAddressMock.mockReturnValue(true);
  mockWalletStoreState.setLastCompletedTxHash.mockReset();

  // Base route state.
  mockSearch = '';
  mockFullPage = false;
  mockPublicKey = 'pubkey-1';
  mockBalanceData = undefined;
  mockTokensMeta = [];
  mockDetectedChain = 'miden';
  mockEpochQuote = { amount: undefined, loading: false, error: null };

  delete process.env.MIDEN_E2E_TEST;
  delete process.env.MIDEN_USE_SPECULATIVE_PROVING;
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

    expect(screen.getByTestId('screen-header')).toBeInTheDocument();
    expect(screen.getByTestId('review-amount').textContent).toBe('youAreSending|5|MDN');
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

    expect(screen.getByTestId('review-amount').textContent).toBe('youAreSending|5|');

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
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
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

    expect(confirmMock).toHaveBeenCalledWith('Confirm your send');
    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'private', 12345n, 999, false);
    expect(requestSWMock).not.toHaveBeenCalled();
    expect(clearSendDraftMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-abc', 'replacestate');
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

// ---------------------------------------------------------------------------
// Speculative-proving invalidation cleanup
// ---------------------------------------------------------------------------
describe('ReviewTransaction — speculative proving cleanup', () => {
  it('invalidates cached speculation on unmount when enabled on extension', async () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(true);
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
    unmount();
    expect(requestSpeculateInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate on unmount when not on an extension', async () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(false);
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    unmount();
    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
  });

  it('does not invalidate on unmount when the flag is off', async () => {
    isExtensionMock.mockReturnValue(true);
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    unmount();
    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `send` telemetry flow — this page owns the terminal call for a flow the send
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
        handle.fail.mock.calls
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
});
