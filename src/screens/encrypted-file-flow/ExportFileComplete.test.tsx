import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import ExportFileComplete, { ExportFileCompleteProps } from './ExportFileComplete';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back. For the interpolated "omitted accounts"
// message we fold the `importedCount` into the string so the test can assert
// the number reached the template.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { importedCount?: string }) =>
      opts?.importedCount !== undefined ? `${key}:${opts.importedCount}` : key
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <div data-testid="icon">{name}</div>,
  IconName: { Success: 'Success', Close: 'Close' }
}));

jest.mock('components/Button', () => ({
  Button: ({ onClick, title }: { onClick?: () => void; title: string }) => (
    <button data-testid="done-button" onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

// `useMidenContext` — the component reads `revealMnemonic` and `accounts`.
// Both are mutated per-test; the factory reads the mutable bindings at call
// time so each render sees the current values.
const mockRevealMnemonic = jest.fn();
let mockAccounts: Array<{ name: string; hdIndex: number }> = [];

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    revealMnemonic: mockRevealMnemonic,
    accounts: mockAccounts
  })
}));

// passworder — every crypto primitive returns a deterministic sentinel so we
// can trace exactly what the component threads through the encryption pipeline.
const mockGenerateSalt = jest.fn();
const mockGenerateKey = jest.fn();
const mockDeriveKey = jest.fn();
const mockEncryptJson = jest.fn();
const mockEncrypt = jest.fn();

jest.mock('lib/miden/passworder', () => ({
  generateSalt: (...args: unknown[]) => mockGenerateSalt(...args),
  generateKey: (...args: unknown[]) => mockGenerateKey(...args),
  deriveKey: (...args: unknown[]) => mockDeriveKey(...args),
  encryptJson: (...args: unknown[]) => mockEncryptJson(...args),
  encrypt: (...args: unknown[]) => mockEncrypt(...args)
}));

// `lib/miden/repo` — provide a no-op `db.tables` so the global jest.setup.js
// afterEach cleanup (`db.tables.map(t => t.clear())`) doesn't blow up, and a
// mockable `exportDb`.
const mockExportDb = jest.fn();

jest.mock('lib/miden/repo', () => ({
  db: { tables: [] },
  exportDb: (...args: unknown[]) => mockExportDb(...args)
}));

const mockMidenClientExportDb = jest.fn();
const mockGetMidenClient = jest.fn();

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  // Run the locked callback synchronously (inline) in tests.
  withWasmClientLock: (cb: () => unknown) => cb()
}));

const mockIsMobile = jest.fn();

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

const mockWriteFile = jest.fn();
const mockShare = jest.fn();

jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: (...args: unknown[]) => mockWriteFile(...args) }
}));

jest.mock('@capacitor/share', () => ({
  Share: { share: (...args: unknown[]) => mockShare(...args) }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseProps: ExportFileCompleteProps = {
  onGoBack: jest.fn(),
  onDone: jest.fn(),
  filePassword: 'file-pass',
  fileName: 'my-wallet',
  walletPassword: 'wallet-pass'
};

const renderComponent = (overrides: Partial<ExportFileCompleteProps> = {}) =>
  render(<ExportFileComplete {...baseProps} {...overrides} />);

describe('ExportFileComplete', () => {
  let clickSpy: jest.SpyInstance;
  let clickedAnchor: HTMLAnchorElement | null;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'HD 1', hdIndex: 1 }
    ];

    mockRevealMnemonic.mockResolvedValue('seed words twelve');
    mockGenerateSalt.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockGenerateKey.mockResolvedValue('PASS_KEY');
    mockDeriveKey.mockResolvedValue('DERIVED_KEY');
    mockEncryptJson.mockResolvedValue({ dt: 'PAYLOAD_DT', iv: 'PAYLOAD_IV' });
    mockEncrypt.mockResolvedValue({ dt: 'CHECK_DT', iv: 'CHECK_IV' });
    mockExportDb.mockResolvedValue('WALLET_DB_DUMP');
    mockMidenClientExportDb.mockResolvedValue('MIDEN_DB_DUMP');
    mockGetMidenClient.mockResolvedValue({ exportDb: mockMidenClientExportDb });
    mockIsMobile.mockReturnValue(false);
    mockWriteFile.mockResolvedValue({ uri: 'file:///cache/my-wallet.json' });
    mockShare.mockResolvedValue(undefined);

    // jsdom doesn't implement the object-URL APIs; stub them so the desktop
    // download path can run without throwing.
    (global.URL.createObjectURL as unknown) = jest.fn(() => 'blob:mock-url');
    (global.URL.revokeObjectURL as unknown) = jest.fn();

    // Anchor.click() would try to navigate in jsdom; capture the anchor and
    // suppress the navigation instead.
    clickedAnchor = null;
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = this;
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  // "Exported!" is only rendered once the file has actually been written, so
  // every success assertion has to let the export settle first. Before the
  // screen showed a spinner, it claimed success on mount — while the export was
  // still running, and even if it then failed.
  it('shows progress until the export lands, then the success screen', async () => {
    renderComponent();

    expect(screen.getByText('encryptedWalletFileExporting')).toBeInTheDocument();
    expect(screen.queryByText('encryptedWalletFileExportedTitle1')).not.toBeInTheDocument();

    await screen.findByText('encryptedWalletFileExportedTitle1');
    expect(screen.queryByText('encryptedWalletFileExporting')).not.toBeInTheDocument();
  });

  it('runs the export once even though finishing it re-renders the screen', async () => {
    // `getExportFile` closes over `exportableAccounts`, whose identity is only as
    // stable as the context array behind it. Without a mount guard, the re-render
    // caused by reporting success re-runs the entire export — re-deriving the
    // mnemonic, re-encrypting, and on mobile opening a second share sheet.
    renderComponent();
    await screen.findByText('encryptedWalletFileExportedTitle1');

    expect(mockEncryptJson).toHaveBeenCalledTimes(1);
    expect(mockRevealMnemonic).toHaveBeenCalledTimes(1);
  });

  it('renders the success icon, titles, descriptions and the Done button', async () => {
    renderComponent();

    await screen.findByText('encryptedWalletFileExportedTitle1');
    expect(screen.getByTestId('icon')).toHaveTextContent('Success');
    expect(screen.getByText('encryptedWalletFileExportedTitle1')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedTitle2')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc1')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc2')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc3')).toBeInTheDocument();
    expect(screen.getByTestId('done-button')).toHaveTextContent('done');

    // Let the mount effect settle so no act() warnings leak into later tests.
    await waitFor(() => expect(mockEncryptJson).toHaveBeenCalled());
  });

  it('does not render the omitted-imported-accounts warning when none are omitted', async () => {
    renderComponent();

    expect(screen.queryByText(/encryptedFileImportedAccountsOmitted/)).not.toBeInTheDocument();

    await waitFor(() => expect(mockEncryptJson).toHaveBeenCalled());
  });

  it('renders the omitted-imported-accounts warning with the omitted count', async () => {
    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'Imported A', hdIndex: -1 },
      { name: 'Imported B', hdIndex: -1 }
    ];

    renderComponent();
    await screen.findByText('encryptedWalletFileExportedTitle1');

    // Two accounts have hdIndex < 0 → the warning surfaces "2".
    expect(screen.getByText('encryptedFileImportedAccountsOmitted:2')).toBeInTheDocument();
  });

  it('invokes onDone when the Done button is clicked', async () => {
    const onDone = jest.fn();
    renderComponent({ onDone });
    await screen.findByText('encryptedWalletFileExportedTitle1');

    fireEvent.click(screen.getByTestId('done-button'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Encryption pipeline (shared by both platforms)
  // -------------------------------------------------------------------------

  it('builds the encrypted payload from db dumps, mnemonic and exportable accounts', async () => {
    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'Imported', hdIndex: -1 },
      { name: 'HD 5', hdIndex: 5 }
    ];

    renderComponent();

    await waitFor(() => expect(mockEncryptJson).toHaveBeenCalled());

    // WASM db dump comes through the client lock; wallet db + mnemonic through
    // their own helpers (mnemonic keyed off the wallet password).
    expect(mockGetMidenClient).toHaveBeenCalledTimes(1);
    expect(mockMidenClientExportDb).toHaveBeenCalledTimes(1);
    expect(mockExportDb).toHaveBeenCalledTimes(1);
    expect(mockRevealMnemonic).toHaveBeenCalledWith('wallet-pass');

    // Key derivation: generateKey(filePassword) → deriveKey(passKey, salt).
    expect(mockGenerateKey).toHaveBeenCalledWith('file-pass');
    expect(mockGenerateSalt).toHaveBeenCalledTimes(1);
    expect(mockDeriveKey).toHaveBeenCalledWith('PASS_KEY', new Uint8Array([1, 2, 3]));

    // Imported (hdIndex < 0) accounts are stripped; the count is carried
    // alongside so the restore side can warn.
    expect(mockEncryptJson).toHaveBeenCalledWith(
      {
        seedPhrase: 'seed words twelve',
        midenClientDbContent: 'MIDEN_DB_DUMP',
        walletDbContent: 'WALLET_DB_DUMP',
        accounts: [
          { name: 'HD 0', hdIndex: 0 },
          { name: 'HD 5', hdIndex: 5 }
        ],
        omittedImportedAccountCount: 1
      },
      'DERIVED_KEY'
    );

    // The password check is encrypted with the constant sentinel + derived key.
    expect(mockEncrypt).toHaveBeenCalledWith('MidenIsAwesome', 'DERIVED_KEY');
  });

  // -------------------------------------------------------------------------
  // Desktop download path (isMobile === false)
  // -------------------------------------------------------------------------

  it('downloads the encrypted file via a temporary anchor on desktop', async () => {
    const appendSpy = jest.spyOn(document.body, 'appendChild');
    const removeSpy = jest.spyOn(document.body, 'removeChild');

    renderComponent();

    await waitFor(() => expect(global.URL.revokeObjectURL).toHaveBeenCalled());

    // Mobile plugins untouched on desktop.
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();

    // A blob URL is created and later revoked.
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    // The anchor was appended, clicked and removed, wired to the blob URL and
    // the "<fileName>.json" download name.
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor!.download).toBe('my-wallet.json');
    expect(clickedAnchor!.getAttribute('href')).toBe('blob:mock-url');

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Mobile share path (isMobile === true)
  // -------------------------------------------------------------------------

  it('writes to the cache directory and shares the file on mobile', async () => {
    mockIsMobile.mockReturnValue(true);

    renderComponent();

    await waitFor(() => expect(mockShare).toHaveBeenCalled());

    // Desktop download path untouched on mobile.
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();

    expect(mockWriteFile).toHaveBeenCalledWith({
      path: 'my-wallet.json',
      data: JSON.stringify({
        dt: 'PAYLOAD_DT',
        iv: 'PAYLOAD_IV',
        salt: new Uint8Array([1, 2, 3]),
        encryptedPasswordCheck: { dt: 'CHECK_DT', iv: 'CHECK_IV' }
      }),
      directory: 'CACHE',
      encoding: 'utf8'
    });

    expect(mockShare).toHaveBeenCalledWith({
      title: 'my-wallet.json',
      url: 'file:///cache/my-wallet.json',
      dialogTitle: 'saveEncryptedWalletFile'
    });
  });

  it('logs (without throwing) when the mobile file export fails', async () => {
    mockIsMobile.mockReturnValue(true);
    const error = new Error('disk full');
    mockWriteFile.mockRejectedValue(error);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to export file on mobile:', error));

    // Share is never reached when the write throws.
    expect(mockShare).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Failure surface — this screen announces "Exported!" on mount, so a failure
  // that is only logged tells the user a backup exists when no file was written.
  // -------------------------------------------------------------------------

  it('replaces the success screen with a failure screen when the export throws', async () => {
    const error = new Error('Do not know how to serialize a BigInt');
    mockExportDb.mockRejectedValue(error);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();

    await waitFor(() => expect(screen.getByText('encryptedWalletFileExportFailedTitle')).toBeInTheDocument());

    // The success claim is gone — not merely accompanied by an error.
    expect(screen.queryByText('encryptedWalletFileExportedTitle1')).not.toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportFailedDesc')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toHaveTextContent('Close');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to export encrypted wallet file:', error);

    consoleErrorSpy.mockRestore();
  });

  it('still offers a way out of the failure screen', async () => {
    mockExportDb.mockRejectedValue(new Error('quota exceeded'));
    const onDone = jest.fn();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent({ onDone });

    await waitFor(() => expect(screen.getByText('encryptedWalletFileExportFailedTitle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('done-button'));
    expect(onDone).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('reports failure when the mobile write/share leg fails', async () => {
    // On mobile the share sheet IS the delivery — the cache file is not reachable
    // by the user — so a failure there means no backup exists anywhere they can
    // find it, however far the encryption got.
    mockIsMobile.mockReturnValue(true);
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();

    await screen.findByText('encryptedWalletFileExportFailedTitle');
    expect(screen.queryByText('encryptedWalletFileExportedTitle1')).not.toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to export file on mobile:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Branch: undefined walletPassword is forwarded verbatim to revealMnemonic
  // -------------------------------------------------------------------------

  it('forwards an undefined walletPassword to revealMnemonic', async () => {
    renderComponent({ walletPassword: undefined });

    await waitFor(() => expect(mockRevealMnemonic).toHaveBeenCalled());
    expect(mockRevealMnemonic).toHaveBeenCalledWith(undefined);
  });
});
