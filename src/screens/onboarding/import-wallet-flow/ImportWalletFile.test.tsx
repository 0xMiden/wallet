import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { DecryptedWalletFile } from 'lib/miden/backup-file';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

import { WalletType } from '../types';
import { ImportWalletFileScreen } from './ImportWalletFile';

/**
 * ImportWalletFileScreen is a react-hook-form-driven onboarding step that
 * accepts an encrypted `.json` wallet backup, decrypts it with a user-supplied
 * password, and (optionally, when the exporter stripped imported accounts)
 * shows a two-step "confirm the omitted accounts" notice before completing the
 * restore.
 *
 * Every module boundary is mocked so each branch is reachable deterministically:
 *   - `react-hook-form`'s `useForm` is mocked so `watch`, `formState`
 *     (`errors` / `isSubmitting` / `isValid`), `register` and `handleSubmit`
 *     are steered by hand. `handleSubmit(cb)` always invokes `cb`, which is the
 *     only way to reach `handleImportSubmit`'s guards and try/catch on demand.
 *   - `@miden-sdk/react/lazy`'s `useImportStore`, `lib/miden/passworder`'s
 *     crypto primitives, and `lib/miden/repo`'s `importDb` are jest.fn()s so we
 *     can trace exactly what the component threads through the decrypt pipeline
 *     and drive the wrong-password / thrown-error / omitted-accounts arms.
 *   - `TextField` / `components/Button` / the v2 icon barrel are thin harnesses
 *     that surface only the props under test (errorCaption, disabled, isLoading,
 *     children).
 *   - The global `FileReader` is replaced with a synchronous fake so the
 *     `onload` (valid JSON / invalid JSON) and `onerror` arms of `processFiles`
 *     fire deterministically inside React's act() scope.
 *
 * Coverage note: `onUploadFileClick`'s `walletFileRef.current != null` guard has
 * a defensive false arm that is unreachable through the UI - the ref is always
 * attached to the mounted <input> by the time a user can click the trigger, so
 * that single branch has no reachable caller. Every line and every other branch
 * is exercised.
 */

// ---------------------------------------------------------------------------
// Mutable control state (read lazily inside mock-factory closures).
// ---------------------------------------------------------------------------
let mockWatchPassword: string | undefined = 'pw';
let mockFormState: {
  errors: { password?: { message?: string } };
  isSubmitting: boolean;
  isValid: boolean;
} = { errors: {}, isSubmitting: false, isValid: true };

const mockRegister = jest.fn((name: string, _opts?: unknown) => ({
  name,
  onChange: jest.fn(),
  onBlur: jest.fn(),
  ref: jest.fn()
}));

const mockImportStore = jest.fn();
const mockImportDb = jest.fn();
const mockStoreIdentifier = jest.fn();
const mockGetMidenClient = jest.fn();
const mockWithWasmClientLock = jest.fn();
const mockAssertWasmHoldCurrent = jest.fn();
const mockGenerateKey = jest.fn();
const mockDeriveKey = jest.fn();
const mockDecrypt = jest.fn();
const mockDecryptJson = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks.
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { importedCount?: string }) =>
      opts?.importedCount !== undefined ? `${key}:${opts.importedCount}` : key
  })
}));

jest.mock('react-hook-form', () => ({
  useForm: () => ({
    watch: (name: string) => (name === 'password' ? mockWatchPassword : undefined),
    register: (name: string, opts?: unknown) => mockRegister(name, opts),
    handleSubmit: (onSubmit: () => unknown) => (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
      return onSubmit();
    },
    formState: mockFormState
  })
}));

jest.mock('lib/miden/passworder', () => ({
  generateKey: (...args: unknown[]) => mockGenerateKey(...args),
  deriveKey: (...args: unknown[]) => mockDeriveKey(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  decryptJson: (...args: unknown[]) => mockDecryptJson(...args)
}));

// `db.tables` keeps the global jest.setup.js afterEach cleanup happy; `importDb`
// is mockable so we can assert the wallet-db payload is threaded through.
jest.mock('lib/miden/repo', () => ({
  db: { tables: [] },
  importDb: (...args: unknown[]) => mockImportDb(...args)
}));

// The restore replaces the store the active client has open, so it goes through
// the client interface under the realm's WASM lock. The lock is mocked so the
// test can assert it was taken, with a label, before any client call.
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  withWasmClientLock: (...args: unknown[]) => mockWithWasmClientLock(...args),
  assertWasmHoldCurrent: (...args: unknown[]) => mockAssertWasmHoldCurrent(...args)
}));

jest.mock('app/icons/v2', () => ({
  __esModule: true,
  Icon: ({ name }: { name: string }) => <div data-testid={`icon-${name}`}>{name}</div>,
  IconName: {
    UploadFile: 'UploadFile',
    UploadedFile: 'UploadedFile',
    Close: 'Close'
  }
}));

jest.mock('components/ui/TextField', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    TextField: ReactLib.forwardRef(
      (
        {
          label,
          hint,
          error,
          autoComplete
        }: { label?: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; autoComplete?: string },
        _ref: unknown
      ) =>
        ReactLib.createElement(
          'div',
          // `autoComplete` is forwarded so a caller's choice is visible here. Whether TextField
          // honours it is TextField.test.tsx's job; this file's job is that the caller asks.
          { 'data-testid': 'form-field', 'data-auto-complete': autoComplete },
          ReactLib.createElement('span', { 'data-testid': 'ff-label' }, label),
          hint ? ReactLib.createElement('span', { 'data-testid': 'ff-hint' }, hint) : null,
          error ? ReactLib.createElement('div', { 'data-testid': 'ff-error' }, error) : null
        )
    )
  };
});

jest.mock('components/Button', () => {
  const ReactLib = require('react');
  return {
    Button: ({
      children,
      type,
      disabled,
      isLoading
    }: {
      children: React.ReactNode;
      type?: string;
      disabled?: boolean;
      isLoading?: boolean;
    }) =>
      ReactLib.createElement(
        'button',
        {
          // Match the real Button's own default (type="button") so this only reads
          // "submit" when the caller passes it explicitly, not as a mock fallback.
          type: type ?? 'button',
          'data-testid': 'submit-button',
          'data-loading': String(Boolean(isLoading)),
          disabled: Boolean(disabled)
        },
        children
      )
  };
});

// ---------------------------------------------------------------------------
// FileReader fake - drives processFiles' onload/onerror synchronously.
// ---------------------------------------------------------------------------
type ReaderJob = { mode: 'load' | 'error'; content?: string; deferred?: boolean };
let fileReaderQueue: ReaderJob[] = [];
let pendingReads: Array<() => void> = [];
const OriginalFileReader = global.FileReader;

class FakeFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: ArrayBuffer | null = null;

  readAsArrayBuffer(_file: unknown) {
    const job = fileReaderQueue.shift() ?? { mode: 'load', content: '{}' };
    const settle = () => {
      if (job.mode === 'error') {
        this.onerror?.();
        return;
      }
      this.result = new TextEncoder().encode(job.content ?? '{}').buffer;
      this.onload?.();
    };
    // A real read is asynchronous, so a `deferred` job hands the settling back to
    // the test. Without it two reads can never overlap here and the staleness
    // guards on onload/onerror are untestable.
    if (job.deferred) {
      pendingReads.push(settle);
      return;
    }
    settle();
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const VALID_WALLET_JSON = JSON.stringify({
  salt: { 0: 10, 1: 20, 2: 30 },
  encryptedPasswordCheck: { dt: 'check-dt', iv: 'check-iv' },
  dt: 'payload-dt',
  iv: 'payload-iv'
});

const VALID_ACCOUNT = {
  publicKey: 'account-1',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 0
};

const VERSION_TWO_PAYLOAD: DecryptedWalletFile = {
  formatVersion: 2,
  seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  midenClientDbContent: 'miden-client-db',
  walletDbContent: 'wallet-db',
  accounts: [VALID_ACCOUNT],
  importedAccounts: []
};

const renderScreen = (props: Partial<React.ComponentProps<typeof ImportWalletFileScreen>> = {}) =>
  render(<ImportWalletFileScreen {...props} />);

const getForm = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;
const getDropzone = (container: HTMLElement) =>
  container.querySelector('[data-testid="wallet-file-dropzone"]') as HTMLElement;
const getFileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

// Upload via the hidden <input>'s change event (exercises `onUploadFile`).
const uploadViaInput = (container: HTMLElement, fileName: string, job?: ReaderJob, size = 1_024) => {
  if (job) fileReaderQueue.push(job);
  const input = getFileInput(container);
  Object.defineProperty(input, 'files', { value: [{ name: fileName, size }], configurable: true });
  fireEvent.change(input);
};

const submit = async (container: HTMLElement) => {
  await act(async () => {
    fireEvent.submit(getForm(container));
  });
};

let alertSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  fileReaderQueue = [];
  pendingReads = [];
  mockWatchPassword = 'pw';
  mockFormState = { errors: {}, isSubmitting: false, isValid: true };

  mockGenerateKey.mockResolvedValue('pass-key');
  mockDeriveKey.mockResolvedValue('derived-key');
  mockDecrypt.mockResolvedValue(ENCRYPTED_WALLET_FILE_PASSWORD_CHECK);
  mockDecryptJson.mockResolvedValue(VERSION_TWO_PAYLOAD);
  mockImportStore.mockResolvedValue(undefined);
  mockImportDb.mockResolvedValue(undefined);
  mockStoreIdentifier.mockResolvedValue('MidenClientDB_mtst');
  mockGetMidenClient.mockResolvedValue({ importDb: mockImportStore, client: { storeIdentifier: mockStoreIdentifier } });
  mockWithWasmClientLock.mockImplementation(async (run: (hold: unknown) => Promise<unknown>) => run({ id: 'hold' }));
  mockAssertWasmHoldCurrent.mockImplementation(() => undefined);

  (global as unknown as { FileReader: unknown }).FileReader = FakeFileReader as unknown;
  alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (global as unknown as { FileReader: unknown }).FileReader = OriginalFileReader;
  alertSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Initial (no file) render + the drop-zone chrome.
// ---------------------------------------------------------------------------
describe('initial render / drop zone', () => {
  it('renders the localized heading, upload icon, choose-from-device trigger and hidden input', () => {
    const { container } = renderScreen();

    expect(screen.getByText('importWallet')).toBeInTheDocument();
    expect(screen.getByText('importWithEncryptedWalletFileDescription')).toBeInTheDocument();
    expect(screen.getByTestId('icon-UploadFile')).toBeInTheDocument();
    expect(screen.getByText('chooseFromDevice')).toBeInTheDocument();
    expect(screen.getByText('jsonFileType')).toBeInTheDocument();
    expect(getFileInput(container)).toHaveAttribute('accept', '.json,application/json');
    // No password field and no notice before a file is loaded.
    expect(screen.queryByTestId('form-field')).not.toBeInTheDocument();
  });

  // A wallet FILE is decrypted with a password chosen at export time, so this is the one password
  // field in the wallet that WANTS the manager. The component default is `new-password`, which
  // suppresses the manager on vault secrets and would offer to generate a password that already
  // exists, so this field overrides it. That TextField honours the override is its own suite's
  // job; this asserts the caller asks for it.
  it('asks the password manager for the stored file password', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });

    expect(screen.getByTestId('form-field')).toHaveAttribute('data-auto-complete', 'current-password');
  });

  it('registers the password field with the required caption once a file is loaded', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    expect(mockRegister).toHaveBeenCalledWith('password', { required: 'PASSWORD_ERROR_CAPTION' });
  });

  it('disables the submit button while no file is loaded (import label)', () => {
    renderScreen();
    const button = screen.getByTestId('submit-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('import');
  });

  it('reflects the react-hook-form isSubmitting flag on the submit button', () => {
    mockFormState = { errors: {}, isSubmitting: true, isValid: true };
    renderScreen();
    expect(screen.getByTestId('submit-button')).toHaveAttribute('data-loading', 'true');
  });

  it('clicks the hidden input when the choose-from-device trigger is pressed', () => {
    const clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    renderScreen();
    fireEvent.click(screen.getByText('chooseFromDevice'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('exposes the file picker trigger as a keyboard-operable button', () => {
    renderScreen();

    expect(screen.getByRole('button', { name: 'chooseFromDevice' })).toHaveAttribute('type', 'button');
  });
});

// ---------------------------------------------------------------------------
// Drag & drop handlers.
// ---------------------------------------------------------------------------
describe('drag handlers', () => {
  it('highlights the drop zone on drag enter', () => {
    const { container } = renderScreen();
    const dropzone = getDropzone(container);
    expect(dropzone.className).not.toContain('ring-accent-primary');

    fireEvent.dragEnter(dropzone);
    expect(getDropzone(container).className).toContain('ring-accent-primary');
  });

  it('drag over is a no-op that prevents the browser default', () => {
    const { container } = renderScreen();
    fireEvent.dragEnter(getDropzone(container));
    // dragOver just calls preventDefault; highlight stays on.
    fireEvent.dragOver(getDropzone(container));
    expect(getDropzone(container).className).toContain('ring-accent-primary');
  });

  it('clears the highlight on drag leave when leaving to a non-child target', () => {
    const { container } = renderScreen();
    fireEvent.dragEnter(getDropzone(container));
    expect(getDropzone(container).className).toContain('ring-accent-primary');

    fireEvent.dragLeave(getDropzone(container), { relatedTarget: document.body });
    expect(getDropzone(container).className).not.toContain('ring-accent-primary');
  });

  it('keeps the highlight when the drag leave goes to a child element', () => {
    const { container } = renderScreen();
    const dropzone = getDropzone(container);
    fireEvent.dragEnter(dropzone);

    const childInput = getFileInput(container); // the hidden input lives inside the drop zone
    // Build the event by hand so `relatedTarget` (a child node) is guaranteed
    // to survive onto the native event React reads.
    const event = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'relatedTarget', { value: childInput });
    fireEvent(dropzone, event);

    expect(getDropzone(container).className).toContain('ring-accent-primary');
  });

  it('loads a dropped JSON file and clears the highlight', () => {
    const { container } = renderScreen();
    fireEvent.dragEnter(getDropzone(container));

    fileReaderQueue.push({ mode: 'load', content: VALID_WALLET_JSON });
    fireEvent.drop(getDropzone(container), { dataTransfer: { files: [{ name: 'wallet.json' }] } });

    // File is now staged -> the chip (with its name) replaces the drop zone.
    expect(screen.getByText('wallet.json')).toBeInTheDocument();
    expect(container.querySelector('.border-dashed')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// processFiles validation branches.
// ---------------------------------------------------------------------------
describe('processFiles validation', () => {
  it('alerts when no file is selected', () => {
    const { container } = renderScreen();
    const input = getFileInput(container);
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fireEvent.change(input);
    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileSelectOne');
  });

  it('alerts when the file extension is not .json', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.txt');
    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileJsonOnly');
    // No reader work happened -> no file staged.
    expect(screen.queryByText('wallet.txt')).not.toBeInTheDocument();
  });

  it('alerts and logs when the file contains invalid JSON', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'broken.json', { mode: 'load', content: 'not-json{' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileMalformed');
    expect(screen.queryByText('broken.json')).not.toBeInTheDocument();
  });

  it('rejects a JSON object that is not an encrypted wallet envelope', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'not-a-wallet.json', { mode: 'load', content: '{"hello":"world"}' });

    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileMalformed');
    expect(screen.queryByText('not-a-wallet.json')).not.toBeInTheDocument();
  });

  it('alerts when the FileReader itself errors', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'error' });
    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileReadFailed');
  });

  it('stages a valid JSON file and shows the password field + clear button', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });

    expect(screen.getByText('wallet.json')).toBeInTheDocument();
    expect(screen.getByTestId('icon-UploadedFile')).toBeInTheDocument();
    expect(screen.getByTestId('form-field')).toBeInTheDocument();
    expect(screen.getByText('enterDecryptionPassword')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'clear' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Clear / re-select.
// ---------------------------------------------------------------------------
describe('clear', () => {
  it('clears the staged file and returns to the drop zone', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    expect(screen.getByText('wallet.json')).toBeInTheDocument();

    // The chip's close button is the only <button type="button">.
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);

    expect(screen.queryByText('wallet.json')).not.toBeInTheDocument();
    expect(getDropzone(container)).toBeInTheDocument();
  });

  // Regression for the #364 round-2 finding: clearing the staged file must also
  // reset the error flags, otherwise a failed attempt on file A leaves a stale
  // error caption showing the moment file B is selected, before any action.
  const clearStagedFile = (container: HTMLElement) =>
    fireEvent.click(container.querySelector('button[type="button"]') as HTMLButtonElement);

  it('clears a restore error when the file is removed, so a re-selected file starts clean', async () => {
    const onSubmit = jest.fn();
    mockImportStore.mockRejectedValueOnce(new Error('idb write failed'));
    const { container } = renderScreen({ onSubmit });
    uploadViaInput(container, 'wallet-a.json', { mode: 'load', content: VALID_WALLET_JSON });

    await submit(container);

    const ffError = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(ffError()).toHaveTextContent('encryptedWalletFileRestoreFailed'));

    // Remove the file, then select a different one WITHOUT submitting again.
    clearStagedFile(container);
    uploadViaInput(container, 'wallet-b.json', { mode: 'load', content: VALID_WALLET_JSON });

    expect(screen.getByText('wallet-b.json')).toBeInTheDocument();
    expect(within(screen.getByTestId('form-field')).queryByTestId('ff-error')).not.toBeInTheDocument();
  });

  it('clears a wrong-password error when the file is removed, so a re-selected file starts clean', async () => {
    const onSubmit = jest.fn();
    mockDecrypt.mockResolvedValueOnce('this-is-not-the-check');
    const { container } = renderScreen({ onSubmit });
    uploadViaInput(container, 'wallet-a.json', { mode: 'load', content: VALID_WALLET_JSON });

    await submit(container);

    const ffError = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(ffError()).toHaveTextContent('incorrectPassword'));

    // Remove the file, then select a different one WITHOUT submitting again.
    clearStagedFile(container);
    uploadViaInput(container, 'wallet-b.json', { mode: 'load', content: VALID_WALLET_JSON });

    expect(screen.getByText('wallet-b.json')).toBeInTheDocument();
    expect(within(screen.getByTestId('form-field')).queryByTestId('ff-error')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Submit button enabled/disabled + error caption once a file is loaded.
// ---------------------------------------------------------------------------
describe('submit button + error caption (file loaded)', () => {
  it('enables submit when the form is valid and a file is loaded', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    expect(screen.getByTestId('submit-button')).toBeEnabled();
  });

  it('pins type="submit" (the canonical Button defaults to type="button")', () => {
    renderScreen();
    expect(screen.getByTestId('submit-button')).toHaveAttribute('type', 'submit');
  });

  it('keeps submit disabled when the form is invalid even with a file loaded', () => {
    mockFormState = { errors: {}, isSubmitting: false, isValid: false };
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    expect(screen.getByTestId('submit-button')).toBeDisabled();
  });

  it('surfaces the react-hook-form password error when there is no wrong-password state', () => {
    mockFormState = { errors: { password: { message: 'Required field' } }, isSubmitting: false, isValid: false };
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    expect(within(screen.getByTestId('form-field')).getByTestId('ff-error')).toHaveTextContent('Required field');
  });
});

// ---------------------------------------------------------------------------
// handleImportSubmit guards.
// ---------------------------------------------------------------------------
describe('handleImportSubmit guards', () => {
  it('is a no-op when submitted before any file is staged', async () => {
    const onSubmit = jest.fn();
    const { container } = renderScreen({ onSubmit });
    await submit(container);
    expect(mockGenerateKey).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is a no-op when no onSubmit callback is provided', async () => {
    const { container } = renderScreen(); // onSubmit undefined
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });
    await submit(container);
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Decryption flow.
// ---------------------------------------------------------------------------
describe('decryption flow', () => {
  const loadFile = (container: HTMLElement) =>
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });

  it('parses the complete payload before importing both databases and forwards that one payload', async () => {
    const onSubmit = jest.fn();
    mockWatchPassword = 'secret';
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(VERSION_TWO_PAYLOAD));
    expect(mockGenerateKey).toHaveBeenCalledWith('secret');
    // salt object -> Object.values -> Uint8Array
    expect(mockDeriveKey).toHaveBeenCalledWith('pass-key', new Uint8Array([10, 20, 30]));
    expect(mockDecrypt).toHaveBeenCalledWith({ dt: 'check-dt', iv: 'check-iv' }, 'derived-key');
    expect(mockDecryptJson).toHaveBeenCalledWith({ dt: 'payload-dt', iv: 'payload-iv' }, 'derived-key');
    expect(mockImportStore).toHaveBeenCalledWith('miden-client-db');
    expect(mockImportDb).toHaveBeenCalledWith('wallet-db');
  });

  it('refuses a file too large to be a backup before reading it', async () => {
    const { container } = renderScreen();

    // 64 MiB + 1: decoding and parsing happen on the UI thread, so the size is
    // checked before FileReader is constructed at all.
    uploadViaInput(container, 'huge.json', undefined, 64 * 1024 * 1024 + 1);

    expect(alertSpy).toHaveBeenCalledWith('encryptedWalletFileTooLarge');
    expect(fileReaderQueue).toHaveLength(0);
    expect(screen.queryByText('huge.json')).not.toBeInTheDocument();
  });

  it('holds the lane from the first submit, before decryption finishes', async () => {
    const onSubmit = jest.fn();
    let finishDerive!: (key: string) => void;
    mockDeriveKey.mockImplementationOnce(() => new Promise<string>(resolve => (finishDerive = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);
    // The second submit arrives while key derivation is still running, which is
    // the longest part of the handler and was outside the lane before.
    await submit(container);
    await act(async () => finishDerive('derived-key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockDeriveKey).toHaveBeenCalledTimes(1);
    expect(mockImportStore).toHaveBeenCalledTimes(1);
  });

  it('runs one restore at a time, whichever way the form is submitted', async () => {
    const onSubmit = jest.fn();
    let finishImport!: () => void;
    mockImportStore.mockImplementationOnce(() => new Promise<void>(resolve => (finishImport = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);
    // Enter in the password field submits the form again while the first
    // restore is still replacing both databases.
    await submit(container);
    await act(async () => finishImport());

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mockImportStore).toHaveBeenCalledTimes(1);
    expect(mockImportDb).toHaveBeenCalledTimes(1);
  });

  it('abandons a restore whose file was cleared while it was still decrypting', async () => {
    const onSubmit = jest.fn();
    let finishDerive!: (key: string) => void;
    mockDeriveKey.mockImplementationOnce(() => new Promise<string>(resolve => (finishDerive = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    await act(async () => finishDerive('derived-key'));

    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not advance onboarding after the screen is left', async () => {
    // Back out of the step and the restore keeps running; it must not pull the
    // user into the confirmation screen for the file they just abandoned.
    const onSubmit = jest.fn();
    let finishStoreSwap!: () => void;
    mockImportStore.mockImplementationOnce(() => new Promise<void>(resolve => (finishStoreSwap = resolve)));
    const { container, unmount } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    unmount();
    await act(async () => finishStoreSwap());

    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not show a discarded file failure against the file staged after it', async () => {
    const onSubmit = jest.fn();
    let finishDerive!: (key: string) => void;
    mockDeriveKey.mockImplementationOnce(() => new Promise<string>(resolve => (finishDerive = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    loadFile(container);
    // Only now does the discarded file's key derivation finish, and its password
    // check fails. That verdict belongs to a file the user already discarded.
    mockDecrypt.mockResolvedValueOnce('not-the-check-value');
    await act(async () => finishDerive('derived-key'));

    expect(screen.queryByText('incorrectPassword')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stops writing when the file is cleared mid-restore, and holds the lane until that run ends', async () => {
    const onSubmit = jest.fn();
    let finishStoreSwap!: () => void;
    mockImportStore.mockImplementationOnce(() => new Promise<void>(resolve => (finishStoreSwap = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    // A second file cannot start while the discarded restore is still writing,
    // and the button says so rather than swallowing the press.
    loadFile(container);
    expect(screen.getByTestId('submit-button')).toBeDisabled();
    expect(screen.getByTestId('submit-button')).toHaveAttribute('data-loading', 'true');
    await submit(container);
    await act(async () => finishStoreSwap());

    expect(mockImportStore).toHaveBeenCalledTimes(1);
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The lane is released when that run ends, so the staged file can be restored.
    expect(screen.getByTestId('submit-button')).toBeEnabled();
  });

  it('does not advance onboarding with a file cleared while its restore was running', async () => {
    const onSubmit = jest.fn();
    let finishImport!: () => void;
    mockImportStore.mockImplementationOnce(() => new Promise<void>(resolve => (finishImport = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    await act(async () => finishImport());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps versioned imported account bindings inside the parsed payload', async () => {
    const onSubmit = jest.fn();
    const importedAccount = { ...VALID_ACCOUNT, publicKey: 'imported', name: 'Imported', hdIndex: -1 };
    const payload: DecryptedWalletFile = {
      ...VERSION_TWO_PAYLOAD,
      accounts: [VALID_ACCOUNT, importedAccount],
      importedAccounts: [
        { accountId: 'imported', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
      ]
    };
    mockDecryptJson.mockResolvedValueOnce(payload);
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(payload));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('lets the same file be chosen again after Clear', async () => {
    // The picker raises no change event for an unchanged value, so a screen that
    // keeps the old value silently ignores the most common retry there is.
    const { container } = renderScreen({});
    loadFile(container);
    expect(screen.getByText('wallet.json')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('does not stage a file whose read the user has already superseded', async () => {
    // The onload guard's own branch: a slow SUCCESSFUL read for a file the user
    // replaced must not stage itself over the newer selection.
    const { container } = renderScreen({});
    fileReaderQueue.push({ mode: 'load', content: VALID_WALLET_JSON, deferred: true });
    uploadViaInput(container, 'first.json');
    fileReaderQueue.push({ mode: 'load', content: VALID_WALLET_JSON });
    uploadViaInput(container, 'second.json');

    await act(async () => {
      pendingReads.forEach(settle => settle());
    });

    expect(screen.getByText('second.json')).toBeInTheDocument();
    expect(screen.queryByText('first.json')).not.toBeInTheDocument();
  });

  it('stops before the store swap when the file is cleared during the client build', async () => {
    // The first gate inside importParsedWallet: the client build is the longest
    // parking await before anything is written.
    const onSubmit = jest.fn();
    let finishClientBuild!: () => void;
    mockGetMidenClient.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishClientBuild = () =>
            resolve({ importDb: mockImportStore, client: { storeIdentifier: mockStoreIdentifier } });
        })
    );
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    await act(async () => finishClientBuild());

    expect(mockImportStore).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not advance onboarding when the file is cleared during the wallet-db import', async () => {
    // The last gate: both databases have been written by now, so the only thing
    // left to withhold is the onboarding advance.
    const onSubmit = jest.fn();
    let finishWalletDb!: () => void;
    mockImportDb.mockImplementationOnce(() => new Promise<void>(resolve => (finishWalletDb = resolve)));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);
    await submit(container);

    await waitFor(() => expect(mockImportDb).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    await act(async () => finishWalletDb());

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not alert for a read the user has already superseded', async () => {
    // A real read is asynchronous: select one file, pick another before the first
    // settles, and the first file's failure belongs to nobody.
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = renderScreen({});
    fileReaderQueue.push({ mode: 'error', deferred: true });
    uploadViaInput(container, 'first.json');
    fileReaderQueue.push({ mode: 'load', content: VALID_WALLET_JSON });
    uploadViaInput(container, 'second.json');

    await act(async () => {
      pendingReads.forEach(settle => settle());
    });

    expect(alertSpy).not.toHaveBeenCalledWith('encryptedWalletFileReadFailed');
    alertSpy.mockRestore();
  });

  it('restores the miden-client dump through the client interface, inside the realm lock', async () => {
    // Regression for #253: the dump belongs in the client's OWN store, so the
    // restore goes through the interface that owns the store name rather than
    // naming one itself. Asserting the labelled hold is what pins that: a
    // component that imported into a literal store name would not take it.
    const onSubmit = jest.fn();
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(mockImportStore).toHaveBeenCalled());
    expect(mockImportStore).toHaveBeenCalledWith('miden-client-db');
    expect(mockWithWasmClientLock).toHaveBeenCalledWith(expect.any(Function), {
      label: 'onboarding-restore-import-store'
    });
  });

  it('defaults filePassword to an empty string when the watched value is undefined', async () => {
    const onSubmit = jest.fn();
    mockWatchPassword = undefined;
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(mockGenerateKey).toHaveBeenCalledWith(''));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('completes a valid legacy payload directly when no imported accounts were omitted', async () => {
    const onSubmit = jest.fn();
    const legacyPayload: DecryptedWalletFile = {
      seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [{ ...VALID_ACCOUNT, name: 'A' }]
    };
    mockDecryptJson.mockResolvedValueOnce(legacyPayload);
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(legacyPayload));
    expect(screen.queryByText(/encryptedFileImportedAccountsOmitted/)).not.toBeInTheDocument();
  });

  it('shows the wrong-password error when the password check does not match', async () => {
    const onSubmit = jest.fn();
    mockDecrypt.mockResolvedValueOnce('this-is-not-the-check');
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() =>
      expect(within(screen.getByTestId('form-field')).getByTestId('ff-error')).toHaveTextContent('incorrectPassword')
    );
    expect(mockDecryptJson).not.toHaveBeenCalled();
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the wrong-password error and logs when decryption throws', async () => {
    const onSubmit = jest.fn();
    mockDecrypt.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() =>
      expect(within(screen.getByTestId('form-field')).getByTestId('ff-error')).toHaveTextContent('incorrectPassword')
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('Decryption failed:', expect.any(Error));
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports a corrupt encrypted payload as malformed after the password check succeeds', async () => {
    const onSubmit = jest.fn();
    mockDecryptJson.mockRejectedValueOnce(new Error('authentication failed'));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    const error = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(error()).toHaveTextContent('encryptedWalletFileMalformed'));
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a distinct restore error (not wrong password) when the miden-client init fails on the correct password', async () => {
    // Regression for the #364 review finding: with the correct password the
    // decryption succeeds, so a client/store/import failure must NOT be
    // reported as "Wrong password" (which sent users into an infinite retry
    // loop with the right password). It must surface a distinct, actionable
    // restore error instead.
    const onSubmit = jest.fn();
    mockGetMidenClient.mockRejectedValueOnce(new Error('wasm client init failed'));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    const ffError = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(ffError()).toHaveTextContent('encryptedWalletFileRestoreFailed'));
    expect(ffError()).not.toHaveTextContent('incorrectPassword');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Wallet restore failed:', expect.any(Error));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the restore error (not wrong password) when importStore rejects on the correct password', async () => {
    const onSubmit = jest.fn();
    mockImportStore.mockRejectedValueOnce(new Error('idb write failed'));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    const ffError = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(ffError()).toHaveTextContent('encryptedWalletFileRestoreFailed'));
    expect(ffError()).not.toHaveTextContent('incorrectPassword');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects malformed decrypted data before either database import', async () => {
    const onSubmit = jest.fn();
    mockDecryptJson.mockResolvedValueOnce({ ...VERSION_TWO_PAYLOAD, accounts: [{ name: 'Missing fields' }] });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    const error = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(error()).toHaveTextContent('encryptedWalletFileMalformed'));
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports an unsupported future version before either database import', async () => {
    const onSubmit = jest.fn();
    mockDecryptJson.mockResolvedValueOnce({ ...VERSION_TWO_PAYLOAD, formatVersion: 3 });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    const error = () => within(screen.getByTestId('form-field')).getByTestId('ff-error');
    await waitFor(() => expect(error()).toHaveTextContent('encryptedWalletFileUnsupportedVersion'));
    expect(mockGetMidenClient).not.toHaveBeenCalled();
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Two-step confirmation when imported accounts were omitted.
// ---------------------------------------------------------------------------
describe('omitted-accounts two-step confirmation', () => {
  const loadFile = (container: HTMLElement) =>
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });

  it('stages a pending restore, shows the notice, and completes on the second confirm click', async () => {
    const onSubmit = jest.fn();
    const legacyPayload: DecryptedWalletFile = {
      seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [{ ...VALID_ACCOUNT, name: 'Kept' }],
      omittedImportedAccountCount: 3
    };
    mockDecryptJson.mockResolvedValueOnce(legacyPayload);
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    // First submit: decrypts, but pauses for confirmation instead of completing.
    await submit(container);

    await waitFor(() => expect(screen.getByText('encryptedFileImportedAccountsOmitted:3')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockImportStore).not.toHaveBeenCalled();
    expect(mockImportDb).not.toHaveBeenCalled();

    // The password field is now hidden, the button flips to the confirm label
    // and is force-enabled regardless of form validity.
    expect(screen.queryByTestId('form-field')).not.toBeInTheDocument();
    const button = screen.getByTestId('submit-button');
    expect(button).toHaveTextContent('continueImport');
    expect(button).toBeEnabled();

    // Second submit: imports and forwards the already parsed payload without
    // decrypting or parsing untrusted data again.
    mockGenerateKey.mockClear();
    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(legacyPayload));
    expect(mockImportStore).toHaveBeenCalledWith('mc');
    expect(mockImportDb).toHaveBeenCalledWith('wd');
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });

  it('force-enables the confirm button even when the form reports invalid', async () => {
    mockFormState = { errors: {}, isSubmitting: false, isValid: false };
    const onSubmit = jest.fn();
    mockDecryptJson.mockResolvedValueOnce({
      seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [VALID_ACCOUNT],
      omittedImportedAccountCount: 1
    });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(screen.getByTestId('submit-button')).toBeEnabled());
    expect(screen.getByTestId('submit-button')).toHaveTextContent('continueImport');
  });
});

describe('design-system layout', () => {
  it('draws the step layout with a fill drop zone (no dashed outline) and the Import button pinned', () => {
    const { container } = renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'importWallet' })).toBeInTheDocument();
    const dropzone = getDropzone(container);
    expect(dropzone).toHaveClass('bg-fill', 'rounded-2xl');
    expect(dropzone.className).not.toMatch(/border-dashed/);
    expect(screen.getByRole('button', { name: 'chooseFromDevice' })).toHaveClass('text-accent-tint-ink');
    expect(screen.getByTestId('submit-button').closest('[data-slot="footer"]')).not.toBeNull();
    expect(screen.getByTestId('submit-button')).toHaveAttribute('type', 'submit');
  });
});
