import React from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { formatBalance, type DepositTokenConfig } from 'lib/deposit-bridge';
import { hapticLight } from 'lib/mobile/haptics';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

export interface DepositAmountStepProps {
  token: DepositTokenConfig;
  /** Raw deposit-address balance in base units. */
  balance: bigint;
  amount: string;
  /**
   * Largest bridgeable amount in base units — balance minus the ETH gas reserve.
   * `undefined` while it is still being estimated (renders a skeleton).
   */
  max?: bigint;
  /** ETH set aside to pay for the AggLayer tx. `0n`/undefined for gasless routes. */
  gasReserve?: bigint;
  /** i18n key of a validation error shown under the field. */
  errorKey?: string;
  confirmDisabled?: boolean;
  onAmountChange: (amount: string) => void;
  /** Back to the asset list; omitted when there is only one funded asset. */
  onSelectToken?: () => void;
  onContinue: () => void;
}

/**
 * Amount step of the deposit-bridge sheet. Defaults to the max the address can
 * send (the drawer computes it via `maxSendableDeposit`); for ETH the reserved
 * gas is spelled out, because the deposit pays for its own bridge tx.
 */
export const DepositAmountStep: React.FC<DepositAmountStepProps> = ({
  token,
  balance,
  amount,
  max,
  gasReserve,
  errorKey,
  confirmDisabled,
  onAmountChange,
  onSelectToken,
  onContinue
}) => {
  const { t } = useTranslation();
  const noGasBudget = max === 0n;

  const uiToken: UIToken = {
    id: token.id,
    name: token.symbol,
    decimals: token.decimals,
    balance: Number(formatBalance(balance, token.decimals)),
    fiatPrice: 0
  };

  return (
    <div className="flex flex-col px-6 pb-6">
      <SelectAmount
        embedded
        token={uiToken}
        amount={amount}
        isValidAmount={!errorKey}
        error={errorKey}
        loading={max === undefined}
        label={t('depositBridgeAmountTitle')}
        onAmountChange={onAmountChange}
        onSelectToken={onSelectToken ?? (() => {})}
      />

      <div className="mt-3 flex items-center gap-2">
        <span className="font-heading text-base font-bold text-gray">
          {t('available')} {formatBalance(balance, token.decimals)} {token.symbol}
        </span>
        {max !== undefined && max > 0n && (
          <button
            type="button"
            data-testid="deposit-bridge-max"
            onClick={() => {
              hapticLight();
              onAmountChange(formatBalance(max, token.decimals));
            }}
            className="rounded-full bg-input-bg px-3 py-1 text-xs font-semibold text-primary-500"
          >
            {t('max')}
          </button>
        )}
      </div>

      {gasReserve !== undefined && gasReserve > 0n && (
        <p className="mt-2 text-xs text-heading-gray/60" data-testid="deposit-bridge-gas-reserve">
          {t('depositNetworkFeeReserved', { amount: formatBalance(gasReserve, token.decimals) })}
        </p>
      )}

      {noGasBudget && (
        <p className="mt-2 text-xs text-status-negative" data-testid="deposit-bridge-no-gas">
          {t('depositNotEnoughForGas')}
        </p>
      )}

      <div className="pt-6">
        <Button
          title={t('confirm')}
          variant={ButtonVariant.Primary}
          onClick={onContinue}
          disabled={confirmDisabled || noGasBudget || max === undefined}
          data-testid="deposit-bridge-amount-confirm"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>
    </div>
  );
};
