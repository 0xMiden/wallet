import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK } from 'screens/shared';

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
 *   - `FormField` / `FormSubmitButton` / the v2 icon barrel are thin harnesses
 *     that surface only the props under test (errorCaption, disabled, loading,
 *     children).
 *   - The global `FileReader` is replaced with a synchronous fake so the
 *     `onload` (valid JSON / invalid JSON) and `onerror` arms of `processFiles`
 *     fire deterministically inside React's act() scope.
 *
 * Coverage note: `onUploadFileClick`'s `walletFileRef.current != null` guard has
 * a defensive false arm that is unreachable through the UI — the ref is always
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

jest.mock('@miden-sdk/react/lazy', () => ({
  useImportStore: () => ({
    importStore: (...args: unknown[]) => mockImportStore(...args)
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

// The restore must write the miden-client dump into the same IndexedDB store
// the active client reads from. That store name comes from the client's
// `storeIdentifier()`, so mock `getMidenClient` to hand back a deterministic one.
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args)
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

jest.mock('app/atoms/FormField', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    PASSWORD_ERROR_CAPTION: 'PASSWORD_ERROR_CAPTION',
    default: ReactLib.forwardRef(
      ({ label, errorCaption }: { label?: React.ReactNode; errorCaption?: React.ReactNode }, _ref: unknown) =>
        ReactLib.createElement(
          'div',
          { 'data-testid': 'form-field' },
          ReactLib.createElement('span', { 'data-testid': 'ff-label' }, label),
          errorCaption ? ReactLib.createElement('div', { 'data-testid': 'ff-error' }, errorCaption) : null
        )
    )
  };
});

jest.mock('app/atoms/FormSubmitButton', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ({ children, disabled, loading }: { children: React.ReactNode; disabled?: boolean; loading?: boolean }) =>
      ReactLib.createElement(
        'button',
        {
          type: 'submit',
          'data-testid': 'submit-button',
          'data-loading': String(Boolean(loading)),
          disabled: Boolean(disabled)
        },
        children
      )
  };
});

// ---------------------------------------------------------------------------
// FileReader fake — drives processFiles' onload/onerror synchronously.
// ---------------------------------------------------------------------------
type ReaderJob = { mode: 'load' | 'error'; content?: string };
let fileReaderQueue: ReaderJob[] = [];
const OriginalFileReader = global.FileReader;

class FakeFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: ArrayBuffer | null = null;

  readAsArrayBuffer(_file: unknown) {
    const job = fileReaderQueue.shift() ?? { mode: 'load', content: '{}' };
    if (job.mode === 'error') {
      this.onerror?.();
      return;
    }
    this.result = new TextEncoder().encode(job.content ?? '{}').buffer;
    this.onload?.();
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

const renderScreen = (props: Partial<React.ComponentProps<typeof ImportWalletFileScreen>> = {}) =>
  render(<ImportWalletFileScreen {...props} />);

const getForm = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;
const getDropzone = (container: HTMLElement) => container.querySelector('.border-dashed') as HTMLElement;
const getFileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

// Upload via the hidden <input>'s change event (exercises `onUploadFile`).
const uploadViaInput = (container: HTMLElement, fileName: string, job?: ReaderJob) => {
  if (job) fileReaderQueue.push(job);
  const input = getFileInput(container);
  Object.defineProperty(input, 'files', { value: [{ name: fileName }], configurable: true });
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
  mockWatchPassword = 'pw';
  mockFormState = { errors: {}, isSubmitting: false, isValid: true };

  mockGenerateKey.mockResolvedValue('pass-key');
  mockDeriveKey.mockResolvedValue('derived-key');
  mockDecrypt.mockResolvedValue(ENCRYPTED_WALLET_FILE_PASSWORD_CHECK);
  mockDecryptJson.mockResolvedValue({
    seedPhrase: 'seed phrase words',
    midenClientDbContent: 'miden-client-db',
    walletDbContent: 'wallet-db',
    accounts: [{ name: 'Account 1' }],
    omittedImportedAccountCount: 0
  });
  mockImportStore.mockResolvedValue(undefined);
  mockImportDb.mockResolvedValue(undefined);
  mockStoreIdentifier.mockResolvedValue('MidenClientDB_mtst');
  mockGetMidenClient.mockResolvedValue({ client: { storeIdentifier: mockStoreIdentifier } });

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
    expect(getFileInput(container)).toBeInTheDocument();
    // No password field and no notice before a file is loaded.
    expect(screen.queryByTestId('form-field')).not.toBeInTheDocument();
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
});

// ---------------------------------------------------------------------------
// Drag & drop handlers.
// ---------------------------------------------------------------------------
describe('drag handlers', () => {
  it('highlights the drop zone on drag enter', () => {
    const { container } = renderScreen();
    const dropzone = getDropzone(container);
    expect(dropzone.className).not.toContain('border-blue-500');

    fireEvent.dragEnter(dropzone);
    expect(getDropzone(container).className).toContain('border-blue-500');
  });

  it('drag over is a no-op that prevents the browser default', () => {
    const { container } = renderScreen();
    fireEvent.dragEnter(getDropzone(container));
    // dragOver just calls preventDefault; highlight stays on.
    fireEvent.dragOver(getDropzone(container));
    expect(getDropzone(container).className).toContain('border-blue-500');
  });

  it('clears the highlight on drag leave when leaving to a non-child target', () => {
    const { container } = renderScreen();
    fireEvent.dragEnter(getDropzone(container));
    expect(getDropzone(container).className).toContain('border-blue-500');

    fireEvent.dragLeave(getDropzone(container), { relatedTarget: document.body });
    expect(getDropzone(container).className).not.toContain('border-blue-500');
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

    expect(getDropzone(container).className).toContain('border-blue-500');
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
    expect(alertSpy).toHaveBeenCalledWith('Select 1 file');
  });

  it('alerts when the file extension is not .json', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.txt');
    expect(alertSpy).toHaveBeenCalledWith('File type must be .json');
    // No reader work happened -> no file staged.
    expect(screen.queryByText('wallet.txt')).not.toBeInTheDocument();
  });

  it('alerts and logs when the file contains invalid JSON', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'broken.json', { mode: 'load', content: 'not-json{' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('Invalid JSON file');
    expect(screen.queryByText('broken.json')).not.toBeInTheDocument();
  });

  it('alerts when the FileReader itself errors', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'error' });
    expect(alertSpy).toHaveBeenCalledWith('Error with file reader');
  });

  it('stages a valid JSON file and shows the password field + clear button', () => {
    const { container } = renderScreen();
    uploadViaInput(container, 'wallet.json', { mode: 'load', content: VALID_WALLET_JSON });

    expect(screen.getByText('wallet.json')).toBeInTheDocument();
    expect(screen.getByTestId('icon-UploadedFile')).toBeInTheDocument();
    expect(screen.getByTestId('form-field')).toBeInTheDocument();
    expect(screen.getByText('enterDecryptionPassword')).toBeInTheDocument();
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

  it('threads the salt/password through the crypto pipeline and completes when no accounts were omitted', async () => {
    const onSubmit = jest.fn();
    mockWatchPassword = 'secret';
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('seed phrase words', [{ name: 'Account 1' }]));
    expect(mockGenerateKey).toHaveBeenCalledWith('secret');
    // salt object -> Object.values -> Uint8Array
    expect(mockDeriveKey).toHaveBeenCalledWith('pass-key', new Uint8Array([10, 20, 30]));
    expect(mockDecrypt).toHaveBeenCalledWith({ dt: 'check-dt', iv: 'check-iv' }, 'derived-key');
    expect(mockDecryptJson).toHaveBeenCalledWith({ dt: 'payload-dt', iv: 'payload-iv' }, 'derived-key');
    expect(mockImportStore).toHaveBeenCalledWith('miden-client-db', 'MidenClientDB_mtst');
    expect(mockImportDb).toHaveBeenCalledWith('wallet-db');
  });

  it('restores the miden-client dump into the active client store name, not the hardcoded "miden-wallet"', async () => {
    // Regression for #253: the export path writes the dump into the client's
    // own store (`storeIdentifier()` -> `MidenClientDB_<network>`), so the
    // restore must target that exact store or the running client keeps reading
    // its empty DB and balances stay 0.
    const onSubmit = jest.fn();
    mockStoreIdentifier.mockResolvedValue('MidenClientDB_mtst');
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(mockImportStore).toHaveBeenCalled());
    expect(mockImportStore).toHaveBeenCalledWith('miden-client-db', 'MidenClientDB_mtst');
    expect(mockImportStore).not.toHaveBeenCalledWith('miden-client-db', 'miden-wallet');
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

  it('completes directly when omittedImportedAccountCount is absent (?? 0 branch)', async () => {
    const onSubmit = jest.fn();
    mockDecryptJson.mockResolvedValueOnce({
      seedPhrase: 'seed',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [{ name: 'A' }]
      // omittedImportedAccountCount intentionally absent
    });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('seed', [{ name: 'A' }]));
    expect(screen.queryByText(/encryptedFileImportedAccountsOmittedRestoreNotice/)).not.toBeInTheDocument();
  });

  it('shows the wrong-password error when the password check does not match', async () => {
    const onSubmit = jest.fn();
    mockDecrypt.mockResolvedValueOnce('this-is-not-the-check');
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() =>
      expect(within(screen.getByTestId('form-field')).getByTestId('ff-error')).toHaveTextContent('Wrong password')
    );
    expect(mockDecryptJson).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the wrong-password error and logs when decryption throws', async () => {
    const onSubmit = jest.fn();
    mockDecrypt.mockRejectedValueOnce(new Error('boom'));
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() =>
      expect(within(screen.getByTestId('form-field')).getByTestId('ff-error')).toHaveTextContent('Wrong password')
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('Decryption failed:', expect.any(Error));
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
    await waitFor(() => expect(ffError()).toHaveTextContent("Couldn't restore the wallet. Please try again."));
    expect(ffError()).not.toHaveTextContent('Wrong password');
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
    await waitFor(() => expect(ffError()).toHaveTextContent("Couldn't restore the wallet. Please try again."));
    expect(ffError()).not.toHaveTextContent('Wrong password');
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
    mockDecryptJson.mockResolvedValueOnce({
      seedPhrase: 'restored seed',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [{ name: 'Kept' }],
      omittedImportedAccountCount: 3
    });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    // First submit: decrypts, but pauses for confirmation instead of completing.
    await submit(container);

    await waitFor(() =>
      expect(screen.getByText('encryptedFileImportedAccountsOmittedRestoreNotice:3')).toBeInTheDocument()
    );
    expect(onSubmit).not.toHaveBeenCalled();

    // The password field is now hidden, the button flips to the confirm label
    // and is force-enabled regardless of form validity.
    expect(screen.queryByTestId('form-field')).not.toBeInTheDocument();
    const button = screen.getByTestId('submit-button');
    expect(button).toHaveTextContent('continueImport');
    expect(button).toBeEnabled();

    // Second submit: completes the restore without re-decrypting.
    mockGenerateKey.mockClear();
    await submit(container);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('restored seed', [{ name: 'Kept' }]));
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });

  it('force-enables the confirm button even when the form reports invalid', async () => {
    mockFormState = { errors: {}, isSubmitting: false, isValid: false };
    const onSubmit = jest.fn();
    mockDecryptJson.mockResolvedValueOnce({
      seedPhrase: 's',
      midenClientDbContent: 'mc',
      walletDbContent: 'wd',
      accounts: [],
      omittedImportedAccountCount: 1
    });
    const { container } = renderScreen({ onSubmit });
    loadFile(container);

    await submit(container);

    await waitFor(() => expect(screen.getByTestId('submit-button')).toBeEnabled());
    expect(screen.getByTestId('submit-button')).toHaveTextContent('continueImport');
  });
});
