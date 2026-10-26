import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { IBuyExtraInputs } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { cn } from 'lib/ui/util';
import { navigate, Redirect } from 'lib/woozie';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import type { TransactionHeroState } from 'screens/generating-transaction/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { OrderProgressBar, OrderSteps, useNow } from 'screens/order-status/OrderProgress';

import {
  BUY_TRACK,
  buyInputsOf,
  buyStepLabelKey,
  buyTokenLabel,
  isBuyTerminal,
  sepoliaTxUrl
} from './buy-status-helpers';

/** A buy brings money into the wallet, so the screen uses the receive colour. */
const BUY_ACCENT: FlowAccent = accentForTransactionType('buy');

/** The title of the in-app browser that opens the relay transaction. */
const ETHERSCAN_TITLE = 'Etherscan';

const heroStateOf = (inputs: IBuyExtraInputs): TransactionHeroState => {
  switch (inputs.phase) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
};

const titleKeyOf = (inputs: IBuyExtraInputs): string => {
  switch (inputs.phase) {
    case 'completed':
      return 'buyStatusCompletedTitle';
    case 'failed':
      return 'buyStatusFailedTitle';
    default:
      return 'buyStatusProgressTitle';
  }
};

interface BuyStatusProps {
  txId: string;
}

/**
 * The status screen of a fiat buy.
 *
 * It watches the tracking row by id. The row is born `Completed`, so the screen reads the progress
 * from `extraInputs.phase` and never from `status`. The poller moves the phase forward: payment →
 * funds on Ethereum → relay sent → bridging → claim on Miden → completed, or failed.
 */
export const BuyStatus: React.FC<BuyStatusProps> = ({ txId }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const inputs = buyInputsOf(row);
  const ticking = inputs !== undefined && !isBuyTerminal(inputs.phase);
  const now = useNow(ticking);
  const onDone = () => navigate('/');

  if (!loaded) {
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );
  }

  // An unknown id, or a row that is not a buy: nothing to show.
  if (!inputs) return <Redirect to="/" />;

  const failed = inputs.phase === 'failed';
  const terminal = isBuyTerminal(inputs.phase);
  const relayTxHash = inputs.relayTxHash;

  const description = (() => {
    switch (inputs.phase) {
      case 'failed':
        return inputs.error ?? t('buyStatusFailedDescription');
      case 'completed':
        return t('buyStatusCompletedDescription');
      default:
        return t('buyStatusProgressDescription');
    }
  })();

  return (
    <SubPageLayout
      data-testid="buy-status-page"
      title={t('buyStatusHeader')}
      onClose={onDone}
      footer={
        <Button
          type="button"
          variant={ButtonVariant.Primary}
          accent={BUY_ACCENT}
          onClick={onDone}
          className="w-full max-w-none"
          data-testid="buy-status-done"
        >
          {terminal ? t('done') : t('hide')}
        </Button>
      }
    >
      <section className="flex flex-1 flex-col items-center pt-5">
        <Hero
          visual={<TransactionHeroIcon state={heroStateOf(inputs)} accent={BUY_ACCENT} />}
          name={t(titleKeyOf(inputs))}
        />
        <TransactionSummaryBadge
          lhs={t('buyStatusFiatAmount', { amount: inputs.fiatAmount, currency: inputs.fiatCurrency })}
          rhs={buyTokenLabel(inputs)}
          fillForArrow="var(--tx-received)"
          className="mt-4"
        />

        <div className="mt-6 w-full">
          <OrderProgressBar track={BUY_TRACK} state={inputs} accent={BUY_ACCENT} testIdPrefix="buy" />
        </div>

        <div className="mt-4 w-full">
          <OrderSteps track={BUY_TRACK} state={inputs} accent={BUY_ACCENT} labelKeyOf={buyStepLabelKey} now={now} />
        </div>

        {/* The error takes the negative ink, as on every other screen that reports one. */}
        <p
          role={failed ? 'alert' : undefined}
          aria-live={failed ? undefined : 'polite'}
          className={cn('mt-4 select-text text-center text-body-sm', failed ? 'text-negative-ink' : 'text-muted')}
          data-testid="buy-status-description"
        >
          {description}
        </p>

        {relayTxHash && (
          <TextAction
            className="mt-2"
            onClick={() => openExternalUrl({ url: sepoliaTxUrl(relayTxHash), title: ETHERSCAN_TITLE })}
            data-testid="buy-status-explorer"
          >
            {t('viewOnEtherscan')}
          </TextAction>
        )}
      </section>
    </SubPageLayout>
  );
};

export default BuyStatus;
