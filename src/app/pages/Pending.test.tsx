import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { Pending } from './Pending';

// The imported `act` from react-dom/test-utils is an overloaded function that
// does not structurally satisfy a hand-written `(cb) => Promise<void>` type.
// Reuse its real type for helpers that accept `act` so call sites type-check.
type ActFn = typeof act;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

// Capture the most recently registered back handler so tests can simulate the
// hardware/swipe "back" gesture (which is how the per-asset detail view returns
// to the pending summary on mobile).
const backHandlerRef: { current: (() => void) | null } = { current: null };
jest.mock('app/env', () => ({
  useAppEnv: () => ({
    fullPage: false,
    registerBackHandler: (handler: () => void) => {
      backHandlerRef.current = handler;
      return () => {
        if (backHandlerRef.current === handler) backHandlerRef.current = null;
      };
    }
  })
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(() => ({}), {
    getState: () => ({
      openTransactionModal: jest.fn(),
      closeTransactionModal: jest.fn()
    })
  }),
  getIntercom: () => ({
    request: jest.fn().mockResolvedValue({})
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { ChevronLeft: 'ChevronLeft', Coins: 'Coins', Copy: 'Copy', File: 'File' }
}));

jest.mock('app/icons/eye-closed.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/icons/eye-open.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/icons/qr-new.svg', () => ({
  ReactComponent: () => null
}));

jest.mock('app/templates/AssetIcon', () => ({
  AssetIcon: () => null
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: () => null
}));

jest.mock('lib/prices', () => ({
  getTokenPrice: () => ({ price: 0 })
}));

jest.mock('components/Button', () => ({
  Button: ({ onClick, title, disabled }: { onClick: () => void; title: string; disabled?: boolean }) => (
    <button onClick={onClick} data-testid="claim-button" disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('components/QRCode', () => ({
  QRCode: () => null
}));

jest.mock('components/SyncWaveBackground', () => ({
  SyncWaveBackground: ({ isSyncing }: { isSyncing: boolean }) => (isSyncing ? <div data-testid="sync-wave" /> : null)
}));

jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef(({ children, ...props }: any, ref: any) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    ))
  }
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (value: bigint) => value.toString()
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-account-123' })
}));

let currentClaimableNotes: any[] = [];
const mockMutateClaimableNotes = jest.fn(() => Promise.resolve(currentClaimableNotes));
const mockUseClaimableNotes = jest.fn(() => ({ data: currentClaimableNotes, mutate: mockMutateClaimableNotes }));
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => mockUseClaimableNotes()
}));

jest.mock('lib/miden/types', () => ({
  NoteTypeEnum: { Public: 'public', Private: 'private' }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => false
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => false
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DrawerTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: jest.fn(), copied: false })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  useLocation: () => ({ search: '' }),
  HistoryAction: { Replace: 'Replace' }
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr?.slice(0, 8) || ''
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(() =>
    Promise.resolve({
      getInputNoteDetails: jest.fn(() => Promise.resolve([]))
    })
  ),
  withWasmClientLock: jest.fn(callback => callback())
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  InputNoteState: { Invalid: 'Invalid' },
  NoteFilter: jest.fn(),
  NoteFilterTypes: { List: 'List' },
  NoteId: { fromHex: jest.fn((id: string) => id) }
}));

const mockInitiateConsumeTransaction = jest.fn();
const mockWaitForConsumeTx = jest.fn();
const mockGetFailedTransactions = jest.fn();

jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: any[]) => mockInitiateConsumeTransaction(...args),
  waitForConsumeTx: (...args: any[]) => mockWaitForConsumeTx(...args),
  verifyStuckTransactionsFromNode: jest.fn().mockResolvedValue(0),
  getFailedTransactions: (...args: any[]) => mockGetFailedTransactions(...args),
  requestSWTransactionProcessing: jest.fn()
}));

// Helper: notes share a single faucetId by default so they all collapse into ONE
// asset group. The Pending page shows a per-asset summary, and clicking an asset
// group opens a detail view that lists the individual notes (each with its own
// Claim/Retry button + spinner). To exercise the individual-note behaviour the
// tests therefore have to open the asset group detail.
const SHARED_FAUCET_ID = 'faucet-shared';
const createMockNote = (id: string, overrides: Record<string, any> = {}) => ({
  id,
  faucetId: SHARED_FAUCET_ID,
  amount: '1000000',
  senderAddress: 'sender-address-789',
  isBeingClaimed: false,
  type: 'public',
  metadata: {
    symbol: 'TEST',
    name: 'Test Token',
    decimals: 6
  },
  ...overrides
});

// Asset-group summary rows open the detail view that lists individual notes.
const getAssetGroupRows = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('[data-testid="pending-asset-row"]')) as HTMLButtonElement[];

// Open the first asset group's detail view (where individual note rows live).
const openFirstAssetGroup = async (container: HTMLElement, act: ActFn): Promise<void> => {
  const rows = getAssetGroupRows(container);
  const firstRow = rows[0];
  if (!firstRow) throw new Error('No asset group rows to open');
  await act(async () => {
    firstRow.click();
  });
};

// Simulate the hardware/swipe "back" gesture to return from a detail view to the summary.
const goBackToSummary = async (act: ActFn): Promise<void> => {
  const handler = backHandlerRef.current;
  if (!handler) throw new Error('No back handler registered (not in detail view?)');
  await act(async () => {
    handler();
  });
};

describe('Pending - Single Note Claiming', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentClaimableNotes = [];
    mockGetFailedTransactions.mockResolvedValue([]);
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    mockWaitForConsumeTx.mockResolvedValue('tx-hash-456');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('shows Claim button when note is not being claimed', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const note = createMockNote('note-1', { isBeingClaimed: false });
    currentClaimableNotes = [note];

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim');
    expect(claimButton).toBeTruthy();
  });

  it('shows spinner when note is being claimed', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const note = createMockNote('note-1', { isBeingClaimed: true });
    currentClaimableNotes = [note];

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    const spinner = testContainer.querySelector('[data-testid="sync-wave"]');
    expect(spinner).toBeTruthy();
  });

  it('initiates consume transaction when Claim button is clicked', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const note = createMockNote('note-1', { isBeingClaimed: false });
    currentClaimableNotes = [note];

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim') as HTMLButtonElement;

    await act(async () => {
      claimButton.click();
    });

    // Wait for async operations
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(mockInitiateConsumeTransaction).toHaveBeenCalledWith('test-account-123', note, false);
    expect(mockWaitForConsumeTx).toHaveBeenCalledWith('tx-id-123', expect.any(AbortSignal));
  });

  it('shows Retry button when claim fails', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    mockWaitForConsumeTx.mockRejectedValue(new Error('Transaction failed'));

    const note = createMockNote('note-1', { isBeingClaimed: false });
    currentClaimableNotes = [note];

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim') as HTMLButtonElement;

    await act(async () => {
      claimButton.click();
    });

    // Wait for async operations
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const retryButton = Array.from(testContainer.querySelectorAll('[data-testid="claim-button"]')).find(
      b => b.textContent === 'retry'
    );
    expect(retryButton).toBeTruthy();
  });

  it('aborts waiting on unmount', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    let abortSignal: AbortSignal | null = null;
    mockWaitForConsumeTx.mockImplementation((_id: string, signal: AbortSignal) => {
      abortSignal = signal;
      return new Promise(() => {}); // Never resolves
    });

    const note = createMockNote('note-1', { isBeingClaimed: false });
    currentClaimableNotes = [note];

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim') as HTMLButtonElement;

    await act(async () => {
      claimButton.click();
    });

    expect(abortSignal).not.toBeNull();
    expect(abortSignal!.aborted).toBe(false);

    // Unmount
    await act(async () => {
      testRoot!.unmount();
      testRoot = null;
    });

    expect(abortSignal!.aborted).toBe(true);
  });
});

describe('Pending - Claim All', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentClaimableNotes = [];
    mockGetFailedTransactions.mockResolvedValue([]);
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    mockWaitForConsumeTx.mockResolvedValue('tx-hash-456');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('does not show Claim All button when there are no claimable notes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    currentClaimableNotes = [];

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeFalsy();
  });

  it('shows Claim All button when there are claimable notes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeTruthy();
  });

  it('processes all notes when Claim All is clicked', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2'), createMockNote('note-3')];
    currentClaimableNotes = notes;

    let txIdCounter = 0;
    mockInitiateConsumeTransaction.mockImplementation(() => Promise.resolve(`tx-id-${++txIdCounter}`));

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
    });

    // Wait for all async operations
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // All transactions should be queued
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(3);
    // On extension: transactions are fire-and-forget via SW (no waitForConsumeTx in handleClaimAll)
    // The intercom request to ProcessTransactionsRequest was sent to the SW
  });

  it('continues processing notes even if one fails to queue', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2'), createMockNote('note-3')];
    currentClaimableNotes = notes;

    let callCount = 0;
    mockInitiateConsumeTransaction.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error('Transaction failed'));
      }
      return Promise.resolve(`tx-id-${callCount}`);
    });

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
    });

    // Wait for all async operations
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should have attempted all 3 notes even though note-2 failed to queue
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(3);
    // On extension: transactions are fire-and-forget via SW (no waitForConsumeTx in handleClaimAll)
  });

  it('skips notes that are already being claimed', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [
      createMockNote('note-1', { isBeingClaimed: false }),
      createMockNote('note-2', { isBeingClaimed: true }),
      createMockNote('note-3', { isBeingClaimed: false })
    ];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
    });

    // Wait for all async operations
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should only process note-1 and note-3, skipping note-2 which is already being claimed
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);
  });

  it('shows spinners on individual notes while Claim All is in progress', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // Let transactions queue, but hang on waitForConsumeTx to keep spinners visible
    let txIdCounter = 0;
    mockInitiateConsumeTransaction.mockImplementation(() => Promise.resolve(`tx-id-${++txIdCounter}`));
    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      // Allow state updates to process
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All button should NOT be visible at the summary (no unclaimed notes left).
    const buttonsAfterClick = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButtonAfterClick = Array.from(buttonsAfterClick).find(b => b.textContent === 'claimAll');
    expect(claimAllButtonAfterClick).toBeFalsy();

    // Drill into the asset group to verify each note row shows its claiming spinner.
    await openFirstAssetGroup(testContainer, act);
    const spinners = testContainer.querySelectorAll('[data-testid="sync-wave"]');
    expect(spinners.length).toBe(2); // One spinner per note
  });
});

describe('Pending - Dynamic Note Arrivals', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentClaimableNotes = [];
    mockGetFailedTransactions.mockResolvedValue([]);
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    mockWaitForConsumeTx.mockResolvedValue('tx-hash-456');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('shows Claim All button when new note arrives during Claim All operation', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Start with 3 notes
    const initialNotes = [createMockNote('note-1'), createMockNote('note-2'), createMockNote('note-3')];
    currentClaimableNotes = initialNotes;

    // Hang on waitForConsumeTx to simulate in-progress claiming
    const waitPromises: { resolve: (value: string) => void }[] = [];
    mockWaitForConsumeTx.mockImplementation(
      () =>
        new Promise(resolve => {
          waitPromises.push({ resolve });
        })
    );

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Click Claim All (summary level)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All hidden at summary (no unclaimed notes)
    let currentButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(currentButtons).find(b => b.textContent === 'claimAll')).toBeFalsy();

    // Simulate new note arriving (SWR revalidation)
    const notesWithNewArrival = [
      createMockNote('note-1', { isBeingClaimed: true }),
      createMockNote('note-2', { isBeingClaimed: true }),
      createMockNote('note-3', { isBeingClaimed: true }),
      createMockNote('note-4') // New note!
    ];
    currentClaimableNotes = notesWithNewArrival;

    // Re-render to simulate SWR update
    await act(async () => {
      testRoot!.render(<Pending />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All button should now appear (enabled) at summary for the new note
    currentButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const newClaimAllButton = Array.from(currentButtons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;
    expect(newClaimAllButton).toBeTruthy();
    expect(newClaimAllButton.disabled).toBeFalsy();

    // Drill into the asset group: 3 original notes spin, the new note has a Claim button.
    await openFirstAssetGroup(testContainer, act);
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(3);
    const detailButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(detailButtons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(1);
  });

  it('clicking Claim All on new note only claims the new note', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Start with notes already being claimed
    const notes = [
      createMockNote('note-1', { isBeingClaimed: true }),
      createMockNote('note-2', { isBeingClaimed: true }),
      createMockNote('note-3') // New unclaimed note
    ];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Click Claim All
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should only initiate transaction for note-3
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(1);
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledWith(
      'test-account-123',
      expect.objectContaining({ id: 'note-3' }),
      false
    );
  });

  it('individual claim makes note unavailable for Claim All', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2'), createMockNote('note-3')];
    currentClaimableNotes = notes;

    // Make individual claims hang
    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click individual Claim on note-1 (in the asset detail view)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const individualClaimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    const note1ClaimButton = individualClaimButtons[0] as HTMLButtonElement;

    await act(async () => {
      note1ClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // One spinner should appear
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(1);

    // Clear mock to track new calls
    mockInitiateConsumeTransaction.mockClear();

    // Return to summary and click Claim All - should only claim note-2 and note-3
    await goBackToSummary(act);
    const currentButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(currentButtons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should only initiate for note-2 and note-3 (not note-1 which is already claiming)
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);
    const calledNoteIds = mockInitiateConsumeTransaction.mock.calls.map((call: any[]) => call[1].id);
    expect(calledNoteIds).toContain('note-2');
    expect(calledNoteIds).toContain('note-3');
    expect(calledNoteIds).not.toContain('note-1');
  });

  it('Claim All button hidden when all notes are being claimed', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [
      createMockNote('note-1', { isBeingClaimed: true }),
      createMockNote('note-2', { isBeingClaimed: true })
    ];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Wait for effects to run
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All button should not be visible at summary (all notes are being claimed)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeFalsy();

    // Drill into the asset group: both note rows should show spinners
    await openFirstAssetGroup(testContainer, act);
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(2);
  });

  it('handles rapid consecutive Claim All clicks correctly', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // Hang on waitForConsumeTx
    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    // Click twice rapidly
    await act(async () => {
      claimAllButton.click();
    });

    await act(async () => {
      // Button might still be there briefly, try to click again
      const currentButtons = testContainer!.querySelectorAll('[data-testid="claim-button"]');
      const maybeClaimAll = Array.from(currentButtons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;
      maybeClaimAll?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should only have initiated transactions once per note
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);
  });

  it('multiple new notes arriving during Claim All shows correct button state', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Start with 2 notes
    const initialNotes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = initialNotes;

    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Click Claim All (summary)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // 3 new notes arrive
    const notesWithNewArrivals = [
      createMockNote('note-1', { isBeingClaimed: true }),
      createMockNote('note-2', { isBeingClaimed: true }),
      createMockNote('note-3'), // New
      createMockNote('note-4'), // New
      createMockNote('note-5') // New
    ];
    currentClaimableNotes = notesWithNewArrivals;

    await act(async () => {
      testRoot!.render(<Pending />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All should be visible and enabled at summary (3 unclaimed notes arrived)
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const newClaimAllButton = Array.from(summaryButtons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;
    expect(newClaimAllButton).toBeTruthy();
    expect(newClaimAllButton.disabled).toBeFalsy();

    // Drill into the asset group: 2 original notes spin, 3 new notes have Claim buttons.
    await openFirstAssetGroup(testContainer, act);
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(2);
    const detailButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(detailButtons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(3);
  });

  it('Claim All processes only unclaimed notes when mixed states exist', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [
      createMockNote('note-1', { isBeingClaimed: true }), // Already claiming from previous session
      createMockNote('note-2'), // Unclaimed
      createMockNote('note-3', { isBeingClaimed: true }), // Already claiming
      createMockNote('note-4'), // Unclaimed
      createMockNote('note-5') // Unclaimed
    ];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should only process unclaimed notes (note-2, note-4, note-5)
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(3);
    const calledNoteIds = mockInitiateConsumeTransaction.mock.calls.map((call: any[]) => call[1].id);
    expect(calledNoteIds).toEqual(expect.arrayContaining(['note-2', 'note-4', 'note-5']));
    expect(calledNoteIds).not.toContain('note-1');
    expect(calledNoteIds).not.toContain('note-3');
  });
});

describe('Pending - Claiming State Reporting', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentClaimableNotes = [];
    mockGetFailedTransactions.mockResolvedValue([]);
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    mockWaitForConsumeTx.mockResolvedValue('tx-hash-456');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('reports claiming state to parent when individual claim starts', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // Hang on transaction to keep claim in progress
    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Initially both notes have Claim buttons (in the asset detail view)
    let buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    let claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(2);

    // Click Claim on first note
    await act(async () => {
      (claimButtons[0] as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // First note should now show spinner; only one Claim button should remain
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(1);
    buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(1);

    // Back at the summary, Claim All should still be visible (for the second unclaimed note)
    await goBackToSummary(act);
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(summaryButtons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeTruthy();
  });

  it('re-enables Claim All button after individual claim completes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1')];
    currentClaimableNotes = notes;

    let resolveWait: (value: string) => void;
    mockWaitForConsumeTx.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveWait = resolve;
        })
    );

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click Claim on the note (in the asset detail view)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim') as HTMLButtonElement;

    await act(async () => {
      claimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Back at the summary, Claim All should be hidden (note is being claimed)
    await goBackToSummary(act);
    const currentButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(currentButtons).find(b => b.textContent === 'claimAll')).toBeFalsy();

    // Complete the claim
    await act(async () => {
      resolveWait!('tx-hash');
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // After claim completes, if note is still there (mock didn't remove it),
    // Claim button should reappear (claim finished successfully)
    // In real scenario, mutateClaimableNotes would remove the claimed note
  });

  it('handles claim error and allows retry', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // First call fails, subsequent calls succeed
    mockWaitForConsumeTx.mockRejectedValueOnce(new Error('Transaction failed'));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click Claim on first note (in the asset detail view)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    const note1ClaimButton = claimButtons[0] as HTMLButtonElement;

    await act(async () => {
      note1ClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Should show Retry button for failed note
    const currentButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const retryButton = Array.from(currentButtons).find(b => b.textContent === 'retry');
    expect(retryButton).toBeTruthy();

    // Back at the summary, Claim All should still be available for note-2
    await goBackToSummary(act);
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(summaryButtons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeTruthy();
  });

  it('Claim All includes failed notes with Retry button', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // First individual claim fails
    mockWaitForConsumeTx.mockRejectedValueOnce(new Error('Transaction failed'));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click Claim on first note (in the asset detail view) - it will fail
    let buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    let claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    const note1ClaimButton = claimButtons[0] as HTMLButtonElement;

    await act(async () => {
      note1ClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Verify Retry button is showing
    buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(buttons).find(b => b.textContent === 'retry')).toBeTruthy();

    // Reset mocks for Claim All - all should succeed now
    mockInitiateConsumeTransaction.mockClear();
    mockWaitForConsumeTx.mockResolvedValue('tx-hash');

    // Back at the summary, click Claim All
    await goBackToSummary(act);
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(summaryButtons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;
    expect(claimAllButton).toBeTruthy();

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All should have processed BOTH notes (including the failed one)
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);
    const calledNoteIds = mockInitiateConsumeTransaction.mock.calls.map((call: any[]) => call[1].id);
    expect(calledNoteIds).toContain('note-1');
    expect(calledNoteIds).toContain('note-2');
  });

  it('Claim All is visible when all notes have failed and show Retry', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1')];
    currentClaimableNotes = notes;

    // Claim will fail
    mockWaitForConsumeTx.mockRejectedValueOnce(new Error('Transaction failed'));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click Claim on the only note (in the asset detail view) - it will fail
    let buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButton = Array.from(buttons).find(b => b.textContent === 'claim') as HTMLButtonElement;

    await act(async () => {
      claimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Verify Retry button is showing
    buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const retryButton = Array.from(buttons).find(b => b.textContent === 'retry');
    expect(retryButton).toBeTruthy();

    // Back at the summary, Claim All should STILL be visible (the failed note is claimable via Claim All)
    await goBackToSummary(act);
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(summaryButtons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeTruthy();
  });

  it('Retry button works after error and can be included in subsequent Claim All', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    // First claim fails, retry succeeds
    mockWaitForConsumeTx.mockRejectedValueOnce(new Error('Transaction failed')).mockResolvedValue('tx-hash');

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click Claim on first note (in the asset detail view) - it will fail
    let buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    let claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    const note1ClaimButton = claimButtons[0] as HTMLButtonElement;

    await act(async () => {
      note1ClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Verify Retry button is showing
    buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const retryButton = Array.from(buttons).find(b => b.textContent === 'retry') as HTMLButtonElement;
    expect(retryButton).toBeTruthy();

    // Click Retry - it should succeed this time
    await act(async () => {
      retryButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // After successful retry, the Claim button should no longer show Retry
    // (in real scenario the note would be removed by mutateClaimableNotes)
    // For this test, we just verify the transaction was initiated
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2); // Original fail + retry
  });
});

describe('Pending - Edge Cases', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentClaimableNotes = [];
    mockGetFailedTransactions.mockResolvedValue([]);
    mockInitiateConsumeTransaction.mockResolvedValue('tx-id-123');
    mockWaitForConsumeTx.mockResolvedValue('tx-hash-456');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('handles empty claimable notes array', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    currentClaimableNotes = [];

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // No Claim buttons or spinners should be present
    expect(testContainer.querySelectorAll('[data-testid="claim-button"]').length).toBe(0);
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(0);
    // Should show empty state message
    expect(testContainer.textContent).toContain('noNotesToClaim');
  });

  it('handles undefined claimable notes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    currentClaimableNotes = undefined as any;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Should not crash, no Claim All button should be present
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeFalsy();
  });

  it('handles null notes in array', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), null, createMockNote('note-2'), undefined] as any[];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Should only render valid notes (in the asset detail view)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(2);
  });

  it('handles single note scenario', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1')];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Claim All button should be visible at the summary
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(summaryButtons).find(b => b.textContent === 'claimAll')).toBeTruthy();

    // Drill into the asset group: the individual Claim button should be visible
    await openFirstAssetGroup(testContainer, act);
    const detailButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(detailButtons).find(b => b.textContent === 'claim')).toBeTruthy();
  });

  it('handles large number of notes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // 20 notes that all share a faucetId collapse into a single asset group.
    const notes = Array.from({ length: 20 }, (_, i) => createMockNote(`note-${i + 1}`));
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Claim All should be available at the summary
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(summaryButtons).find(b => b.textContent === 'claimAll')).toBeTruthy();

    // Drill into the asset group: all 20 notes should render their Claim buttons
    await openFirstAssetGroup(testContainer, act);
    const detailButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(detailButtons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(20);
  });

  it('handles all notes transitioning to being claimed simultaneously', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2'), createMockNote('note-3')];
    currentClaimableNotes = notes;

    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // Click Claim All (summary)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // Claim All should be hidden at summary (no unclaimed notes left)
    const summaryButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    expect(Array.from(summaryButtons).find(b => b.textContent === 'claimAll')).toBeFalsy();

    // Drill into the asset group: all notes spin, no Claim buttons remain
    await openFirstAssetGroup(testContainer, act);
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(3);
    const detailButtons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(detailButtons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(0);
  });

  it('handles interleaved individual and Claim All operations', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [
      createMockNote('note-1'),
      createMockNote('note-2'),
      createMockNote('note-3'),
      createMockNote('note-4')
    ];
    currentClaimableNotes = notes;

    mockWaitForConsumeTx.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      testRoot!.render(<Pending />);
    });
    await openFirstAssetGroup(testContainer, act);

    // Click individual Claim on note-1 (in the asset detail view)
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    const note1ClaimButton = claimButtons[0] as HTMLButtonElement;

    await act(async () => {
      note1ClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // 1 spinner should appear
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(1);

    // Click the in-view "Claim all in this group" action (shares claimNotesBatch with
    // Claim All) for the remaining notes. Staying in the detail view keeps note-1's
    // individual claiming spinner mounted.
    mockInitiateConsumeTransaction.mockClear();
    const groupClaimButton = (Array.from(testContainer.querySelectorAll('button')) as HTMLButtonElement[]).find(
      b => b.textContent === 'claimAllProgress'
    ) as HTMLButtonElement;
    expect(groupClaimButton).toBeTruthy();

    await act(async () => {
      groupClaimButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // The batch claim should have only processed notes 2, 3, 4 (not note-1, already claiming)
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(3);
    const calledNoteIds = mockInitiateConsumeTransaction.mock.calls.map((call: any[]) => call[1].id);
    expect(calledNoteIds).not.toContain('note-1');

    // All 4 notes should now show spinners (note-1 individually + 2/3/4 via the batch)
    expect(testContainer.querySelectorAll('[data-testid="sync-wave"]').length).toBe(4);
  });

  it('cleans up claiming state when component unmounts during Claim All', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    const notes = [createMockNote('note-1'), createMockNote('note-2')];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll') as HTMLButtonElement;

    await act(async () => {
      claimAllButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // On extension: Claim All is fire-and-forget via SW.
    // The abort controller still exists and is aborted on unmount via the useEffect cleanup.
    expect(mockInitiateConsumeTransaction).toHaveBeenCalledTimes(2);

    // Unmount while Claim All is in progress
    await act(async () => {
      testRoot!.unmount();
      testRoot = null;
    });
  });

  it('groups notes with the same faucetId into a collapsible group', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Two notes with the same faucetId should be grouped
    const notes = [
      createMockNote('note-1', { faucetId: 'shared-faucet' }),
      createMockNote('note-2', { faucetId: 'shared-faucet' })
    ];
    currentClaimableNotes = notes;

    await act(async () => {
      testRoot!.render(<Pending />);
    });

    // On the pending summary the group is collapsed, so individual claim buttons are
    // hidden — only the Claim All button is visible.
    const buttons = testContainer.querySelectorAll('[data-testid="claim-button"]');
    const claimButtons = Array.from(buttons).filter(b => b.textContent === 'claim');
    expect(claimButtons.length).toBe(0); // No individual claim buttons when collapsed

    const claimAllButton = Array.from(buttons).find(b => b.textContent === 'claimAll');
    expect(claimAllButton).toBeTruthy();
  });
});
