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
  /** Cross-chain (0x recipient) send — swaps the Miden chip for a destination-network selector. */
  isBridge?: boolean;
  /** Chosen destination network (bridge only). */
  network?: BridgeNetwork;
  /** Token symbol every bridged send arrives as (USDC). */
  outputSymbol?: string;
  label?: React.ReactNode;
  confirmTitle?: string;
  showNetworkPill?: boolean;
  showBalanceHelper?: boolean;
  /** Padding classes for the confirm-button footer. Defaults to the send-flow
   *  spacing (`pt-4 pb-24`); pass a snugger value to hug the bottom. */
  footerClassName?: string;
  children?: React.ReactNode;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  onSelectNetwork?: () => void;
  onConfirm: () => void;
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
  isBridge = false,
  network,
  outputSymbol,
  label,
  confirmTitle,
  showNetworkPill = true,
  showBalanceHelper = true,
  footerClassName = 'pt-4 pb-24',
  children,
  onAmountChange,
  onSelectToken,
  onSelectNetwork,
  onConfirm
}) => {
  const { t } = useTranslation();

  const availableFiat = token ? token.balance * token.fiatPrice : 0;
  const canProceed = !!token && isValidAmount && (!isBridge || !!network);

  const selectToken = () => {
    hapticLight();
    onSelectToken();
  };

  const selectNetwork = () => {
    hapticLight();
    onSelectNetwork?.();
  };

  // Same-chain (Miden) send: a single token chip with a dropdown chevron.
  const tokenChip = (
    <button
      type="button"
      data-testid="send-token-selector"
      onClick={selectToken}
      className="flex items-center gap-1.25 cursor-pointer"
    >
      {token && <TokenLogo symbol={token.name} size="md" />}
      <span className="font-heading text-2xl font-bold text-heading-gray">
        {token ? token.name : t('selectAToken')}
      </span>
      <Icon name={IconName.ChevronDown} size="sm" className="text-primary-500" fill="currentColor" />
    </button>
  );

  // Cross-chain send: a token row connected to a destination-network row, so it
  // reads as "send <token> → arrives as <outputSymbol> on <network>".
  const bridgeSelector = (
    <div className="flex flex-col">
      <button type="button" onClick={selectToken} className="flex items-center gap-3 text-left">
        {token ? <TokenLogo symbol={token.name} size="md" /> : <PlaceholderCircle>$</PlaceholderCircle>}
        <span className="font-heading text-2xl font-bold text-heading-gray">
          {token ? token.name : t('selectAToken')}
        </span>
        <Icon name={IconName.ChevronRightLucide} size="sm" className="text-primary-500" />
      </button>

      {/* Connector aligning the two circle icons */}
      <div className="my-1 ml-4.25 h-4 w-0.5 bg-grey-300" />

      <button type="button" onClick={selectNetwork} className="flex items-start gap-3 text-left">
        <PlaceholderCircle>
          <Icon name={IconName.Globe} size="sm" className="text-pure-white" fill="currentColor" />
        </PlaceholderCircle>
        <div className="flex flex-col">
          <span className="font-heading text-2xl font-bold text-[#808080] flex items-center gap-1">
            {network ? (
              <>
                <span className="text-[#808080]">{t('network')}</span>
                <span>{network.name}</span>
              </>
            ) : (
              t('selectNetwork')
            )}
            <Icon name={IconName.ChevronRightLucide} size="sm" className="text-primary-500" />
          </span>
          {network && (
            <span className="text-xs text-[#9B9B9B]">
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
        <span className="font-heading text-[#808080] text-base font-bold">
          {t('available')} {formatBalance(token.balance)} {token.name}
        </span>
        <span className="font-heading text-[#808080] text-base font-bold">
          {t('approxFiatValue', { value: `$${availableFiat.toFixed(2)}` })}
        </span>
      </>
    ) : null;

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        {showNetworkPill && !isBridge && (
          <span className="self-start text-xs font-semibold text-pure-white bg-primary-500 px-3 py-1 rounded-full mb-3">
            {t('miden')}
          </span>
        )}
        <AmountInput
          label={label ?? t('selectAmount')}
          value={amount}
          error={error ? t(error) : undefined}
          helper={helper}
          tokenSelector={isBridge ? bridgeSelector : tokenChip}
          data-testid="send-amount-input"
          onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
        />
        {children}
      </div>

      <div className={clsx('shrink-0', footerClassName)}>
        <Button
          title={confirmTitle ?? t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onConfirm}
          disabled={!canProceed}
          data-testid="send-amount-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
