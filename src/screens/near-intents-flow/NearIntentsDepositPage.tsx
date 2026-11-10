import React, { useEffect, useState } from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { NetworkChip } from 'components/NetworkChip';
import { QRCode } from 'components/QRCode';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { getDateFnsLocale } from 'lib/i18n';
import { Redirect } from 'lib/woozie';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { truncateAddress } from 'utils/string';

import { chainLogoNetwork } from './chains';
import {
  acceptsDeposit,
  DEPOSIT_STATUS_DISPLAY,
  depositDeadlineMs,
  nearIntentsDepositStatus,
  nearIntentsTrackingOf
} from './deposit-status';
import { formatCountdown } from './format';

/** Resolution of the QR image; on screen the code scales to its frame. */
const QR_SIZE = 300;
const COUNTDOWN_TICK_MS = 1000;

/** The pill style of the copyable address and memo: the same one as the Miden address on Receive. */
const COPY_PILL_CLASS =
  'flex h-11 w-full items-center justify-center rounded-full bg-fill px-4 text-ink transition-colors hover:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-receive';

/** The current time, again each second while `ticking` is true. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}

export interface NearIntentsDepositPageProps {
  rowId: string;
}

/**
 * The deposit page of one NEAR Intents tracking row. It reads everything from the row, so it shows
 * the same deposit after a reload, and it follows the phase that the tracking loop writes. An
 * unknown row goes back to Receive.
 */
export const NearIntentsDepositPage: React.FC<NearIntentsDepositPageProps> = ({ rowId }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(rowId);

  /** The deadline time, with the time that is left while the deposit can still arrive. */
  const sendBeforeText = (deadlineMs: number, nowMs: number, counting: boolean): string => {
    const time = format(deadlineMs, 'HH:mm', { locale: getDateFnsLocale() });
    if (!counting) return time;
    return t('nearIntentsSendBeforeValue', { time, countdown: formatCountdown(deadlineMs - nowMs) });
  };
  const back = useBackWithFallback('/receive');
  const tracking = nearIntentsTrackingOf(row);
  const deadline = tracking ? depositDeadlineMs(tracking) : Number.NaN;
  const waitingPhase = tracking?.phase === 'depositing' || tracking?.phase === 'pending-deposit';
  const now = useNow(waitingPhase && Number.isFinite(deadline));

  if (!loaded) {
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );
  }
  if (!tracking) return <Redirect to="/receive" />;

  const deadlineKnown = Number.isFinite(deadline);
  const deadlinePassed = deadlineKnown && now >= deadline;
  const status = nearIntentsDepositStatus(tracking.phase, deadlinePassed);
  const display = DEPOSIT_STATUS_DISPLAY[status];
  const open = acceptsDeposit(status);
  const origin = tracking.originAsset;
  // The row keeps the config it was made with. A row from before the NEAR Intents config has no
  // chain list, so it shows the 1Click chain id.
  const chainName = tracking.config.chains?.find(chain => chain.id === origin.blockchain)?.name ?? origin.blockchain;
  const depositAddress = tracking.depositAddress ?? '';
  const depositMemo = tracking.depositMemo;
  const amountIn = tracking.quote.quote.amountInFormatted;
  const sendBefore = deadlineKnown ? sendBeforeText(deadline, now, waitingPhase && !deadlinePassed) : undefined;

  return (
    <SubPageLayout title={t('nearIntentsDepositTitle')} onBack={back} data-testid="near-intents-deposit-page">
      <section className="flex flex-col items-center gap-2 text-center">
        <span className="text-label text-muted">{t('nearIntentsSendExactly')}</span>
        <div className="flex items-center justify-center gap-2">
          <span className="text-hero-value text-ink select-text" data-testid="near-intents-deposit-amount">
            {amountIn} {origin.symbol}
          </span>
          {open && (
            <CopyButton
              text={amountIn}
              icon="only"
              iconClassName="text-accent-receive"
              checkClassName="text-positive-ink"
              aria-label={t('nearIntentsCopyAmount')}
              data-testid="near-intents-copy-amount"
            />
          )}
        </div>
        <NetworkChip
          kind="ethereum"
          network={chainLogoNetwork(origin.blockchain)}
          label={t('nearIntentsOnChain', { chain: chainName })}
          data-testid="near-intents-deposit-chain"
        />
      </section>

      {status === 'expired' ? (
        <Notice
          tone="negative"
          errorId={null}
          icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
          title={t('nearIntentsStatusExpired')}
          data-testid="near-intents-expired-notice"
        >
          {t('nearIntentsExpiredBody')}
        </Notice>
      ) : (
        open && (
          <section className="flex flex-col items-center gap-3">
            <div className="aspect-square w-full max-w-56" data-testid="near-intents-deposit-qr">
              <QRCode address={depositAddress} payload="plain" size={QR_SIZE} palette="green" />
            </div>
            <div className="flex w-full flex-col gap-2">
              <span className="px-1 text-label text-muted">{t('nearIntentsDepositAddress')}</span>
              <span className="sr-only" data-testid="near-intents-deposit-address-full">
                {depositAddress}
              </span>
              <CopyButton
                text={depositAddress}
                label={truncateAddress(depositAddress, true, 10, 4, 8)}
                icon="leading"
                iconClassName="text-accent-receive"
                checkClassName="text-positive-ink"
                className={COPY_PILL_CLASS}
                contentClassName="gap-2 font-heading text-base leading-5 font-bold"
                aria-label={t('nearIntentsCopyDepositAddress')}
                data-testid="near-intents-copy-address"
              />
            </div>
            {depositMemo && (
              <div className="flex w-full flex-col gap-2" data-testid="near-intents-deposit-memo">
                <span className="px-1 text-label text-muted">{t('nearIntentsDepositMemo')}</span>
                <CopyButton
                  text={depositMemo}
                  label={depositMemo}
                  icon="leading"
                  iconClassName="text-accent-receive"
                  checkClassName="text-positive-ink"
                  className={COPY_PILL_CLASS}
                  contentClassName="gap-2 font-heading text-base leading-5 font-bold"
                  aria-label={t('nearIntentsCopyMemo')}
                  data-testid="near-intents-copy-memo"
                />
                <Notice tone="warning" errorId={null} data-testid="near-intents-memo-warning">
                  {t('nearIntentsMemoWarning')}
                </Notice>
              </div>
            )}
          </section>
        )
      )}

      <DetailCard surface="fill">
        <DetailRow label={t('nearIntentsYouReceive')} data-testid="near-intents-fact-receive">
          {t('nearIntentsReceiveValue', {
            amount: tracking.quote.quote.amountOutFormatted,
            symbol: tracking.destinationAsset.symbol
          })}
        </DetailRow>
        {sendBefore !== undefined && (
          <DetailRow label={t('nearIntentsSendBefore')} data-testid="near-intents-fact-deadline">
            {sendBefore}
          </DetailRow>
        )}
        <DetailRow label={t('nearIntentsRefundTo')} data-testid="near-intents-fact-refund">
          {truncateAddress(tracking.request.refundTo)}
        </DetailRow>
      </DetailCard>

      <Pill
        size="lg"
        tone={display.tone}
        live
        icon={<span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />}
        className="w-full justify-center"
        data-testid="near-intents-deposit-status"
        data-phase={tracking.phase}
      >
        {t(display.labelKey)}
      </Pill>

      <p className="text-center text-caption text-muted" data-testid="near-intents-deposit-hint">
        {display.hintKey
          ? t(display.hintKey, { symbol: tracking.destinationAsset.symbol })
          : t('nearIntentsDepositCaption', { symbol: origin.symbol, chain: chainName })}
      </p>
    </SubPageLayout>
  );
};

export default NearIntentsDepositPage;
