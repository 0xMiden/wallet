import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ExportAccountFile from './ExportAccountFile';

const messages = {
  exportAccountFileWarningTitle: 'This file controls your funds',
  exportAccountFileWarningBody:
    'This file grants access to funds for the exported account. Do not share it with anyone.',
  exportAccountFileAcknowledge: 'I understand that anyone with this file can access the account funds.',
  exportAccountFilePasswordDescription: 'Enter your wallet password to export this account.',
  exportAccountFileHardwareDescription: 'Confirm with your device security to export this account.',
  exportAccountFilePasscodeDescription: 'Enter your wallet passcode to export this account.',
  saveAccountFile: 'Save account file',
  password: 'Password',
  error: 'Error',
  accountFileDownloadStarted: 'Account file download started.',
  accountFileShareSuccess: 'Account file shared.',
  exportAccountFile: 'Export account file',
  exportAccountFileGuardianUnavailable:
    'A Guardian account cannot be exported to an account file. Its signing key is held by your device.'
} as const;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (messages as Record<string, string>)[key] ?? key })
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

// Faithful on the one thing that matters to these assertions: the real control renders
// `error ?? subtitle` as its hint, so a stub that drops `error` hides a duplicated failure.
// (It still submits on every click; the one-submit-per-code latch is covered against the REAL
// component in ExportAccountFile.passcode.test.tsx.)
jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({
    onSubmit,
    disabled,
    error,
    subtitle
  }: {
    onSubmit: (code: string) => void;
    disabled?: boolean;
    error?: string | null;
    subtitle?: string;
  }) => (
    <div>
      <button type="button" disabled={disabled} onClick={() => onSubmit('123456')}>
        Enter passcode
      </button>
      <span>{error ?? subtitle}</span>
    </div>
  )
}));

const mockExportAccountFile = jest.fn();
let mockAccountPublicKey = 'mtst1account_suffix';
let mockAccountType = 'on-chain';
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({
    publicKey: mockAccountPublicKey,
    name: 'Account 1',
    isPublic: true,
    type: mockAccountType,
    hdIndex: 0
  }),
  useMidenContext: () => ({ exportAccountFile: mockExportAccountFile })
}));

const mockHasHardwareProtector = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => mockHasHardwareProtector() }
}));

const mockHapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticMedium: () => mockHapticMedium() }));

let mockMobile = false;
jest.mock('lib/platform', () => ({ isMobile: () => mockMobile }));
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
jest.mock('@capacitor/share', () => ({
  Share: { share: (...args: unknown[]) => mockShare(...args) }
}));

let clickedAnchor: HTMLAnchorElement | null;
let clickSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockMobile = false;
  mockHasHardwareProtector.mockResolvedValue(false);
  mockExportAccountFile.mockResolvedValue(new Uint8Array([4, 5, 6]));
  mockWriteFile.mockResolvedValue({ uri: 'file:///cache/mtst1account.mac' });
  mockDeleteFile.mockResolvedValue(undefined);
  mockReaddir.mockResolvedValue({ files: [] });
  mockAccountPublicKey = 'mtst1account_suffix';
  mockAccountType = 'on-chain';
  mockShare.mockResolvedValue(undefined);
  global.URL.createObjectURL = jest.fn(() => 'blob:account-file');
  global.URL.revokeObjectURL = jest.fn();
  clickedAnchor = null;
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchor = this;
  });
});

afterEach(() => {
  clickSpy.mockRestore();
});

async function renderReady() {
  render(<ExportAccountFile />);
  await screen.findByText(messages.exportAccountFileWarningBody);
}

function acknowledge() {
  fireEvent.click(screen.getByRole('checkbox'));
}

it('requires the explicit funds warning acknowledgement and password before desktop download', async () => {
  await renderReady();

  expect(screen.getByText(messages.exportAccountFileWarningBody)).toBeInTheDocument();
  // The page names the account it would export, as the shared account row.
  expect(screen.getByTestId('account-banner')).toHaveTextContent('Account 1');
  const saveButton = screen.getByRole('button', { name: messages.saveAccountFile });
  expect(saveButton).toBeDisabled();

  acknowledge();
  expect(mockHapticMedium).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);

  await screen.findByText(messages.accountFileDownloadStarted);
  expect(screen.queryByText(messages.accountFileShareSuccess)).not.toBeInTheDocument();
  expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account_suffix', 'wallet-password');
  expect(clickedAnchor?.download).toBe('mtst1account.mac');
  expect(clickedAnchor?.href).toBe('blob:account-file');
  await waitFor(() => expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:account-file'));
});

it('cleans up the temporary browser download when starting it fails', async () => {
  clickSpy.mockImplementationOnce(() => {
    throw new Error('Download failed');
  });
  await renderReady();

  acknowledge();
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  fireEvent.click(screen.getByRole('button', { name: messages.saveAccountFile }));

  expect(await screen.findByText('Download failed')).toBeInTheDocument();
  expect(document.body.querySelector('a[download="mtst1account.mac"]')).toBeNull();
  await waitFor(() => expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:account-file'));
});

it('uses device authentication without a password when a hardware protector exists', async () => {
  mockHasHardwareProtector.mockResolvedValue(true);
  await renderReady();

  acknowledge();
  expect(screen.queryByLabelText(messages.password)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: messages.saveAccountFile }));

  await waitFor(() => expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account_suffix', undefined));
});

it('uses the mobile passcode, writes raw bytes as base64, and opens the share sheet', async () => {
  mockMobile = true;
  await renderReady();

  const passcodeButton = screen.getByRole('button', { name: 'Enter passcode' });
  expect(passcodeButton).toBeDisabled();
  acknowledge();
  fireEvent.click(passcodeButton);

  await waitFor(() => expect(mockShare).toHaveBeenCalled());
  expect(await screen.findByText(messages.accountFileShareSuccess)).toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileDownloadStarted)).not.toBeInTheDocument();
  expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account_suffix', '123456');
  expect(mockWriteFile).toHaveBeenCalledWith({
    path: 'mtst1account.mac',
    data: 'BAUG',
    directory: 'CACHE'
  });
  expect(mockShare).toHaveBeenCalledWith({
    title: 'mtst1account.mac',
    files: ['file:///cache/mtst1account.mac'],
    dialogTitle: messages.saveAccountFile
  });
  expect(mockDeleteFile).toHaveBeenCalledWith({ path: 'mtst1account.mac', directory: 'CACHE' });
});

it('deletes the sensitive mobile cache file when sharing fails', async () => {
  mockMobile = true;
  mockShare.mockRejectedValueOnce(new Error('Share failed'));
  await renderReady();

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));

  expect(await screen.findByText('Share failed')).toBeInTheDocument();
  expect(mockDeleteFile).toHaveBeenCalledWith({ path: 'mtst1account.mac', directory: 'CACHE' });
  expect(screen.queryByText(messages.accountFileDownloadStarted)).not.toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileShareSuccess)).not.toBeInTheDocument();
});

it('focuses the password field once the hardware probe resolves, and Enter submits', async () => {
  await renderReady();

  const passwordField = screen.getByLabelText(messages.password);
  expect(passwordField).toHaveFocus();

  acknowledge();
  fireEvent.change(passwordField, { target: { value: 'wallet-password' } });
  fireEvent.submit(passwordField.closest('form')!);

  await screen.findByText(messages.accountFileDownloadStarted);
  expect(mockExportAccountFile).toHaveBeenCalledWith('mtst1account_suffix', 'wallet-password');
});

it('does not export on Enter before the warning is acknowledged', async () => {
  await renderReady();

  const passwordField = screen.getByLabelText(messages.password);
  fireEvent.change(passwordField, { target: { value: 'wallet-password' } });
  expect(screen.getByRole('button', { name: messages.saveAccountFile })).toBeDisabled();
  fireEvent.submit(passwordField.closest('form')!);

  await waitFor(() => expect(mockExportAccountFile).not.toHaveBeenCalled());
});

it('falls back to the password step-up when the hardware probe rejects', async () => {
  mockHasHardwareProtector.mockRejectedValueOnce(new Error('probe unavailable'));
  await renderReady();

  expect(screen.getByLabelText(messages.password)).toBeInTheDocument();
});

it('zeroes bytes that arrive after the screen is gone, and opens no sheet over what replaced it', async () => {
  mockMobile = true;
  const exported = new Uint8Array([4, 5, 6]);
  let releaseExport: (value: Uint8Array) => void = () => undefined;
  mockExportAccountFile.mockReturnValueOnce(
    new Promise<Uint8Array>(resolve => {
      releaseExport = resolve;
    })
  );
  const view = render(<ExportAccountFile />);
  await screen.findByText(messages.exportAccountFileWarningBody);

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));
  view.unmount();
  releaseExport(exported);

  await waitFor(() => expect(Array.from(exported)).toEqual([0, 0, 0]));
  expect(mockShare).not.toHaveBeenCalled();
});

it('opens no share sheet when the screen goes while the stale-export sweep is in flight', async () => {
  // The sweep and the write are each a bridge round trip, so the screen can be gone before delivery.
  // A .mac share sheet must not appear over whatever replaced it - and the plaintext cache copy
  // must still be reclaimed.
  mockMobile = true;
  let releaseSweep: () => void = () => undefined;
  mockReaddir.mockReturnValueOnce(
    new Promise(resolve => {
      releaseSweep = () => resolve({ files: [] });
    })
  );
  const view = render(<ExportAccountFile />);
  await screen.findByText(messages.exportAccountFileWarningBody);

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));
  await waitFor(() => expect(mockReaddir).toHaveBeenCalled());

  view.unmount();
  releaseSweep();

  await waitFor(() => expect(mockDeleteFile).toHaveBeenCalledWith({ path: 'mtst1account.mac', directory: 'CACHE' }));
  expect(mockShare).not.toHaveBeenCalled();
});

it('demands fresh consent when the active account changes under a mounted screen', async () => {
  // useAccount() is the globally shared currentAccount: another open surface can switch it while
  // this screen stays mounted, because the Settings route keys its sub-pages by tab slug alone.
  const view = render(<ExportAccountFile />);
  await screen.findByText(messages.exportAccountFileWarningBody);

  acknowledge();
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  expect(screen.getByRole('button', { name: messages.saveAccountFile })).toBeEnabled();

  mockAccountPublicKey = 'mtst1other_suffix';
  view.rerender(<ExportAccountFile />);
  await screen.findByText(messages.exportAccountFileWarningBody);

  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.getByLabelText(messages.password)).toHaveValue('');
  expect(screen.getByRole('button', { name: messages.saveAccountFile })).toBeDisabled();
});

it('zeroes the desktop download copy, which revokeObjectURL does not reach', async () => {
  const exported = new Uint8Array([4, 5, 6]);
  mockExportAccountFile.mockResolvedValueOnce(exported);
  const blobParts: Uint8Array[] = [];
  const RealBlob = global.Blob;
  // Capture the array handed to Blob: revokeObjectURL releases the URL mapping, not this copy.
  global.Blob = class extends RealBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      blobParts.push(parts[0] as Uint8Array);
    }
  } as unknown as typeof Blob;
  try {
    await renderReady();
    acknowledge();
    fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
    fireEvent.click(screen.getByRole('button', { name: messages.saveAccountFile }));

    await screen.findByText(messages.accountFileDownloadStarted);
    expect(blobParts).toHaveLength(1);
    expect(Array.from(blobParts[0]!)).toEqual([0, 0, 0]);
  } finally {
    global.Blob = RealBlob;
  }
});

it('reclaims a stale export left behind by a killed share before writing the next one', async () => {
  mockMobile = true;
  mockReaddir.mockResolvedValue({ files: [{ name: 'mtst1orphan.mac' }, { name: 'unrelated.png' }] });
  await renderReady();

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));

  await waitFor(() => expect(mockWriteFile).toHaveBeenCalled());
  expect(mockDeleteFile).toHaveBeenCalledWith({ path: 'mtst1orphan.mac', directory: 'CACHE' });
  expect(mockDeleteFile).not.toHaveBeenCalledWith({ path: 'unrelated.png', directory: 'CACHE' });
});

it('still exports when the stale-export sweep fails', async () => {
  mockMobile = true;
  mockReaddir.mockRejectedValueOnce(new Error('readdir unavailable'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await renderReady();

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));

  expect(await screen.findByText(messages.accountFileShareSuccess)).toBeInTheDocument();
  consoleError.mockRestore();
});

it('treats a dismissed share sheet as a choice, showing neither an error nor a success', async () => {
  mockMobile = true;
  const exported = new Uint8Array([4, 5, 6]);
  mockExportAccountFile.mockResolvedValueOnce(exported);
  mockShare.mockRejectedValueOnce(new Error('Share canceled'));
  await renderReady();

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));

  await waitFor(() => expect(mockDeleteFile).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(messages.error)).not.toBeInTheDocument();
  expect(screen.queryByText('Share canceled')).not.toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileShareSuccess)).not.toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileDownloadStarted)).not.toBeInTheDocument();

  // The bytes are gone either way: a dismissal is not a reason to keep key material around.
  await waitFor(() => expect(Array.from(exported)).toEqual([0, 0, 0]));
});

it('keeps the real share failure when deleting the temporary file also fails', async () => {
  mockMobile = true;
  mockShare.mockRejectedValueOnce(new Error('Share failed'));
  mockDeleteFile.mockRejectedValueOnce(new Error('Delete failed'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await renderReady();

  acknowledge();
  fireEvent.click(screen.getByRole('button', { name: 'Enter passcode' }));

  expect(await screen.findByText('Share failed')).toBeInTheDocument();
  expect(screen.queryByText('Delete failed')).not.toBeInTheDocument();
  consoleError.mockRestore();
});

it('reports export failures and does not claim the file was saved', async () => {
  mockExportAccountFile.mockRejectedValueOnce(new Error('Export failed'));
  await renderReady();

  acknowledge();
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  fireEvent.click(screen.getByRole('button', { name: messages.saveAccountFile }));

  expect(await screen.findByText('Export failed')).toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileDownloadStarted)).not.toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileShareSuccess)).not.toBeInTheDocument();
  expect(global.URL.createObjectURL).not.toHaveBeenCalled();
});

it('refuses a Guardian account without asking for the warning or a credential', async () => {
  mockAccountType = 'guardian';

  render(<ExportAccountFile />);

  expect(await screen.findByText(messages.exportAccountFileGuardianUnavailable)).toBeInTheDocument();
  expect(screen.queryByText(messages.exportAccountFileWarningBody)).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(messages.password)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: messages.saveAccountFile })).not.toBeInTheDocument();
  expect(mockExportAccountFile).not.toHaveBeenCalled();
});
