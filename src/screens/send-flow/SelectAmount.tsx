import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

import { BridgeNetwork } from './bridge-networks';
import { UIToken } from './types';

export interface SelectAmountProps {
  token?: UIToken;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  /** Overrides the amount label (e.g. "Select Amount", "You Pay"). */
  label?: React.ReactNode;
  /** Overrides the Confirm button label in the page variant. */
  confirmTitle?: string;
  showNetworkPill?: boolean;
  showBalanceHelper?: boolean;
  /** Padding classes for the confirm-button footer. The `pb-24` default clears
   *  the floating BottomNav; pass a snugger value when the navbar is hidden. */
  footerClassName?: string;
  children?: React.ReactNode;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  /** Required in the default (page) variant, which renders its own Confirm CTA. */
  onConfirm?: () => void;
  /**
   * `embedded` strips the full-screen chrome (network pill, scroll container,
   * Confirm button) so the field can be stacked — the swap screen renders two of
   * these (You Pay / You Receive) under one shared Confirm. The available-balance
   * helper is NOT stripped by `embedded`; it's controlled by `showBalanceHelper`
   * (#461). Defaults to the standalone page layout used by the send flow.
   */
  embedded?: boolean;
  /** Token-logo symbol override (e.g. the DEX `logoSymbol`); defaults to `token.name`. */
  logoSymbol?: string;
  /** Cross-chain deposit — swaps the Miden chip for a destination-network selector. */
  isBridge?: boolean;
  /** Chosen destination network (bridge only). */
  network?: BridgeNetwork;
  /** Token symbol every bridged transfer arrives as (USDC). */
  outputSymbol?: string;
  /** Optional custom header rendered above the amount (e.g. the bridge-deposit "wallet connected · Miden Bridge" title). */
  title?: React.ReactNode;
  /** Show a skeleton in place of the amount while it is being computed (e.g. the swap receive quote). */
  loading?: boolean;
  onSelectNetwork?: () => void;
}

/** Trim trailing zeros so "200.000" renders as "200" but "200.5" stays intact. */
function formatBalance(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/** Blue circle used as a placeholder before a token/network is chosen. */
const PlaceholderCircle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500 text-pure-white">
    {children}
  </span>
);

export const SelectAmount: React.FC<SelectAmountProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  label,
  confirmTitle,
  showNetworkPill = true,
  showBalanceHelper = true,
  footerClassName = 'pt-4 pb-24',
  children,
  onAmountChange,
  onSelectToken,
  onConfirm,
  embedded = false,
  logoSymbol,
  isBridge = false,
  network,
  outputSymbol,
  title,
  loading,
  onSelectNetwork
}) => {
  const { t } = useTranslation();

  const availableFiat = token ? token.balance * token.fiatPrice : 0;
  const canProceed = !!token && isValidAmount && (!isBridge || !!network);

  const tokenSelector = (
    <button
      type="button"
      data-testid="send-token-selector"
      onClick={() => {
        hapticLight();
        onSelectToken();
      }}
      className="flex items-center gap-1.25 cursor-pointer rounded-full bg-input-bg px-3 py-2"
    >
      {token ? (
        <TokenLogo symbol={logoSymbol ?? token.name} size="md" />
      ) : embedded ? (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2F6BED] text-lg font-bold text-pure-white">
          $
        </span>
      ) : null}
      <span className="font-heading text-2xl font-bold text-heading-gray">
        {token ? token.name : t('selectAToken')}
      </span>
      <Icon name={IconName.ChevronDown} size="sm" className="text-primary-500" fill="currentColor" />
    </button>
  );

  // Cross-chain: a token row connected to a destination-network row, so it
  // reads as "send <token> → arrives as <outputSymbol> on <network>".
  const bridgeSelector = (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid="send-token-selector"
        onClick={() => {
          hapticLight();
          onSelectToken();
        }}
        className="flex items-center gap-3 text-left"
      >
        {token ? <TokenLogo symbol={logoSymbol ?? token.name} size="md" /> : <PlaceholderCircle>$</PlaceholderCircle>}
        <span className="font-heading text-2xl font-bold text-heading-gray">
          {token ? token.name : t('selectAToken')}
        </span>
        <Icon name={IconName.ChevronRightLucide} size="sm" className="text-primary-500" />
      </button>

      {/* Connector aligning the two circle icons */}
      <div className="my-1 ml-4.25 h-4 w-0.5 bg-grey-300" />

      <button
        type="button"
        onClick={() => {
          hapticLight();
          onSelectNetwork?.();
        }}
        className="flex items-start gap-3 text-left"
      >
        <PlaceholderCircle>
          <Icon name={IconName.Globe} size="sm" className="text-pure-white" fill="currentColor" />
        </PlaceholderCircle>
        <div className="flex flex-col">
          <span className="font-heading text-2xl font-bold text-gray flex items-center gap-1">
            {network ? (
              <>
                <span className="text-gray">{t('network')}</span>
                <span>{network.name}</span>
              </>
            ) : (
              t('selectNetwork')
            )}
            <Icon name={IconName.ChevronRightLucide} size="sm" className="text-primary-500" />
          </span>
          {network && (
            <span className="text-xs text-text-muted">
              {t('receiveOnArrivesAs', { network: network.name, symbol: outputSymbol })}
            </span>
          )}
        </div>
      </button>
    </div>
  );

  const helper =
    token && showBalanceHelper ? (
      <>
        <span className="font-heading text-gray text-base font-bold">
          {t('available')} {formatBalance(token.balance)} {token.name}
        </span>
        {/* Only show the fiat approximation when we actually have a price — swap
            DEX tokens carry no fiatPrice, so a "$0.00" line would be misleading. */}
        {token.fiatPrice > 0 && (
          <span className="font-heading text-gray text-base font-bold">
            {t('approxFiatValue', { value: `$${availableFiat.toFixed(2)}` })}
          </span>
        )}
      </>
    ) : null;

  const amountField = (
    <AmountInput
      label={label ?? (title ? undefined : t('selectAmount'))}
      value={amount}
      error={error ? t(error) : undefined}
      // The helper (available balance) is controlled by `showBalanceHelper`, not
      // by `embedded`: the swap "You Pay" field is embedded but must still show
      // how much is spendable (#461). Embedded callers that don't want it (e.g.
      // the swap "You Receive" field) pass showBalanceHelper={false}.
      helper={helper}
      tokenSelector={isBridge ? bridgeSelector : tokenSelector}
      showDivider={!!amount && !!token}
      data-testid="send-amount-input"
      loading={loading}
      onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
    />
  );

  if (embedded) {
    return amountField;
  }

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        {title}
        {showNetworkPill && !isBridge && (
          <span className="self-start text-xs font-semibold text-pure-white bg-primary-500 px-3 py-1 rounded-full mb-3">
            {t('miden')}
          </span>
        )}
        {amountField}
        {children}
      </div>

      <div className={clsx('shrink-0', footerClassName)}>
        <Button
          title={confirmTitle ?? t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          // `onConfirm` is optional (the embedded variant omits it and returns
          // early above), so in this page variant a missing handler disables
          // the CTA rather than rendering a live-but-dead button.
          disabled={!canProceed || !onConfirm}
          data-testid="send-amount-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
