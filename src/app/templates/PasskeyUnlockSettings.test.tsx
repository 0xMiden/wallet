import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { createPlatformCredential } from 'lib/platform-auth/webauthn';
import type {
  PlatformCredentialMetadata,
  PlatformUnlockCommand,
  PlatformUnlockResult,
  PlatformUnlockState
} from 'lib/platform-auth/types';

import PasskeyUnlockSettings from './PasskeyUnlockSettings';

let mockSidePanel = true;
let mockConfirmWindow = false;
const created: PlatformCredentialMetadata = { credentialId: 'BQYHCA', prfSalt: 'A'.repeat(43), backupEligible: true };
const previous: PlatformCredentialMetadata = { credentialId: 'AQIDBA', prfSalt: 'A'.repeat(43), backupEligible: false };
let mockState: PlatformUnlockState;
const mockRefresh = jest.fn(async () => undefined);
const mockOpenPanel = jest.fn(async () => true);
const mockConfirm = jest.fn(async () => true);
async function sendCommand(command: PlatformUnlockCommand): Promise<PlatformUnlockResult> {
  switch (command.action) {
    case 'state':
      return { action: 'state', state: mockState };
    case 'begin':
      return { action: 'begin', enrollmentId: 'A'.repeat(43) };
    case 'commit':
      mockState = { ...mockState, credential: created };
      return { action: 'commit' };
    case 'remove':
      mockState = { ...mockState, credential: null };
      return { action: 'remove' };
    case 'pending-signals':
      return { action: 'pending-signals', credentialIds: [] };
    default:
      return { action: command.action };
  }
}
const mockSend = jest.fn(sendCommand);

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/env', () => ({ useAppEnv: () => ({ sidePanel: mockSidePanel, confirmWindow: mockConfirmWindow }) }));
jest.mock('app/hooks/usePlatformUnlock', () => ({
  usePlatformUnlock: () => ({ state: mockState, loading: false, refresh: mockRefresh })
}));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ platformUnlock: mockSend }) }));
jest.mock('lib/platform-auth/webauthn', () => ({ createPlatformCredential: jest.fn() }));
jest.mock('lib/extension/side-panel-handoff', () => ({ openSidePanelToWallet: () => mockOpenPanel() }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('components/flow/FlowFooter', () => ({
  FlowFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}));

const mockCreate = jest.mocked(createPlatformCredential);

function submit() {
  fireEvent.change(screen.getByLabelText('password'), { target: { value: 'fixture password' } });
  const field = screen.getByLabelText('password');
  const form = field.closest('form');
  if (!form) throw new Error('Enrollment form unavailable');
  fireEvent.submit(form);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset().mockImplementation(sendCommand);
  mockSidePanel = true;
  mockConfirmWindow = false;
  mockState = { available: true, hasPassword: true, credential: null };
  mockConfirm.mockResolvedValue(true);
  mockOpenPanel.mockResolvedValue(true);
  mockCreate.mockImplementation(async (_old, onCreated) => {
    await onCreated(created.credentialId, created.prfSalt, created.backupEligible);
    return { credentialId: created.credentialId, prfSecret: 'A'.repeat(43) };
  });
});

it('waits for explicit submission, tracks the returned ID and enables the existing wallet', async () => {
  render(<PasskeyUnlockSettings />);
  expect(mockCreate).not.toHaveBeenCalled();
  submit();
  await screen.findByText('passkeyUnlockEnabled');
  expect(mockSend.mock.calls.map(([command]) => command.action)).toEqual(['begin', 'track', 'commit']);
  expect(mockSend).toHaveBeenCalledWith({ action: 'track', enrollmentId: 'A'.repeat(43), credential: created });
  expect(mockRefresh).toHaveBeenCalled();
  expect(screen.getByText('passkeySyncCapable')).toBeInTheDocument();
});

it.each(['wrong password', 'Platform enrollment expired'])(
  'keeps the old credential when saving fails: %s',
  async reason => {
    mockState.credential = previous;
    mockSend.mockImplementationOnce(async () => ({ action: 'begin', enrollmentId: 'A'.repeat(43) }));
    mockSend.mockImplementationOnce(async () => ({ action: 'track' }));
    mockSend.mockImplementationOnce(async () => {
      throw new Error(reason);
    });
    render(<PasskeyUnlockSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'passkeyReplace' }));
    submit();
    await screen.findByText('passkeySetupFailed');
    expect(mockSend).toHaveBeenCalledWith({ action: 'abandon', enrollmentId: 'A'.repeat(43) });
    expect(mockState.credential).toEqual(previous);
  }
);

it.each(['NotAllowedError', 'Platform PRF unavailable'])(
  'abandons a failed native ceremony without saving: %s',
  async reason => {
    mockCreate.mockImplementation(async (_old, onCreated) => {
      await onCreated(created.credentialId, created.prfSalt, created.backupEligible);
      throw reason === 'NotAllowedError' ? new DOMException('Canceled', reason) : new Error(reason);
    });
    render(<PasskeyUnlockSettings />);
    submit();
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith({ action: 'abandon', enrollmentId: 'A'.repeat(43) }));
    expect(mockSend.mock.calls.some(([command]) => command.action === 'commit')).toBe(false);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('password')).toHaveValue('');
  }
);

it('excludes the old credential during replacement and displays non-sync eligibility without treating it as authority', async () => {
  mockState.credential = previous;
  render(<PasskeyUnlockSettings />);
  expect(screen.getByText('passkeyDeviceBound')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'passkeyReplace' }));
  submit();
  await screen.findByText('passkeySyncCapable');
  expect(mockCreate.mock.calls[0]?.[0]).toBe(previous.credentialId);
});

it('removes only after confirmation and explains provider deletion separately', async () => {
  mockState.credential = previous;
  render(<PasskeyUnlockSettings />);
  expect(screen.getByText('passkeyProviderRemoval')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'passkeyRemove' }));
  await waitFor(() =>
    expect(mockSend).toHaveBeenCalledWith({ action: 'remove', expectedCredentialId: previous.credentialId })
  );
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ destructive: true, children: 'passkeyProviderRemoval' })
  );
  expect(mockRefresh).toHaveBeenCalled();
});

it('does not remove when its confirmation is canceled', async () => {
  mockState.credential = previous;
  mockConfirm.mockResolvedValue(false);
  render(<PasskeyUnlockSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'passkeyRemove' }));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
  expect(mockSend).not.toHaveBeenCalled();
});

it.each([false, true])('offers only a side-panel handoff outside the enrollment surface, confirm=%s', async confirm => {
  mockSidePanel = false;
  mockConfirmWindow = confirm;
  mockState.credential = previous;
  render(<PasskeyUnlockSettings />);
  expect(screen.queryByLabelText('password')).not.toBeInTheDocument();
  expect(screen.getByText('passkeyUnlockEnabled')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'openWallet' }));
  await waitFor(() => expect(mockOpenPanel).toHaveBeenCalled());
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('does not start duplicate ceremonies or save a native result that arrives after unmount', async () => {
  let finish: ((value: { credentialId: string; prfSecret: string }) => void) | undefined;
  mockCreate.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const view = render(<PasskeyUnlockSettings />);
  submit();
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  submit();
  expect(mockCreate).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    finish?.({ credentialId: created.credentialId, prfSecret: 'A'.repeat(43) });
  });
  expect(mockSend.mock.calls.some(([command]) => command.action === 'commit')).toBe(false);
  expect(mockSend).toHaveBeenCalledWith({ action: 'abandon', enrollmentId: 'A'.repeat(43) });
});
