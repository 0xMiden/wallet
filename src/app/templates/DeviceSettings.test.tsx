import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import DeviceSettings from './DeviceSettings';

const mockInitiate = jest.fn(async (..._args: (string | boolean | object)[]) => 'revocation-row');
const mockNavigate = jest.fn();
const mockConfirm = jest.fn(async () => true);
const otherDeviceCommitment = `0x${'2'.repeat(64)}`;
const mockDevices = [
  { commitment: `0x${'1'.repeat(64)}`, current: true },
  { commitment: otherDeviceCommitment, current: false }
];
const mockState = { currentAccount: { publicKey: 'account' }, seedPhraseStatus: 'stored' };

jest.mock('components/StrictActionAuthentication', () => ({
  StrictActionAuthentication: ({ onResult }: { onResult: (result: 'authenticated' | 'cancelled') => void }) => (
    <>
      <button onClick={() => onResult('authenticated')}>Authenticate</button>
      <button onClick={() => onResult('cancelled')}>Cancel authentication</button>
    </>
  )
}));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: typeof mockState) => T) => selector(mockState)
}));
jest.mock('lib/miden/front/useDeviceSigners', () => ({
  useDeviceSigners: () => ({ devices: mockDevices, failed: false })
}));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ signTransaction: jest.fn() }) }));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/miden/activity', () => ({
  initiateRevokeDeviceTransaction: (...args: string[]) => mockInitiate(...args),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn()
}));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => false }));
jest.mock('lib/platform', () => ({ isExtension: () => true, isMobile: () => false }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
jest.mock('lib/woozie', () => ({ navigate: (...args: string[]) => mockNavigate(...args) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  mockState.seedPhraseStatus = 'stored';
});

it('marks this device and offers revocation only for the other signer', () => {
  render(<DeviceSettings />);
  expect(screen.getByText('currentDevice')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'revokeDevice' })).toHaveLength(1);
  expect(screen.getByText('deviceRecoveryStored')).toBeInTheDocument();
});

it('explains the phrase prompt when the phrase is absent and queues the selected commitment', async () => {
  mockState.seedPhraseStatus = 'removed';
  render(<DeviceSettings />);
  expect(screen.getByText('deviceRecoveryRequired')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'revokeDevice' }));
  await screen.findByRole('button', { name: 'Authenticate' });
  expect(mockInitiate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
  await waitFor(() => expect(mockInitiate).toHaveBeenCalledWith('account', otherDeviceCommitment, false, {}));
  expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction-full/revocation-row');
});

it('does not submit when confirmation is cancelled', async () => {
  mockConfirm.mockResolvedValue(false);
  render(<DeviceSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'revokeDevice' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'revokeDevice' })).not.toBeDisabled());
  expect(mockInitiate).not.toHaveBeenCalled();
});

it('does not queue a revocation when authentication is cancelled', async () => {
  render(<DeviceSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'revokeDevice' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel authentication' }));
  expect(mockInitiate).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});
