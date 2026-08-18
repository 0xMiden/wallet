import React from 'react';

import { PrivateDataPermission, AllowedPrivateData } from '@demox-labs/miden-wallet-adapter-base';
import { fireEvent, render, screen } from '@testing-library/react';

import type { DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';
import { DELEGATE_PROOF_STORAGE_KEY } from 'lib/settings/constants';

import { DappConfirmationModal } from './DappConfirmationModal';

// The wallet-adapter package ships as ESM and is not transformed by jest, so the
// repo-level manual mock (`__mocks__/@demox-labs/miden-wallet-adapter-base.ts`)
// stands in for it — but that stub exports `AllowedPrivateData` as `{}`, which
// makes every member `undefined`: the bit masking in `formatAllowedPrivateData`
// degrades to `NaN` and the `=== PrivateDataPermission.Auto` check degrades to
// `undefined === undefined`, i.e. always true. Restore the real values so these
// assertions describe production behaviour instead of the stub's.
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
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
  useMobileBackHandler: () => undefined
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
});
