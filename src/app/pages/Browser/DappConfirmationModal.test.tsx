import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { PrivateDataPermission, AllowedPrivateData } from '@demox-labs/miden-wallet-adapter-base';
import type { DAppConfirmationRequest } from 'lib/dapp-browser/confirmation-store';

import { DappConfirmationModal } from './DappConfirmationModal';

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
  const passthrough = React.forwardRef(({ children, ...rest }: { children?: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
    React.createElement('div', { ref, ...rest }, children)
  );
  return { motion: new Proxy({}, { get: () => passthrough }) };
});

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {}
}));

const FULL_ACCOUNT_ID = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';

function buildRequest(): DAppConfirmationRequest {
  return {
    id: 'req-1',
    type: 'connect',
    origin: 'https://faucet.testnet.miden.io',
    appMeta: { name: 'Miden Faucet' },
    network: 'testnet',
    networkRpc: 'https://rpc.testnet.miden.io',
    privateDataPermission: PrivateDataPermission.UponRequest,
    allowedPrivateData: AllowedPrivateData.None,
    existingPermission: false
  } as DAppConfirmationRequest;
}

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
});
