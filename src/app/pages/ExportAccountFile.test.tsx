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
  accountFileExportSuccess: 'Account file saved.'
} as const;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (messages as Record<string, string>)[key] ?? key })
}));

jest.mock('app/atoms/FormField', () => ({
  __esModule: true,
  default: ({
    label,
    errorCaption,
    labelDescription: _labelDescription,
    containerClassName: _containerClassName,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    errorCaption?: React.ReactNode;
    labelDescription?: React.ReactNode;
    containerClassName?: string;
  }) => (
    <label>
      {label}
      <input aria-label={label} {...props} />
      {errorCaption ? <span>{errorCaption}</span> : null}
    </label>
  )
}));

jest.mock('app/templates/AccountBanner', () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) => <div data-testid="account-banner" className={className} />
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title: string; onClick: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary' }
}));

jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({ onSubmit, disabled }: { onSubmit: (code: string) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSubmit('123456')}>
      Enter passcode
    </button>
  )
}));

const mockExportAccountFile = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({
    publicKey: 'mtst1account_suffix',
    name: 'Account 1',
    isPublic: true,
    type: 'on-chain',
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
jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args)
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
  expect(screen.getByTestId('account-banner')).toHaveClass('text-heading-gray');
  const saveButton = screen.getByRole('button', { name: messages.saveAccountFile });
  expect(saveButton).toBeDisabled();

  acknowledge();
  expect(mockHapticMedium).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);

  await screen.findByText(messages.accountFileExportSuccess);
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
  expect(screen.queryByText(messages.accountFileExportSuccess)).not.toBeInTheDocument();
});

it('reports export failures and does not claim the file was saved', async () => {
  mockExportAccountFile.mockRejectedValueOnce(new Error('Export failed'));
  await renderReady();

  acknowledge();
  fireEvent.change(screen.getByLabelText(messages.password), { target: { value: 'wallet-password' } });
  fireEvent.click(screen.getByRole('button', { name: messages.saveAccountFile }));

  expect(await screen.findByText('Export failed')).toBeInTheDocument();
  expect(screen.queryByText(messages.accountFileExportSuccess)).not.toBeInTheDocument();
  expect(global.URL.createObjectURL).not.toHaveBeenCalled();
});
