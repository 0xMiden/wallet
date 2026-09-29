import React, { useEffect, useState } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ACCENT_CLASSES, accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { springs, useMotion, usePreset } from 'lib/animation';
import { BUY_PHASES, IBuyExtraInputs } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { cn } from 'lib/ui/util';
import { navigate, Redirect } from 'lib/woozie';
import { TransactionHeroIcon, TransactionStepRow } from 'screens/generating-transaction/components';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import type { TransactionHeroState } from 'screens/generating-transaction/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import {
  buyActiveIndex,
  buyInputsOf,
  buyProgressFraction,
  buyStepDurationsMs,
  buyStepLabelKey,
  buyStepState,
  buyTokenLabel,
  isBuyTerminal,
  sepoliaTxUrl
} from './buy-status-helpers';

/** A buy brings money into the wallet, so the screen uses the receive colour. */
const BUY_ACCENT: FlowAccent = accentForTransactionType('buy');

/** The title of the in-app browser that opens the relay transaction. */
const ETHERSCAN_TITLE = 'Etherscan';

const TICK_MS = 1_000;
const MINUTE_MS = 60_000;

/** Give the current time, and update it each second while `ticking` is true. */
const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
};

interface BuyProgressBarProps {
  inputs: IBuyExtraInputs;
}

/**
 * The progress of the order as one bar with one segment for each step.
 *
 * The fill moves with a spring when the phase changes. While a step is in progress, its half
 * segment pulses. Under reduced motion the fill moves instantly and the pulse does not run.
 * A failed order shows the fill in the negative colour.
 */
const BuyProgressBar: React.FC<BuyProgressBarProps> = ({ inputs }) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const fillTransition = useMotion(springs.standard);
  const pulse = usePreset('pulse');
  const fraction = buyProgressFraction(inputs);
  const index = buyActiveIndex(inputs);
  const failed = inputs.phase === 'failed';
  const inProgress = !isBuyTerminal(inputs.phase);
  // The share of the fill that is the active half segment.
  const activeShare = inProgress ? 0.5 / (index + 0.5) : 0;
  const total = BUY_PHASES.length;

  return (
    <div className="flex w-full flex-col gap-2">
      <div
        role="progressbar"
        aria-label={t('buyStatusProgressLabel')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={inputs.phase === 'completed' ? total : index}
        aria-valuetext={t('buyStatusStepOf', { current: index + 1, total })}
        className="relative h-2 w-full overflow-hidden rounded-full bg-fill"
        data-testid="buy-progress"
        data-progress={fraction.toFixed(4)}
      >
        <motion.div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            failed ? 'bg-status-negative' : ACCENT_CLASSES[BUY_ACCENT].bg
          )}
          initial={false}
          animate={{ width: `${fraction * 100}%` }}
          transition={fillTransition}
          data-testid="buy-progress-fill"
          data-failed={failed}
        >
          {inProgress && !reduceMotion && (
            <motion.span
              aria-hidden="true"
              className="absolute inset-y-0 right-0 bg-page"
              style={{ width: `${activeShare * 100}%` }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.45, 0] }}
              transition={pulse.transition}
              data-testid="buy-progress-pulse"
            />
          )}
        </motion.div>
        {/* Hairlines between the segments, so the bar reads as six steps. */}
        {BUY_PHASES.slice(1).map((phase, i) => (
          <span
            key={phase}
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-page"
            style={{ left: `${((i + 1) / total) * 100}%` }}
          />
        ))}
      </div>
      <p className="text-center text-caption text-muted" aria-hidden="true">
        {t('buyStatusStepOf', { current: index + 1, total })}
      </p>
    </div>
  );
};

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
  const durations = buyStepDurationsMs(inputs, now);
  const relayTxHash = inputs.relayTxHash;

  const durationLabel = (ms: number | undefined): string | undefined => {
    if (ms === undefined) return undefined;
    if (ms < MINUTE_MS) return t('transactionStepDurationSec', { seconds: Math.round(ms / 1000) });
    return t('buyStepDurationMin', { minutes: Math.floor(ms / MINUTE_MS) });
  };

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
          <BuyProgressBar inputs={inputs} />
        </div>

        <div className="mt-4 w-full overflow-hidden rounded-2xl bg-fill">
          {BUY_PHASES.map((phase, index) => {
            const state = buyStepState(inputs, index);
            const labelKey = buyStepLabelKey(phase);
            return (
              <TransactionStepRow
                key={phase}
                step={{ id: phase, labelKey, defaultLabel: labelKey }}
                label={t(labelKey)}
                state={state}
                accent={BUY_ACCENT}
                isLast={index === BUY_PHASES.length - 1}
                meta={state === 'pending' ? undefined : durationLabel(durations[index])}
              />
            );
          })}
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
