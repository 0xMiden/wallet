import React, { FC, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/ui/Avatar';
import { CopyButton } from 'components/ui/CopyButton';
import { DappOrigin } from 'components/ui/DappOrigin';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { WalletAccount } from 'lib/shared/types';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { cn } from 'lib/ui/util';
import { truncateAddress, truncateHash } from 'utils/string';

import { TxAssetView } from './decode';
import type { NoteFlow } from './note-flow';
import { quantityOf, ResolvedAsset, useResolvedAssets } from './TransactionAssetView';
import { loadConfirmationTokenMetadata, TransactionNoteFlow } from './TransactionNoteFlow';

/**
 * The body of the extension's transaction and consume windows: the amount and a one-line summary
 * up top, the money moving between the two parties (with the network fee where the request
 * carries one), then where the request came from and the note's details.
 */

/** One `Label, value` line of a dApp preview, split at its first ", "; a line with none is all label. */
function readMessages(messages: string[]): Array<{ label: string; value: string }> {
  return messages.map(message => {
    const at = message.indexOf(', ');
    return at === -1 ? { label: message, value: '' } : { label: message.slice(0, at), value: message.slice(at + 2) };
  });
}

/**
 * The preview lines a view does not lay out itself. This is the approval surface: a line the
 * backend adds later must still reach the user, so anything unrecognised is listed as written.
 */
const OtherLines: FC<{ rows: Array<{ label: string; value: string }>; known: string[] }> = ({ rows, known }) => (
  <>
    {rows
      .filter(row => !known.includes(row.label))
      .map((row, i) => (
        <DetailRow key={`${row.label}-${i}`} label={row.label}>
          {row.value}
        </DetailRow>
      ))}
  </>
);

const SEND_LINES = ['From', 'Amount', 'Recipient', 'Note Type', 'Recall Blocks'];
const CONSUME_LINES = ['Amount', 'Receiving', 'Note Type', 'Network fee (max)'];

/** The amount without its sign, for the summary pill. */
const unsigned = (amount: string) => amount.replace(/^[+-]/, '');

const initialOf = (text: string) => Array.from(text.trim())[0]?.toUpperCase() ?? '?';

// --------------------------------------------------------------------------------------------
// Shared pieces
// --------------------------------------------------------------------------------------------

interface HeaderLine {
  amount: string;
  symbol?: string;
  incoming: boolean;
  testId?: string;
  verified?: boolean;
}

/** The signed amount(s) as the window's figure, then the summary pill under them. */
const AmountHeader: FC<{ lines: HeaderLine[]; pill: React.ReactNode; dim?: boolean; children?: React.ReactNode }> = ({
  lines,
  pill,
  dim = false,
  children
}) => (
  <div className="flex flex-col items-center gap-2 text-center">
    {lines.length > 0 && (
      <div className="flex flex-col gap-1">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'text-hero-value',
              dim ? 'text-muted' : line.incoming ? 'text-positive-tint-ink' : 'text-ink'
            )}
          >
            <span data-testid={line.testId}>{line.amount}</span>
            {line.symbol && <span className="ml-1.5 text-entry-unit">{line.symbol}</span>}
          </div>
        ))}
      </div>
    )}
    {pill}
    {children}
  </div>
);

/** `amount  [glyph]  counterparty`, like the in-progress transaction screen's summary badge. */
const SummaryPill: FC<{ children: React.ReactNode }> = ({ children }) => (
  <Pill size="lg" haptic={false} className="max-w-full">
    <span className="flex min-w-0 items-center gap-2.5 font-semibold">{children}</span>
  </Pill>
);

interface MovementRow {
  leading: React.ReactNode;
  title: React.ReactNode;
  subtitle: React.ReactNode;
  amount: React.ReactNode;
  incoming: boolean;
  dim?: boolean;
  titleTestId?: string;
  verified?: boolean;
}

/** Who sends to whom: one row per side, an arrow between them, the fee along the bottom. */
const MovementCard: FC<{ rows: MovementRow[]; fee?: { label: string; value: React.ReactNode } }> = ({ rows, fee }) => (
  <div className="relative overflow-hidden rounded-2xl border border-hairline bg-page">
    {rows.map((row, i) => (
      <div key={i} className={cn('relative flex items-center gap-3 px-4 py-3.5', i > 0 && 'border-t border-hairline')}>
        {i > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-3.5 left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-page text-muted"
          >
            <Icon name={IconName.ArrowDown} size="xs" fill="currentColor" />
          </span>
        )}
        {row.leading}
        <div className="min-w-0 flex-1">
          <div className="truncate text-row-title text-ink" data-testid={row.titleTestId}>
            {row.title}
          </div>
          <div className="truncate text-caption-heading text-muted">{row.subtitle}</div>
        </div>
        <span
          className={cn(
            'shrink-0 whitespace-nowrap text-value',
            row.dim ? 'text-muted' : row.incoming ? 'text-positive-tint-ink' : 'text-ink'
          )}
          data-verified={row.verified === undefined ? undefined : String(row.verified)}
        >
          {row.amount}
        </span>
      </div>
    ))}
    {fee && (
      <div className="flex items-center justify-between gap-3 border-t border-hairline bg-fill/50 px-4 py-3">
        <span className="text-body-sm font-semibold text-muted">{fee.label}</span>
        <span className="text-value text-ink" data-testid="tx-network-fee">
          {fee.value}
        </span>
      </div>
    )}
  </div>
);

/** Private (sage, a lock) or Public (sand, a globe); any other value as written. */
const NoteTypeBadge: FC<{ value: string }> = ({ value }) => {
  const kind = value.trim().toLowerCase();
  if (kind !== 'private' && kind !== 'public') return <span data-testid="confirm-tx-value-note-type">{value}</span>;
  const isPrivate = kind === 'private';
  return (
    <span
      className={cn(
        'inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-label',
        isPrivate ? 'bg-positive-tint text-positive-tint-ink' : 'bg-pending-tint text-pending-tint-ink'
      )}
    >
      <Icon name={isPrivate ? IconName.LockFilled : IconName.Globe} size="xs" fill="currentColor" />
      <span data-testid="confirm-tx-value-note-type">{value}</span>
    </span>
  );
};

/** The request card's first two rows: which site asked, on which network. */
const RequestRows: FC<{ origin: string }> = ({ origin }) => {
  const { t } = useTranslation();
  return (
    <>
      <DetailRow label={t('confirmTxRequestFrom')}>
        <DappOrigin origin={origin} className="justify-end text-right" data-testid="confirm-request-origin" />
      </DetailRow>
      <DetailRow label={t('network')}>{t('midenNetworkName', { network: t(getEffectiveNetworkName()) })}</DetailRow>
    </>
  );
};

const AccountAvatar: FC<{ account: WalletAccount }> = ({ account }) => (
  <Avatar size={40} tone="brand" initials={initialOf(account.name)} />
);

const GlyphAvatar: FC<{ icon: IconName; color?: string; tone?: 'neutral' }> = ({ icon, color, tone }) => (
  <Avatar
    size={40}
    tone={tone ?? 'custom'}
    color={color}
    icon={<Icon name={icon} size="sm" fill="currentColor" className={tone ? 'text-ink' : 'text-page'} />}
  />
);

const FailureNotice: FC<{ message: string; errorId: UserErrorId | null }> = ({ message, errorId }) => {
  const { t } = useTranslation();
  return (
    <Notice
      variant="fact"
      tone="negative"
      role="alert"
      errorId={errorId}
      title={t('confirmTxFailedTitle')}
      icon={<Icon name={IconName.FactCross} size="xs" fill="currentColor" />}
      data-testid="confirm-tx-error"
    >
      {message}
    </Notice>
  );
};

export interface TransactionRequestError {
  message: string;
  errorId: UserErrorId | null;
}

// --------------------------------------------------------------------------------------------
// Send
// --------------------------------------------------------------------------------------------

export const SendRequest: FC<{
  origin: string;
  account: WalletAccount;
  messages: string[];
  error?: TransactionRequestError;
}> = ({ origin, account, messages, error }) => {
  const { t } = useTranslation();
  // `formatSendTransactionPreview`: 'Transfer note from faucet:', the faucet id, then label lines.
  const faucetId = messages[1] ?? '';
  const rows = useMemo(() => readMessages(messages.slice(2)), [messages]);
  const value = (label: string) => rows.find(row => row.label === label)?.value;
  const amount = value('Amount') ?? '';
  const recipient = value('Recipient') ?? '';
  const from = value('From') ?? account.publicKey;
  const noteType = value('Note Type');
  const recallBlocks = value('Recall Blocks');

  // The preview carries the faucet id but not its symbol: look it up the way the custom view does.
  const [symbol, setSymbol] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    if (!faucetId) return undefined;
    loadConfirmationTokenMetadata(faucetId)
      .then(md => {
        if (!cancelled && hasKnownScale(md)) setSymbol(md.symbol);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [faucetId]);

  const withSymbol = (a: string) => (symbol ? `${a} ${symbol}` : a);
  const recipientShort = truncateAddress(recipient);

  return (
    <div className="contents face-heading">
      <div className="flex w-full flex-col gap-5">
        <AmountHeader
          lines={[{ amount, symbol, incoming: false, testId: 'confirm-tx-value-amount' }]}
          pill={
            <SummaryPill>
              <span className="truncate">{withSymbol(unsigned(amount))}</span>
              <Icon name={IconName.Send} size="xs" fill="currentColor" className="shrink-0 text-accent-send" />
              <span className="truncate">{recipientShort}</span>
            </SummaryPill>
          }
        >
          {noteType && <NoteTypeBadge value={noteType} />}
        </AmountHeader>
        {error && <FailureNotice message={error.message} errorId={error.errorId} />}
        <MovementCard
          rows={[
            {
              leading: <AccountAvatar account={account} />,
              title: account.name,
              subtitle: `${truncateAddress(from)} · ${t('confirmTxYouTag')}`,
              amount: withSymbol(amount),
              incoming: false
            },
            {
              leading: <Avatar size={40} tone="neutral" initials={initialOf(recipient)} />,
              title: recipientShort,
              subtitle: t('recipient'),
              amount: withSymbol(`+${unsigned(amount)}`),
              incoming: false,
              titleTestId: 'confirm-tx-value-recipient'
            }
          ]}
        />
        <DetailCard surface="outline" face="heading">
          <RequestRows origin={origin} />
          {recallBlocks && <DetailRow label={t('confirmTxRecallBlocks')}>{recallBlocks}</DetailRow>}
          <OtherLines rows={rows} known={SEND_LINES} />
          <DetailRow label={t('confirmTxTokenFaucet')}>
            <span className="flex items-center gap-1.5">
              {/* The full id is the row's title and what Copy writes; the row shows it shortened. */}
              <span title={faucetId}>{truncateAddress(faucetId)}</span>
              <span className="sr-only" data-testid="confirm-tx-faucet">
                {faucetId}
              </span>
              <CopyButton text={faucetId} icon="only" />
            </span>
          </DetailRow>
        </DetailCard>
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------------------------
// Consume
// --------------------------------------------------------------------------------------------

export const ConsumeRequest: FC<{
  origin: string;
  account: WalletAccount;
  messages: string[];
  noteId: string;
  error?: TransactionRequestError;
}> = ({ origin, account, messages, noteId, error }) => {
  const { t } = useTranslation();
  // `formatConsumeTransactionPreview`: a headline naming the (shortened) faucet, then label lines.
  const headline = messages[0] ?? '';
  const faucetShort = headline.includes(': ') ? headline.slice(headline.indexOf(': ') + 2) : '';
  const rows = useMemo(() => readMessages(messages.slice(1)), [messages]);
  const amounts = rows.filter(row => row.label === 'Amount').map(row => row.value);
  const receiving = rows.filter(row => row.label === 'Receiving').map(row => row.value);
  const noteType = rows.find(row => row.label === 'Note Type')?.value;
  const maxFee = rows.find(row => row.label === 'Network fee (max)')?.value;
  const first = amounts[0];

  return (
    <div className="contents face-heading">
      <div className="flex w-full flex-col gap-5">
        <AmountHeader
          lines={amounts.map((amount, i) => ({
            amount,
            incoming: true,
            testId: i === 0 ? 'confirm-tx-value-amount' : undefined
          }))}
          pill={
            <SummaryPill>
              <span className="truncate">{first ? unsigned(first) : headline}</span>
              <Icon name={IconName.Receive} size="xs" fill="currentColor" className="shrink-0 text-accent-receive" />
              <span className="truncate">{account.name}</span>
            </SummaryPill>
          }
        >
          {noteType && <NoteTypeBadge value={noteType} />}
        </AmountHeader>
        {error && <FailureNotice message={error.message} errorId={error.errorId} />}
        <MovementCard
          rows={[
            {
              leading: <GlyphAvatar icon={IconName.ArrowRightDownFill} tone="neutral" />,
              title: t('confirmTxNoteFromFaucet'),
              subtitle: faucetShort,
              amount: amounts.map(unsigned).join(', '),
              incoming: false
            },
            {
              leading: <AccountAvatar account={account} />,
              title: account.name,
              subtitle: `${truncateAddress(account.publicKey)} · ${t('confirmTxYouTag')}`,
              amount: amounts.join(', '),
              incoming: true
            }
          ]}
          fee={maxFee ? { label: t('networkFeeMax'), value: maxFee.replace(/^-/, '') } : undefined}
        />
        <DetailCard surface="outline" face="heading">
          <RequestRows origin={origin} />
          {receiving.map((nft, i) => (
            <DetailRow key={i} label={t('confirmTxReceiving')}>
              {nft}
            </DetailRow>
          ))}
          <OtherLines rows={rows} known={CONSUME_LINES} />
          <DetailRow label={t('noteId')}>
            <span className="flex items-center gap-1.5">
              <span title={noteId}>{truncateHash(noteId)}</span>
              <CopyButton text={noteId} icon="only" />
            </span>
          </DetailRow>
        </DetailCard>
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------------------------
// Custom transaction
// --------------------------------------------------------------------------------------------

export const CustomRequest: FC<{
  origin: string;
  account: WalletAccount;
  view: TxAssetView;
  mode: 'verified' | 'declared';
  noteFlow?: NoteFlow;
  simulationFailed: boolean;
  advanced: React.ReactNode;
  error?: TransactionRequestError;
}> = ({ origin, account, view, mode, noteFlow, simulationFailed, advanced, error }) => {
  const { t } = useTranslation();
  const outgoing = useResolvedAssets(view.outgoing);
  const incoming = useResolvedAssets(view.incoming);
  const feeAssets = useMemo(() => (view.fee ? [view.fee] : []), [view.fee]);
  const [feeAsset] = useResolvedAssets(feeAssets);
  const verified = mode === 'verified';
  const dim = !verified;
  const label = (a: ResolvedAsset) => `${quantityOf(a)} ${a.symbol ?? t('unknown')}`;
  const moves =
    view.outgoing.length > 0 ||
    view.incoming.length > 0 ||
    view.outgoingNfts.length > 0 ||
    view.incomingNfts.length > 0 ||
    view.unlistedAssets > 0;

  const rows: MovementRow[] = [
    ...outgoing.map(a => ({
      leading: <GlyphAvatar icon={IconName.ArrowRightUpFill} color="var(--accent-send)" />,
      title: t('confirmTxYouPay'),
      subtitle: t('confirmTxLeavesAccount'),
      amount: `-${label(a)}`,
      incoming: false,
      dim,
      verified
    })),
    ...view.outgoingNfts.map(nft => ({
      leading: <GlyphAvatar icon={IconName.ArrowRightUpFill} color="var(--accent-send)" />,
      title: t('confirmTxYouPay'),
      subtitle: `${t('nftFaucet')} ${truncateAddress(nft.faucetId)}`,
      amount: `-${t('nft')} ${nft.assetId}`,
      incoming: false,
      dim,
      verified
    })),
    ...incoming.map(a => ({
      leading: <GlyphAvatar icon={IconName.ArrowRightDownFill} color="var(--accent-receive)" />,
      title: t('confirmTxYouGet'),
      subtitle: t('confirmTxArrivesAccount'),
      amount: `+${label(a)}`,
      incoming: true,
      dim,
      verified
    })),
    ...view.incomingNfts.map(nft => ({
      leading: <GlyphAvatar icon={IconName.ArrowRightDownFill} color="var(--accent-receive)" />,
      title: t('confirmTxYouGet'),
      subtitle: `${t('nftFaucet')} ${truncateAddress(nft.faucetId)}`,
      amount: `+${t('nft')} ${nft.assetId}`,
      incoming: true,
      dim,
      verified
    }))
  ];

  const headerLines: HeaderLine[] = [
    ...outgoing.map(a => ({ amount: `-${quantityOf(a)}`, symbol: a.symbol ?? t('unknown'), incoming: false })),
    ...incoming.map(a => ({ amount: `+${quantityOf(a)}`, symbol: a.symbol ?? t('unknown'), incoming: true }))
  ];

  return (
    <div className="contents face-heading">
      <div
        className="flex w-full flex-col gap-5"
        data-testid="tx-asset-view"
        data-mode={mode}
        data-account={view.account ?? ''}
      >
        <AmountHeader
          lines={headerLines}
          dim={dim}
          pill={
            <SummaryPill>
              <Icon name={IconName.Code} size="xs" fill="currentColor" className="shrink-0 text-muted" />
              <span className="truncate">{t('confirmTxCustomTransaction')}</span>
            </SummaryPill>
          }
        >
          {dim && !simulationFailed && (
            <span className="text-caption-heading text-muted">{t('declaredBySiteVerifying')}</span>
          )}
        </AmountHeader>

        {error && <FailureNotice message={error.message} errorId={error.errorId} />}
        {simulationFailed && (
          <Notice
            variant="fact"
            tone="warning"
            title={t('confirmTxNotVerifiedTitle')}
            icon={<Icon name={IconName.FactAlert} size="xs" fill="currentColor" />}
            data-testid="tx-simulation-failed"
          >
            {t('couldNotVerifyBySimulation')}
          </Notice>
        )}
        {view.unlistedAssets > 0 && (
          <Notice
            variant="fact"
            tone="warning"
            icon={<Icon name={IconName.FactAlert} size="xs" fill="currentColor" />}
            data-testid="tx-unlisted-assets"
          >
            {t('unlistedAssetsWarning')}
          </Notice>
        )}

        {(rows.length > 0 || view.fee) && (
          <section>
            {/* Named for assistive tech and for the E2E preview checks; the rows say the rest. */}
            {moves && <h3 className="sr-only">{t('assetChanges')}</h3>}
            <MovementCard
              rows={rows}
              fee={view.fee ? { label: t('networkFee'), value: feeAsset ? label(feeAsset) : t('loading') } : undefined}
            />
          </section>
        )}

        <DetailCard surface="outline" face="heading">
          <RequestRows origin={origin} />
          {view.account && (
            <DetailRow label={t('account')} sub={truncateAddress(view.account)}>
              {account.name}
            </DetailRow>
          )}
          <DetailRow label={t('inputNotesConsumed')}>{view.inputNotesConsumed}</DetailRow>
          <DetailRow label={t('outputNotesCreated')}>
            <span data-testid="tx-output-notes-created">{view.outputNotesCreated}</span>
          </DetailRow>
          {verified && (
            <DetailRow label={t('storageChanged')}>
              {view.storageChanged ? (
                <span className="flex items-center gap-1.5">
                  <Icon name={IconName.WarningFill} size="xs" fill="currentColor" className="text-pending-ink" />
                  <span data-testid="tx-storage-changed" data-changed="true">
                    {t('yes')}
                  </span>
                </span>
              ) : (
                <span data-testid="tx-storage-changed" data-changed="false">
                  {t('no')}
                </span>
              )}
            </DetailRow>
          )}
        </DetailCard>

        {verified && noteFlow ? (
          <TransactionNoteFlow flow={noteFlow} account={view.account} />
        ) : (
          <p className="px-1 text-caption-heading text-muted" data-testid="tx-note-flow-unavailable">
            {t(verified ? 'verifiedNoteDetailsUnavailable' : 'declaredNoteDetailsUnavailable')}
          </p>
        )}

        {advanced}
      </div>
    </div>
  );
};
