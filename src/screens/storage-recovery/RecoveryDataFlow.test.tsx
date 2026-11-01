import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StorageRecoveryPage } from 'app/StorageRecoveryPage';
import { RECOVERY_DATA_FILE_MAX_BYTES } from 'lib/miden/recovery/external-file';
import type { StorageHealth } from 'lib/miden/storage-health';
import type { ExportFilePasswordProps } from 'screens/encrypted-file-flow/ExportFileSetNamePassword';

import { RecoveryDataFlow } from './RecoveryDataFlow';
import { RecoveryDataSettings } from './RecoveryDataSettings';

let mockPlatform: import('lib/auth/strict-action-authentication').StrictAuthenticationPlatform = 'extension';
let mockReady = true;
const mockExport = jest.fn<Promise<string>, [string, number, string, string | undefined]>();
const mockImport = jest.fn<
  Promise<{ imported: boolean; retainedEntries: number }>,
  [string, string, number, string, string | undefined]
>();
const mockCancel = jest.fn<Promise<void>, [string]>();
const mockVerify = jest.fn<Promise<void>, [string | undefined]>();
const mockProtectors = jest.fn();
let mockAvailability: StorageHealth;
let mockDeliveryProps: { preparedContent?: string; fileKind?: string } | undefined;

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    storageAvailability: mockAvailability,
    ready: mockReady,
    exportRecoveryDataFile: mockExport,
    importRecoveryDataFile: mockImport,
    cancelRecoveryDataOperation: mockCancel
  })
}));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      getStrictAuthenticationProtectors: mockProtectors,
      verifyStrictActionAuthentication: mockVerify
    })
}));
jest.mock('lib/platform', () => ({
  getPlatform: () => mockPlatform,
  isExtension: () => mockPlatform === 'extension',
  isDesktop: () => mockPlatform === 'desktop',
  isMobile: () => mockPlatform === 'mobile'
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticError: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({
    children,
    title,
    footer
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      {children}
      {footer}
    </section>
  ),
  SubPageHeaderProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SubPageSection: ({ children, description }: { children?: React.ReactNode; description?: React.ReactNode }) => (
    <section>
      {description}
      {children}
    </section>
  )
}));
jest.mock('screens/encrypted-file-flow/ExportFileSetNamePassword', () => ({
  __esModule: true,
  default: ({
    passwordValue,
    description,
    passwordDescription,
    fileName,
    handlePasswordChange,
    onFileNameChange,
    onGoNext,
    error
  }: ExportFilePasswordProps) => (
    <section data-testid="recovery-file-password-form">
      <p>{description}</p>
      <p>{passwordDescription}</p>
      {error && <p role="alert">{error}</p>}
      <input aria-label="recovery-test-file-password" value={passwordValue} onChange={handlePasswordChange} />
      <input aria-label="recovery-test-file-name" value={fileName} onChange={onFileNameChange} />
      <button onClick={onGoNext}>continue</button>
    </section>
  )
}));
jest.mock('screens/encrypted-file-flow/ExportFileComplete', () => ({
  __esModule: true,
  default: (props: { preparedContent?: string; fileKind?: string }) => {
    mockDeliveryProps = props;
    return <div data-testid="recovery-delivery" />;
  }
}));

class DeferredReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsText(_file: Blob): void {
    readers.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
  finish(value: string): void {
    this.result = value;
    this.onload?.();
  }
}
let readers: DeferredReader[] = [];
const originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');

function input(label: string): HTMLInputElement {
  const node = screen.queryByLabelText(label);
  expect(node).toBeInTheDocument();
  if (!(node instanceof HTMLInputElement)) throw new Error('Expected a file-flow input');
  return node;
}
function choose(file: File): void {
  fireEvent.change(input('recoveryDataChooseFile'), { target: { files: [file] } });
}
async function finishRead(index: number, content: string): Promise<void> {
  await act(async () => {
    readers[index]?.finish(content);
  });
}
async function confirmWalletCredential(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('password'), { target: { value: 'disposable-wallet-credential' } });
  fireEvent.click(screen.getByRole('button', { name: 'continue' }));
}
function enterFilePassword(): void {
  fireEvent.change(input('recoveryDataFilePassword'), { target: { value: 'disposable-file-password' } });
}

beforeEach(() => {
  mockPlatform = 'extension';
  mockReady = true;
  jest.clearAllMocks();
  readers = [];
  mockPlatform = 'extension';
  mockAvailability = {
    status: 'unavailable',
    epoch: 9,
    reason: 'continuity',
    backend: 'wallet',
    operation: 'validate',
    time: 1
  };
  mockDeliveryProps = undefined;
  mockExport.mockResolvedValue('encrypted-disposable-file');
  mockImport.mockResolvedValue({ imported: true, retainedEntries: 2 });
  mockCancel.mockResolvedValue(undefined);
  mockVerify.mockResolvedValue(undefined);
  mockProtectors.mockResolvedValue({ hardware: false, password: true });
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: DeferredReader });
});
afterEach(() => {
  if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader);
});

describe('Task5 recovery file UI', () => {
  it.each(['healthy', 'unavailable'])(
    'exports from %s with one authenticated backend operation and shared delivery',
    async state => {
      if (state === 'healthy') mockAvailability = { status: 'healthy', epoch: 9 };
      render(<RecoveryDataFlow mode="export" onClose={jest.fn()} />);
      expect(screen.queryByTestId('recovery-file-password-form')).toBeInTheDocument();
      fireEvent.change(input('recovery-test-file-password'), { target: { value: 'disposable-file-password' } });
      fireEvent.click(screen.getByRole('button', { name: 'continue' }));
      expect(mockExport).not.toHaveBeenCalled();
      await confirmWalletCredential();
      await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
      expect(mockExport).toHaveBeenCalledWith(
        'disposable-file-password',
        9,
        expect.any(String),
        'disposable-wallet-credential'
      );
      expect(mockVerify).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(mockDeliveryProps).toMatchObject({
          preparedContent: 'encrypted-disposable-file',
          fileKind: 'recovery-data'
        })
      );
    }
  );

  it('refuses an oversized file before reading it or requesting decryption', async () => {
    render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
    choose(new File([new Uint8Array(RECOVERY_DATA_FILE_MAX_BYTES + 1)], 'oversized.json'));
    await waitFor(() => expect(screen.queryByText('recoveryDataSize')).toBeInTheDocument());
    expect(readers).toHaveLength(0);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('a later selected file owns the read even when the first FileReader finishes last', async () => {
    render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
    choose(new File(['first'], 'first.json'));
    choose(new File(['second'], 'second.json'));
    await finishRead(1, 'second-encrypted-file');
    await finishRead(0, 'first-encrypted-file');
    enterFilePassword();
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await confirmWalletCredential();
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockImport).toHaveBeenCalledWith(
      'second-encrypted-file',
      'disposable-file-password',
      9,
      expect.any(String),
      'disposable-wallet-credential'
    );
  });

  it('clear and same-file reselection retire the old read without enabling an incomplete new import', async () => {
    render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
    const file = new File(['retry'], 'retry.json');
    choose(file);
    enterFilePassword();
    fireEvent.click(screen.getByRole('button', { name: 'recoveryDataClearFile' }));
    choose(file);
    await finishRead(0, 'retired-encrypted-file');
    expect(screen.queryByRole('button', { name: 'continue' })).toBeDisabled();
    await finishRead(1, 'current-encrypted-file');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await confirmWalletCredential();
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockImport).toHaveBeenCalledWith(
      'current-encrypted-file',
      'disposable-file-password',
      9,
      expect.any(String),
      'disposable-wallet-credential'
    );
  });

  it('unmount retires a pending backend import using its exact operation identity', async () => {
    let finish!: (result: { imported: boolean; retainedEntries: number }) => void;
    mockImport.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const view = render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
    choose(new File(['pending'], 'pending.json'));
    await finishRead(0, 'pending-encrypted-file');
    enterFilePassword();
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await confirmWalletCredential();
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    const call = mockImport.mock.calls[0];
    if (!call) throw new Error('Expected the import operation');
    view.unmount();
    expect(mockCancel).toHaveBeenCalledWith(call[3]);
    await act(async () => {
      finish({ imported: true, retainedEntries: 2 });
    });
  });

  it('a wrong file password is shown as a file error rather than a wallet authentication error', async () => {
    mockImport.mockRejectedValueOnce(new Error('RecoveryDataFile:password'));
    render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
    choose(new File(['wrong-password'], 'protected.json'));
    await finishRead(0, 'protected-encrypted-file');
    enterFilePassword();
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await confirmWalletCredential();
    await waitFor(() => expect(screen.queryByText('recoveryDataWrongPassword')).toBeInTheDocument());
    expect(screen.queryByText('smthWentWrong')).not.toBeInTheDocument();
  });
});

it('uses import-specific guidance when importing recovery data', () => {
  render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
  expect(screen.getByText('recoveryDataImportDescription')).toBeInTheDocument();
  expect(screen.queryByText('recoveryDataDescription')).not.toBeInTheDocument();
});

it('identifies the recovery data file when setting its export password', () => {
  render(<RecoveryDataFlow mode="export" onClose={jest.fn()} />);
  expect(screen.getByText('recoveryDataDescription')).toBeInTheDocument();
  expect(screen.getByText('recoveryDataExportPasswordDescription')).toBeInTheDocument();
});

it('Task5 recovery hardware file failure does not masquerade as biometric authentication failure', async () => {
  mockPlatform = 'desktop';
  mockProtectors.mockResolvedValue({ hardware: true, password: false });
  const unavailable = new Error('Wallet storage unavailable');
  unavailable.name = 'StorageUnavailableError';
  mockExport.mockRejectedValueOnce(unavailable);
  render(<RecoveryDataFlow mode="export" onClose={jest.fn()} />);
  fireEvent.change(input('recovery-test-file-password'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: 'continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
  await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('recoveryDataUnavailable')).toBeInTheDocument());
  expect(screen.queryByText('biometricFailed')).not.toBeInTheDocument();
});

it('Task5 recovery file read failure is distinct from malformed file contents', async () => {
  render(<RecoveryDataFlow mode="import" onClose={jest.fn()} />);
  choose(new File(['{}'], 'recovery-data.json', { type: 'application/json' }));
  expect(readers).toHaveLength(1);
  const pending = readers[0];
  if (!pending?.onerror) throw new Error('Missing real reader error handler');
  act(() => pending.onerror?.());
  expect(screen.queryByText('recoveryDataReadFailed')).toBeInTheDocument();
  expect(screen.queryByText('recoveryDataMalformed')).not.toBeInTheDocument();
  expect(mockImport).not.toHaveBeenCalled();
});

it.each([
  { surface: 'settings', mode: 'export' },
  { surface: 'settings', mode: 'import' },
  { surface: 'unavailable-ready', mode: 'export' },
  { surface: 'unavailable-ready', mode: 'import' },
  { surface: 'unavailable-locked', mode: 'export' },
  { surface: 'unavailable-locked', mode: 'import' }
])(
  'Task5 recovery file entry connects $surface to $mode and returns without ordinary authentication',
  async ({ surface, mode }) => {
    mockReady = surface !== 'unavailable-locked';
    mockAvailability =
      surface === 'settings'
        ? { status: 'healthy', epoch: 17 }
        : { status: 'unavailable', epoch: 17, reason: 'journal', backend: 'independent', operation: 'mutate', time: 1 };
    render(surface === 'settings' ? <RecoveryDataSettings /> : <StorageRecoveryPage />);
    const name = mode === 'export' ? 'recoveryDataExport' : 'recoveryDataImport';
    const button = screen.queryByRole('button', { name });
    expect(button).toBeInTheDocument();
    if (!button) throw new Error('Missing asserted recovery file entry');
    fireEvent.click(button);
    expect(
      screen.queryByLabelText(mode === 'export' ? 'recovery-test-file-password' : 'recoveryDataChooseFile')
    ).toBeInTheDocument();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockExport).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    const { useMobileBackHandler } = await import('lib/mobile/useMobileBackHandler');
    const registered = jest.mocked(useMobileBackHandler).mock.calls.map(([handler]) => handler);
    if (registered.length === 0) throw new Error('Missing registered recovery back handler');
    let consumed = false;
    act(() => {
      for (const handler of [...registered].reverse()) {
        if (handler() === true) {
          consumed = true;
          break;
        }
      }
    });
    expect(consumed).toBe(true);
    expect(screen.queryByRole('button', { name })).toBeInTheDocument();
  }
);
