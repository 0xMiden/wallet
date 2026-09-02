import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { deriveNoteClaimState, NoteClaimState } from 'app/hooks/noteClaimState';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Icon, IconName } from 'app/icons/v2';
import { formatDate } from 'app/templates/history/transactionUtils';
import { MarkAsSpamDrawer } from 'app/templates/MarkAsSpamDrawer';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { formatBigInt, formatUsd } from 'lib/i18n/numbers';
import { initiateConsumeTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { isWorthClaiming } from 'lib/miden/fees/spendable';
import { AssetMetadata } from 'lib/miden/front';
import { useNoteSpamState } from 'lib/miden/front/note-spam';
import { SpamAction } from 'lib/miden/note-spam';
import { ConsumableNote, NoteTypeEnum } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { useLongPress } from 'lib/ui/useLongPress';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { NoteContextMenu } from './NoteContextMenu';
import { SpamUndoBanner } from './SpamUndoBanner';

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
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimAll: () => void;
  onClaimGroup?: (faucetId: string) => void;
  /**
   * Fires when the tab moves between the asset list (`null`) and one asset's
   * detail (its faucet id), so the page can tailor its header — the spam bin is
   * only offered on the list.
   */
  onSelectedGroupChange?: (faucetId: string | null) => void;
}

const groupNumber = (value: string): string => {
  const parts = value.split('.');
  const whole = parts[0] ?? '0';
  const decimal = parts[1];
  const wholeGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimal !== undefined ? `${wholeGrouped}.${decimal}` : wholeGrouped;
};

export const PendingTab: React.FC<PendingTabProps> = ({
  safeClaimableNotes,
  unclaimedNotesCount,
  account,
  isDelegatedProvingEnabled,
  claimingNoteIds,
  retriableNoteIds,
  invalidNoteIds,
  checkingNoteIds,
  onClaimingStateChange,
  onClaimAll,
  onClaimGroup,
  onSelectedGroupChange
}) => {
  const { registerBackHandler } = useAppEnv();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [selectedFaucetId, setSelectedFaucetId] = useState<string | null>(null);

  // Hide / block flow. The store applies the action optimistically, so the row is
  // gone in this render; the banner offers a one-tap Undo for a few seconds and
  // the spam bin keeps the action reversible after that.
  const spam = useNoteSpamState();
  const [undoAction, setUndoAction] = useState<SpamAction | null>(null);

  const handleSpamAction = useCallback(
    (action: SpamAction) => {
      setUndoAction(action);
      spam.run(action).catch(err => console.error('[PendingTab] spam action failed:', err));
    },
    [spam]
  );

  const handleUndo = useCallback(() => {
    if (!undoAction) return;
    setUndoAction(null);
    spam.undo(undoAction).catch(err => console.error('[PendingTab] spam undo failed:', err));
  }, [spam, undoAction]);

  const dismissUndo = useCallback(() => setUndoAction(null), []);

  const banner = (
    <div className="px-6">
      <SpamUndoBanner action={undoAction} onUndo={handleUndo} onDismiss={dismissUndo} />
    </div>
  );

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

  const selectedGroup = useMemo(
    () => groupedNotes.find(g => g.faucetId === selectedFaucetId) ?? null,
    [groupedNotes, selectedFaucetId]
  );

  useEffect(() => {
    if (selectedFaucetId && !selectedGroup) {
      setSelectedFaucetId(null);
    }
  }, [selectedFaucetId, selectedGroup]);

  // Report the effective view, not the raw selection: a selected group that has
  // just emptied is on its way back to the list (see the reset above).
  const effectiveFaucetId = selectedGroup ? selectedFaucetId : null;
  useEffect(() => {
    onSelectedGroupChange?.(effectiveFaucetId);
  }, [effectiveFaucetId, onSelectedGroupChange]);

  const handleSelectGroup = useCallback((faucetId: string) => {
    hapticLight();
    setSelectedFaucetId(faucetId);
  }, []);

  const handleBack = useCallback(() => {
    hapticLight();
    setSelectedFaucetId(null);
  }, []);

  useEffect(() => {
    if (!selectedFaucetId) return;
    return registerBackHandler(handleBack);
  }, [selectedFaucetId, handleBack, registerBackHandler]);

  if (selectedGroup) {
    return (
      <>
        {banner}
        <AssetPendingDetail
          group={selectedGroup}
          tokenPrices={tokenPrices}
          account={account}
          isDelegatedProvingEnabled={isDelegatedProvingEnabled}
          claimingNoteIds={claimingNoteIds}
          retriableNoteIds={retriableNoteIds}
          invalidNoteIds={invalidNoteIds}
          checkingNoteIds={checkingNoteIds}
          onClaimingStateChange={onClaimingStateChange}
          onClaimGroup={onClaimGroup}
          onSpamAction={handleSpamAction}
        />
      </>
    );
  }

  return (
    <>
      {banner}
      <PendingSummary
        groupedNotes={groupedNotes}
        tokenPrices={tokenPrices}
        unclaimedNotesCount={unclaimedNotesCount}
        retriableNoteIds={retriableNoteIds}
        invalidNoteIds={invalidNoteIds}
        onSelectGroup={handleSelectGroup}
        onClaimAll={onClaimAll}
        onSpamAction={handleSpamAction}
      />
    </>
  );
};

interface PendingSummaryProps {
  groupedNotes: AssetNoteGroup[];
  tokenPrices: TokenPrices;
  unclaimedNotesCount: number;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  onSelectGroup: (faucetId: string) => void;
  onClaimAll: () => void;
  onSpamAction: (action: SpamAction) => void;
}

const PendingSummary: React.FC<PendingSummaryProps> = ({
  groupedNotes,
  tokenPrices,
  unclaimedNotesCount,
  retriableNoteIds,
  invalidNoteIds,
  onSelectGroup,
  onClaimAll,
  onSpamAction
}) => {
  const verificationBaseFee = useVerificationBaseFee();
  const nativeFaucetId = useMidenFaucetId();
  const { t } = useTranslation();

  // The asset group whose "Mark as spam?" sheet is open. Kept as the last group
  // (not cleared on close) so the sheet's contents don't blank while it animates
  // out — same shape as the per-note sheet in AssetPendingDetail.
  const [spamGroup, setSpamGroup] = useState<AssetNoteGroup | null>(null);
  const [spamSheetOpen, setSpamSheetOpen] = useState(false);

  const openSpamSheet = useCallback((group: AssetNoteGroup) => {
    hapticLight();
    setSpamGroup(group);
    setSpamSheetOpen(true);
  }, []);

  // The sheet is per-note; for a whole group it needs only the faucet, the
  // total and the metadata, so the group is presented as one note carrying its
  // total. The sender is not meaningful for a group and is never read in
  // `asset` scope.
  const spamGroupAsNote = useMemo(
    () =>
      spamGroup && {
        id: spamGroup.faucetId,
        faucetId: spamGroup.faucetId,
        senderAddress: '',
        amount: spamGroup.totalAmount.toString(),
        metadata: spamGroup.metadata
      },
    [spamGroup]
  );

  const totals: { totalUsd: number; notesCount: number; assetsCount: number } = useMemo(() => {
    let totalUsd = 0;
    let notesCount = 0;
    for (const group of groupedNotes) {
      const decimals = group.metadata?.decimals ?? 6;
      const amount = Number(formatBigInt(group.totalAmount, decimals));
      const { price } = getTokenPrice(tokenPrices, group.metadata?.symbol || '');
      totalUsd += amount * price;
      notesCount += group.notes.length;
    }
    return { totalUsd, notesCount, assetsCount: groupedNotes.length };
  }, [groupedNotes, tokenPrices]);

  if (groupedNotes.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-4 flex flex-col min-h-full">
          <div className="flex flex-col items-center justify-center flex-1">
            <p className="text-sm text-center text-text-tertiary-token">{t('noNotesToClaim')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full mx-auto py-2 px-6 flex flex-col min-h-full">
        <div className="bg-surface-interactive rounded-10 px-4 py-3">
          <p className="text-[10px] text-center text-black font-heading font-semibold leading-snug">
            {t('pendingNotesInfo')}
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-1 font-heading">
          <span className="text-sm font-bold text-primary-500 leading-none">{t('totalPending')}</span>
          <span className="font-heading text-5xl font-extrabold text-heading-gray leading-none tracking-tight">
            {formatUsd(totals.totalUsd)}
          </span>
          <span className="mt-1 text-sm font-bold text-heading-gray font-heading">
            <span className="mr-1.5">•</span>
            {t('notesPendingAcrossAssets', { notes: totals.notesCount, assets: totals.assetsCount })}
          </span>
        </div>

        <div className="mt-5 border-b-4 border-rule-default" />

        <div className="flex flex-col">
          {groupedNotes.map((group, index) => (
            <AssetSummaryRow
              key={group.faucetId}
              group={group}
              tokenPrices={tokenPrices}
              retriableNoteIds={retriableNoteIds}
              invalidNoteIds={invalidNoteIds}
              // NATIVE groups only. The fee is quoted in the native asset's base units,
              // so comparing another asset's base units against it compares two
              // different currencies: a perfectly valuable token group was labelled
              // "not worth claiming" purely because its raw base-unit total happened to
              // be a small number. Auto-consume never touches non-native notes either,
              // so the label's premise does not hold for them. Judging a token group
              // properly needs a price conversion, which is a separate feature.
              notWorthClaiming={
                nativeFaucetId !== null &&
                group.faucetId === nativeFaucetId &&
                !isWorthClaiming(group.totalAmount, verificationBaseFee)
              }
              showDivider={index !== groupedNotes.length - 1}
              onClick={() => onSelectGroup(group.faucetId)}
              // The native faucet can never be blocked (it would hide every MIDEN
              // note and fight auto-consume), so its row gets no dismiss affordance.
              onMarkSpam={group.faucetId === nativeFaucetId ? undefined : () => openSpamSheet(group)}
            />
          ))}
        </div>

        <MarkAsSpamDrawer
          open={spamSheetOpen}
          onOpenChange={setSpamSheetOpen}
          note={spamGroupAsNote}
          isNativeFaucet={false}
          scope="asset"
          noteCount={spamGroup?.notes.length ?? 0}
          onConfirm={onSpamAction}
        />

        {unclaimedNotesCount > 0 && (
          <div className="flex justify-center mt-auto pt-4 pb-2">
            <Button
              data-testid="claim-all-button"
              className="w-full"
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

interface AssetSummaryRowProps {
  /** True when the group's total is worth no more than the fee to claim it. */
  notWorthClaiming?: boolean;
  group: AssetNoteGroup;
  tokenPrices: TokenPrices;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  showDivider: boolean;
  onClick: () => void;
  /** Opens the "Mark as spam?" sheet for the whole group. Absent for the native faucet. */
  onMarkSpam?: () => void;
}

const AssetSummaryRow: React.FC<AssetSummaryRowProps> = ({
  notWorthClaiming,
  group,
  tokenPrices,
  retriableNoteIds,
  invalidNoteIds,
  showDivider,
  onClick,
  onMarkSpam
}) => {
  const { t } = useTranslation();
  const { metadata, notes, totalAmount } = group;
  const symbol = metadata?.symbol || 'UNKNOWN';
  const decimals = metadata?.decimals ?? 6;
  const formattedTotal = groupNumber(formatBigInt(totalAmount, decimals));
  const { price } = getTokenPrice(tokenPrices, symbol);
  const usdValue = Number(formatBigInt(totalAmount, decimals)) * price;

  // Notes in this group that failed or went terminal (#456): surface them as a
  // distinct red badge so a failure is discoverable from the summary, instead
  // of the neutral incoming-count pill.
  const needsAttentionCount = notes.filter(n => retriableNoteIds.has(n.id) || invalidNoteIds.has(n.id)).length;

  // The row is one native <button>, so the dismiss control cannot live inside it
  // (nested buttons are invalid). It sits as a sibling, aligned with the amount
  // column, and the row's right padding makes room for it.
  return (
    <div className={classNames('relative w-full', showDivider && 'border-b border-rule-default')}>
      <button
        data-testid="pending-asset-row"
        type="button"
        onClick={onClick}
        className={classNames('w-full py-4 text-left', onMarkSpam && 'pr-9')}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <TokenLogo symbol={symbol} size="md" />
            <span className="text-lg font-heading font-extrabold text-heading-gray dark:text-pure-white leading-tight truncate">
              {metadata?.name || symbol}
            </span>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span
              data-testid="pending-asset-amount"
              className="font-heading text-base font-bold text-heading-gray leading-tight"
            >
              {formattedTotal} {symbol}
            </span>
            <span className="font-heading text-sm text-black opacity-50 leading-tight">
              {t('pendingTabApproxUsd', { value: formatUsd(usdValue) })}
            </span>
          </div>
        </div>
        {notWorthClaiming && (
          // Auto-consume skips this group, so say why rather than leaving it to sit
          // there unexplained. Claiming stays available: the call is the user's, the
          // wallet just will not spend their money on it unprompted.
          <div className="mt-3 w-full text-center text-sm font-heading text-black opacity-50">
            {t('notWorthClaiming')}
          </div>
        )}
        {needsAttentionCount > 0 ? (
          <div className="mt-3 w-full rounded-full bg-red-500/10 py-2 text-center text-base font-heading font-semibold text-red-500">
            {t('notesUnresolved', { count: needsAttentionCount })}
          </div>
        ) : (
          <div className="mt-3 w-full rounded-full bg-surface-interactive py-2 text-center text-base font-heading font-semibold text-black opacity-60">
            {t('incomingTransfersCount', { count: notes.length })}
          </div>
        )}
      </button>
      {onMarkSpam && (
        <button
          data-testid="pending-asset-spam-button"
          type="button"
          aria-label={t('markAssetAsSpam', { asset: metadata?.name || symbol })}
          onClick={onMarkSpam}
          className={classNames(
            'absolute right-0 top-4 flex h-7 w-7 items-center justify-center rounded-full',
            'text-heading-gray opacity-50 hover:opacity-100 transition-opacity',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600'
          )}
        >
          <Icon name={IconName.Close} size="xs" fill="currentColor" className="w-3.5! h-3.5!" />
        </button>
      )}
    </div>
  );
};

interface AssetPendingDetailProps {
  group: AssetNoteGroup;
  tokenPrices: ReturnType<typeof useWalletStore.getState>['tokenPrices'];
  account: WalletAccount;
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimGroup?: (faucetId: string) => void;
  onSpamAction: (action: SpamAction) => void;
}

const AssetPendingDetail: React.FC<AssetPendingDetailProps> = ({
  group,
  tokenPrices,
  account,
  isDelegatedProvingEnabled,
  claimingNoteIds,
  retriableNoteIds,
  invalidNoteIds,
  checkingNoteIds,
  onClaimingStateChange,
  onClaimGroup,
  onSpamAction
}) => {
  const { t } = useTranslation();
  const { metadata, faucetId, notes, totalAmount } = group;
  const symbol = metadata?.symbol || 'UNKNOWN';
  const name = metadata?.name || symbol;
  const decimals = metadata?.decimals ?? 6;

  const midenFaucetId = useMidenFaucetId();
  const contacts = useWalletStore(s => s.settings?.contacts);
  const contactNameByAddress = useMemo(() => {
    const names = new Map<string, string>();
    for (const contact of contacts ?? []) names.set(contact.address, contact.name);
    return names;
  }, [contacts]);

  // The note whose "Mark as spam?" sheet is open. Kept as the last note (not
  // cleared on close) so the sheet's contents don't blank while it animates out.
  const [spamNote, setSpamNote] = useState<NoteWithMetadata | null>(null);
  const [spamSheetOpen, setSpamSheetOpen] = useState(false);

  const openSpamSheet = useCallback((note: NoteWithMetadata) => {
    setSpamNote(note);
    setSpamSheetOpen(true);
  }, []);

  const hideNote = useCallback(
    (note: NoteWithMetadata) => onSpamAction({ kind: 'hide-note', noteId: note.id }),
    [onSpamAction]
  );

  const formattedAmount = groupNumber(formatBigInt(totalAmount, decimals));
  const numericAmount = Number(formatBigInt(totalAmount, decimals));
  const { price } = getTokenPrice(tokenPrices, symbol);
  const usdValue = numericAmount * price;

  const unclaimedInGroup = notes.filter(n => !n.isBeingClaimed && !claimingNoteIds.has(n.id));
  const canClaimAllGroup = unclaimedInGroup.length > 0;

  const handleClaimGroup = useCallback(() => {
    if (!canClaimAllGroup) return;
    hapticLight();
    onClaimGroup?.(faucetId);
  }, [canClaimAllGroup, faucetId, onClaimGroup]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full mx-auto pt-6 px-6 flex flex-col min-h-full">
        <div className="flex flex-col items-center flex-1">
          <div className="inline-flex items-center px-3 py-1 rounded-5 bg-surface-interactive text-[10px] font-bold tracking-[0.08em] uppercase text-text-primary-token">
            <span>{name}</span>
            <span className="mx-2 text-heading-gray">•</span>
            <span>{t('incomingCount', { count: notes.length })}</span>
          </div>

          <div className="mt-4 flex items-end gap-2 leading-none">
            <span className="font-heading text-[44px] font-extrabold text-text-primary-token leading-none tracking-tight">
              {formattedAmount}
            </span>
            <span className="font-heading text-base font-bold text-heading-gray pb-1">{symbol}</span>
          </div>

          <div className="font-heading mt-2 text-sm text-heading-gray">
            {t('pendingTabApproxUsd', { value: formatUsd(usdValue) })}
          </div>

          <div className="mt-5 flex w-full flex-col gap-3">
            {notes.map(note => (
              <DetailNoteRow
                key={note.id}
                note={note}
                account={account}
                isDelegatedProvingEnabled={isDelegatedProvingEnabled}
                claimState={deriveNoteClaimState(note, {
                  retriableNoteIds,
                  invalidNoteIds,
                  claimingNoteIds,
                  checkingNoteIds
                })}
                onClaimingStateChange={onClaimingStateChange}
                senderName={contactNameByAddress.get(note.senderAddress)}
                onHide={hideNote}
                onMarkSpam={openSpamSheet}
              />
            ))}
          </div>

          <p className="mt-4 text-center font-heading text-sm font-semibold text-heading-gray">
            {t('pressAndHoldForOptions')}
          </p>
        </div>
        <MarkAsSpamDrawer
          open={spamSheetOpen}
          onOpenChange={setSpamSheetOpen}
          note={spamNote}
          isNativeFaucet={midenFaucetId !== null && spamNote?.faucetId === midenFaucetId}
          onConfirm={onSpamAction}
        />
        {onClaimGroup && (
          <button
            data-testid="claim-group-button"
            type="button"
            onClick={handleClaimGroup}
            disabled={!canClaimAllGroup}
            className={classNames(
              'mt-4 w-full rounded-2xl bg-surface-interactive py-3.5 text-base font-bold text-accent-primary',
              'hover:bg-grey-50 transition-colors',
              !canClaimAllGroup && 'opacity-50 cursor-not-allowed'
            )}
          >
            {t('claimAllProgress', { unclaimed: unclaimedInGroup.length, total: notes.length })}
          </button>
        )}
      </div>
    </div>
  );
};

interface DetailNoteRowProps {
  note: NoteWithMetadata;
  account: WalletAccount;
  isDelegatedProvingEnabled: boolean;
  /** Parent-derived state from the four claim id-sets (see deriveNoteClaimState). */
  claimState?: NoteClaimState;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
  /** Contact name for the sender, shown in place of the truncated address when known. */
  senderName?: string;
  onHide: (note: NoteWithMetadata) => void;
  onMarkSpam: (note: NoteWithMetadata) => void;
}

/**
 * One pending note as a four-cell card: sender · visibility · amount · Claim.
 * Press-and-hold (or right-click / Shift+F10) opens the note menu; the Claim
 * button is excluded from the hold so a finger resting on it still just claims.
 */
const DetailNoteRow: React.FC<DetailNoteRowProps> = ({
  note,
  account,
  isDelegatedProvingEnabled,
  claimState = 'pending',
  onClaimingStateChange,
  senderName,
  onHide,
  onMarkSpam
}) => {
  const { t } = useTranslation();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [isLoading, setIsLoading] = useState(note.isBeingClaimed || false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const { bind: longPressBind } = useLongPress({ onLongPress: openMenu, disabled: menuOpen });

  // Fold this row's local claim attempt into the parent-derived state: an
  // in-flight local claim reads as consuming; a local claim error reads as
  // retriable. Precedence: consuming > failed (terminal) > retriable > pending.
  const rowState: NoteClaimState =
    isLoading || claimState === 'consuming'
      ? 'consuming'
      : claimState === 'failed'
        ? 'failed'
        : error || claimState === 'retriable'
          ? 'retriable'
          : 'pending';

  const isRetriable = rowState === 'retriable';
  const isFailed = rowState === 'failed';
  // Terminal-invalid notes get no Retry/Claim affordance; everything else that
  // isn't spinning keeps a button.
  const showButton = rowState === 'pending' || rowState === 'retriable';

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
      // Explicit user tap (Claim / Retry) — bypass the auto-consume backoff gate
      // so a retry after a failure always queues a fresh attempt.
      const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled, true);

      if (isExtension()) {
        requestSWTransactionProcessing();
      }

      if (!signal.aborted) {
        navigate(`/generating-transaction-full/${encodeURIComponent(id)}`);
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
  }, [account, isDelegatedProvingEnabled, note, t]);

  const copySender = useCallback(() => {
    if (!note.senderAddress) return;
    navigator.clipboard.writeText(note.senderAddress).catch(err => console.warn('Copy sender failed:', err));
  }, [note.senderAddress]);

  const { metadata } = note;
  const decimals = metadata?.decimals ?? 6;
  const formattedAmount = formatBigInt(BigInt(note.amount), decimals);
  const symbol = metadata?.symbol || 'UNKNOWN';
  const { price } = getTokenPrice(tokenPrices, symbol);
  const usdValue = Number(formattedAmount) * price;
  const senderDisplay =
    senderName ?? (note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown'));
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div
      ref={rowRef}
      data-testid="detail-note-row"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      tabIndex={0}
      className={classNames(
        'relative w-full overflow-hidden rounded-2xl border border-border-card bg-white',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600',
        menuOpen && 'ring-2 ring-primary-500/40',
        (isRetriable || isFailed) && 'bg-red-500/10'
      )}
      // No iOS press-and-hold callout on the card: the hold belongs to the menu.
      style={{ WebkitTouchCallout: 'none' }}
      {...longPressBind}
    >
      <div className="relative z-10 flex items-stretch divide-x divide-border-card">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 bg-tx-received px-3 py-3">
          <span className="flex min-w-0 flex-col font-heading text-heading-gray">
            <span className="text-sm font-bold leading-tight">{t('From')}</span>
            <span className="truncate text-xs font-semibold leading-tight opacity-80">{senderDisplay}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center px-2.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-interactive px-2.5 py-1 font-heading text-xs font-medium text-text-muted">
            {!isPublic && <Icon name={IconName.EyeOff} size="xs" fill="currentColor" className="w-3! h-3!" />}
            {t(isPublic ? 'public' : 'shielded')}
          </span>
        </div>

        <div className="flex shrink-0 flex-col items-center justify-center px-2.5 font-heading">
          <span data-testid="detail-note-amount" className="inline-flex items-baseline gap-1">
            <span className="text-base font-extrabold leading-none text-receive-green">{formattedAmount}</span>
            <span className="text-sm font-bold leading-none text-heading-gray">{symbol}</span>
          </span>
          <span className="mt-1 text-[11px] font-medium leading-none text-heading-gray opacity-50">
            {t('pendingTabApproxUsd', { value: formatUsd(usdValue) })}
          </span>
        </div>

        {/* Presses that start on the Claim button never arm the hold (see useLongPress). */}
        <div className="flex shrink-0 items-center px-2.5" data-longpress-ignore="">
          {showButton ? (
            <Button
              data-testid="claim-button"
              className="w-auto shrink-0 px-4 h-8 text-sm leading-none"
              variant={ButtonVariant.Primary}
              onClick={handleClaim}
              title={isRetriable ? t('retry') : t('claim')}
            />
          ) : (
            <div className="w-16 h-8 shrink-0" />
          )}
        </div>
      </div>

      {(isRetriable || isFailed) && (
        <div className="relative z-10 border-t border-border-card px-3 py-2 text-xs text-red-500">
          {isRetriable ? t('noteClaimFailedRetry') : t('noteUnavailable')}
        </div>
      )}
      {note.recallableAtMs !== undefined && (
        <div className="relative z-10 flex items-center gap-2 border-t border-border-card bg-yellow-300 dark:bg-yellow-600/25 px-3 py-1.5">
          <Icon
            name={IconName.Time}
            className="w-3! h-3! shrink-0 text-yellow-800 dark:text-yellow-300 [&_path]:fill-current"
          />
          <span className="font-heading text-xs font-semibold leading-tight text-yellow-700 dark:text-yellow-300">
            {t('noteReturnsToSenderBy', { date: formatDate(note.recallableAtMs / 1000) })}
          </span>
        </div>
      )}

      <NoteContextMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorEl={rowRef.current}
        canClaim={showButton}
        onClaim={handleClaim}
        onHide={() => onHide(note)}
        onCopySender={copySender}
        onMarkSpam={() => onMarkSpam(note)}
      />
    </div>
  );
};
