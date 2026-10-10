import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { FlowSpinner } from 'components/flow/FlowSpinner';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { CopyButton } from 'components/ui/CopyButton';
import { CopyChip } from 'components/ui/CopyChip';
import { IconCircle } from 'components/ui/FactRow';
import { Notice } from 'components/ui/Notice';
import { cn } from 'lib/ui/util';
import { truncateHash } from 'utils/string';

import {
  EndedState,
  SellBackendCheck,
  sellRelayTestAmount,
  SellRelay,
  SellRelayError,
  SellStep,
  SellStepId
} from './useSellRelay';

/** A sale sends value out of the wallet, so the notification uses the send colour. */
const SELL_ACCENT: FlowAccent = accentForTransactionType('send');

/** The spinner size in px: the glyph size of an `IconCircle`. */
const SPINNER_SIZE = 16;

type NotificationTone = 'send' | 'positive' | 'negative';

const circleClassName = (tone: NotificationTone): string => {
  switch (tone) {
    case 'send':
      return 'bg-accent-send-tint text-accent-send-ink';
    case 'positive':
      return 'bg-positive-tint text-positive-tint-ink';
    case 'negative':
      return 'bg-negative-tint text-negative-tint-ink';
  }
};

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

const backendCheckView = (check: SellBackendCheck): { key: string; className: string; role: 'status' | 'alert' } => {
  switch (check) {
    case 'pending':
      return { key: 'cashSellBackendChecking', className: 'text-muted', role: 'status' };
    case 'verified':
      return { key: 'cashSellBackendVerified', className: 'text-positive-tint-ink', role: 'status' };
    case 'mismatch':
      return { key: 'cashSellBackendMismatch', className: 'text-negative-ink', role: 'alert' };
  }
};

/** The steps as `id:state` pairs, for the tests. */
const stepsAttribute = (steps: SellStep[]): string => steps.map(step => `${step.id}:${step.state}`).join(',');

interface ShellProps {
  tone: NotificationTone;
  phase: string;
  steps: SellStep[];
  role: 'status' | 'alert';
  /** The glyph in the leading circle. */
  glyph: React.ReactNode;
  title: string;
  /** The lines under the title. */
  children: React.ReactNode;
  /** One compact action after the text. */
  trailing?: React.ReactNode;
  /** Full-width content under the row: a notice or a row of buttons. */
  footer?: React.ReactNode;
  testId?: string;
}

/** The one layout of the notification: the circle, the title over its lines, a trailing action and a footer. */
const Shell: React.FC<ShellProps> = ({
  tone,
  phase,
  steps,
  role,
  glyph,
  title,
  children,
  trailing,
  footer,
  testId
}) => (
  <Card surface="outline" padding="tile" className="flex flex-col gap-3.5">
    <div
      role={role}
      className="flex items-center gap-3"
      data-testid="cash-sell-notification"
      data-phase={phase}
      data-steps={stepsAttribute(steps)}
    >
      <IconCircle size="lg" className={circleClassName(tone)}>
        {glyph}
      </IconCircle>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" data-testid={testId}>
        <span className="text-row-title text-ink">{title}</span>
        {children}
      </div>
      {trailing}
    </div>
    {footer}
  </Card>
);

interface SellRelayNotificationProps {
  relay: SellRelay;
  /** The Sepolia address of the account: the temporary test aid shows it. */
  evmAddress: string | undefined;
}

/**
 * The card that reports a Transak sale on the provider page: the approval of the deposit the widget named, then the
 * progress of the relay and its result. The page under it stays in place.
 */
export const SellRelayNotification: React.FC<SellRelayNotificationProps> = ({ relay, evmAddress }) => {
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

  const dismissButton = (labelKey: string, onClick: () => void, testId: string) => (
    <Button variant={ButtonVariant.Secondary} size="sm" onClick={onClick} data-testid={testId}>
      {t(labelKey)}
    </Button>
  );

  if (phase === 'unreadable' || pageDeposit === null) {
    return (
      <Shell
        tone="negative"
        phase={phase}
        steps={steps}
        role="alert"
        glyph={<Icon name={IconName.Warning} size="xs" fill="currentColor" />}
        title={t('cashSellUnreadableTitle')}
        testId="cash-sell-unreadable"
        footer={
          <Button
            variant={ButtonVariant.Secondary}
            size="sm"
            className="w-full"
            onClick={relay.cancel}
            data-testid="cash-sell-cancel"
          >
            {t('cashSellBackToTransak')}
          </Button>
        }
      >
        <span className="text-caption text-muted">{t('cashSellUnreadable')}</span>
      </Shell>
    );
  }

  const amount = pageDeposit.amount;

  switch (phase) {
    case 'confirm': {
      const check = backendCheckView(backendCheck);
      const testAmount = sellRelayTestAmount(amount);
      return (
        <Shell
          tone="send"
          phase={phase}
          steps={steps}
          role="status"
          glyph={<Icon name={IconName.ArrowUp} size="xs" fill="currentColor" />}
          title={t('cashSellSendTitle', { amount })}
          trailing={
            <CopyButton
              text={pageDeposit.address}
              icon="only"
              aria-label={t('copy')}
              className="shrink-0"
              data-testid="cash-sell-deposit-copy"
            />
          }
          footer={
            <>
              {/* TEMPORARY test aid: the testnet relay sends Sepolia USDC from the account's own EVM address, so the
                  tester must fund it first. Remove it with the real bridge-out. */}
              {evmAddress && (
                <Notice tone="warning" title={t('cashSellTestFundingTitle')} data-testid="cash-sell-test-funding">
                  <span className="flex flex-col gap-2">
                    <span>{t('cashSellTestFunding', { amount: testAmount ?? amount })}</span>
                    <span className="select-text break-all text-ink">{evmAddress}</span>
                    <CopyButton text={evmAddress} icon="leading" className="self-start" />
                  </span>
                </Notice>
              )}
              <div className="flex gap-2">
                <Button
                  variant={ButtonVariant.Secondary}
                  size="sm"
                  className="flex-1"
                  onClick={relay.cancel}
                  data-testid="cash-sell-cancel"
                >
                  {t('cancel')}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  accent={SELL_ACCENT}
                  disabled={backendCheck !== 'verified'}
                  onClick={relay.confirm}
                  data-testid="cash-sell-confirm"
                >
                  {t('confirm')}
                </Button>
              </div>
            </>
          }
        >
          <span
            className="select-text text-caption text-muted"
            title={pageDeposit.address}
            data-testid="cash-sell-deposit-address"
          >
            {t('cashSellToAddress', { address: truncateHash(pageDeposit.address) })}
          </span>
          <span
            role={check.role}
            className={cn('text-caption', check.className)}
            data-state={backendCheck}
            data-testid="cash-sell-backend-check"
          >
            {t(check.key)}
          </span>
        </Shell>
      );
    }
    case 'success':
      return (
        <Shell
          tone="positive"
          phase={phase}
          steps={steps}
          role="status"
          glyph={<Icon name={IconName.Checkmark} size="xs" fill="currentColor" />}
          title={t('cashSellSuccessTitle')}
          trailing={dismissButton('done', relay.dismiss, 'cash-sell-done')}
          footer={
            result && !result.paidClicked ? (
              <Notice tone="warning" role="status" data-testid="cash-sell-tap-paid">
                {t('cashSellTapPaid')}
              </Notice>
            ) : undefined
          }
        >
          <span className="text-caption text-muted">{t('cashSellSoldAmount', { amount })}</span>
          {result?.relayTxHash && (
            <CopyChip text={result.relayTxHash} className="min-w-0 self-start" data-testid="cash-sell-relay-hash">
              {truncateHash(result.relayTxHash)}
            </CopyChip>
          )}
        </Shell>
      );
    case 'failed':
      return (
        <Shell
          tone="negative"
          phase={phase}
          steps={steps}
          role="alert"
          glyph={<Icon name={IconName.Warning} size="xs" fill="currentColor" />}
          title={t('cashSellFailedTitle')}
          trailing={dismissButton('promptCardDismiss', relay.dismiss, 'cash-sell-done')}
        >
          {error && (
            <span className="select-text text-caption text-muted" data-testid="cash-sell-error">
              {errorText(error)}
            </span>
          )}
          {error?.kind === 'order' && error.message && (
            <span className="select-text text-caption text-muted" data-testid="cash-sell-error-detail">
              {error.message}
            </span>
          )}
        </Shell>
      );
    default: {
      const activeIndex = steps.findIndex(step => step.state === 'active');
      const active = steps[activeIndex];
      return (
        <Shell
          tone="send"
          phase={phase}
          steps={steps}
          role="status"
          glyph={<FlowSpinner accent={SELL_ACCENT} size={SPINNER_SIZE} />}
          title={t('cashSellSendingTitle', { amount })}
        >
          {active && (
            <span className="text-caption text-muted" data-testid="cash-sell-step">
              {t('cashSellStepProgress', {
                step: t(stepLabelKey(active.id)),
                current: activeIndex + 1,
                total: steps.length
              })}
            </span>
          )}
        </Shell>
      );
    }
  }
};
