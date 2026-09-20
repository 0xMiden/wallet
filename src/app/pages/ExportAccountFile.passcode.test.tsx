import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ExportAccountFile from './ExportAccountFile';

/**
 * Drives the REAL `components/PasscodeEntry`, which the sibling suite stubs.
 *
 * That distinction is the whole point of this file. The real control guarantees exactly one submit
 * per distinct completed code (`submittedCodeRef`) and clears its digits only when `error` turns
 * non-null - and a dismissed share sheet deliberately sets no error. A stub that calls `onSubmit`
 * on every click cannot express either rule, so a screen that dead-ends on this branch still looks
 * healthy there. Only the real control shows whether a retry is actually possible.
 */

const messages = {
  exportAccountFileWarningBody: 'This file grants access to funds for the exported account.',
  exportAccountFileAcknowledge: 'I understand.',
  exportAccountFilePasscodeDescription: 'Enter your wallet passcode to export this account.',
  saveAccountFile: 'Save account file',
  error: 'Error',
  accountFileShareSuccess: 'Account file shared.'
} as const;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (messages as Record<string, string>)[key] ?? key })
}));

jest.mock('app/templates/AccountBanner', () => ({
  __esModule: true,
  default: () => <div data-testid="account-banner" />
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

const mockExportAccountFile = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'mtst1account_suffix', name: 'Account 1', isPublic: true, type: 'on-chain' }),
  useMidenContext: () => ({ exportAccountFile: mockExportAccountFile })
}));

jest.mock('lib/miden/back/vault', () => ({ Vault: { hasHardwareProtector: () => Promise.resolve(false) } }));
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn(),
  hapticLight: jest.fn(),
  hapticSelection: jest.fn()
}));
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isCapacitor: () => true,
  isExtension: () => false,
  isIOS: () => true,
  isAndroid: () => false,
  isTauri: () => false,
  isDesktop: () => false,
  getPlatform: () => 'mobile'
}));
jest.mock('lib/mobile/useHideDappBubblesWhileOpen', () => ({ useHideDappBubblesWhileOpen: jest.fn() }));

const mockWriteFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockReaddir = jest.fn();
jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args)
  }
}));

const mockShare = jest.fn();
jest.mock('@capacitor/share', () => ({ Share: { share: (...args: unknown[]) => mockShare(...args) } }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockExportAccountFile.mockResolvedValue(new Uint8Array([4, 5, 6]));
  mockWriteFile.mockResolvedValue({ uri: 'file:///cache/mtst1account.mac' });
  mockDeleteFile.mockResolvedValue(undefined);
  mockReaddir.mockResolvedValue({ files: [] });
  mockShare.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

/** Tap six digits, then let the control's 150 ms auto-submit timer fire. */
async function enterPasscode() {
  for (const digit of ['1', '2', '3', '4', '5', '6']) {
    fireEvent.click(screen.getByTestId(`numpad-${digit}`));
  }
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
}

it('gives the user a usable keypad again after a dismissed share sheet', async () => {
  // The real control submits exactly once per completed code and clears its digits only on an
  // error, and a dismissal is deliberately not an error. Without the remount token the keypad
  // would sit full and inert, with no other control on this branch: a dead end.
  mockShare.mockRejectedValueOnce(new Error('Share canceled'));
  render(<ExportAccountFile />);
  await act(async () => {
    await Promise.resolve();
  });

  fireEvent.click(screen.getByRole('checkbox'));
  await enterPasscode();

  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(messages.accountFileShareSuccess)).not.toBeInTheDocument();

  // Same six digits again: only a fresh keypad can accept them.
  await enterPasscode();

  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(2));
  expect(mockExportAccountFile).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(messages.accountFileShareSuccess)).toBeInTheDocument();
});
