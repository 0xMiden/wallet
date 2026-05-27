import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as EyeClosedIcon } from 'app/icons/eye-closed.svg';
import { ReactComponent as EyeOpenIcon } from 'app/icons/eye-open.svg';
import { AssetIcon } from 'app/templates/AssetIcon';
import { Button, ButtonVariant } from 'components/Button';
import { SyncWaveBackground } from 'components/SyncWaveBackground';
import { formatBigInt } from 'lib/i18n/numbers';
import { initiateConsumeTransaction, requestSWTransactionProcessing, waitForConsumeTx } from 'lib/miden/activity';
import { AssetMetadata } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { ConsumableNote, NoteTypeEnum } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

export type NoteWithMetadata = NonNullable<ConsumableNote & { metadata: AssetMetadata }>;

export interface AssetNoteGroup {
  faucetId: string;
  metadata: AssetMetadata;
  notes: NoteWithMetadata[];
  totalAmount: bigint;
}

interface PendingTabProps {
  safeClaimableNotes: NoteWithMetadata[];
  unclaimedNotesCount: number;
  account: WalletAccount;
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  failedNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimAll: () => void;
}

export const PendingTab: React.FC<PendingTabProps> = ({
  safeClaimableNotes,
  unclaimedNotesCount,
  account,
  mutateClaimableNotes,
  isDelegatedProvingEnabled,
  claimingNoteIds,
  failedNoteIds,
  checkingNoteIds,
  onClaimingStateChange,
  onClaimAll
}) => {
  const { t } = useTranslation();
  const pendingCount = safeClaimableNotes.length;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full mx-auto py-4 px-4 flex flex-col min-h-full">
        {pendingCount === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1">
            <p className="text-sm text-center text-text-tertiary-token">{t('noNotesToClaim')}</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-heading-gray mb-4 text-center font-medium">
              {t('readyToClaim', { count: pendingCount })}
            </p>
            <div className="flex flex-col gap-3">
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
                  onClaimingStateChange={onClaimingStateChange}
                />
              ))}
            </div>
          </>
        )}
        {unclaimedNotesCount > 0 && !isMobile() && (
          <div className="flex justify-center mt-4 pb-4">
            <Button
              className="w-30 h-10 text-md"
              variant={ButtonVariant.Primary}
              onClick={onClaimAll}
              title={t('claimAll')}
            />
          </div>
        )}
      </div>
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

  const claimingCount = notes.filter(n => n.isBeingClaimed || claimingNoteIds.has(n.id)).length;

  const soloNote = notes.length === 1 ? notes[0] : null;
  if (soloNote) {
    return (
      <SingleNoteRow
        note={soloNote}
        account={account}
        mutateClaimableNotes={mutateClaimableNotes}
        isDelegatedProvingEnabled={isDelegatedProvingEnabled}
        isClaimingFromParent={claimingNoteIds.has(soloNote.id)}
        hasFailedFromParent={failedNoteIds.has(soloNote.id)}
        isCheckingFromParent={checkingNoteIds.has(soloNote.id)}
        onClaimingStateChange={onClaimingStateChange}
      />
    );
  }

  const formattedTotal = formatBigInt(totalAmount, metadata?.decimals || 6);
  const symbol = metadata?.symbol || 'UNKNOWN';

  const publicCount = notes.filter(n => n.type === NoteTypeEnum.Public || n.type === 'unknown').length;
  const privateCount = notes.filter(n => n.type === NoteTypeEnum.Private).length;

  return (
    <div className="rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggleExpand}
        className={classNames(
          'w-full flex items-center justify-between bg-app-bg hover:bg-grey-50 transition-colors',
          isMobile() ? 'pt-[14px] pb-[10px] pl-[8px] pr-[25px]' : 'pt-[10px] pb-[7px] pl-[6px] pr-[17.5px]'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AssetIcon assetSlug={symbol} assetId={faucetId} size={24} className="shrink-0 rounded-lg" />
          <span className="text-sm font-normal">{symbol}</span>
        </div>

        <span className={classNames('font-regular text-heading-gray pr-3', isMobile() ? 'text-xs' : 'text-sm')}>
          {formattedTotal}
        </span>

        <div className={classNames('flex items-center gap-2', publicCount > 0 && privateCount > 0 ? '' : 'pr-2')}>
          {publicCount > 0 && <EyeOpenIcon className="text-primary-500" style={{ width: 18, height: 18 }} />}
          {privateCount > 0 && <EyeClosedIcon className="text-primary-500" style={{ width: 18, height: 18 }} />}
        </div>

        <div className="flex items-center gap-2 pr-5">
          <span className="text-sm text-grey-500">
            {claimingCount}/{notes.length}
          </span>
        </div>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-[minmax(80px,1fr)_minmax(60px,auto)_50px_70px] gap-x-3 px-3 py-2 border-y-[0.5px] border-y-[#00000033] text-xs text-[#0000009E] font-medium items-center">
              <span>{t('from')}</span>
              <span className="text-center">{t('amount')}</span>
              <span className="text-center">{t('status')}</span>
              <span className="text-center">{t('action')}</span>
            </div>

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
        requestSWTransactionProcessing();

        console.log('[Claim] Queued tx:', id, 'requesting SW processing...');
        try {
          await waitForConsumeTx(id, signal);
          console.log('[Claim] TX completed successfully');
          await mutateClaimableNotes();
          // Don't setIsLoading(false) on success — keep spinner until sync removes the note
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.error('[Claim] waitForConsumeTx failed:', err);
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
      console.error('[Claim] Error in outer catch:', err);
    } finally {
      if (!isExtension()) {
        setIsLoading(false);
      }
    }
  }, [account, isDelegatedProvingEnabled, mutateClaimableNotes, note, t]);

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
            <span className="text-sm font-medium text-black">
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
  }, [account, isDelegatedProvingEnabled, mutateClaimableNotes, note, t]);

  const { metadata } = note;
  const formattedAmount = formatBigInt(BigInt(note.amount), metadata?.decimals || 6);
  const senderDisplay = note.senderAddress ? truncateAddress(note.senderAddress, false, 8) : t('unknown');
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div className="relative bg-app-bg">
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
