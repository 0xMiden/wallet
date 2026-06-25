import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { ReactComponent as EyeClosedIcon } from 'app/icons/eye-closed.svg';
import { ReactComponent as EyeOpenIcon } from 'app/icons/eye-open.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { SyncWaveBackground } from 'components/SyncWaveBackground';
import { TokenLogo } from 'components/TokenLogo';
import { formatBigInt } from 'lib/i18n/numbers';
import { initiateConsumeTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { AssetMetadata } from 'lib/miden/front';
import { ConsumableNote, NoteTypeEnum } from 'lib/miden/types';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
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
  failedNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimAll: () => void;
  onClaimGroup?: (faucetId: string) => void;
}

const formatUsd = (value: number): string => {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

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
  failedNoteIds,
  checkingNoteIds,
  onClaimingStateChange,
  onClaimAll,
  onClaimGroup
}) => {
  const { registerBackHandler } = useAppEnv();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
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
        group={selectedGroup}
        tokenPrices={tokenPrices}
        account={account}
        isDelegatedProvingEnabled={isDelegatedProvingEnabled}
        claimingNoteIds={claimingNoteIds}
        failedNoteIds={failedNoteIds}
        checkingNoteIds={checkingNoteIds}
        onClaimingStateChange={onClaimingStateChange}
        onClaimGroup={onClaimGroup}
      />
    );
  }

  return (
    <PendingSummary
      groupedNotes={groupedNotes}
      tokenPrices={tokenPrices}
      claimingNoteIds={claimingNoteIds}
      unclaimedNotesCount={unclaimedNotesCount}
      onSelectGroup={handleSelectGroup}
      onClaimAll={onClaimAll}
    />
  );
};

interface PendingSummaryProps {
  groupedNotes: AssetNoteGroup[];
  tokenPrices: TokenPrices;
  claimingNoteIds: Set<string>;
  unclaimedNotesCount: number;
  onSelectGroup: (faucetId: string) => void;
  onClaimAll: () => void;
}

const PendingSummary: React.FC<PendingSummaryProps> = ({
  groupedNotes,
  tokenPrices,
  claimingNoteIds,
  unclaimedNotesCount,
  onSelectGroup,
  onClaimAll
}) => {
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
      <div className="w-full mx-auto py-4 px-4 flex flex-col min-h-full gap-3">
        <div className="bg-surface-interactive rounded-10 px-4 py-4 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold text-accent-primary leading-none">{t('totalPending')}</span>
            <span className="font-heading text-[32px] font-bold text-text-primary-token leading-none tracking-tight">
              {formatUsd(totals.totalUsd)}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 justify-center">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-medium text-accent-primary flex gap-1">
                <p className="font-bold text-black">{`${totals.notesCount} `}</p>
                {t('pendingNotesCount')}
              </span>
            </div>
            <span className="font-medium text-text-primary-token flex gap-1 text-[10px]">
              <p className="font-bold text-black">{`${totals.assetsCount} `}</p> {t('pendingAssetsCount')}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {groupedNotes.map(group => (
            <AssetSummaryRow
              key={group.faucetId}
              group={group}
              claimingNoteIds={claimingNoteIds}
              onClick={() => onSelectGroup(group.faucetId)}
            />
          ))}
        </div>

        {unclaimedNotesCount > 0 && !isMobile() && (
          <div className="flex justify-center mt-2 pb-2">
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

interface AssetSummaryRowProps {
  group: AssetNoteGroup;
  claimingNoteIds: Set<string>;
  onClick: () => void;
}

const AssetSummaryRow: React.FC<AssetSummaryRowProps> = ({ group, claimingNoteIds, onClick }) => {
  const { t } = useTranslation();
  const { metadata, notes, totalAmount } = group;
  const symbol = metadata?.symbol || 'UNKNOWN';
  const decimals = metadata?.decimals ?? 6;
  const formattedTotal = formatBigInt(totalAmount, decimals);
  const claimingCount = notes.filter(n => n.isBeingClaimed || claimingNoteIds.has(n.id)).length;

  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        'w-full flex items-center rounded-2xl border border-rule-default bg-white',
        'px-4 py-3 hover:bg-surface-interactive transition-colors text-left'
      )}
    >
      <div className="flex items-center gap-2 flex-3 min-w-0">
        <TokenLogo symbol={symbol} size="md" />
        <div className="flex flex-col min-w-0">
          <span className="text-base font-extrabold text-heading-gray dark:text-pure-white leading-tight truncate">
            {metadata?.name || symbol}
          </span>
          <span className="font-heading text-xs text-black opacity-50 leading-tight mt-0.5 font-semibold">
            {formattedTotal} {symbol} <span className="italic">{t('pending')}</span>
          </span>
        </div>
      </div>
      <span className="text-sm font-semibold text-black opacity-60 flex-1">
        {claimingCount}/{notes.length}
      </span>
      <Icon name={IconName.ArrowRight} className="w-4 h-4 text-accent-primary shrink-0" fill="currentColor" />
    </button>
  );
};

interface AssetPendingDetailProps {
  group: AssetNoteGroup;
  tokenPrices: ReturnType<typeof useWalletStore.getState>['tokenPrices'];
  account: WalletAccount;
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  failedNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  onClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  onClaimGroup?: (faucetId: string) => void;
}

const AssetPendingDetail: React.FC<AssetPendingDetailProps> = ({
  group,
  tokenPrices,
  account,
  isDelegatedProvingEnabled,
  claimingNoteIds,
  failedNoteIds,
  checkingNoteIds,
  onClaimingStateChange,
  onClaimGroup
}) => {
  const { t } = useTranslation();
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
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full mx-auto pt-6 px-4 flex flex-col min-h-full">
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
            <span className="mr-1">≈</span>
            {formatUsd(usdValue)}
          </div>

          <div className="mt-5 rounded-2xl border border-rule-default bg-white overflow-hidden w-full">
            {notes.map((note, index) => (
              <DetailNoteRow
                key={note.id}
                note={note}
                account={account}
                isDelegatedProvingEnabled={isDelegatedProvingEnabled}
                isClaimingFromParent={claimingNoteIds.has(note.id)}
                hasFailedFromParent={failedNoteIds.has(note.id)}
                isCheckingFromParent={checkingNoteIds.has(note.id)}
                onClaimingStateChange={onClaimingStateChange}
                showDivider={index !== notes.length - 1}
              />
            ))}
          </div>
        </div>
        {onClaimGroup && (
          <button
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
  isClaimingFromParent?: boolean;
  hasFailedFromParent?: boolean;
  isCheckingFromParent?: boolean;
  onClaimingStateChange?: (noteId: string, isClaiming: boolean) => void;
  showDivider: boolean;
}

const DetailNoteRow: React.FC<DetailNoteRowProps> = ({
  note,
  account,
  isDelegatedProvingEnabled,
  isClaimingFromParent = false,
  hasFailedFromParent = false,
  isCheckingFromParent = false,
  onClaimingStateChange,
  showDivider
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
      // Explicit user tap (Claim / Retry) — bypass the auto-consume backoff gate
      // so a retry after a failure always queues a fresh attempt.
      const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled, true);

      if (isExtension()) {
        requestSWTransactionProcessing();
      }

      if (!signal.aborted) {
        navigate({
          pathname: '/generating-transaction-full',
          search: `?txId=${encodeURIComponent(id)}`
        });
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

  const { metadata } = note;
  const decimals = metadata?.decimals ?? 6;
  const formattedAmount = formatBigInt(BigInt(note.amount), decimals);
  const symbol = metadata?.symbol || 'UNKNOWN';
  const senderDisplay = note.senderAddress ? truncateAddress(note.senderAddress) : t('unknown');
  const isPublic = note.type === NoteTypeEnum.Public || note.type === 'unknown';

  return (
    <div className={classNames('relative', showDivider && 'border-b border-rule-default w-full')}>
      <SyncWaveBackground isSyncing={showSpinner} className="rounded-none" />
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-4 py-3 relative z-10">
        <span className="text-sm text-text-primary-token truncate">{senderDisplay}</span>
        <div className="text-accent-primary flex justify-center">
          {isPublic ? (
            <EyeOpenIcon style={{ width: 16, height: 16 }} />
          ) : (
            <EyeClosedIcon style={{ width: 16, height: 16 }} />
          )}
        </div>
        <span className="font-heading text-sm font-medium text-text-primary-token text-right">
          {formattedAmount}
          {symbol}
        </span>
        {!showSpinner ? (
          <Button
            className="w-18 h-7.5 text-white font-semibold rounded-5 text-xs leading-none"
            variant={ButtonVariant.Primary}
            onClick={handleClaim}
            title={hasError ? t('retry') : t('claim')}
          />
        ) : (
          <div className="w-18 h-7.5" />
        )}
      </div>
    </div>
  );
};
