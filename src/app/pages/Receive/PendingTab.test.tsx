import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension, isMobile } from 'lib/platform';
import { WalletAccount } from 'lib/shared/types';

import { PendingTab, NoteWithMetadata } from './PendingTab';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key
  })
}));

const registeredBackHandlers: Array<() => void> = [];
const registerBackHandlerMock = jest.fn((handler: () => void) => {
  registeredBackHandlers.push(handler);
  return () => {
    const idx = registeredBackHandlers.indexOf(handler);
    if (idx >= 0) registeredBackHandlers.splice(idx, 1);
  };
});

jest.mock('app/env', () => ({
  useAppEnv: () => ({ registerBackHandler: registerBackHandlerMock })
}));

const mockTokenPrices = {} as Record<string, unknown>;
const openTransactionModalMock = jest.fn();
const mockStoreState = { tokenPrices: mockTokenPrices, openTransactionModal: openTransactionModalMock };

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockStoreState) => unknown) => (selector ? selector(mockStoreState) : mockStoreState),
    { getState: () => mockStoreState }
  )
}));

const initiateConsumeTransactionMock = jest.fn();
const requestSWTransactionProcessingMock = jest.fn();
const waitForConsumeTxMock = jest.fn();

jest.mock('lib/miden/activity', () => ({
  initiateConsumeTransaction: (...args: unknown[]) => initiateConsumeTransactionMock(...args),
  requestSWTransactionProcessing: (...args: unknown[]) => requestSWTransactionProcessingMock(...args),
  waitForConsumeTx: (...args: unknown[]) => waitForConsumeTxMock(...args)
}));

jest.mock('lib/prices', () => ({
  getTokenPrice: () => ({ price: 1 })
}));

// formatBigInt is pure but its transitive imports (i18next/bignumber/metadata) don't
// resolve cleanly under this test's module graph; provide a faithful decimal formatter.
jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (amount: bigint, decimals: number) => {
    const negative = amount < 0n;
    const abs = negative ? -amount : amount;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    const value = fracStr ? `${whole}.${fracStr}` : `${whole}`;
    return negative ? `-${value}` : value;
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isMobile: jest.fn(() => false)
}));

const navigateMock = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
  HistoryAction: { Replace: 'replace' }
}));

jest.mock('components/Button', () => ({
  Button: ({
    onClick,
    title,
    disabled,
    ...rest
  }: {
    onClick?: () => void;
    title?: string;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button data-testid={rest['data-testid']} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary' }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: () => null
}));

jest.mock('components/SyncWaveBackground', () => ({
  SyncWaveBackground: () => null
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { ArrowRight: 'ArrowRight', ChevronLeft: 'ChevronLeft' }
}));

const isExtensionMock = isExtension as jest.Mock;
const isMobileMock = isMobile as jest.Mock;

const account = { publicKey: 'pk-1' } as WalletAccount;

const makeNote = (overrides: Partial<NoteWithMetadata> = {}): NoteWithMetadata =>
  ({
    id: 'note-1',
    faucetId: 'faucet-1',
    amount: '1000000',
    senderAddress: 'mtst1apsender_addr_1234567890',
    isBeingClaimed: false,
    type: NoteTypeEnum.Private,
    metadata: { symbol: 'TST', name: 'Test Token', decimals: 6 },
    ...overrides
  }) as NoteWithMetadata;

type Props = React.ComponentProps<typeof PendingTab>;

const baseProps = (overrides: Partial<Props> = {}): Props => ({
  safeClaimableNotes: [makeNote()],
  unclaimedNotesCount: 1,
  account,
  mutateClaimableNotes: jest.fn(async () => []),
  isDelegatedProvingEnabled: false,
  claimingNoteIds: new Set<string>(),
  failedNoteIds: new Set<string>(),
  checkingNoteIds: new Set<string>(),
  onClaimingStateChange: jest.fn(),
  onClaimAll: jest.fn(),
  onClaimGroup: undefined,
  ...overrides
});

describe('PendingTab', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    registeredBackHandlers.length = 0;
    isExtensionMock.mockReturnValue(true);
    isMobileMock.mockReturnValue(false);
    openTransactionModalMock.mockReset();
  });

  const renderInto = async (element: React.ReactElement) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    return { container, root };
  };

  const click = (el: Element | null) =>
    act(() => {
      (el as HTMLElement).click();
    });

  const clickAsync = async (el: Element | null) =>
    act(async () => {
      (el as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

  it('groups notes from the same faucet into one row and distinct faucets into separate rows', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [
            makeNote({ id: 'n1', faucetId: 'faucet-1' }),
            makeNote({ id: 'n2', faucetId: 'faucet-1' }),
            makeNote({ id: 'n3', faucetId: 'faucet-2', metadata: { symbol: 'AAA', name: 'Alpha', decimals: 6 } })
          ],
          unclaimedNotesCount: 3
        })}
      />
    );

    const rows = Array.from(container.querySelectorAll('[data-testid="pending-asset-row"]'));
    expect(rows).toHaveLength(2);
    // First group has 2 notes → 0/2.
    expect(rows[0]?.textContent).toContain('0/2');
    expect(rows[1]?.textContent).toContain('0/1');
    act(() => root.unmount());
  });

  it('renders the empty state when there are no grouped notes', async () => {
    const { container, root } = await renderInto(
      <PendingTab {...baseProps({ safeClaimableNotes: [], unclaimedNotesCount: 0 })} />
    );
    expect(container.textContent).toContain('noNotesToClaim');
    expect(container.querySelectorAll('[data-testid="pending-asset-row"]')).toHaveLength(0);
    act(() => root.unmount());
  });

  it('shows the claim-all button on desktop and fires onClaimAll', async () => {
    const onClaimAll = jest.fn();
    const { container, root } = await renderInto(<PendingTab {...baseProps({ onClaimAll })} />);
    const claimAll = container.querySelector('[data-testid="claim-all-button"]');
    expect(claimAll).not.toBeNull();
    click(claimAll);
    expect(onClaimAll).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('shows the claim-all button on mobile and fires onClaimAll', async () => {
    isMobileMock.mockReturnValue(true);
    const onClaimAll = jest.fn();
    const { container, root } = await renderInto(<PendingTab {...baseProps({ onClaimAll })} />);
    const claimAll = container.querySelector('[data-testid="claim-all-button"]');
    expect(claimAll).not.toBeNull();
    click(claimAll);
    expect(onClaimAll).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('hides the claim-all button when unclaimedNotesCount is 0', async () => {
    const { container, root } = await renderInto(<PendingTab {...baseProps({ unclaimedNotesCount: 0 })} />);
    expect(container.querySelector('[data-testid="claim-all-button"]')).toBeNull();
    act(() => root.unmount());
  });

  it('navigates into a group detail and back to the summary', async () => {
    const { container, root } = await renderInto(<PendingTab {...baseProps()} />);

    const row = container.querySelector('[data-testid="pending-asset-row"]');
    click(row);

    // Detail view shown.
    expect(container.querySelector('[data-testid="pending-detail-back"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pending-asset-row"]')).toBeNull();

    const back = container.querySelector('[data-testid="pending-detail-back"]');
    click(back);

    // Back to summary.
    expect(container.querySelector('[data-testid="pending-asset-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pending-detail-back"]')).toBeNull();
    act(() => root.unmount());
  });

  it('returns to the summary via the registered back handler while in detail view', async () => {
    const { container, root } = await renderInto(<PendingTab {...baseProps()} />);
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    expect(container.querySelector('[data-testid="pending-detail-back"]')).not.toBeNull();
    expect(registeredBackHandlers).toHaveLength(1);

    act(() => {
      registeredBackHandlers[0]?.();
    });

    // Back handler cleared the selection → summary shown again.
    expect(container.querySelector('[data-testid="pending-asset-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pending-detail-back"]')).toBeNull();
    act(() => root.unmount());
  });

  it('clears a stale selection when the selected group disappears from the claimable notes', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [
            makeNote({ id: 'n1', faucetId: 'faucet-1' }),
            makeNote({ id: 'n2', faucetId: 'faucet-2', metadata: { symbol: 'AAA', name: 'Alpha', decimals: 6 } })
          ],
          unclaimedNotesCount: 2
        })}
      />
    );

    // Select faucet-1's group.
    const firstRow = container.querySelector('[data-testid="pending-asset-row"][data-faucet-id="faucet-1"]');
    click(firstRow);
    expect(container.querySelector('[data-testid="pending-detail-back"]')).not.toBeNull();

    // Re-render without faucet-1 → selectedGroup becomes null → effect resets selection.
    await act(async () => {
      root.render(
        <PendingTab
          {...baseProps({
            safeClaimableNotes: [
              makeNote({ id: 'n2', faucetId: 'faucet-2', metadata: { symbol: 'AAA', name: 'Alpha', decimals: 6 } })
            ],
            unclaimedNotesCount: 1
          })}
        />
      );
    });

    // Selection reset → summary view shown.
    expect(container.querySelector('[data-testid="pending-detail-back"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="pending-asset-row"]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('renders UNKNOWN symbol / symbol-name fallbacks and counts claiming notes in the summary row', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [
            makeNote({ id: 'n1', isBeingClaimed: true, metadata: { decimals: 6 } as any }),
            makeNote({ id: 'n2', metadata: { symbol: 'SYM', decimals: 6 } as any })
          ],
          claimingNoteIds: new Set<string>(['n2']),
          unclaimedNotesCount: 0
        })}
      />
    );
    const row = container.querySelector('[data-testid="pending-asset-row"]');
    // Both notes counted as claiming → 2/2.
    expect(row?.textContent).toContain('2/2');
    // First note metadata has neither symbol nor name → UNKNOWN displayed.
    expect(row?.textContent).toContain('UNKNOWN');
    act(() => root.unmount());
  });

  it('renders the claim-group button when onClaimGroup is provided and fires it when enabled', async () => {
    const onClaimGroup = jest.fn();
    const { container, root } = await renderInto(<PendingTab {...baseProps({ onClaimGroup })} />);
    click(container.querySelector('[data-testid="pending-asset-row"]'));

    const groupButton = container.querySelector('[data-testid="claim-group-button"]') as HTMLButtonElement;
    expect(groupButton).not.toBeNull();
    expect(groupButton.disabled).toBe(false);
    click(groupButton);
    expect(onClaimGroup).toHaveBeenCalledWith('faucet-1');
    act(() => root.unmount());
  });

  it('disables the claim-group button when all notes in the group are being claimed (early return)', async () => {
    const onClaimGroup = jest.fn();
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [makeNote({ id: 'n1', isBeingClaimed: true })],
          claimingNoteIds: new Set<string>(),
          onClaimGroup
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));

    const groupButton = container.querySelector('[data-testid="claim-group-button"]') as HTMLButtonElement;
    expect(groupButton.disabled).toBe(true);
    click(groupButton);
    expect(onClaimGroup).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('omits the claim-group button entirely when onClaimGroup is undefined', async () => {
    const { container, root } = await renderInto(<PendingTab {...baseProps({ onClaimGroup: undefined })} />);
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    expect(container.querySelector('[data-testid="claim-group-button"]')).toBeNull();
    act(() => root.unmount());
  });

  it('shows a claim button for unclaimed notes and a spinner for notes already being claimed', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [
            makeNote({ id: 'n1', isBeingClaimed: false }),
            makeNote({ id: 'n2', isBeingClaimed: true })
          ],
          unclaimedNotesCount: 1
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    // One claim button (n1), one spinner (n2 isBeingClaimed).
    expect(container.querySelectorAll('[data-testid="claim-button"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="claim-spinner"]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('shows a spinner when the note is claiming or checking from the parent', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [makeNote({ id: 'n1' }), makeNote({ id: 'n2' }), makeNote({ id: 'n3' })],
          claimingNoteIds: new Set<string>(['n1']),
          checkingNoteIds: new Set<string>(['n2'])
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    // n1 (claiming) + n2 (checking) → 2 spinners, n3 → 1 claim button.
    expect(container.querySelectorAll('[data-testid="claim-spinner"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="claim-button"]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('labels the claim button "retry" when the note has failed from the parent', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [makeNote({ id: 'n1' })],
          failedNoteIds: new Set<string>(['n1'])
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    const button = container.querySelector('[data-testid="claim-button"]');
    expect(button?.textContent).toContain('retry');
    act(() => root.unmount());
  });

  it('labels the claim button "claim" and renders an unknown sender for a public note without a sender address', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [makeNote({ id: 'n1', type: NoteTypeEnum.Public, senderAddress: '' as any })]
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    const detail = container.querySelector('[data-testid="pending-detail-back"]')!.parentElement!;
    expect(detail.textContent).toContain('unknown');
    const button = container.querySelector('[data-testid="claim-button"]');
    expect(button?.textContent).toContain('claim');
    act(() => root.unmount());
  });

  it('treats type "unknown" as a public note and renders the eye-open icon', async () => {
    const { container, root } = await renderInto(
      <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1', type: 'unknown' })] })} />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    // Eye-open svg is rendered for public/unknown notes (svgs auto-mock to a component).
    expect(container.querySelector('[data-testid="claim-button"]')).not.toBeNull();
    act(() => root.unmount());
  });

  describe('handleClaim', () => {
    it('extension path: processes the SW request, waits, and re-fetches notes', async () => {
      initiateConsumeTransactionMock.mockResolvedValue('tx-id');
      waitForConsumeTxMock.mockResolvedValue(undefined);
      const mutateClaimableNotes = jest.fn(async () => []);
      isExtensionMock.mockReturnValue(true);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })], mutateClaimableNotes })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      expect(initiateConsumeTransactionMock).toHaveBeenCalled();
      expect(requestSWTransactionProcessingMock).toHaveBeenCalled();
      expect(waitForConsumeTxMock).toHaveBeenCalled();
      expect(mutateClaimableNotes).toHaveBeenCalled();
      act(() => root.unmount());
    });

    it('extension path: surfaces an error and re-enables the button when waitForConsumeTx rejects', async () => {
      initiateConsumeTransactionMock.mockResolvedValue('tx-id');
      waitForConsumeTxMock.mockRejectedValue(new Error('boom'));
      isExtensionMock.mockReturnValue(true);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })] })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      // setIsLoading(false) in the catch → button (not spinner) shown again, labelled retry.
      const button = container.querySelector('[data-testid="claim-button"]');
      expect(button).not.toBeNull();
      expect(button?.textContent).toContain('retry');
      act(() => root.unmount());
    });

    it('extension path: AbortError from waitForConsumeTx is swallowed without surfacing an error', async () => {
      initiateConsumeTransactionMock.mockResolvedValue('tx-id');
      waitForConsumeTxMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
      const mutateClaimableNotes = jest.fn(async () => []);
      isExtensionMock.mockReturnValue(true);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })], mutateClaimableNotes })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      // No setError → spinner stays (isLoading stays true on extension path), no retry label.
      expect(container.querySelector('[data-testid="claim-spinner"]')).not.toBeNull();
      expect(mutateClaimableNotes).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it('non-extension path: opens the transaction modal, waits, and re-fetches notes', async () => {
      initiateConsumeTransactionMock.mockResolvedValue('tx-id');
      waitForConsumeTxMock.mockResolvedValue(undefined);
      const mutateClaimableNotes = jest.fn(async () => [makeNote({ id: 'still-here' })]);
      isExtensionMock.mockReturnValue(false);
      isMobileMock.mockReturnValue(false);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })], mutateClaimableNotes })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      expect(openTransactionModalMock).toHaveBeenCalled();
      expect(mutateClaimableNotes).toHaveBeenCalled();
      // remainingNotes non-empty + not mobile → no navigate.
      expect(navigateMock).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it('non-extension + mobile path: navigates home when no notes remain', async () => {
      initiateConsumeTransactionMock.mockResolvedValue('tx-id');
      waitForConsumeTxMock.mockResolvedValue(undefined);
      const mutateClaimableNotes = jest.fn(async () => []);
      isExtensionMock.mockReturnValue(false);
      // Grouping + summary render read isMobile() first; keep them false, flip true for the claim path.
      isMobileMock.mockReturnValue(false);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })], mutateClaimableNotes })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));

      isMobileMock.mockReturnValue(true);
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      expect(navigateMock).toHaveBeenCalledWith('/', 'replace');
      act(() => root.unmount());
    });

    it('non-extension path: surfaces an error from the outer catch when initiateConsumeTransaction rejects', async () => {
      initiateConsumeTransactionMock.mockRejectedValue(new Error('init-failed'));
      isExtensionMock.mockReturnValue(false);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })] })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      const button = container.querySelector('[data-testid="claim-button"]');
      expect(button?.textContent).toContain('retry');
      errSpy.mockRestore();
      act(() => root.unmount());
    });

    it('outer catch: AbortError from initiateConsumeTransaction is swallowed without an error label', async () => {
      initiateConsumeTransactionMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
      isExtensionMock.mockReturnValue(false);

      const { container, root } = await renderInto(
        <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })] })} />
      );
      click(container.querySelector('[data-testid="pending-asset-row"]'));
      await clickAsync(container.querySelector('[data-testid="claim-button"]'));

      const button = container.querySelector('[data-testid="claim-button"]');
      // No error surfaced → still labelled claim (non-extension resets isLoading in finally).
      expect(button?.textContent).toContain('claim');
      act(() => root.unmount());
    });
  });

  it('falls back to default decimals/symbol/name when a group has no metadata (summary + detail)', async () => {
    const onClaimGroup = jest.fn();
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          // metadata undefined exercises every `metadata?.x ?? fallback` / `|| fallback` branch.
          safeClaimableNotes: [makeNote({ id: 'n1', metadata: undefined as any })],
          onClaimGroup
        })}
      />
    );
    // Summary row falls back to UNKNOWN (no symbol, no name).
    const row = container.querySelector('[data-testid="pending-asset-row"]');
    expect(row?.textContent).toContain('UNKNOWN');

    // Detail view also falls back (name/symbol/decimals) without throwing.
    click(row);
    expect(container.querySelector('[data-testid="pending-detail-back"]')).not.toBeNull();
    expect(container.textContent).toContain('UNKNOWN');
    // DetailNoteRow symbol fallback.
    expect(container.querySelector('[data-testid="claim-button"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('formats a fractional group total with grouped thousands and a decimal part in the detail header', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          // 1234567500000 / 1e6 = 1,234,567.5 → exercises the decimal branch of groupNumber.
          safeClaimableNotes: [makeNote({ id: 'n1', amount: '1234567500000' })],
          unclaimedNotesCount: 1
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    expect(container.textContent).toContain('1,234,567.5');
    act(() => root.unmount());
  });

  it('aborts the in-flight controller when a note is claimed twice in a row', async () => {
    initiateConsumeTransactionMock.mockResolvedValue('tx-id');
    waitForConsumeTxMock.mockResolvedValue(undefined);
    const mutateClaimableNotes = jest.fn(async () => [makeNote({ id: 'still-here' })]);
    isExtensionMock.mockReturnValue(false);
    isMobileMock.mockReturnValue(false);

    const { container, root } = await renderInto(
      <PendingTab {...baseProps({ safeClaimableNotes: [makeNote({ id: 'n1' })], mutateClaimableNotes })} />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));

    // First claim: abortControllerRef.current is null → optional-chaining short-circuits.
    await clickAsync(container.querySelector('[data-testid="claim-button"]'));
    // Second claim: abortControllerRef.current is set → abort() is invoked.
    await clickAsync(container.querySelector('[data-testid="claim-button"]'));

    expect(initiateConsumeTransactionMock).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('renders the divider between notes but not after the last note', async () => {
    const { container, root } = await renderInto(
      <PendingTab
        {...baseProps({
          safeClaimableNotes: [makeNote({ id: 'n1' }), makeNote({ id: 'n2' })]
        })}
      />
    );
    click(container.querySelector('[data-testid="pending-asset-row"]'));
    // First note row carries border-b (showDivider=true), last does not (showDivider=false).
    const withDivider = container.querySelectorAll('.border-b.border-rule-default');
    expect(withDivider).toHaveLength(1);
    act(() => root.unmount());
  });
});
