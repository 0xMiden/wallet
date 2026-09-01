import React, { FC, ReactNode, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { TokenLogo } from 'components/TokenLogo';
import { formatBigInt } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotesWithSpam } from 'lib/miden/front/claimable-notes';
import { useNoteSpamState } from 'lib/miden/front/note-spam';
import { NoteSpamEntry } from 'lib/miden/note-spam';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { truncateAddress } from 'utils/string';

/** Newest first — the bin reads like a log of what the user just did. */
const newestFirst = (entries: NoteSpamEntry[]): NoteSpamEntry[] => [...entries].sort((a, b) => b.at - a.at);

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h2 className="font-heading text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">{title}</h2>
    <div className="flex flex-col divide-y divide-border-light rounded-2xl border border-border-card bg-white">
      {children}
    </div>
  </section>
);

const Row: FC<{ leading?: ReactNode; title: string; subtitle?: string; actionLabel: string; onAction: () => void }> = ({
  leading,
  title,
  subtitle,
  actionLabel,
  onAction
}) => (
  <div className="flex items-center gap-3 px-3 py-3">
    {leading}
    <div className="flex min-w-0 flex-1 flex-col font-heading">
      <span className="truncate text-sm font-bold text-heading-gray">{title}</span>
      {subtitle && <span className="truncate text-xs text-text-muted">{subtitle}</span>}
    </div>
    <Button
      variant={ButtonVariant.Secondary}
      className="w-auto shrink-0 px-3 h-8 text-xs leading-none"
      title={actionLabel}
      onClick={onAction}
    />
  </div>
);

/**
 * The spam bin behind the trash button on Pending Notes: the notes the spam
 * list is hiding right now, plus the blocked assets and senders doing the
 * hiding. Every row has a one-tap way back.
 */
const SpamNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const account = useAccount();
  const { spam: hiddenNotes } = useClaimableNotesWithSpam(account.publicKey);
  const { state, remove } = useNoteSpamState();
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const handleBack = useBackWithFallback('/pending-notes');

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  const blockedFaucets = useMemo(() => newestFirst(state.blockedFaucetIds), [state.blockedFaucetIds]);
  const blockedSenders = useMemo(() => newestFirst(state.blockedSenders), [state.blockedSenders]);
  // Only individually-hidden notes get a Restore row; a note hidden by a block
  // comes back when its asset or sender is unblocked below.
  const hiddenById = useMemo(() => {
    const ids = new Set(state.hiddenNoteIds.map(entry => entry.value));
    return hiddenNotes.filter(note => ids.has(note.id));
  }, [hiddenNotes, state.hiddenNoteIds]);
  const hiddenCountByFaucet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of hiddenNotes) counts.set(note.faucetId, (counts.get(note.faucetId) ?? 0) + 1);
    return counts;
  }, [hiddenNotes]);

  const isEmpty = hiddenById.length === 0 && blockedFaucets.length === 0 && blockedSenders.length === 0;

  const act = (promise: Promise<void>) => promise.catch(err => console.error('[SpamNotes] restore failed:', err));

  return (
    <div
      data-testid="spam-notes-page"
      className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}
    >
      <NavigationHeader title={t('spamBin')} onBack={handleBack} variant="prominent" titleAlign="left" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex w-full flex-col gap-6 px-6 pb-6 pt-2">
          {isEmpty && (
            <p className="py-10 text-center text-sm text-text-tertiary-token" data-testid="spam-bin-empty">
              {t('spamBinEmpty')}
            </p>
          )}

          {hiddenById.length > 0 && (
            <Section title={t('spamHiddenNotes')}>
              {hiddenById.map(note => {
                const symbol = note.metadata?.symbol || 'UNKNOWN';
                const decimals = note.metadata?.decimals ?? 6;
                return (
                  <Row
                    key={note.id}
                    leading={<TokenLogo symbol={symbol} size="sm" />}
                    title={`${formatBigInt(BigInt(note.amount), decimals)} ${symbol}`}
                    subtitle={`${t('from')} ${note.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown')}`}
                    actionLabel={t('restore')}
                    onAction={() => act(remove('hidden-note', note.id))}
                  />
                );
              })}
            </Section>
          )}

          {blockedFaucets.length > 0 && (
            <Section title={t('spamBlockedAssets')}>
              {blockedFaucets.map(entry => {
                const metadata = assetsMetadata[entry.value];
                const symbol = metadata?.symbol;
                return (
                  <Row
                    key={entry.value}
                    leading={symbol ? <TokenLogo symbol={symbol} size="sm" /> : undefined}
                    title={metadata?.name || symbol || truncateAddress(entry.value, false, 8, 4)}
                    subtitle={t('spamBlockedAssetNotes', { count: hiddenCountByFaucet.get(entry.value) ?? 0 })}
                    actionLabel={t('unblock')}
                    onAction={() => act(remove('blocked-faucet', entry.value))}
                  />
                );
              })}
            </Section>
          )}

          {blockedSenders.length > 0 && (
            <Section title={t('spamBlockedSenders')}>
              {blockedSenders.map(entry => (
                <Row
                  key={entry.value}
                  title={truncateAddress(entry.value, false, 8, 4)}
                  actionLabel={t('unblock')}
                  onAction={() => act(remove('blocked-sender', entry.value))}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
};

export default SpamNotes;
