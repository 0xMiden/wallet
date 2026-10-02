import React from 'react';

import { PrivateDataPermission, AllowedPrivateData } from '@miden-sdk/miden-wallet-adapter-base';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { expectDomainNeverClipped } from 'components/ui/dapp-origin-test-utils';
import { confirmSensitiveAction } from 'lib/biometric';
import type { DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { DELEGATE_PROOF_STORAGE_KEY } from 'lib/settings/constants';

import { DappConfirmationModal } from './DappConfirmationModal';

// The wallet-adapter package ships as ESM and is not transformed by jest, so the
// repo-level manual mock (`__mocks__/@miden-sdk/miden-wallet-adapter-base.ts`)
// stands in for it — but that stub exports `AllowedPrivateData` as `{}`, which
// makes every member `undefined`: the bit masking in `formatAllowedPrivateData`
// degrades to `NaN` and the `=== PrivateDataPermission.Auto` check degrades to
// `undefined === undefined`, i.e. always true. Restore the real values so these
// assertions describe production behaviour instead of the stub's.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

jest.mock('lib/animation', () => ({
  useSprings: () => ({ overlay: {}, modal: {}, reduceMotion: false })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: jest.fn()
}));

const mockWalletStoreState = { getStrictAuthenticationProtectors: jest.fn() };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockWalletStoreState) => unknown) => selector(mockWalletStoreState)
}));

jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  const passthrough = React.forwardRef(
    ({ children, ...rest }: { children?: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ref, ...rest }, children)
  );
  return { motion: new Proxy({}, { get: () => passthrough }) };
});

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {}
}));

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => (
    <div data-testid="spending-limit-challenge">
      <span>{props.assessment.revision}</span>
      <button type="button" onClick={() => props.onResult({ id: 'ui-only-authorization' })}>
        authenticate-limit
      </button>
      <button type="button" onClick={() => props.onResult(undefined)}>
        cancel-limit
      </button>
    </div>
  )
}));

const FULL_ACCOUNT_ID = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';

function buildRequest(overrides: Partial<DAppConfirmationRequest> = {}): DAppConfirmationRequest {
  return {
    id: 'req-1',
    type: 'connect',
    origin: 'https://faucet.testnet.miden.io',
    appMeta: { name: 'Miden Faucet' },
    network: 'testnet',
    networkRpc: 'https://rpc.testnet.miden.io',
    privateDataPermission: PrivateDataPermission.UponRequest,
    allowedPrivateData: AllowedPrivateData.None,
    existingPermission: false,
    ...overrides
  } as DAppConfirmationRequest;
}

/** A connect request asking for standing (`Auto`) access to private notes. */
const autoRequest = () =>
  buildRequest({
    privateDataPermission: PrivateDataPermission.Auto,
    allowedPrivateData: AllowedPrivateData.Notes | AllowedPrivateData.Assets
  });

const limitedTransactionRequest = () =>
  buildRequest({
    type: 'transaction',
    sourcePublicKey: FULL_ACCOUNT_ID,
    transactionMessages: ['Send 5 MIDEN'],
    spendingLimitAssessment: {
      accountId: FULL_ACCOUNT_ID,
      usdAmount: 5_000_000n,
      revision: 'revision-1',
      assessedAt: 100,
      breach: { spent: 8_000_000n, proposedTotal: 13_000_000n, limit: 10_000_000n, overBy: 3_000_000n, resetAt: 200 }
    }
  });

/** A transaction request within the spending limit, so Approve reaches the biometric gate. */
const plainTransactionRequest = () =>
  buildRequest({
    type: 'transaction',
    sourcePublicKey: FULL_ACCOUNT_ID,
    transactionMessages: ['Send 5 MIDEN']
  });

const confirmMock = confirmSensitiveAction as jest.Mock;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('DappConfirmationModal', () => {
  // Regression: previously the modal received an already-truncated string
  // and echoed it back as the canonical accountPublicKey. The backend then
  // tried to bech32-decode "mtst1aps...wr6w" and threw "invalid character
  // (code=.)", which surfaced to the dApp as NOT_GRANTED after the user
  // had successfully tapped Approve. The fix passes the FULL accountId
  // into the modal and truncates only for display.
  it('echoes the FULL accountId to onResolve on Approve (no "..." truncation in the wire value)', () => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    expect(onResolve).toHaveBeenCalledTimes(1);
    const arg = onResolve.mock.calls[0]![0];
    expect(arg.confirmed).toBe(true);
    expect(arg.accountPublicKey).toBe(FULL_ACCOUNT_ID);
    expect(arg.accountPublicKey).not.toMatch(/\.\.\./);
  });

  it('registers its back handler in the overlay tier, ahead of the browser page', () => {
    render(<DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);

    expect(useMobileBackHandler).toHaveBeenCalledWith(expect.any(Function), [], { overlay: true });
  });

  it('does not allow Approve when accountId is null', () => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={buildRequest()} accountId={null} onResolve={onResolve} />);

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    expect(onResolve).not.toHaveBeenCalled();
  });

  // The connect prompt used to render only app name, origin, account and
  // network — never the private-data scope — and then echoed the dApp's
  // requested `Auto` permission straight back, granting standing access to
  // private notes / balances that the user was never shown.
  it('discloses a requested standing private-data scope on the connect prompt', () => {
    render(<DappConfirmationModal request={autoRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);

    const scope = screen.getByTestId('private-data-scope');
    expect(scope.textContent).toContain('privateDataAccessAuto');
    expect(scope.textContent).toContain('accessWillBeGranted');
    expect(scope.textContent).toContain('Assets, Notes');
    expect(screen.getByLabelText('confirmRisk')).toBeInTheDocument();
  });

  it('downgrades an unacknowledged Auto request to UponRequest on Approve', () => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={autoRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onResolve.mock.calls[0]![0].privateDataPermission).toBe(PrivateDataPermission.UponRequest);
  });

  it('grants Auto only after the risk box is ticked', () => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={autoRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    fireEvent.click(screen.getByLabelText('confirmRisk'));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onResolve.mock.calls[0]![0].privateDataPermission).toBe(PrivateDataPermission.Auto);
  });

  it('shows the upon-request scope (and no risk box) when standing access is not requested', () => {
    render(<DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);

    const scope = screen.getByTestId('private-data-scope');
    expect(scope.textContent).toContain('privateDataAccessUponRequest');
    expect(scope.textContent).toContain('confirmationRequired');
    expect(screen.queryByLabelText('confirmRisk')).toBeNull();
  });

  it('renders no private-data scope box for a transaction confirmation', () => {
    render(
      <DappConfirmationModal
        request={buildRequest({ type: 'transaction', transactionMessages: ['Send 5 MIDEN'] })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    expect(screen.queryByTestId('private-data-scope')).toBeNull();
  });

  // The backend used to hard-code delegated proving for every mobile dApp
  // write, silently overriding a user who had turned the setting off.
  it("carries the user's Delegated-proving setting on Approve", () => {
    localStorage.setItem(DELEGATE_PROOF_STORAGE_KEY, 'false');
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onResolve.mock.calls[0]![0].delegate).toBe(false);
    localStorage.removeItem(DELEGATE_PROOF_STORAGE_KEY);
  });

  it('does not resolve an over-limit approval until strict authentication succeeds', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={limitedTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-1');
    expect(onResolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'authenticate-limit' }));

    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, spendingLimitAuthenticated: true })
    );
    expect(onResolve.mock.calls[0]![0]).not.toHaveProperty('spendingLimitAuthorization');
  });

  it('denies an over-limit request when strict authentication is cancelled', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={limitedTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));

    expect(onResolve).toHaveBeenCalledWith({ confirmed: false });
  });

  it('resolves only once when a strict-authentication completion is delivered twice', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={limitedTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    const authenticate = screen.getByRole('button', { name: 'authenticate-limit' });
    fireEvent.click(authenticate);
    fireEvent.click(authenticate);

    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('denies a transaction when the active account changed while the request was open', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={limitedTransactionRequest()} accountId="mtst1different" onResolve={onResolve} />
    );

    expect(onResolve).toHaveBeenCalledWith({ confirmed: false });
  });
});

describe('DappConfirmationModal - dApp transaction biometric confirmation', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    mockWalletStoreState.getStrictAuthenticationProtectors.mockReset();
    mockWalletStoreState.getStrictAuthenticationProtectors.mockResolvedValue({ hardware: false, password: true });
  });

  it("confirms with the dApp-transaction reason and a probe wired to the store's protector check", async () => {
    mockWalletStoreState.getStrictAuthenticationProtectors.mockResolvedValue({ hardware: true, password: false });
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledWith('confirmDappTransactionReason', expect.any(Function));
    const probe = confirmMock.mock.calls[0]![1];
    await expect(probe()).resolves.toBe(true);
  });

  it('resolves the request once the prompt succeeds', async () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, accountPublicKey: FULL_ACCOUNT_ID })
    );
  });

  it('does not resolve when the prompt is declined, and allows a later attempt to succeed', async () => {
    confirmMock.mockResolvedValue(false);
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();

    expect(onResolve).not.toHaveBeenCalled();

    confirmMock.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('does not start a second prompt or resolve twice from a second tap while the first is pending', async () => {
    let releaseConfirm: (confirmed: boolean) => void = () => {};
    confirmMock.mockReturnValue(
      new Promise<boolean>(resolve => {
        releaseConfirm = resolve;
      })
    );
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });

    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseConfirm(true);
    });
    await flush();

    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('does not resolve, logs the error, and leaves the modal approvable again when the prompt rejects', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    confirmMock.mockRejectedValueOnce(new Error('protector check failed'));
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();

    expect(onResolve).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));

    confirmMock.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();

    expect(onResolve).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('never resolves a stale approval superseded by a new request, and still resolves the new one normally', async () => {
    const requestA = plainTransactionRequest();
    const requestB = buildRequest({
      id: 'req-2',
      type: 'transaction',
      sourcePublicKey: FULL_ACCOUNT_ID,
      transactionMessages: ['Send 2 MIDEN']
    });
    let releaseA: (confirmed: boolean) => void = () => {};
    confirmMock.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        releaseA = resolve;
      })
    );
    const onResolve = jest.fn();
    const { rerender } = render(
      <DappConfirmationModal request={requestA} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);

    rerender(<DappConfirmationModal request={requestB} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    await act(async () => {
      releaseA(true);
    });
    await flush();

    expect(onResolve).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(confirmMock.mock.calls[1]![0]).toBe('confirmDappTransactionReason');
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
  });

  it('never resolves an approval once the modal has unmounted', async () => {
    let release: (confirmed: boolean) => void = () => {};
    confirmMock.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        release = resolve;
      })
    );
    const onResolve = jest.fn();
    const { unmount } = render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      release(true);
    });
    await flush();

    expect(onResolve).not.toHaveBeenCalled();
  });

  it.each([
    ['connect', buildRequest()],
    ['sign', buildRequest({ type: 'sign' })]
  ] as const)('resolves a %s request without calling confirmSensitiveAction', async (_label, request) => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={request} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve|confirm/i }));
    });
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('opens the spending-limit challenge without calling confirmSensitiveAction', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal request={limitedTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe('DappConfirmationModal origin', () => {
  const LONG_ORIGIN = 'https://login.secure.account-verify.wallet.example.co.uk';

  it('keeps the registrable domain of a long origin out of the truncating part', () => {
    render(
      <DappConfirmationModal
        request={buildRequest({ origin: LONG_ORIGIN })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    const shown = within(screen.getByRole('heading', { level: 2 })).getByTestId('dapp-confirmation-origin');
    expect(shown.textContent).toBe(LONG_ORIGIN);
    const domain = within(shown).getByTestId('dapp-origin-domain');
    expect(domain).toHaveTextContent(/^example\.co\.uk$/);
    expect(within(shown).getByTestId('dapp-origin-lead')).toHaveClass('truncate');
    // The row directly wrapping DappOrigin, not the modal card: the card's own
    // overflow-hidden is an unrelated rounded-corner clip (no fixed height, so it
    // never clips text) and would otherwise make this guard fail on every render.
    expectDomainNeverClipped(domain, shown.parentElement!);
  });

  it('shows the origin the same way in the title when the dApp sends no name', () => {
    render(
      <DappConfirmationModal
        request={buildRequest({ origin: LONG_ORIGIN, appMeta: undefined })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    const title = screen.getByRole('heading', { level: 2 });
    expect(title.textContent).toBe(LONG_ORIGIN);
    expect(title).not.toHaveClass('truncate');
    expect(within(title).getByTestId('dapp-origin-domain')).toHaveTextContent(/^example\.co\.uk$/);
  });

  // The injected providers send only the page's hostname as the name, so any other name was forged
  // by the page and must not become the title or the dialog's accessible name.
  it('titles the dialog with the origin, never a name the dApp sent', () => {
    render(
      <DappConfirmationModal
        request={buildRequest({ origin: 'https://evil.io', appMeta: { name: 'wallet.example.co.uk' } })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('https://evil.io');
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/evil\.io/);
    expect(screen.getByRole('dialog')).not.toHaveAccessibleName(/example\.co\.uk/);
  });
});
