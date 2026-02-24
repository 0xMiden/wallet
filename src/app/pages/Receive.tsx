import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { useAppEnv } from 'app/env';
import { ReactComponent as EyeClosedIcon } from 'app/icons/eye-closed.svg';
import { ReactComponent as EyeOpenIcon } from 'app/icons/eye-open.svg';
import { ReactComponent as QRIcon } from 'app/icons/qr-new.svg';
import { Icon, IconName } from 'app/icons/v2';
import { AssetIcon } from 'app/templates/AssetIcon';
import { Button, ButtonVariant } from 'components/Button';
import { QRCode } from 'components/QRCode';
import { SyncWaveBackground } from 'components/SyncWaveBackground';
import { formatBigInt } from 'lib/i18n/numbers';
import {
  getFailedTransactions,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx
} from 'lib/miden/activity';
import { AssetMetadata, useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { ConsumableNote, NoteTypeEnum } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { goBack, HistoryAction, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

export interface ReceiveProps {}

// Type for a note with metadata
type NoteWithMetadata = NonNullable<ConsumableNote & { metadata: AssetMetadata }>;

// Type for grouped notes by asset
interface AssetNoteGroup {
  faucetId: string;
  metadata: AssetMetadata;
  notes: NoteWithMetadata[];
  totalAmount: bigint;
}

export const Receive: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const address = account.publicKey;

  // Check if opened from notification (should go back instead of home on close)
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const { fullPage } = useAppEnv();
  const safeClaimableNotes = useMemo(
    () => (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null),
    [claimableNotes]
  );
  const [claimingNoteIds, setClaimingNoteIds] = useState<Set<string>>(new Set());
  // Track individual note claiming states reported by child components
  const [individualClaimingIds, setIndividualClaimingIds] = useState<Set<string>>(new Set());
  // Track notes that failed during Claim All
  const [failedNoteIds, setFailedNoteIds] = useState<Set<string>>(new Set());
  // Track notes being checked for state from node
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  const claimAllAbortRef = useRef<AbortController | null>(null);
  // Track expanded asset groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Group notes by faucetId/asset
  const groupedNotes = useMemo(() => {
    const groups = new Map<string, AssetNoteGroup>();

    for (const note of safeClaimableNotes) {
      const existing = groups.get(note.faucetId);
      if (existing) {
        existing.notes.push(note);
        existing.totalAmount += BigInt(note.amount);
      } else {
        groups.set(note.faucetId, {
          faucetId: note.faucetId,
          metadata: note.metadata,
          notes: [note],
          totalAmount: BigInt(note.amount)
        });
      }
    }

    return Array.from(groups.values());
  }, [safeClaimableNotes]);

  const toggleGroupExpanded = useCallback((faucetId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(faucetId)) {
        next.delete(faucetId);
      } else {
        next.add(faucetId);
      }
      return next;
    });
  }, []);

  // Callback for child components to report their claiming state
  const handleClaimingStateChange = useCallback((noteId: string, isClaiming: boolean) => {
    setIndividualClaimingIds(prev => {
      const next = new Set(prev);
      if (isClaiming) {
        next.add(noteId);
      } else {
        next.delete(noteId);
      }
      return next;
    });
  }, []);

  // Notes that are not currently being claimed (available for "Claim All")
  // A note is claimable if it's not being claimed via:
  // - IndexedDB (isBeingClaimed) - from previous sessions or after tx queued
  // - Claim All operation (claimingNoteIds) - current batch operation
  // - Individual claim (individualClaimingIds) - user clicked single Claim button
  const unclaimedNotes = safeClaimableNotes.filter(
    n => !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
  );

  useEffect(() => {
    return () => {
      claimAllAbortRef.current?.abort();
    };
  }, []);

  // Poll for stuck transactions and verify their state from the node
  // On extension, skip — the SW handles stuck transaction cleanup via generateTransactionsLoop
  useEffect(() => {
    if (isExtension()) return;

    const checkStuckTransactions = async () => {
      const resolved = await verifyStuckTransactionsFromNode();
      if (resolved > 0) {
        // Refresh claimable notes if any transactions were resolved
        mutateClaimableNotes();
      }
    };

    // Check immediately on mount
    checkStuckTransactions();

    // Then poll every 3 seconds
    const interval = setInterval(checkStuckTransactions, 3000);
    return () => clearInterval(interval);
  }, [mutateClaimableNotes]);

  // Check for failed notes: both from local IndexedDB and node state (only once on mount)
  const hasCheckedFailedNotes = useRef(false);
  useEffect(() => {
    const checkFailedNotes = async () => {
      if (safeClaimableNotes.length === 0) return;
      if (hasCheckedFailedNotes.current) return;
      hasCheckedFailedNotes.current = true;

      // Show loading wave on all notes while checking
      const noteIdsToCheck = new Set(safeClaimableNotes.map(n => n.id));
      setCheckingNoteIds(noteIdsToCheck);

      const failedIds = new Set<string>();

      try {
        // 1. Check local IndexedDB for failed consume transactions
        const failedTxs = await getFailedTransactions();
        for (const tx of failedTxs) {
          if (tx.type === 'consume' && tx.noteId) {
            failedIds.add(tx.noteId);
          }
        }

        // 2. Check node state for Invalid notes
        try {
          if (isExtension()) {
            // On extension, use intercom to check note state via SW
            const res = await getIntercom().request({
              type: WalletMessageType.GetInputNoteDetailsRequest,
              noteIds: safeClaimableNotes.map(n => n.id)
            });
            if (res && 'notes' in res) {
              for (const note of (res as any).notes) {
                if (note.state === 'Invalid') {
                  failedIds.add(note.noteId);
                }
              }
            }
          } else {
            const { InputNoteState, NoteFilter, NoteFilterTypes, NoteId } = await import('@miden-sdk/miden-sdk');
            const noteIds = safeClaimableNotes.map(n => NoteId.fromHex(n.id));
            const noteDetails = await withWasmClientLock(async () => {
              const midenClient = await getMidenClient();
              const noteFilter = new NoteFilter(NoteFilterTypes.List, noteIds);
              return await midenClient.getInputNoteDetails(noteFilter);
            });

            for (const note of noteDetails) {
              if (note.state === InputNoteState.Invalid) {
                failedIds.add(note.noteId);
              }
            }
          }
        } catch (err) {
          console.error('[Receive] Error checking node state for notes:', err);
        }

        // Only include notes that are still claimable (shown in UI)
        const claimableNoteIds = new Set(safeClaimableNotes.map(n => n.id));
        const failedClaimableNotes = new Set([...failedIds].filter(id => claimableNoteIds.has(id)));

        if (failedClaimableNotes.size > 0) {
          setFailedNoteIds(prev => new Set([...prev, ...failedClaimableNotes]));
        }
      } finally {
        setCheckingNoteIds(new Set());
      }
    };

    checkFailedNotes();
  }, [safeClaimableNotes]);

  const handleClaimAll = useCallback(async () => {
    if (unclaimedNotes.length === 0) return;

    claimAllAbortRef.current?.abort();
    claimAllAbortRef.current = new AbortController();
    const signal = claimAllAbortRef.current.signal;

    // Refresh the claimable notes list before queueing to avoid race conditions
    // with auto-consume (Explore page may have already started claiming some notes)
    const freshNotes = await mutateClaimableNotes();
    const freshUnclaimedNotes = (freshNotes ?? []).filter(
      n => n && !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
    );

    if (freshUnclaimedNotes.length === 0) {
      // All notes are already being claimed (likely by auto-consume)
      return;
    }

    // Mark unclaimed notes as being claimed
    const noteIds = freshUnclaimedNotes.map(n => n!.id);
    setClaimingNoteIds(new Set(noteIds));

    // Track results
    let failed = 0;
    let queueFailed = 0;

    // Clear previous failures
    setFailedNoteIds(new Set());

    try {
      // Queue all transactions first, before opening loading page
      // This ensures all notes get queued even if the popup closes
      const transactionIds: { noteId: string; txId: string }[] = [];
      for (const note of freshUnclaimedNotes) {
        try {
          const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
          transactionIds.push({ noteId: note.id, txId: id });
        } catch (err) {
          console.error('Error queuing note for claim:', note.id, err);
          queueFailed++;
          // Mark as failed and remove from claiming set
          setFailedNoteIds(prev => new Set(prev).add(note.id));
          setClaimingNoteIds(prev => {
            const next = new Set(prev);
            next.delete(note.id);
            return next;
          });
        }
      }

      if (isExtension()) {
        // On extension: fire-and-forget — SW handles processing.
        // Notes show "claiming" spinner via claimingNoteIds + NoteClaimStarted broadcast.
        // Notes disappear when sync cycle removes them from getConsumableNotes().
        requestSWTransactionProcessing();
      } else {
        // Open loading page (popup stays open since tab is not active)
        useWalletStore.getState().openTransactionModal();

        // Wait for all transactions to complete
        for (const { noteId, txId } of transactionIds) {
          if (signal.aborted) break;
          try {
            await waitForConsumeTx(txId, signal);
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
              break;
            }
            console.error('Error waiting for transaction:', txId, err);
            // Mark this note as failed
            setFailedNoteIds(prev => new Set(prev).add(noteId));
          }
        }

        // Refresh the list - this will remove successfully claimed notes
        await mutateClaimableNotes();

        // Navigate to home on mobile after claiming all notes
        if (isMobile()) {
          navigate('/', HistoryAction.Replace);
        }
      }
    } finally {
      if (!isExtension()) {
        setClaimingNoteIds(new Set());
      }
      // On extension, keep claimingNoteIds set — they'll be cleared when notes disappear from sync
    }
  }, [
    unclaimedNotes,
    account.publicKey,
    isDelegatedProvingEnabled,
    mutateClaimableNotes,
    claimingNoteIds,
    individualClaimingIds
  ]);

  const handleFileChange = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = async (e: ProgressEvent<FileReader>) => {
      try {
        if (e.target?.result instanceof ArrayBuffer) {
          const noteBytesAsUint8Array = new Uint8Array(e.target.result);

          if (isExtension()) {
            // On extension, route through SW via intercom
            const b64 = Buffer.from(noteBytesAsUint8Array).toString('base64');
            const res = await getIntercom().request({
              type: WalletMessageType.ImportNoteBytesRequest,
              noteBytes: b64
            });
            if (res && 'noteId' in res) {
              navigate(`/import-note-pending/${(res as any).noteId}`);
            } else {
              navigate('/import-note-failure');
            }
          } else {
            // Wrap WASM client operations in a lock to prevent concurrent access
            const noteId = await withWasmClientLock(async () => {
              const midenClient = await getMidenClient();
              const id = await midenClient.importNoteBytes(noteBytesAsUint8Array);
              await midenClient.syncState();
              return id;
            });
            navigate(`/import-note-pending/${noteId}`);
          }
        }
      } catch (error) {
        console.error('Error during note import:', error);
        navigate('/import-note-failure');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onDropFile = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileChange(file);
      }
    },
    [handleFileChange]
  );

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding)
  const containerClass = isMobile()
    ? 'h-full w-full'
    : fullPage
      ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px] border rounded-3xl'
      : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  const [isQRSheetOpen, setIsQRSheetOpen] = useState(false);

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-white relative')}>
      {/* Custom Header with back button, title, and QR icon */}
      <div
        className="flex flex-row px-4 items-center justify-between border-b border-grey-100"
        style={{ paddingTop: isMobile() ? '24px' : '14px', paddingBottom: '14px' }}
      >
        <button
          type="button"
          onClick={goBack}
          className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-grey-100"
          aria-label="Back"
        >
          <Icon name={IconName.ChevronLeft} size="sm" fill="black" />
        </button>
        <h1 className="text-[20px] font-medium">{t('receive')}</h1>

        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-grey-100"
          aria-label={t('showQrCode')}
          onClick={() => {
            hapticLight();
            setIsQRSheetOpen(true);
          }}
        >
          <QRIcon className="text-[#484848]" style={{ width: '25px', height: '25px' }} />
        </button>
      </div>

      <div
        className="flex-1 flex flex-col min-h-0"
        onDrop={onDropFile}
        onDragOver={e => e.preventDefault()}
        onDragEnter={onDragEnter}
        data-testid="receive-page"
      >
        <FormField ref={fieldRef} value={address} style={{ display: 'none' }} />
        <div className={classNames('w-full mx-auto py-4 flex flex-col flex-1 min-h-0', isMobile() ? 'px-8' : 'px-4')}>
          {safeClaimableNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1">
              <svg
                width="52"
                height="52"
                viewBox="0 0 52 52"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="mb-4 text-grey-400"
              >
                {/* Banknote outline */}
                <rect
                  x="6"
                  y="14"
                  width="40"
                  height="24"
                  rx="3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Center circle (coin symbol) */}
                <circle cx="26" cy="26" r="6" stroke="currentColor" strokeWidth="1.5" />
                {/* Corner circles */}
                <circle cx="13" cy="20" r="1.5" fill="currentColor" opacity="0.4" />
                <circle cx="39" cy="20" r="1.5" fill="currentColor" opacity="0.4" />
                <circle cx="13" cy="32" r="1.5" fill="currentColor" opacity="0.4" />
                <circle cx="39" cy="32" r="1.5" fill="currentColor" opacity="0.4" />
              </svg>
              <p className="text-sm text-center text-heading-gray">{t('noNotesToClaim')}</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-heading-gray mb-4 shrink-0 text-center font-medium">
                {t('readyToClaim', { count: safeClaimableNotes.length })}
              </p>
              {/* Scrollable grouped notes container */}
              <div className="flex flex-col gap-3 overflow-y-auto flex-1 min-h-0">
                {groupedNotes.map(group => (
                  <AssetNoteGroupComponent
                    key={group.faucetId}
                    group={group}
                    isExpanded={expandedGroups.has(group.faucetId)}
                    onToggleExpand={() => toggleGroupExpanded(group.faucetId)}
                    account={account}
                    mutateClaimableNotes={mutateClaimableNotes}
                    isDelegatedProvingEnabled={isDelegatedProvingEnabled}
                    claimingNoteIds={claimingNoteIds}
                    failedNoteIds={failedNoteIds}
                    checkingNoteIds={checkingNoteIds}
                    onClaimingStateChange={handleClaimingStateChange}
                  />
                ))}
              </div>
            </>
          )}
          {unclaimedNotes.length > 0 && (
            <div className="flex justify-center mt-4 pb-4 shrink-0">
              <Button
                className="w-30 h-10 text-md"
                variant={ButtonVariant.Primary}
                onClick={handleClaimAll}
                title={t('claimAll')}
              />
            </div>
          )}
        </div>
      </div>

      {/* QR Code Bottom Sheet */}
      <AnimatePresence>
        {isQRSheetOpen && (
          <>
            <motion.div
              className="absolute inset-0 bg-black/30 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsQRSheetOpen(false)}
            />
            <motion.div
              className="absolute bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              style={{ paddingBottom: isMobile() ? 'max(2rem, env(safe-area-inset-bottom))' : '2rem' }}
            >
              <div className="flex justify-center pt-4 pb-2">
                <div className="w-12 h-1 bg-grey-200 rounded-full" />
              </div>
              <div className="flex flex-col items-center p-6 pt-2">
                <QRCode address={address} size={200} onCopy={copy} className="w-full" />
                {copied && (
                  <p className="text-xs text-primary-500 mt-2 transition-opacity duration-200">{t('copied')}</p>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

// Asset Group Component with collapsible table
interface AssetNoteGroupProps {
  group: AssetNoteGroup;
  isExpanded: boolean;
  onToggleExpand: () => void;
  account: WalletAccount;
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  failedNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
}

const AssetNoteGroupComponent: React.FC<AssetNoteGroupProps> = ({
  group,
  isExpanded,
  onToggleExpand,
  account,
  mutateClaimableNotes,
  isDelegatedProvingEnabled,
  claimingNoteIds,
  failedNoteIds,
  checkingNoteIds,
  onClaimingStateChange
}) => {
  const { t } = useTranslation();
  const { notes, metadata, faucetId, totalAmount } = group;

  // Count notes being claimed in this group
  const claimingCount = notes.filter(n => n.isBeingClaimed || claimingNoteIds.has(n.id)).length;

  // Single note - render inline without collapsible
  if (notes.length === 1) {
    const note = notes[0];
    return (
      <SingleNoteRow
        note={note}
        account={account}
        mutateClaimableNotes={mutateClaimableNotes}
        isDelegatedProvingEnabled={isDelegatedProvingEnabled}
        isClaimingFromParent={claimingNoteIds.has(note.id)}
        hasFailedFromParent={failedNoteIds.has(note.id)}
        isCheckingFromParent={checkingNoteIds.has(note.id)}
        onClaimingStateChange={onClaimingStateChange}
      />
    );
  }

  const formattedTotal = formatBigInt(totalAmount, metadata?.decimals || 6);
  const symbol = metadata?.symbol || 'UNKNOWN';

  // Count public and private notes
  const publicCount = notes.filter(n => n.type === NoteTypeEnum.Public || n.type === 'unknown').length;
  const privateCount = notes.filter(n => n.type === NoteTypeEnum.Private).length;

  return (
    <div className="border border-grey-100 rounded-xl overflow-hidden">
      {/* Group Header */}
      <button
        type="button"
        onClick={onToggleExpand}
        className={classNames(
          'w-full flex items-center justify-between bg-white hover:bg-grey-50 transition-colors',
          isMobile() ? 'pt-[14px] pb-[10px] pl-[8px] pr-[25px]' : 'pt-[10px] pb-[7px] pl-[6px] pr-[17.5px]'
        )}
      >
        {/* Left: Icon + Symbol */}
        <div className="flex items-center gap-2 min-w-0">
          <AssetIcon assetSlug={symbol} assetId={faucetId} size={24} className="shrink-0 rounded-lg" />
          <span className="text-sm font-normal">{symbol}</span>
        </div>

        {/* Right: Total amount */}
        <span className={classNames('font-regular text-[#0000009E] pr-[12px]', isMobile() ? 'text-xs' : 'text-sm')}>
          {formattedTotal}
        </span>

        {/* Center: Eye icons showing public/private counts */}
        <div className={classNames('flex items-center gap-2', publicCount > 0 && privateCount > 0 ? '' : 'pr-2')}>
          {publicCount > 0 && <EyeOpenIcon className="text-primary-500" style={{ width: 18, height: 18 }} />}
          {privateCount > 0 && <EyeClosedIcon className="text-primary-500" style={{ width: 18, height: 18 }} />}
        </div>

        {/* Far right: Count + Chevron */}
        <div className="flex items-center gap-2 pr-5">
          <span className="text-sm text-grey-500">
            {claimingCount}/{notes.length}
          </span>
        </div>
      </button>

      {/* Collapsible Table */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            {/* Table Header */}
            <div className="grid grid-cols-[minmax(80px,1fr)_minmax(60px,auto)_50px_70px] gap-x-3 px-3 py-2 border-y-[0.5px] border-y-[#00000033] text-xs text-[#0000009E] font-medium items-center">
              <span>{t('from')}</span>
              <span className="text-center">{t('amount')}</span>
              <span className="text-center">{t('status')}</span>
              <span className="text-center">{t('action')}</span>
            </div>

            {/* Table Rows */}
            <div className="divide-y divide-grey-100 overflow-y-auto max-h-[240px]">
              {notes.map(note => (
                <NoteTableRow
                  key={note.id}
                  note={note}
                  account={account}
                  mutateClaimableNotes={mutateClaimableNotes}
                  isDelegatedProvingEnabled={isDelegatedProvingEnabled}
                  isClaimingFromParent={claimingNoteIds.has(note.id)}
                  hasFailedFromParent={failedNoteIds.has(note.id)}
                  isCheckingFromParent={checkingNoteIds.has(note.id)}
                  onClaimingStateChange={onClaimingStateChange}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Single note row (for assets with only 1 note)
interface SingleNoteRowProps {
  note: NoteWithMetadata;
  account: WalletAccount;
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  isClaimingFromParent?: boolean;
  hasFailedFromParent?: boolean;
  isCheckingFromParent?: boolean;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
}

const SingleNoteRow: React.FC<SingleNoteRowProps> = ({
  note,
  account,
  mutateClaimableNotes,
  isDelegatedProvingEnabled,
  isClaimingFromParent = false,
  hasFailedFromParent = false,
  isCheckingFromParent = false,
  onClaimingStateChange
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(note.isBeingClaimed || false);
  const showSpinner = isLoading || isClaimingFromParent || isCheckingFromParent;
  const [error, setError] = useState<string | null>(null);
  const hasError = error || hasFailedFromParent;
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onClaimingStateChange?.(note.id, isLoading);
  }, [isLoading, note.id, onClaimingStateChange]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleClaim = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    hapticLight();

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);

      if (isExtension()) {
        // On extension: fire-and-forget — SW handles processing.
        // Note shows "claiming" spinner via isLoading state.
        // Note disappears when sync cycle removes it from getConsumableNotes().
        requestSWTransactionProcessing();

        // Wait for the Dexie transaction to complete (Dexie liveQuery updates from SW)
        try {
          await waitForConsumeTx(id, signal);
          await mutateClaimableNotes();
          // Don't setIsLoading(false) on success — keep spinner until sync removes the note
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError('Failed to claim note');
          setIsLoading(false);
        }
      } else {
        useWalletStore.getState().openTransactionModal();
        await waitForConsumeTx(id, signal);
        const remainingNotes = await mutateClaimableNotes();

        if (isMobile() && (!remainingNotes || remainingNotes.length === 0)) {
          navigate('/', HistoryAction.Replace);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(t('failedToClaimNote'));
      console.error('Error claiming note:', err);
    } finally {
      if (!isExtension()) {
        setIsLoading(false);
      }
    }
  }, [account, isDelegatedProvingEnabled, mutateClaimableNotes, note]);

  const { metadata, faucetId } = note;
  const symbol = metadata?.symbol || 'UNKNOWN';
  const formattedAmount = formatBigInt(BigInt(note.amount), metadata?.decimals || 6);
  const senderDisplay = note.senderAddress ? truncateAddress(note.senderAddress) : t('unknown');
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div className="relative border-[0.5px] border-[#00000033]  rounded-[10px] p-3">
      <SyncWaveBackground isSyncing={showSpinner} className="rounded-xl" />
      <div className="flex items-center justify-between relative z-10">
        <div className="flex items-center gap-3">
          <AssetIcon assetSlug={symbol} assetId={faucetId} size={32} />
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {formattedAmount} {symbol}
            </span>
            <span className="text-xs text-grey-500">
              {t('from')}: {senderDisplay}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-primary-500">
            {isPublic ? (
              <EyeOpenIcon style={{ width: 14, height: 14 }} />
            ) : (
              <EyeClosedIcon style={{ width: 14, height: 14 }} />
            )}
          </div>
          {!showSpinner && (
            <Button
              className="w-[65px] h-[32px] text-xs"
              variant={ButtonVariant.Primary}
              onClick={handleClaim}
              title={hasError ? t('retry') : t('claim')}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// Table row for notes within a group
interface NoteTableRowProps {
  note: NoteWithMetadata;
  account: WalletAccount;
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  isClaimingFromParent?: boolean;
  hasFailedFromParent?: boolean;
  isCheckingFromParent?: boolean;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
}

const NoteTableRow: React.FC<NoteTableRowProps> = ({
  note,
  account,
  mutateClaimableNotes,
  isDelegatedProvingEnabled,
  isClaimingFromParent = false,
  hasFailedFromParent = false,
  isCheckingFromParent = false,
  onClaimingStateChange
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(note.isBeingClaimed || false);
  const showSpinner = isLoading || isClaimingFromParent || isCheckingFromParent;
  const [error, setError] = useState<string | null>(null);
  const hasError = error || hasFailedFromParent;
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onClaimingStateChange?.(note.id, isLoading);
  }, [isLoading, note.id, onClaimingStateChange]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleClaim = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    hapticLight();

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);

      if (isExtension()) {
        requestSWTransactionProcessing();

        try {
          await waitForConsumeTx(id, signal);
          await mutateClaimableNotes();
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError('Failed to claim note');
          setIsLoading(false);
        }
      } else {
        useWalletStore.getState().openTransactionModal();
        await waitForConsumeTx(id, signal);
        const remainingNotes = await mutateClaimableNotes();

        if (isMobile() && (!remainingNotes || remainingNotes.length === 0)) {
          navigate('/', HistoryAction.Replace);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(t('failedToClaimNote'));
      console.error('Error claiming note:', err);
    } finally {
      if (!isExtension()) {
        setIsLoading(false);
      }
    }
  }, [account, isDelegatedProvingEnabled, mutateClaimableNotes, note]);

  const { metadata } = note;
  const formattedAmount = formatBigInt(BigInt(note.amount), metadata?.decimals || 6);
  const senderDisplay = note.senderAddress ? truncateAddress(note.senderAddress, false, 8) : t('unknown');
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div className="relative bg-white">
      <SyncWaveBackground isSyncing={showSpinner} className="rounded-none" />
      <div className="grid grid-cols-[minmax(80px,1fr)_minmax(60px,auto)_50px_70px] gap-x-3 px-3 py-4 items-center text-heading-gray relative z-10">
        <span className={isMobile() ? 'text-[10px]' : 'text-xs'}>{senderDisplay}</span>
        <span className="text-sm font-medium text-center">{formattedAmount}</span>
        <div className="text-grey-400 flex justify-center">
          {isPublic ? (
            <EyeOpenIcon style={{ width: 16, height: 16 }} />
          ) : (
            <EyeClosedIcon style={{ width: 16, height: 16 }} />
          )}
        </div>
        <div className="flex justify-center">
          {!showSpinner ? (
            <Button
              className="rounded-[6.1px] px-[10px] !py-1"
              variant={ButtonVariant.Primary}
              onClick={handleClaim}
              title={hasError ? t('retry') : t('claim')}
            />
          ) : (
            <div className="w-[60px] h-[28px]" />
          )}
        </div>
      </div>
    </div>
  );
};
