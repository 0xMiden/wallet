import React from 'react';

import BigNumber from 'bignumber.js';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { durations } from 'lib/animation/durations';
import { easings } from 'lib/animation/easings';
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { truncateAddress } from 'utils/string';

import { getBridgeNetwork, SendNetworkId } from './bridge-networks';
import { NetworkChip } from './NetworkChip';
import { SendStepLayout } from './SendStepLayout';
import { UIToken } from './types';

export interface SendAmountProps {
  /** The token with its spendable balance (the native token's fee reserve already taken off). */
  token?: UIToken;
  amount: string;
  isValidAmount: boolean;
  /** Untranslated error key from the send form. */
  error?: string;
  recipientAddress: string;
  /** Saved contact name for the recipient, shown instead of the address. */
  recipientName?: string;
  network?: SendNetworkId;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  /** Opens Receive, offered when the account has no MIDEN for the fee. */
  onReceive: () => void;
  onBack: () => void;
  onConfirm: () => void;
}

/**
 * Round DOWN to 4dp (more for tiny balances) and trim zeros, as SelectAmount
 * does: the figure, and the Max it fills in, must never exceed what the form
 * accepts once the fee reserve is held back.
 */
function formatBalance(value: number): string {
  return toAdaptiveFixed(value, 4, BigNumber.ROUND_DOWN).replace(/\.?0+$/, '');
}

/**
 * The send flow's amount step. The amount is the step's large input, under the
 * title like the recipient address. One card below it holds what the amount is
 * made of: the token (with its available balance and Max) and where it goes.
 */
export const SendAmount: React.FC<SendAmountProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  recipientAddress,
  recipientName,
  network,
  onAmountChange,
  onSelectToken,
  onReceive,
  onBack,
  onConfirm
}) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : { duration: durations.normal, ease: easings.easeOutCubic };

  // A decimals guess converts the typed amount into the wrong base units, so
  // an unknown-scale token can't be sent (see SelectAmount).
  const scaleIsKnown = token === undefined || token.scaleIsKnown;
  const canProceed = !!token && scaleIsKnown && isValidAmount;

  // The missing-fee shortfall is about the account, not the typed number, so it
  // gets a notice with a way out instead of turning the amount red. An empty
  // field isn't an invalid amount yet.
  const feeShortfall = error === 'insufficientFeeAsset';
  const amountError = error && !feeShortfall && (amount || error !== 'invalidAmount') ? t(error) : undefined;

  const fiatValue =
    token && scaleIsKnown && token.fiatPrice > 0 && amount
      ? t('approxFiatValue', { value: `$${toAdaptiveFixed(parseFloat(amount) * token.fiatPrice)}` })
      : undefined;

  const bridgeNetwork = network && network !== 'miden' ? getBridgeNetwork(network) : undefined;

  return (
    <SendStepLayout
      title={t('enterAmount')}
      onBack={onBack}
      footer={
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canProceed}
          data-testid="send-amount-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      }
    >
      <AmountInput
        value={amount}
        invalid={!!amountError}
        error={amountError}
        helper={fiatValue && <span className="font-heading text-base font-bold text-gray">{fiatValue}</span>}
        showDivider={false}
        data-testid="send-amount-input"
        onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
      />

      <div className="mt-8 rounded-2xl bg-surface-interactive">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            data-testid="send-token-selector"
            onClick={() => {
              hapticLight();
              onSelectToken();
            }}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {token ? (
              <TokenLogo symbol={token.name} size="md" />
            ) : (
              <span className="h-9 w-9 shrink-0 rounded-full bg-gray-100" aria-hidden="true" />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1 font-heading text-lg leading-tight font-bold text-heading-gray">
                {token ? token.name : t('selectAToken')}
                <Icon name={IconName.ChevronDown} size="xs" className="text-accent-send" fill="currentColor" />
              </span>
              {token && (
                <span className="text-sm text-text-muted" data-testid="send-amount-available">
                  {scaleIsKnown ? `${t('available')} ${formatBalance(token.balance)}` : t('unknownTokenScale')}
                </span>
              )}
            </span>
          </button>
          <AnimatePresence initial={false}>
            {token && scaleIsKnown && token.balance > 0 && (
              <motion.span
                key="max"
                className="inline-flex shrink-0"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={transition}
              >
                <button
                  type="button"
                  data-testid="send-amount-max"
                  onClick={() => {
                    hapticLight();
                    onAmountChange(formatBalance(token.balance));
                  }}
                  className="shrink-0 rounded-full border border-border-subtle bg-app-bg px-3 py-1.5 font-heading text-sm font-bold text-accent-send"
                >
                  {t('max')}
                </button>
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="mx-4 border-t border-rule-default" />

        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-sm text-text-muted">{t('to')}</span>
          <span
            data-testid="send-amount-recipient"
            className="min-w-0 flex-1 truncate font-heading text-base font-bold text-heading-gray"
          >
            {recipientName ?? truncateAddress(recipientAddress)}
          </span>
          {bridgeNetwork ? (
            <NetworkChip kind="ethereum" label={bridgeNetwork.name} />
          ) : (
            <NetworkChip kind="miden" label={t('miden')} />
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {feeShortfall && (
          <motion.div
            key="fee-notice"
            className="overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
          >
            <div className="pt-4">
              <div
                data-testid="send-fee-notice"
                className="flex items-start gap-3 rounded-2xl border border-border-subtle px-4 py-3"
              >
                <Icon
                  name={IconName.InformationFill}
                  size="xs"
                  fill="currentColor"
                  className="mt-0.5 shrink-0 text-heading-gray"
                />
                <div className="flex flex-col items-start gap-1">
                  <span className="text-sm text-heading-gray">{t('insufficientFeeAsset')}</span>
                  <button
                    type="button"
                    data-testid="send-fee-notice-receive"
                    onClick={() => {
                      hapticLight();
                      onReceive();
                    }}
                    className="flex items-center gap-0.5 font-heading text-sm font-bold text-accent-send"
                  >
                    {t('receive')}
                    <Icon name={IconName.ChevronRightLucide} size="xs" className="text-accent-send" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SendStepLayout>
  );
};
