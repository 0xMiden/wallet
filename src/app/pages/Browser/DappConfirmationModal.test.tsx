import React, { useLayoutEffect } from 'react';

import { PrivateDataPermission, AllowedPrivateData } from '@miden-sdk/miden-wallet-adapter-base';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { expectDomainNeverClipped } from 'components/ui/dapp-origin-test-utils';
import { confirmSensitiveAction } from 'lib/biometric';
import {
  dappConfirmationStore,
  type DAppConfirmationRequest,
  type DAppLoginSignConfirmationRequest
} from 'lib/dapp-browser/confirmation-store';
import { useDappConfirmation } from 'lib/dapp-browser/use-dapp-confirmation';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { DELEGATE_PROOF_STORAGE_KEY } from 'lib/settings/constants';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { truncateAddress } from 'utils/string';

import { DappConfirmationModal } from './DappConfirmationModal';

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

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
  // Interpolated values follow the key, so a line that names its networks can be read.
  useTranslation: () => ({
    t: (k: string, values?: Record<string, string>) => (values ? `${k}:${Object.values(values).join(',')}` : k)
  })
}));

// The build's network unless a case puts the wallet on another.
let mockWalletNetwork: MIDEN_NETWORK_NAME | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return { ...actual, getEffectiveNetworkName: () => mockWalletNetwork ?? actual.getEffectiveNetworkName() };
});

jest.mock('lib/animation', () => ({
  installSheetKeyframes: () => {},
  sheetMotionVars: {},
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

jest.mock('lib/miden/back/protector-probe', () => ({
  probeHardwareProtector: jest.fn()
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

jest.mock('components/SpendingLimitChallenge', () => {
  const { Drawer, DrawerContent, DrawerTitle } = jest.requireActual('lib/ui/drawer');
  return {
    SpendingLimitChallenge: (props: any) => (
      <Drawer open onOpenChange={(open: boolean) => !open && props.onResult(undefined)}>
        <DrawerContent data-testid="spending-limit-challenge">
          <DrawerTitle>Challenge</DrawerTitle>
          <span>{props.assessment.revision}</span>
          <button type="button" onClick={() => props.onResult({ id: 'ui-only-authorization' })}>
            authenticate-limit
          </button>
          <button type="button" onClick={() => props.onResult(undefined)}>
            cancel-limit
          </button>
        </DrawerContent>
      </Drawer>
    )
  };
});

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

it('shows the verified custom transaction note flow in the mobile and desktop modal', () => {
  render(
    <DappConfirmationModal
      request={buildRequest({
        type: 'transaction',
        transactionMessages: ['Simulated effects:'],
        sourcePublicKey: FULL_ACCOUNT_ID,
        noteFlow: {
          inputCount: 0,
          inputs: [],
          outputs: [{ id: 'note-1', kind: 'P2ID', visibility: 'public', assets: [] }]
        }
      })}
      accountId={FULL_ACCOUNT_ID}
      onResolve={jest.fn()}
    />
  );
  expect(screen.getByTestId('tx-note-flow')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'showNotes' }));
  expect(screen.getByText('noInputNotes')).toBeInTheDocument();
  expect(screen.getByText('P2ID')).toBeInTheDocument();
});

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

  // Both render sites reuse one modal instance across requests, so a tick on one
  // standing-access request must not grant the next one without its own gesture.
  it('does not carry a ticked risk box over to the next request shown', () => {
    const onResolve = jest.fn();
    const { rerender } = render(
      <DappConfirmationModal request={autoRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );
    fireEvent.click(screen.getByLabelText('confirmRisk'));

    const next = { ...autoRequest(), id: 'req-2', origin: 'https://other.example' };
    rerender(<DappConfirmationModal request={next} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);
    expect(screen.getByLabelText('confirmRisk')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onResolve.mock.calls[0]![0].privateDataPermission).toBe(PrivateDataPermission.UponRequest);
    expect(onResolve.mock.calls[0]![1]).toBe('req-2');
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
      expect.objectContaining({ confirmed: true, spendingLimitAuthenticated: true }),
      'req-1'
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

    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
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

    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
  });

  // Escape and the back handler register once, at mount, so they must still deny the request shown now.
  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    [
      'the back handler',
      () => {
        const [backHandler] = jest.mocked(useMobileBackHandler).mock.calls[0]!;
        act(() => {
          backHandler();
        });
      }
    ]
  ] as const)('denies the request on screen from %s after the request changed', (_label, deny) => {
    jest.mocked(useMobileBackHandler).mockClear();
    const onResolve = jest.fn();
    const { rerender } = render(
      <DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />
    );
    rerender(
      <DappConfirmationModal
        request={buildRequest({ id: 'req-2' })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={onResolve}
      />
    );

    deny();

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-2');
  });
});

describe('DappConfirmationModal - dApp transaction biometric confirmation', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it('confirms with the dApp-transaction reason and the shared hardware-only protector probe', async () => {
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledWith('confirmDappTransactionReason', probeHardwareProtector);
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
      expect.objectContaining({ confirmed: true, accountPublicKey: FULL_ACCOUNT_ID }),
      'req-1'
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

  it('does not resolve, logs and shows the error, and leaves the modal approvable again when the prompt rejects', async () => {
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
    expect(screen.getByTestId('dapp-approval-error')).toHaveTextContent('protector check failed');
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1050));
    });
    expect(reportUserVisibleError).toHaveBeenCalledWith('raw_dapp_approval_failed', 'inline');

    confirmMock.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();

    expect(onResolve).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('shows a generic error when the prompt rejects with no message', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    confirmMock.mockRejectedValueOnce(new Error(''));
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();

    expect(screen.getByTestId('dapp-approval-error')).toHaveTextContent('smthWentWrong');
    consoleSpy.mockRestore();
  });

  it('clears the error as soon as Approve is tapped again, before the next prompt settles', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    confirmMock.mockRejectedValueOnce(new Error('protector check failed'));
    render(
      <DappConfirmationModal request={plainTransactionRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await flush();
    expect(screen.getByTestId('dapp-approval-error')).toBeInTheDocument();

    let release: (confirmed: boolean) => void = () => {};
    confirmMock.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        release = resolve;
      })
    );
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('dapp-approval-error')).toBeNull();

    await act(async () => {
      release(false);
    });
    consoleSpy.mockRestore();
  });

  it('clears the error when the request changes, so it is gone on coming back to that request', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    confirmMock.mockRejectedValueOnce(new Error('protector check failed'));
    const requestA = plainTransactionRequest();
    const requestB = buildRequest({ id: 'req-2' });
    const { rerender } = render(
      <DappConfirmationModal request={requestA} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    await flush();
    expect(screen.getByTestId('dapp-approval-error')).toBeInTheDocument();

    rerender(<DappConfirmationModal request={requestB} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);
    expect(screen.queryByTestId('dapp-approval-error')).toBeNull();

    rerender(<DappConfirmationModal request={requestA} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);
    expect(screen.queryByTestId('dapp-approval-error')).toBeNull();
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
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }), 'req-2');
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

/** Records a promise's result without awaiting it, so a test can assert that it is still pending. */
function track<T>(promise: Promise<T>): { result?: T } {
  const tracked: { result?: T } = {};
  void promise.then(result => {
    tracked.result = result;
  });
  return tracked;
}

function StoreHarness() {
  const { request, resolve } = useDappConfirmation('s1');
  return request ? <DappConfirmationModal request={request} accountId={FULL_ACCOUNT_ID} onResolve={resolve} /> : null;
}

// With the real store and hook, `requestConfirmation` replaces a pending entry before React re-renders,
// so a decision made on the replaced request's render must not resolve its replacement.
describe('DappConfirmationModal - resolving through the store', () => {
  const sessionTransaction = (id: string) =>
    buildRequest({
      id,
      sessionId: 's1',
      type: 'transaction',
      sourcePublicKey: FULL_ACCOUNT_ID,
      transactionMessages: [`Send from ${id}`]
    });

  beforeEach(() => {
    confirmMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const pending of dappConfirmationStore.getAllPendingRequests()) {
        dappConfirmationStore.resolveConfirmation(pending.sessionId, { confirmed: false });
      }
    });
  });

  it('leaves the replacing request pending when the prompt opened for the replaced one succeeds', async () => {
    let releaseA: (confirmed: boolean) => void = () => {};
    confirmMock.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        releaseA = resolve;
      })
    );
    const first = track(dappConfirmationStore.requestConfirmation(sessionTransaction('req-1')));
    render(<StoreHarness />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);

    // Outside act and released before any act runs, so A's approval lands before React renders B.
    const second = track(dappConfirmationStore.requestConfirmation(sessionTransaction('req-2')));
    releaseA(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await flush();

    expect(second.result).toBeUndefined();
    expect(first.result).toEqual({ confirmed: false });
  });

  it("never shows the replaced request's prompt failure on the request that replaced it", async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let rejectA: (error: Error) => void = () => {};
    confirmMock.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectA = reject;
      })
    );
    // Read in the commit that first shows each request, before its effects run.
    const shownWithError: string[] = [];
    function ProbedHarness() {
      const { request, resolve } = useDappConfirmation('s1');
      useLayoutEffect(() => {
        if (request && document.querySelector('[data-testid="dapp-approval-error"]')) shownWithError.push(request.id);
      });
      return request ? (
        <DappConfirmationModal request={request} accountId={FULL_ACCOUNT_ID} onResolve={resolve} />
      ) : null;
    }
    void dappConfirmationStore.requestConfirmation(sessionTransaction('req-1'));
    render(<ProbedHarness />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    });

    void dappConfirmationStore.requestConfirmation(sessionTransaction('req-2'));
    rejectA(new Error('protector check failed'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() => expect(screen.getByText('Send from req-2')).toBeInTheDocument());

    expect(screen.queryByTestId('dapp-approval-error')).toBeNull();
    expect(shownWithError).toEqual([]);
    consoleSpy.mockRestore();
  });

  it('leaves the replacing request pending when Deny is tapped on the replaced one', async () => {
    const first = track(dappConfirmationStore.requestConfirmation(sessionTransaction('req-1')));
    render(<StoreHarness />);

    const second = track(dappConfirmationStore.requestConfirmation(sessionTransaction('req-2')));
    fireEvent.click(screen.getByRole('button', { name: 'deny' }));
    await flush();

    expect(second.result).toBeUndefined();
    expect(first.result).toEqual({ confirmed: false });
  });
});

describe('DappConfirmationModal - a connect asked again after its key read failed (#1471)', () => {
  const askedAgain = (previousAttemptError: string) => Object.assign(buildRequest(), { previousAttemptError });

  it.each([
    ["the read's error", 'Account not found', 'Account not found'],
    ['a generic error for a read with no message', '', 'smthWentWrong']
  ])('shows %s, and its Retry approves the request', (_label, previousAttemptError, shown) => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal
        request={askedAgain(previousAttemptError)}
        accountId={FULL_ACCOUNT_ID}
        onResolve={onResolve}
      />
    );

    expect(screen.getByTestId('dapp-approval-error')).toHaveTextContent(shown);
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, accountPublicKey: FULL_ACCOUNT_ID }),
      'req-1'
    );
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
    // Check the title row: the card's rounded-corner clip also contains the scrollable request body.
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

describe('DappConfirmationModal network', () => {
  afterEach(() => {
    mockWalletNetwork = undefined;
  });

  // dApps on the adapter's defaults claim testnet, so the claim is no guide to where the request runs.
  it.each<[string, DAppConfirmationRequest]>([
    ['connect', buildRequest({ network: 'testnet' })],
    ['send', { ...plainTransactionRequest(), network: 'testnet' }]
  ])("names the wallet's own network on the %s sheet, not the dApp's claim", (_kind, request) => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    render(<DappConfirmationModal request={request} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);

    expect(screen.getByTestId('dapp-confirmation-network')).toHaveTextContent(/^mainnet$/);
  });

  it('warns on a connect that claims another network, naming both', () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    render(
      <DappConfirmationModal
        request={buildRequest({ network: 'testnet' })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    expect(screen.getByTestId('dapp-network-mismatch')).toHaveTextContent('dappNetworkMismatch:testnet,mainnet');
  });

  it('keeps the warning to the connect sheet', () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    render(
      <DappConfirmationModal
        request={{ ...plainTransactionRequest(), network: 'testnet' }}
        accountId={FULL_ACCOUNT_ID}
        onResolve={jest.fn()}
      />
    );

    expect(screen.getByTestId('dapp-confirmation-network')).toBeInTheDocument();
    expect(screen.queryByTestId('dapp-network-mismatch')).not.toBeInTheDocument();
  });

  it.each<[string, string | undefined]>([
    ['claims the network the wallet is on', MIDEN_NETWORK_NAME.MAINNET],
    ['claims no network', undefined]
  ])('does not warn when the dApp %s', (_label, network) => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    render(
      <DappConfirmationModal request={buildRequest({ network })} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />
    );

    expect(screen.queryByTestId('dapp-network-mismatch')).not.toBeInTheDocument();
  });
});

describe('DappConfirmationModal test ids', () => {
  // The mobile dApp E2E driver (playwright/e2e/helpers/dapp-mobile-sheet.ts) finds the sheet from its origin and reads
  // these ids; a renamed one leaves every mobile cell waiting on a sheet it cannot see.
  it('marks every message line, Deny and Approve inside the dialog its origin titles', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal
        request={buildRequest({
          type: 'transaction',
          sourcePublicKey: FULL_ACCOUNT_ID,
          transactionMessages: ['Simulated effects:', 'Notes created, 1']
        })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={onResolve}
      />
    );
    const dialog = screen.getByTestId('dapp-confirmation-origin').closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error('the origin is not inside a dialog');
    const sheet = within(dialog);
    expect(sheet.getAllByTestId('dapp-confirmation-message').map(line => line.textContent)).toEqual([
      'Simulated effects:',
      'Notes created, 1'
    ]);
    expect(sheet.getByTestId('dapp-confirmation-approve').textContent).toBe('confirm');
    fireEvent.click(sheet.getByTestId('dapp-confirmation-deny'));
    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
  });

  it('approves a connect through the Approve test id', () => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={buildRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);
    fireEvent.click(screen.getByTestId('dapp-confirmation-approve'));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }), 'req-1');
  });
});

describe('DappConfirmationModal - a login signature', () => {
  const LOGIN_ACCOUNT_ID = 'mtst1azcw08rget79fqp8ymr0zqkv5v4lj3s7_qruqqypuyph';
  const OPAQUE_ROW = 'Warning, this site asked you to sign a value the wallet cannot decode.';
  const loginRequest = (overrides: Partial<DAppLoginSignConfirmationRequest> = {}) =>
    buildRequest({
      type: 'loginSign',
      origin: 'https://example.org',
      appMeta: { name: 'example.org' },
      domain: 'example.org',
      accountId: LOGIN_ACCOUNT_ID,
      transactionMessages: ['Kind, word', OPAQUE_ROW],
      ...overrides
    });

  beforeEach(() => {
    confirmMock.mockReset();
  });

  it("names the site and shows the request's account, with no detail rows", () => {
    render(<DappConfirmationModal request={loginRequest()} accountId={FULL_ACCOUNT_ID} onResolve={jest.fn()} />);

    expect(screen.getByText('dappLoginSignRequest:example.org')).toBeInTheDocument();
    expect(screen.getByText('loginSignatureNote:example.org')).toBeInTheDocument();
    expect(screen.getByText(truncateAddress(LOGIN_ACCOUNT_ID))).toBeInTheDocument();
    expect(screen.queryByText(truncateAddress(FULL_ACCOUNT_ID))).not.toBeInTheDocument();
    expect(screen.queryByText(OPAQUE_ROW)).not.toBeInTheDocument();
    expect(screen.queryByText('Kind, word')).not.toBeInTheDocument();
  });

  // Approve reports the account the sheet shows, not the wallet's selected one.
  it.each([
    ['Approve', /approve/i, { confirmed: true, accountPublicKey: LOGIN_ACCOUNT_ID }],
    ['Deny', /deny/i, { confirmed: false }]
  ] as const)('settles a login from %s, with no biometric prompt', (_label, name, result) => {
    const onResolve = jest.fn();
    render(<DappConfirmationModal request={loginRequest()} accountId={FULL_ACCOUNT_ID} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name }));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining(result), 'req-1');
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('cannot approve a login that names no account, and Deny still settles it', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal
        request={loginRequest({ accountId: undefined })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={onResolve}
      />
    );

    expect(screen.getByText('noAccountSelected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onResolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
  });

  it('cannot approve a login that names no site, and Deny still settles it', () => {
    const onResolve = jest.fn();
    render(
      <DappConfirmationModal
        request={loginRequest({ domain: undefined })}
        accountId={FULL_ACCOUNT_ID}
        onResolve={onResolve}
      />
    );

    expect(screen.getByText(truncateAddress(LOGIN_ACCOUNT_ID))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onResolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({ confirmed: false }, 'req-1');
  });
});
