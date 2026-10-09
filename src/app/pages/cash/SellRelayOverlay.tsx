import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Button, ButtonVariant } from 'components/ui/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { CopyChip } from 'components/ui/CopyChip';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Hero } from 'components/ui/Hero';
import { Notice, NoticeTone } from 'components/ui/Notice';
import { TransactionHeroIcon, TransactionStepRow } from 'screens/generating-transaction/components';
import type { TransactionHeroState } from 'screens/generating-transaction/types';

import {
  EndedState,
  SellBackendCheck,
  sellRelayTestAmount,
  SellRelay,
  SellRelayError,
  SellRelayPhase,
  SellStepId
} from './useSellRelay';

/** A sale sends value out of the wallet, so the overlay uses the send colour. */
const SELL_ACCENT: FlowAccent = accentForTransactionType('send');

interface SellRelayOverlayProps {
  relay: SellRelay;
  /** The Sepolia address of the account: the temporary test aid shows it. */
  evmAddress: string | undefined;
}

const stepLabelKey = (id: SellStepId): string => {
  switch (id) {
    case 'bridge':
      return 'cashSellStepBridge';
    case 'prepare':
      return 'cashSellStepPrepare';
    case 'relay':
      return 'cashSellStepRelay';
    case 'paid':
      return 'cashSellStepPaid';
  }
};

const orderEndedKey = (state: EndedState): string => {
  switch (state) {
    case 'failed':
      return 'cashSellOrderFailed';
    case 'expired':
      return 'cashSellOrderExpired';
    case 'cancelled':
      return 'cashSellOrderCancelled';
  }
};

const backendCheckView = (check: SellBackendCheck): { key: string; tone: NoticeTone; role: 'status' | 'alert' } => {
  switch (check) {
    case 'pending':
      return { key: 'cashSellBackendChecking', tone: 'neutral', role: 'status' };
    case 'verified':
      return { key: 'cashSellBackendVerified', tone: 'positive', role: 'status' };
    case 'mismatch':
      return { key: 'cashSellBackendMismatch', tone: 'negative', role: 'alert' };
  }
};

const heroState = (phase: SellRelayPhase): TransactionHeroState => {
  switch (phase) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'processing';
  }
};

const progressTitleKey = (phase: SellRelayPhase): string => {
  switch (phase) {
    case 'success':
      return 'cashSellSuccessTitle';
    case 'failed':
      return 'cashSellFailedTitle';
    default:
      return 'cashSellProgressTitle';
  }
};

const shortHash = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-8)}`;

/**
 * The wallet page that shows in place of the provider list while the Transak widget is hidden during a sell: the
 * confirmation of the deposit page values, then the steps of the relay.
 */
export const SellRelayOverlay: React.FC<SellRelayOverlayProps> = ({ relay, evmAddress }) => {
  const { t } = useTranslation();
  const { phase, pageDeposit, backendCheck, steps, error, result } = relay;

  const errorText = (cause: SellRelayError): string => {
    switch (cause.kind) {
      case 'refused':
        return t('cashSellRefused', { reason: cause.reason });
      case 'order':
        return t(orderEndedKey(cause.state));
      case 'timeout':
        return t('cashSellTimeout');
      case 'unexpected':
        return t('cashSellUnexpected');
    }
  };

  if (phase === 'unreadable' || pageDeposit === null) {
    return (
      <FlowLayout
        title={t('cashSellConfirmTitle')}
        onBack={relay.cancel}
        focusTitleOnMount
        footer={
          <Button
            variant={ButtonVariant.Secondary}
            className="w-full"
            onClick={relay.cancel}
            data-testid="cash-sell-cancel"
          >
            {t('cashSellBackToTransak')}
          </Button>
        }
      >
        <EmptyState
          icon={IconName.Warning}
          role="alert"
          title={t('cashSellUnreadableTitle')}
          description={t('cashSellUnreadable')}
          data-testid="cash-sell-unreadable"
        />
      </FlowLayout>
    );
  }

  if (phase === 'confirm') {
    const check = backendCheckView(backendCheck);
    const testAmount = sellRelayTestAmount(pageDeposit.amount);
    return (
      <FlowLayout
        title={t('cashSellConfirmTitle')}
        onBack={relay.cancel}
        focusTitleOnMount
        footer={
          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              accent={SELL_ACCENT}
              disabled={backendCheck !== 'verified'}
              onClick={relay.confirm}
              data-testid="cash-sell-confirm"
            >
              {t('confirm')}
            </Button>
            <Button
              variant={ButtonVariant.Secondary}
              className="w-full"
              onClick={relay.cancel}
              data-testid="cash-sell-cancel"
            >
              {t('cancel')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4" data-testid="cash-sell-overlay">
          <p className="text-body text-ink" data-testid="cash-sell-summary">
            {t('cashSellBridgingOut', { amount: pageDeposit.amount })}
          </p>
          <DetailCard>
            <DetailRow label={t('cashSellDepositAddress')} stacked>
              <span className="min-w-0 select-text" data-testid="cash-sell-deposit-address">
                {pageDeposit.address}
              </span>
              <CopyButton
                text={pageDeposit.address}
                icon="only"
                aria-label={t('copy')}
                className="shrink-0"
                data-testid="cash-sell-deposit-copy"
              />
            </DetailRow>
          </DetailCard>
          <Notice variant="inline" tone={check.tone} role={check.role} data-testid="cash-sell-backend-check">
            <span data-state={backendCheck}>{t(check.key)}</span>
          </Notice>
          {/* TEMPORARY test aid: the testnet relay sends Sepolia USDC from the account's own EVM address, so the
              tester must fund it first. Remove it with the real bridge-out. */}
          {evmAddress && (
            <Notice tone="warning" title={t('cashSellTestFundingTitle')} data-testid="cash-sell-test-funding">
              <span className="flex flex-col gap-2">
                <span>{t('cashSellTestFunding', { amount: testAmount ?? pageDeposit.amount })}</span>
                <span className="select-text break-all text-ink">{evmAddress}</span>
                <CopyButton text={evmAddress} icon="leading" className="self-start" />
              </span>
            </Notice>
          )}
        </div>
      </FlowLayout>
    );
  }

  const finished = phase === 'success' || phase === 'failed';

  return (
    <FlowLayout
      title={t('cashSellingUsdc')}
      focusTitleOnMount
      footer={
        finished ? (
          <Button className="w-full" accent={SELL_ACCENT} onClick={relay.dismiss} data-testid="cash-sell-done">
            {t('done')}
          </Button>
        ) : null
      }
    >
      <section className="flex flex-col items-center gap-4 pt-5" data-testid="cash-sell-progress" data-phase={phase}>
        <Hero
          visual={<TransactionHeroIcon state={heroState(phase)} accent={SELL_ACCENT} />}
          name={t(progressTitleKey(phase))}
        />
        <p className="text-center text-body-sm text-muted">
          {t('cashSellBridgingOut', { amount: pageDeposit.amount })}
        </p>
        <div className="w-full overflow-hidden rounded-2xl bg-fill">
          {steps.map((step, index) => {
            const labelKey = stepLabelKey(step.id);
            return (
              <TransactionStepRow
                key={step.id}
                step={{ id: step.id, labelKey, defaultLabel: labelKey }}
                label={t(labelKey)}
                state={step.state}
                accent={SELL_ACCENT}
                isLast={index === steps.length - 1}
              />
            );
          })}
        </div>
        {error && (
          <div className="flex w-full flex-col gap-1">
            <ErrorLine data-testid="cash-sell-error">{errorText(error)}</ErrorLine>
            {error.kind === 'order' && error.message && (
              <p className="select-text text-center text-caption text-muted" data-testid="cash-sell-error-detail">
                {error.message}
              </p>
            )}
          </div>
        )}
        {result?.relayTxHash && (
          <DetailCard className="w-full">
            <DetailRow label={t('cashSellRelayTransaction')} data-testid="cash-sell-relay-hash">
              <CopyChip text={result.relayTxHash} className="min-w-0">
                {shortHash(result.relayTxHash)}
              </CopyChip>
            </DetailRow>
          </DetailCard>
        )}
        {result && !result.paidClicked && (
          <Notice tone="warning" role="status" data-testid="cash-sell-tap-paid">
            {t('cashSellTapPaid')}
          </Notice>
        )}
      </section>
    </FlowLayout>
  );
};
