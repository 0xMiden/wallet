import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { importedAccountBackupFailure } from 'lib/miden/backup-file';

import ExportFileComplete, { ExportFileCompleteProps } from './ExportFileComplete';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back, with any interpolation argument folded in, so a
// test can assert the one detail the failure copy carries: which account could
// not be backed up.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.accountName === undefined ? key : `${key}:${String(options.accountName)}`
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <div data-testid="icon">{name}</div>,
  IconName: { Success: 'Success', Close: 'Close' }
}));

// The shared 64px outcome circle (the one transaction outcomes use): a marker exposing its state.
jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-icon" data-state={state} />
}));

jest.mock('components/Button', () => ({
  Button: ({ onClick, title }: { onClick?: () => void; title: string }) => (
    <button data-testid="done-button" onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

// Keep the legacy fields until the RED run proves the old exporter still uses
// them. The version 2 implementation must use only the authenticated snapshot.
const mockRevealMnemonic = jest.fn();
let mockAccounts: Array<{ name: string; hdIndex: number }> = [];
const mockExportWalletBackupMaterial = jest.fn();

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    revealMnemonic: mockRevealMnemonic,
    accounts: mockAccounts,
    exportWalletBackupMaterial: mockExportWalletBackupMaterial
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
  isMobile: () => mockIsMobile(),
  isAndroid: () => false
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
  let createdBlob: Blob | null;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'HD 1', hdIndex: 1 }
    ];

    mockExportWalletBackupMaterial.mockResolvedValue({
      seedPhrase: 'seed words twelve',
      midenClientDbContent: 'MIDEN_DB_DUMP',
      walletDbContent: 'WALLET_DB_DUMP',
      accounts: mockAccounts,
      importedAccounts: []
    });
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
    createdBlob = null;
    (global.URL.createObjectURL as unknown) = jest.fn((blob: Blob) => {
      createdBlob = blob;
      return 'blob:mock-url';
    });
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
    expect(mockExportWalletBackupMaterial).toHaveBeenCalledTimes(1);
  });

  it('renders the success icon, titles, descriptions and the Done button', async () => {
    renderComponent();

    await screen.findByText('encryptedWalletFileExportedTitle1');
    expect(screen.getByTestId('hero-icon')).toHaveAttribute('data-state', 'success');
    // The outcome is the shared Hero: its title is the 24px h2, the copy under it muted.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('encryptedWalletFileExportedTitle1');
    expect(screen.getByText('encryptedWalletFileExportedDesc1').parentElement).toHaveClass(
      'text-body-sm',
      'text-muted'
    );
    // Done is pinned in the SubPageLayout footer, not in the scrolling body.
    const page = screen.getByTestId('export-file-complete');
    expect(page.querySelector('[data-slot="footer"]')).toContainElement(screen.getByTestId('done-button'));
    expect(screen.getByText('encryptedWalletFileExportedTitle1')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedTitle2')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc1')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc2')).toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportedDesc3')).toBeInTheDocument();
    expect(screen.getByTestId('done-button')).toHaveTextContent('done');

    // Let the mount effect settle so no act() warnings leak into later tests.
    await waitFor(() => expect(mockEncryptJson).toHaveBeenCalled());
  });

  it('does not render the legacy omission warning for a successful version 2 export', async () => {
    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'Imported A', hdIndex: -1 },
      { name: 'Imported B', hdIndex: -1 }
    ];
    mockExportWalletBackupMaterial.mockResolvedValueOnce({
      seedPhrase: 'seed words twelve',
      midenClientDbContent: 'MIDEN_DB_DUMP',
      walletDbContent: 'WALLET_DB_DUMP',
      accounts: mockAccounts,
      importedAccounts: [
        { accountId: 'imported-a', publicKeyCommitment: 'a1b2', authScheme: 'falcon', secretKeyHex: '0102' },
        { accountId: 'imported-b', publicKeyCommitment: 'c3d4', authScheme: 'ecdsa', secretKeyHex: '0304' }
      ]
    });

    renderComponent();
    await screen.findByText('encryptedWalletFileExportedTitle1');

    expect(screen.queryByText('encryptedFileImportedAccountsOmitted')).not.toBeInTheDocument();
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

  it('builds a complete version 2 payload from one authenticated backend snapshot', async () => {
    mockAccounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'Imported', hdIndex: -1 },
      { name: 'HD 5', hdIndex: 5 }
    ];
    const importedAccounts = [
      { accountId: 'imported', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
    ];
    mockExportWalletBackupMaterial.mockResolvedValueOnce({
      seedPhrase: 'seed words twelve',
      midenClientDbContent: 'MIDEN_DB_DUMP',
      walletDbContent: 'WALLET_DB_DUMP',
      accounts: mockAccounts,
      importedAccounts
    });

    renderComponent();

    await waitFor(() => expect(mockEncryptJson).toHaveBeenCalled());

    expect(mockExportWalletBackupMaterial).toHaveBeenCalledWith('wallet-pass');
    // The wallet dump travels with the snapshot, so the screen takes none of its
    // own: a second read here would be a second point in time in one file.
    expect(mockExportDb).not.toHaveBeenCalled();
    expect(mockRevealMnemonic).not.toHaveBeenCalled();
    expect(mockGetMidenClient).not.toHaveBeenCalled();

    // Key derivation: generateKey(filePassword) → deriveKey(passKey, salt).
    expect(mockGenerateKey).toHaveBeenCalledWith('file-pass');
    expect(mockGenerateSalt).toHaveBeenCalledTimes(1);
    expect(mockDeriveKey).toHaveBeenCalledWith('PASS_KEY', new Uint8Array([1, 2, 3]));

    expect(mockEncryptJson).toHaveBeenCalledWith(
      {
        formatVersion: 2,
        seedPhrase: 'seed words twelve',
        midenClientDbContent: 'MIDEN_DB_DUMP',
        walletDbContent: 'WALLET_DB_DUMP',
        accounts: mockAccounts,
        importedAccounts
      },
      'DERIVED_KEY'
    );

    // The password check is encrypted with the constant sentinel + derived key.
    expect(mockEncrypt).toHaveBeenCalledWith('MidenIsAwesome', 'DERIVED_KEY');
  });

  it('writes an encrypted file that decrypts to the complete version 2 snapshot', async () => {
    const passworder = jest.requireActual<typeof import('lib/miden/passworder')>('lib/miden/passworder');
    const importedAccounts = [
      { accountId: 'imported', publicKeyCommitment: 'a1b2', authScheme: 'falcon' as const, secretKeyHex: '0102' }
    ];
    const accounts = [
      { name: 'HD 0', hdIndex: 0 },
      { name: 'Imported', hdIndex: -1 }
    ];
    mockExportWalletBackupMaterial.mockResolvedValueOnce({
      seedPhrase: 'seed words twelve',
      midenClientDbContent: 'MIDEN_DB_DUMP',
      walletDbContent: 'WALLET_DB_DUMP',
      accounts,
      importedAccounts
    });
    mockGenerateKey.mockImplementation(passworder.generateKey);
    let derivedKey: CryptoKey | undefined;
    mockDeriveKey.mockImplementation(async (key: CryptoKey, salt: Uint8Array) => {
      derivedKey = await passworder.deriveKey(key, salt, 1_000);
      return derivedKey;
    });
    mockEncryptJson.mockImplementation(passworder.encryptJson);
    mockEncrypt.mockImplementation(passworder.encrypt);

    renderComponent();
    await waitFor(() => expect(createdBlob).not.toBeNull());

    const fileContent = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(createdBlob!);
    });
    const encryptedFile = JSON.parse(fileContent);
    const payload = await passworder.decryptJson({ dt: encryptedFile.dt, iv: encryptedFile.iv }, derivedKey!);
    expect(payload).toEqual({
      formatVersion: 2,
      seedPhrase: 'seed words twelve',
      midenClientDbContent: 'MIDEN_DB_DUMP',
      walletDbContent: 'WALLET_DB_DUMP',
      accounts,
      importedAccounts
    });
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
    // A failure AFTER the snapshot: the dump now travels with it, so the
    // serialization that can still throw here is the file encryption.
    const error = new Error('Do not know how to serialize a BigInt');
    mockEncryptJson.mockRejectedValue(error);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();

    await waitFor(() => expect(screen.getByText('encryptedWalletFileExportFailedTitle')).toBeInTheDocument());

    // The success claim is gone — not merely accompanied by an error.
    expect(screen.queryByText('encryptedWalletFileExportedTitle1')).not.toBeInTheDocument();
    expect(screen.getByText('encryptedWalletFileExportFailedDesc')).toBeInTheDocument();
    expect(screen.getByTestId('hero-icon')).toHaveAttribute('data-state', 'failed');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to export encrypted wallet file:', error);

    consoleErrorSpy.mockRestore();
  });

  it('creates no download or share result when the authenticated snapshot fails', async () => {
    // The backend names the one account the user can act on through a code; the
    // screen localizes it and never renders the backend's own text.
    mockExportWalletBackupMaterial.mockRejectedValueOnce(new Error(importedAccountBackupFailure('Imported Account')));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();
    await screen.findByText('encryptedWalletFileExportFailedTitle');

    expect(screen.getByText('encryptedWalletFileExportFailedAccount:Imported Account')).toBeInTheDocument();
    expect(mockExportDb).not.toHaveBeenCalled();
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('shows the generic failure description for a backend error it cannot name', async () => {
    mockExportWalletBackupMaterial.mockRejectedValueOnce(new Error('recursive use of an object'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();
    await screen.findByText('encryptedWalletFileExportFailedTitle');

    expect(screen.getByText('encryptedWalletFileExportFailedDesc')).toBeInTheDocument();
    expect(screen.queryByText('recursive use of an object')).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it('still offers a way out of the failure screen', async () => {
    mockExportWalletBackupMaterial.mockRejectedValue(new Error('quota exceeded'));
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

  // Dismissing the share sheet rejects exactly like a real failure does
  // (SharePlugin rejects with "Share canceled" on both platforms), but the file
  // encrypted and wrote fine — only delivery was declined. Reporting that as
  // "nothing was saved" is false, and making the user redo the file password to
  // reach a sheet they can reopen for free is gratuitous.
  describe('share sheet dismissal', () => {
    const cancelShare = () => {
      mockIsMobile.mockReturnValue(true);
      mockShare.mockRejectedValueOnce(new Error('Share canceled'));
      return jest.spyOn(console, 'error').mockImplementation(() => {});
    };

    it('offers to reopen the sheet instead of claiming the export failed', async () => {
      const consoleErrorSpy = cancelShare();

      renderComponent();

      await screen.findByText('encryptedWalletFileNotSavedTitle');
      expect(screen.queryByText('encryptedWalletFileExportFailedTitle')).not.toBeInTheDocument();
      expect(screen.queryByText('encryptedWalletFileExportedTitle1')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });

    it('re-shares the file already on disk without re-running the export', async () => {
      const consoleErrorSpy = cancelShare();

      renderComponent();
      await screen.findByText('encryptedWalletFileNotSavedTitle');

      const exportsBefore = mockExportDb.mock.calls.length;
      const writesBefore = mockWriteFile.mock.calls.length;
      const sharesBefore = mockShare.mock.calls.length;
      mockShare.mockResolvedValueOnce(undefined);
      fireEvent.click(screen.getByText('encryptedWalletFileSaveAgain'));

      await screen.findByText('encryptedWalletFileExportedTitle1');
      // A NEW share call, not merely the earlier one still sitting in the mock:
      // asserting only `toHaveBeenLastCalledWith` also passes when the button
      // opens no sheet at all and just flips the screen to success.
      expect(mockShare.mock.calls.length).toBe(sharesBefore + 1);
      expect(mockShare.mock.calls[sharesBefore]![0]).toEqual(
        expect.objectContaining({ url: 'file:///cache/my-wallet.json' })
      );
      // The mnemonic reveal, key derivation and encryption all succeeded — the
      // retry must not repeat them, only reopen the sheet for the same file.
      expect(mockExportDb.mock.calls.length).toBe(exportsBefore);
      expect(mockWriteFile.mock.calls.length).toBe(writesBefore);

      consoleErrorSpy.mockRestore();
    });

    it('stays recoverable when the reopened sheet is dismissed again', async () => {
      const consoleErrorSpy = cancelShare();

      renderComponent();
      await screen.findByText('encryptedWalletFileNotSavedTitle');

      const sharesBefore = mockShare.mock.calls.length;
      mockShare.mockRejectedValueOnce(new Error('Share canceled'));
      fireEvent.click(screen.getByText('encryptedWalletFileSaveAgain'));

      // Staying put is also what a no-op button does, so pin that the sheet
      // actually reopened before checking where we ended up.
      await waitFor(() => expect(mockShare.mock.calls.length).toBe(sharesBefore + 1));
      expect(await screen.findByText('encryptedWalletFileSaveAgain')).toBeInTheDocument();
      expect(screen.queryByText('encryptedWalletFileExportFailedTitle')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });

    it('falls to the failure screen when the reopened sheet fails for real', async () => {
      const consoleErrorSpy = cancelShare();

      renderComponent();
      await screen.findByText('encryptedWalletFileNotSavedTitle');

      mockShare.mockRejectedValueOnce(new Error('no activity found to handle intent'));
      fireEvent.click(screen.getByText('encryptedWalletFileSaveAgain'));

      await screen.findByText('encryptedWalletFileExportFailedTitle');
      expect(screen.queryByText('encryptedWalletFileNotSavedTitle')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });

    it('treats a genuine share failure as a failure, not a dismissal', async () => {
      mockIsMobile.mockReturnValue(true);
      mockShare.mockRejectedValueOnce(new Error('no activity found to handle intent'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      renderComponent();

      await screen.findByText('encryptedWalletFileExportFailedTitle');
      expect(screen.queryByText('encryptedWalletFileNotSavedTitle')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });

    it('treats a write failure as a failure even if it mentions cancellation', async () => {
      // The file never reached disk, so there is nothing to re-share — the
      // recoverable path must be gated on the write having actually landed.
      mockIsMobile.mockReturnValue(true);
      mockWriteFile.mockRejectedValueOnce(new Error('operation cancelled'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      renderComponent();

      await screen.findByText('encryptedWalletFileExportFailedTitle');
      expect(screen.queryByText('encryptedWalletFileNotSavedTitle')).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Branch: undefined walletPassword is forwarded verbatim to the snapshot
  // -------------------------------------------------------------------------

  it('forwards an undefined walletPassword to exportWalletBackupMaterial', async () => {
    renderComponent({ walletPassword: undefined });

    await waitFor(() => expect(mockExportWalletBackupMaterial).toHaveBeenCalled());
    expect(mockExportWalletBackupMaterial).toHaveBeenCalledWith(undefined);
  });
});
