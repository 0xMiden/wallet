import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { formatBalance, type DepositTokenConfig } from 'lib/deposit-bridge';
import { hapticLight } from 'lib/mobile/haptics';
import type { BridgeRoute } from 'screens/send-flow/types';

export interface ReviewBridgeProps {
  token: DepositTokenConfig;
  /** Base units actually being bridged — the arrived balance less any gas reserve. */
  amount?: bigint;
  /** Quoted arrival amount in base units; `undefined` while quoting or unavailable. */
  receiveAmount?: bigint;
  /** The solver's spread (input − output) in base units. Only the Fast route charges one. */
  feeAmount?: bigint;
  route: BridgeRoute;
  /** Pre-formatted arrival estimate for the chosen route ("~30 sec"). */
  routeEta: string;
  quoteLoading: boolean;
  confirmDisabled?: boolean;
  submitting?: boolean;
  /** Route caveat and/or submit failure, rendered under the totals. */
  notice?: React.ReactNode;
  /** Small print pinned under the CTA (e.g. the reserved network fee). */
  footerNote?: React.ReactNode;
  onOpenRoutePicker: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Fiat has no source yet for EVM-side assets — the wallet's prices come from
 * Miden asset metadata, and there is no ETH/USD feed. The rows are built now so
 * the layout is final; each renders this placeholder until a feed lands.
 */
const FIAT_PLACEHOLDER = '—';

const Skeleton: React.FC<{ className: string }> = ({ className }) => (
  <div className={`animate-pulse rounded bg-heading-gray/10 ${className}`} />
);

/**
 * Terminal step of a deposit bridge: what leaves Sepolia, what lands on Miden,
 * the route it takes and what the solver keeps for taking it.
 *
 * The amount is NOT editable here — it is whatever actually arrived on the
 * deposit address (less the gas reserve), so the figure can never exceed what
 * the address can pay. The route is, via the picker the Route row opens.
 */
export const ReviewBridge: React.FC<ReviewBridgeProps> = ({
  token,
  amount,
  receiveAmount,
  feeAmount,
  route,
  routeEta,
  quoteLoading,
  confirmDisabled,
  submitting,
  notice,
  footerNote,
  onOpenRoutePicker,
  onConfirm,
  onCancel
}) => {
  const { t } = useTranslation();

  const sendText = amount !== undefined ? `${formatBalance(amount, token.decimals)} ${token.symbol}` : undefined;
  const receiveText =
    receiveAmount !== undefined ? `${formatBalance(receiveAmount, token.decimals)} ${token.symbol}` : undefined;
  const feeText = feeAmount !== undefined ? `${formatBalance(feeAmount, token.decimals)} ${token.symbol}` : undefined;
  const routeLabel = route === 'epoch' ? t('routeFastEpoch') : t('routeSlowAgglayer');

  return (
    // Full height with a pinned footer: the CTA sits at the bottom of the
    // screen, not wherever the content happens to stop.
    <div className="flex h-full min-h-0 flex-col" data-testid="deposit-review-bridge">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 pb-4" style={{ touchAction: 'pan-y' }}>
        {/* What goes in, what comes out. One card so the pair reads as one movement. */}
        <div className="rounded-2xl bg-pure-white">
          <div className="flex items-center gap-3 px-4 py-4">
            <TokenLogo symbol={token.symbol} size="md" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-heading-gray opacity-60">{t('youBridge')}</span>
              <span className="truncate font-heading text-xl font-bold text-heading-gray" data-testid="review-send">
                {sendText ?? <Skeleton className="mt-1 h-5 w-24" />}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="font-heading text-base font-bold text-heading-gray">{FIAT_PLACEHOLDER}</span>
              <span className="text-sm text-heading-gray opacity-60">{t('ethereumSepolia')}</span>
            </div>
          </div>

          <div className="relative h-px bg-rule-default">
            <span className="absolute left-6 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-rule-default bg-pure-white">
              <Icon name={IconName.ArrowDown} size="xs" fill="currentColor" className="text-heading-gray" />
            </span>
          </div>

          <div className="flex items-center gap-3 px-4 py-4">
            <TokenLogo symbol={token.symbol} size="md" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-heading-gray opacity-60">{t('youReceive')}</span>
              <span className="truncate font-heading text-xl font-bold text-heading-gray" data-testid="review-receive">
                {quoteLoading ? <Skeleton className="mt-1 h-5 w-24" /> : (receiveText ?? FIAT_PLACEHOLDER)}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="font-heading text-base font-bold text-heading-gray">{FIAT_PLACEHOLDER}</span>
              <span className="text-sm text-heading-gray opacity-60">{t('miden')}</span>
            </div>
          </div>
        </div>

        {/* Route, what it costs, and the sum the deposit address gives up. */}
        <div className="mt-4 overflow-hidden rounded-2xl bg-pure-white">
          <button
            type="button"
            data-testid="review-route-row"
            onClick={() => {
              hapticLight();
              onOpenRoutePicker();
            }}
            className="flex w-full items-center gap-3 px-4 py-4 text-left"
          >
            <span className="shrink-0 text-base text-heading-gray opacity-60">{t('route')}</span>
            <span className="flex min-w-0 flex-1 flex-col items-center">
              <span className="truncate font-heading text-base font-bold text-heading-gray">{routeLabel}</span>
              <span className="truncate text-sm text-heading-gray opacity-60">
                {t('bridgeArrivesIn', { eta: routeEta })}
              </span>
            </span>
            <Icon name={IconName.ChevronRight} size="sm" className="shrink-0 text-heading-gray opacity-40" />
          </button>

          <div className="h-px bg-rule-default" />

          <div className="flex items-center justify-between px-4 py-4">
            <span className="text-base text-heading-gray opacity-60">{t('bridgeFee')}</span>
            <span className="flex flex-col items-end">
              <span className="font-heading text-base font-bold text-heading-gray">{FIAT_PLACEHOLDER}</span>
              <span className="text-sm text-heading-gray opacity-60" data-testid="review-fee">
                {quoteLoading ? <Skeleton className="h-3 w-16" /> : (feeText ?? t('noFee'))}
              </span>
            </span>
          </div>

          <div className="flex items-center justify-between bg-gray-50 px-4 py-4">
            <span className="font-heading text-base font-bold text-heading-gray">{t('totalCost')}</span>
            <span className="font-heading text-base font-bold text-heading-gray" data-testid="review-total">
              {sendText ?? FIAT_PLACEHOLDER}
            </span>
          </div>
        </div>

        <p className="mt-4 text-center text-sm leading-snug text-heading-gray opacity-60">
          {t('bridgeRatesMoveNotice')}
        </p>

        {notice && (
          <p className="mt-3 text-center text-xs text-heading-gray/60" data-testid="deposit-bridge-notice">
            {notice}
          </p>
        )}
      </div>

      <div className="shrink-0 px-6 pt-2 pb-6">
        <Button
          title={submitting ? t('confirming') : t('confirmBridge')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="review-confirm-bridge"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
        <button
          type="button"
          data-testid="review-cancel"
          onClick={() => {
            hapticLight();
            onCancel();
          }}
          className="mt-4 w-full text-center font-heading text-base font-bold text-heading-gray"
        >
          {t('cancel')}
        </button>
        {footerNote && <div className="mt-3 text-center text-xs text-heading-gray/60">{footerNote}</div>}
      </div>
    </div>
  );
};
