import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { accentForTransactionType, FlowAccent } from 'components/flow/accent';
import { FlowSpinner } from 'components/flow/FlowSpinner';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { CopyButton } from 'components/ui/CopyButton';
import { IconCircle } from 'components/ui/FactRow';
import { Notice } from 'components/ui/Notice';
import type { SellEndedState } from 'lib/miden/activity/sell-order';
import type { SellTokenBlock } from 'lib/onramp/sell-token';
import { cn } from 'lib/ui/util';
import { formatDeadline } from 'screens/sell-status/sell-status-helpers';
import { truncateHash } from 'utils/string';

import { SellBackendCheck, SellRelay, SellRelayError, SellTokenCheck } from './useSellRelay';

/** A sale sends value out of the wallet, so the notification uses the send colour. */
const SELL_ACCENT: FlowAccent = accentForTransactionType('sell');

/** The spinner size in px: the glyph size of an `IconCircle`. */
const SPINNER_SIZE = 16;

/**
 * The time the sale needs before the relay, in ms: about 30 minutes of bridge-out, and the 2 minutes before
 * Transak's expiry at which the backend stops the order. With less time left, the card warns the user.
 */
export const SELL_TIME_NEEDED_MS = 32 * 60_000;

type NotificationTone = 'send' | 'negative';

const circleClassName = (tone: NotificationTone): string => {
  switch (tone) {
    case 'send':
      return 'bg-accent-send-tint text-accent-send-ink';
    case 'negative':
      return 'bg-negative-tint text-negative-tint-ink';
  }
};

const orderEndedKey = (state: SellEndedState): string => {
  switch (state) {
    case 'failed':
      return 'cashSellOrderFailed';
    case 'expired':
      return 'cashSellOrderExpired';
    case 'cancelled':
      return 'cashSellOrderCancelled';
  }
};

const tokenBlockKey = (reason: SellTokenBlock): string => {
  switch (reason) {
    case 'no-token':
      return 'cashSellBlockedNoToken';
    case 'ambiguous-token':
      return 'cashSellBlockedAmbiguous';
    case 'unknown-scale':
      return 'cashSellBlockedUnknownScale';
    case 'not-registered':
      return 'cashSellBlockedNotRegistered';
    case 'amount':
      return 'cashSellBlockedAmount';
    case 'insufficient-balance':
      return 'cashSellBlockedBalance';
    case 'unavailable':
      return 'cashSellBlockedUnavailable';
  }
};

interface CheckView {
  key: string;
  className: string;
  role: 'status' | 'alert';
}

const backendCheckView = (check: SellBackendCheck): CheckView => {
  switch (check) {
    case 'pending':
      return { key: 'cashSellBackendChecking', className: 'text-muted', role: 'status' };
    case 'verified':
      return { key: 'cashSellBackendVerified', className: 'text-positive-tint-ink', role: 'status' };
    case 'mismatch':
      return { key: 'cashSellBackendMismatch', className: 'text-negative-ink', role: 'alert' };
  }
};

const tokenCheckView = (check: SellTokenCheck): CheckView => {
  switch (check.kind) {
    case 'pending':
      return { key: 'cashSellTokenChecking', className: 'text-muted', role: 'status' };
    case 'ready':
      return { key: 'cashSellTokenReady', className: 'text-muted', role: 'status' };
    case 'blocked':
      return { key: tokenBlockKey(check.reason), className: 'text-negative-ink', role: 'alert' };
  }
};

interface ShellProps {
  tone: NotificationTone;
  phase: string;
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
const Shell: React.FC<ShellProps> = ({ tone, phase, role, glyph, title, children, trailing, footer, testId }) => (
  <Card surface="outline" padding="tile" className="flex flex-col gap-3.5">
    <div role={role} className="flex items-center gap-3" data-testid="cash-sell-notification" data-phase={phase}>
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
}

/**
 * The card that starts a Transak sale on the provider page: the approval of the deposit that the widget named, then
 * the short start (signature and bridge-out). After the start the status page shows the progress. The page under
 * the card stays in place.
 */
export const SellRelayNotification: React.FC<SellRelayNotificationProps> = ({ relay }) => {
  const { t } = useTranslation();
  const { phase, pageDeposit, backendCheck, tokenCheck, tokenSymbol, expiresAt, error } = relay;

  const errorText = (cause: SellRelayError): string => {
    switch (cause.kind) {
      case 'refused':
        return t('cashSellRefused', { reason: cause.reason });
      case 'order':
        return t(orderEndedKey(cause.state));
      case 'timeout':
        return t('cashSellTimeout');
      case 'bridge':
        return t('cashSellBridgeNotStarted');
      case 'unexpected':
        return t('cashSellUnexpected');
    }
  };

  const errorDetail = (cause: SellRelayError): string | null => {
    switch (cause.kind) {
      case 'order':
        return cause.message;
      case 'bridge':
        return cause.message;
      default:
        return null;
    }
  };

  if (phase === 'unreadable' || pageDeposit === null) {
    return (
      <Shell
        tone="negative"
        phase={phase}
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
    case 'failed': {
      const detail = error === null ? null : errorDetail(error);
      return (
        <Shell
          tone="negative"
          phase={phase}
          role="alert"
          glyph={<Icon name={IconName.Warning} size="xs" fill="currentColor" />}
          title={t('cashSellFailedTitle')}
          trailing={
            <Button variant={ButtonVariant.Secondary} size="sm" onClick={relay.dismiss} data-testid="cash-sell-done">
              {t('promptCardDismiss')}
            </Button>
          }
        >
          {error && (
            <span className="select-text text-caption text-muted" data-testid="cash-sell-error">
              {errorText(error)}
            </span>
          )}
          {detail && (
            <span className="select-text text-caption text-muted" data-testid="cash-sell-error-detail">
              {detail}
            </span>
          )}
        </Shell>
      );
    }
    case 'starting':
      return (
        <Shell
          tone="send"
          phase={phase}
          role="status"
          glyph={<FlowSpinner accent={SELL_ACCENT} size={SPINNER_SIZE} />}
          title={t('cashSellStartingTitle', { amount, symbol: tokenSymbol })}
        >
          <span className="text-caption text-muted" data-testid="cash-sell-step">
            {t('cashSellStarting')}
          </span>
        </Shell>
      );
    default: {
      const backend = backendCheckView(backendCheck);
      const token = tokenCheckView(tokenCheck);
      const deadlineMs = expiresAt === null ? null : expiresAt * 1000;
      const shortOfTime = deadlineMs !== null && deadlineMs - Date.now() < SELL_TIME_NEEDED_MS;
      return (
        <Shell
          tone="send"
          phase={phase}
          role="status"
          glyph={<Icon name={IconName.ArrowUp} size="xs" fill="currentColor" />}
          title={t('cashSellSendTitle', { amount, symbol: tokenSymbol })}
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
              {shortOfTime && (
                <Notice tone="warning" role="status" data-testid="cash-sell-short-of-time">
                  {t('cashSellShortOfTime')}
                </Notice>
              )}
              <div className="flex gap-2.5">
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
                  disabled={!relay.canConfirm}
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
            role={backend.role}
            className={cn('text-caption', backend.className)}
            data-state={backendCheck}
            data-testid="cash-sell-backend-check"
          >
            {t(backend.key)}
          </span>
          <span
            role={token.role}
            className={cn('text-caption', token.className)}
            data-state={tokenCheck.kind}
            data-testid="cash-sell-token-check"
          >
            {t(token.key, { symbol: tokenSymbol })}
          </span>
          {deadlineMs !== null && (
            <span className="text-caption text-muted" data-testid="cash-sell-deadline">
              {t('cashSellDeadline', { time: formatDeadline(deadlineMs) })}
            </span>
          )}
        </Shell>
      );
    }
  }
};
