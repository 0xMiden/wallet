import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { deriveNoteClaimState, NoteClaimState } from 'app/hooks/noteClaimState';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { ReactComponent as EyeOpenIcon } from 'app/icons/eye-open.svg';
import { Icon, IconName } from 'app/icons/v2';
import { formatDate } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { SyncWaveBackground } from 'components/SyncWaveBackground';
import { TokenLogo } from 'components/TokenLogo';
import { formatBigInt, formatUsd } from 'lib/i18n/numbers';
import { initiateConsumeTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { isWorthClaiming } from 'lib/miden/fees/spendable';
import { AssetMetadata } from 'lib/miden/front';
import { ConsumableNote, NoteTypeEnum } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
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
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimAll: () => void;
  onClaimGroup?: (faucetId: string) => void;
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
  onClaimGroup
}) => {
  const { registerBackHandler } = useAppEnv();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  // Same pair `PendingSummary` resolves, so the detail view can judge the group it is
  // showing rather than being told nothing about it.
  const verificationBaseFee = useVerificationBaseFee();
  const nativeFaucetId = useMidenFaucetId();
  const [selectedFaucetId, setSelectedFaucetId] = useState<string | null>(null);

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
      <AssetPendingDetail
        notWorthClaiming={
          nativeFaucetId !== null &&
          selectedGroup.faucetId === nativeFaucetId &&
          !isWorthClaiming(selectedGroup.totalAmount, verificationBaseFee)
        }
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
      />
    );
  }

  const claimingCount = safeClaimableNotes.filter(n => n.isBeingClaimed).length;

  return (
    <PendingSummary
      groupedNotes={groupedNotes}
      tokenPrices={tokenPrices}
      unclaimedNotesCount={unclaimedNotesCount}
      claimingCount={claimingCount}
      retriableNoteIds={retriableNoteIds}
      invalidNoteIds={invalidNoteIds}
      onSelectGroup={handleSelectGroup}
      onClaimAll={onClaimAll}
    />
  );
};

interface PendingSummaryProps {
  /** Notes with a live consume behind them; they have already left `unclaimedNotesCount`. */
  claimingCount: number;
  groupedNotes: AssetNoteGroup[];
  tokenPrices: TokenPrices;
  unclaimedNotesCount: number;
  retriableNoteIds: Set<string>;
  invalidNoteIds: Set<string>;
  onSelectGroup: (faucetId: string) => void;
  onClaimAll: () => void;
}

const PendingSummary: React.FC<PendingSummaryProps> = ({
  groupedNotes,
  tokenPrices,
  unclaimedNotesCount,
  claimingCount,
  retriableNoteIds,
  invalidNoteIds,
  onSelectGroup,
  onClaimAll
}) => {
  const verificationBaseFee = useVerificationBaseFee();
  const maxNetworkFee = useNetworkFeeEstimate();
  const nativeFaucetId = useMidenFaucetId();
  const { t } = useTranslation();

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
            />
          ))}
        </div>

        {/* Claiming does not navigate away any more, so this block is where progress is
            reported. Every note being claimed has already dropped out of `unclaimedNotesCount`,
            so gating on that alone made the CTA vanish the moment the user tapped it. */}
        {(unclaimedNotesCount > 0 || claimingCount > 0) && (
          <div className="flex flex-col items-center mt-auto pt-4 pb-2">
            {/* Claiming submits immediately -- there is no review step between this
                button and the transaction -- so this is the only place the cost can be
                stated before the user commits. Label and amount are separate nodes so
                no placeholder-only string has to survive translation. */}
            {maxNetworkFee && unclaimedNotesCount > 0 && (
              <div className="mb-2 text-center text-xs text-heading-gray">
                <div>
                  {t('networkFeeMax')} · {maxNetworkFee}
                </div>
                {/* Claim All submits one transaction PER FAUCET (useClaimNotes.ts), so the
                    bound above is one transaction's ceiling and the true maximum is that
                    times the asset count. Say so rather than quoting a single figure over
                    a button that submits several. */}
                {totals.assetsCount > 1 && <div className="mt-0.5">{t('feeChargedPerAsset')}</div>}
              </div>
            )}
            {/* Two ids on purpose: `claim-all-button` keeps meaning "an actionable Claim All",
                which is the contract the E2E helper reads — it treats that id being visible as
                permission to click, and a disabled button under it would make the helper click a
                control it cannot action. The in-flight state gets its own id, the same split #834
                made for the row's control. */}
            {unclaimedNotesCount > 0 ? (
              <Button
                data-testid="claim-all-button"
                className="w-full"
                variant={ButtonVariant.Primary}
                onClick={onClaimAll}
                title={t('claimAll')}
              />
            ) : (
              <Button
                data-testid="claim-all-status"
                className="w-full"
                variant={ButtonVariant.Primary}
                disabled
                isLoading
                title={t('claiming')}
              />
            )}
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
}

const AssetSummaryRow: React.FC<AssetSummaryRowProps> = ({
  notWorthClaiming,
  group,
  tokenPrices,
  retriableNoteIds,
  invalidNoteIds,
  showDivider,
  onClick
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

  return (
    <button
      data-testid="pending-asset-row"
      type="button"
      onClick={onClick}
      className={classNames('w-full py-4 text-left', showDivider && 'border-b border-rule-default')}
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
  /**
   * Whether claiming this group costs more than it credits. Computed by the caller,
   * which already resolves the native faucet and the base fee — the same value the
   * collapsed summary row shows. Passed down because THIS is the screen with the
   * Claim buttons: showing the warning only on the row the user taps through means
   * it is gone at the moment they decide.
   */
  notWorthClaiming?: boolean;
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
  notWorthClaiming = false
}) => {
  const { t } = useTranslation();
  const maxNetworkFee = useNetworkFeeEstimate();
  const { metadata, faucetId, notes, totalAmount } = group;
  const symbol = metadata?.symbol || 'UNKNOWN';
  const name = metadata?.name || symbol;
  const decimals = metadata?.decimals ?? 6;

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
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {notWorthClaiming && (
          // The verdict belongs on the screen with the Claim buttons, not only on the row
          // the user tapped to get here. Claiming stays enabled: the wallet declines to
          // spend their money unprompted, it does not refuse the choice.
          <div className="mb-3 w-full text-center text-sm font-heading text-black opacity-50">
            {t('notWorthClaiming')}
          </div>
        )}
        <div className="w-full mx-auto pt-6 px-6 flex flex-col">
          <div className="flex flex-col items-center">
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

            <div className="mt-5 w-full">
              {notes.map((note, index) => (
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
                  showDivider={index !== notes.length - 1}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      {onClaimGroup && (
        // Footer, deliberately OUTSIDE the scroller above. Every per-note Claim button
        // in the list submits its own transaction and pays its own fee, so the cost
        // statement has to stay on screen while those buttons are reachable -- when it
        // sat after the list, a screenful of notes hid it. It also means the group
        // button no longer has to be scrolled to.
        <div className="w-full mx-auto shrink-0 px-6 pb-4 pt-3">
          {maxNetworkFee && (
            <div className="mb-2 text-center text-xs text-heading-gray">
              <div>
                {t('networkFeeMax')} · {maxNetworkFee}
              </div>
              {/* The number is identical for every button on this screen; what differs is
                  how many times it is charged. The group button consumes all of this
                  faucet's notes in one transaction, so it pays once; claiming the rows
                  one at a time pays once each. Repeating the amount per row would say
                  the opposite. */}
              {notes.length > 1 && <div className="mt-0.5">{t('feeChargedPerClaim')}</div>}
            </div>
          )}
          <button
            data-testid="claim-group-button"
            type="button"
            onClick={handleClaimGroup}
            disabled={!canClaimAllGroup}
            className={classNames(
              'w-full rounded-2xl bg-surface-interactive py-3.5 text-base font-bold text-accent-primary',
              'hover:bg-grey-50 transition-colors',
              !canClaimAllGroup && 'opacity-50 cursor-not-allowed'
            )}
          >
            {t('claimAllProgress', { unclaimed: unclaimedInGroup.length, total: notes.length })}
          </button>
        </div>
      )}
    </div>
  );
};

/** Design-provided padlock glyph for private notes; inherits `currentColor`. */
const PrivateLockIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 23 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
    <path
      d="M4.17676 12.1703V8.60738C4.17676 4.17777 6.96934 1 11.2064 1C15.4434 1 18.236 4.17777 18.236 8.60738V12.1703"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M17.6592 12.3633H4.75554C2.68141 12.3633 1 14.0447 1 16.1188V23.2447C1 25.3189 2.68141 27.0003 4.75554 27.0003H17.6592C19.7333 27.0003 21.4148 25.3189 21.4148 23.2447V16.1188C21.4148 14.0447 19.7333 12.3633 17.6592 12.3633Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.2073 20.7409C12.1115 20.7409 12.8444 20.0079 12.8444 19.1038C12.8444 18.1997 12.1115 17.4668 11.2073 17.4668C10.3032 17.4668 9.57031 18.1997 9.57031 19.1038C9.57031 20.0079 10.3032 20.7409 11.2073 20.7409Z"
      fill="currentColor"
    />
    <path
      d="M12.2669 21.1266C12.2669 20.5416 11.7927 20.0674 11.2077 20.0674C10.6227 20.0674 10.1484 20.5416 10.1484 21.1266V22.6674C10.1484 23.2524 10.6227 23.7266 11.2077 23.7266C11.7927 23.7266 12.2669 23.2524 12.2669 22.6674V21.1266Z"
      fill="currentColor"
    />
  </svg>
);

interface DetailNoteRowProps {
  note: NoteWithMetadata;
  account: WalletAccount;
  isDelegatedProvingEnabled: boolean;
  /** Parent-derived state from the four claim id-sets (see deriveNoteClaimState). */
  claimState?: NoteClaimState;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
  showDivider: boolean;
}

const DetailNoteRow: React.FC<DetailNoteRowProps> = ({
  note,
  account,
  isDelegatedProvingEnabled,
  claimState = 'pending',
  onClaimingStateChange,
  showDivider
}) => {
  const { t } = useTranslation();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  // Purely "this row's own claim is in flight". The gated look for a note being claimed
  // elsewhere arrives via `claimState`, derived from `note.isBeingClaimed` -- seeding it here
  // too took a mount-time snapshot that never followed the note back to claimable.
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const showSpinner = rowState === 'consuming';
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

      // A SINGLE-note claim still goes to the progress screen, deliberately. That screen is
      // addressed by one transaction id, which is exactly what this is -- so it renders a true
      // receipt (sender, total consumed, note ids, fee, explorer link) and its own interval keeps
      // driving the queue off-extension. Claim All is the case it cannot represent: that queues
      // one consume PER FAUCET and only the first id survives, so the screen would assert a
      // confident, wrong receipt while the other faucets were still queued or already failed.
      // See `useClaimNotes.claimNotesBatch`, which is where the navigation was removed.
      if (!signal.aborted) {
        navigate(`/generating-transaction-full/${encodeURIComponent(id)}`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(t('failedToClaimNote'));
      console.error('Error claiming note:', err);
    } finally {
      // Same reason as the batch set in `useClaimNotes`: `note.isBeingClaimed` now comes from
      // the live consume row, so this row-local latch no longer has to stay on to keep the
      // spinner up on extension. Latching it also survived the gate clearing, so the button
      // stayed gone until the row was unmounted and remounted.
      setIsLoading(false);
    }
  }, [account, isDelegatedProvingEnabled, note, t]);

  const { metadata } = note;
  const decimals = metadata?.decimals ?? 6;
  const formattedAmount = formatBigInt(BigInt(note.amount), decimals);
  const symbol = metadata?.symbol || 'UNKNOWN';
  const { price } = getTokenPrice(tokenPrices, symbol);
  const usdValue = Number(formattedAmount) * price;
  const senderDisplay = note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div
      data-testid="detail-note-row"
      className={classNames(
        'relative w-full',
        showDivider && 'border-b border-rule-default',
        (isRetriable || isFailed) && 'bg-red-500/10'
      )}
    >
      <SyncWaveBackground isSyncing={showSpinner} className="rounded-none" />
      <div className="flex items-center gap-3 py-3.5 relative z-10">
        <div className="flex min-w-0 flex-1 flex-col gap-1 font-heading text-heading-gray">
          <div className="flex items-end gap-1.5">
            <span data-testid="detail-note-amount" className="inline-flex items-end gap-1.5">
              <span className="text-xl font-extrabold leading-none text-receive-green">{formattedAmount}</span>
              <span className="text-sm font-bold leading-none">{symbol}</span>
            </span>
            <span className="text-[13px] font-medium leading-none opacity-50">
              {t('pendingTabApproxUsd', { value: formatUsd(usdValue) })}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight">
            <span className="font-medium lowercase opacity-50">{t('from')}</span>
            <span className="min-w-0 truncate font-bold">{senderDisplay}</span>
            <span className="font-medium opacity-40">·</span>
            {isPublic ? (
              <EyeOpenIcon className="w-3 h-3 shrink-0 [&_path]:fill-current" />
            ) : (
              <PrivateLockIcon className="w-2.5 h-3 shrink-0" />
            )}
            <span className="font-bold">{t(isPublic ? 'public' : 'private')}</span>
          </div>
        </div>

        {showButton ? (
          <Button
            data-testid="claim-button"
            className="w-auto shrink-0 px-4 h-8 text-sm leading-none"
            variant={ButtonVariant.Primary}
            onClick={handleClaim}
            title={isRetriable ? t('retry') : t('claim')}
          />
        ) : showSpinner && note.claimingTxId ? (
          // A note being consumed keeps a labelled control instead of unmounting to a blank
          // spacer, so the wait is legible -- and the control is a live destination: it opens
          // that consume's own progress screen, which already renders per-step rows and timings.
          <Button
            data-testid="claiming-status-button"
            className="w-auto shrink-0 px-4 h-8 text-sm leading-none"
            variant={ButtonVariant.Secondary}
            onClick={() => navigate(`/generating-transaction-full/${encodeURIComponent(note.claimingTxId!)}`)}
            title={t('claiming')}
          />
        ) : (
          <div className="w-20 h-8 shrink-0" />
        )}
      </div>
      {(isRetriable || isFailed) && (
        <div className="relative z-10 -mt-1 pb-3 text-xs text-red-500">
          {isRetriable ? t('noteClaimFailedRetry') : t('noteUnavailable')}
        </div>
      )}
      {note.recallableAtMs !== undefined && (
        <div className="relative z-10 -mt-1 mb-3.5 flex items-center gap-2 rounded-10 bg-yellow-300 dark:bg-yellow-600/25 px-2.5 py-1.5">
          <Icon
            name={IconName.Time}
            className="w-3! h-3! shrink-0 text-yellow-800 dark:text-yellow-300 [&_path]:fill-current"
          />
          <span className="font-heading text-xs font-semibold leading-tight text-yellow-700 dark:text-yellow-300">
            {t('noteReturnsToSenderBy', { date: formatDate(note.recallableAtMs / 1000) })}
          </span>
        </div>
      )}
    </div>
  );
};
