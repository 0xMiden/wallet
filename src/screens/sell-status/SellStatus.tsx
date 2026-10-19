import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { CopyButton } from 'components/ui/CopyButton';
import { CopyChip } from 'components/ui/CopyChip';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { ISellExtraInputs } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { cn } from 'lib/ui/util';
import { navigate, Redirect } from 'lib/woozie';
import { sepoliaTxUrl } from 'screens/buy-status/buy-status-helpers';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import type { TransactionHeroState } from 'screens/generating-transaction/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { OrderProgressBar, OrderSteps, useNow } from 'screens/order-status/OrderProgress';
import { truncateHash } from 'utils/string';

import {
  formatDeadline,
  isSellTerminal,
  SELL_TRACK,
  sellDeadlineMs,
  sellFailureKey,
  sellFundsLocation,
  sellFundsNoticeKey,
  sellInputsOf,
  sellStepLabelKey,
  sellTokenLabel
} from './sell-status-helpers';

/** A sale sends value out of the wallet, so the screen uses the send colour. */
const SELL_ACCENT: FlowAccent = accentForTransactionType('sell');

/** The title of the in-app browser that opens the relay transaction. */
const ETHERSCAN_TITLE = 'Etherscan';

/** The provider of the sale. A name, not copy: it is not translated. */
const PROVIDER_NAME = 'Transak';

const heroStateOf = (inputs: ISellExtraInputs): TransactionHeroState => {
  switch (inputs.phase) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
};

const titleKeyOf = (inputs: ISellExtraInputs): string => {
  switch (inputs.phase) {
    case 'completed':
      return 'sellStatusCompletedTitle';
    case 'failed':
      return 'sellStatusFailedTitle';
    default:
      return 'sellStatusProgressTitle';
  }
};

interface SellStatusProps {
  txId: string;
}

/**
 * The status screen of a fiat sell.
 *
 * It watches the tracking row by id. The row is born `Completed`, so the screen reads the progress
 * from `extraInputs.phase` and never from `status`. The watcher moves the phase forward: bridge-out on
 * Miden → bridging to Ethereum → funds on Ethereum → sent to Transak → payment received → payout
 * completed, or failed.
 */
export const SellStatus: React.FC<SellStatusProps> = ({ txId }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const inputs = sellInputsOf(row);
  const ticking = inputs !== undefined && !isSellTerminal(inputs.phase);
  const now = useNow(ticking);
  const onDone = () => navigate('/');

  if (!loaded) {
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );
  }

  // An unknown id, or a row that is not a sell: nothing to show.
  if (!inputs) return <Redirect to="/" />;

  const failed = inputs.phase === 'failed';
  const terminal = isSellTerminal(inputs.phase);
  const { relayTxHash, bridgeTransactionId, transakStatus } = inputs;
  const deadlineMs = sellDeadlineMs(inputs);
  // The text of a backend expiry tells where the token is, so that failure gets no second notice.
  const fundsNoticeKey =
    failed && inputs.failure !== 'order-expired' ? sellFundsNoticeKey(sellFundsLocation(inputs)) : undefined;
  // A page deposit whose "Yes, I have paid" button the wallet did not find: the user must tap it in Transak.
  const mustTapPaid = inputs.paidClicked === false && !terminal;

  const description = (() => {
    switch (inputs.phase) {
      case 'failed':
        return t(sellFailureKey(inputs.failure));
      case 'completed':
        return t('sellStatusCompletedDescription');
      default:
        return t('sellStatusProgressDescription');
    }
  })();

  return (
    <SubPageLayout
      data-testid="sell-status-page"
      title={t('sellStatusHeader')}
      onClose={onDone}
      footer={
        <Button
          type="button"
          variant={ButtonVariant.Primary}
          accent={SELL_ACCENT}
          onClick={onDone}
          className="w-full max-w-none"
          data-testid="sell-status-done"
        >
          {terminal ? t('done') : t('hide')}
        </Button>
      }
    >
      <section className="flex flex-col items-center pt-5" data-phase={inputs.phase} data-testid="sell-status-progress">
        <Hero
          visual={<TransactionHeroIcon state={heroStateOf(inputs)} accent={SELL_ACCENT} />}
          name={t(titleKeyOf(inputs))}
        />
        <TransactionSummaryBadge
          lhs={sellTokenLabel(inputs)}
          rhs={PROVIDER_NAME}
          fillForArrow="var(--tx-sent)"
          className="mt-4"
        />

        <div className="mt-6 w-full">
          <OrderProgressBar track={SELL_TRACK} state={inputs} accent={SELL_ACCENT} testIdPrefix="sell" />
        </div>

        <div className="mt-4 w-full">
          <OrderSteps track={SELL_TRACK} state={inputs} accent={SELL_ACCENT} labelKeyOf={sellStepLabelKey} now={now} />
        </div>

        {/* The error takes the negative ink, as on every other screen that reports one. */}
        <p
          role={failed ? 'alert' : undefined}
          aria-live={failed ? undefined : 'polite'}
          className={cn('mt-4 select-text text-center text-body-sm', failed ? 'text-negative-ink' : 'text-muted')}
          data-testid="sell-status-description"
        >
          {description}
        </p>
        {failed && inputs.error && (
          <p className="mt-1 select-text text-center text-caption text-muted" data-testid="sell-status-error-detail">
            {inputs.error}
          </p>
        )}
      </section>

      {fundsNoticeKey !== undefined && (
        <Notice tone="warning" role="note" data-testid="sell-status-funds">
          {t(fundsNoticeKey)}
        </Notice>
      )}

      {mustTapPaid && (
        <Notice tone="warning" role="status" data-testid="sell-status-tap-paid">
          {t('cashSellTapPaid')}
        </Notice>
      )}

      <DetailCard>
        <DetailRow label={t('sellDetailAmount')} data-testid="sell-status-amount">
          {sellTokenLabel(inputs)}
        </DetailRow>
        {deadlineMs !== undefined && (
          <DetailRow
            label={t('sellDetailDeadline')}
            sub={t('sellDetailDeadlineHint')}
            data-testid="sell-status-deadline"
          >
            {formatDeadline(deadlineMs)}
          </DetailRow>
        )}
        <DetailRow label={t('cashSellDepositAddress')} stacked data-testid="sell-status-deposit-address">
          <span className="select-text">{inputs.depositAddress}</span>
          <CopyButton text={inputs.depositAddress} className="shrink-0" />
        </DetailRow>
        {inputs.evmAddress && (
          <DetailRow label={t('sellDetailEvmAddress')} stacked data-testid="sell-status-evm-address">
            <span className="select-text">{inputs.evmAddress}</span>
            <CopyButton text={inputs.evmAddress} className="shrink-0" />
          </DetailRow>
        )}
        {bridgeTransactionId && (
          <DetailRow label={t('sellDetailBridgeTransaction')} data-testid="sell-status-bridge-tx">
            <CopyChip text={bridgeTransactionId}>{truncateHash(bridgeTransactionId)}</CopyChip>
          </DetailRow>
        )}
        {relayTxHash && (
          <DetailRow label={t('cashSellRelayTransaction')} data-testid="sell-status-relay-tx">
            <CopyChip text={relayTxHash}>{truncateHash(relayTxHash)}</CopyChip>
          </DetailRow>
        )}
        {transakStatus && (
          <DetailRow label={t('sellDetailTransakStatus')} data-testid="sell-status-transak-status">
            <span className="select-text break-all">{transakStatus}</span>
          </DetailRow>
        )}
        <DetailRow label={t('sellDetailOrderId')} data-testid="sell-status-order-id">
          <CopyChip text={inputs.orderId}>{truncateHash(inputs.orderId)}</CopyChip>
        </DetailRow>
      </DetailCard>

      {relayTxHash && (
        <TextAction
          className="self-center"
          onClick={() => openExternalUrl({ url: sepoliaTxUrl(relayTxHash), title: ETHERSCAN_TITLE })}
          data-testid="sell-status-explorer"
        >
          {t('viewOnEtherscan')}
        </TextAction>
      )}
    </SubPageLayout>
  );
};

export default SellStatus;
