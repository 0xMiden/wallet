import React from 'react';

import { TokenLogo } from 'components/TokenLogo';
import { DEPOSIT_TOKEN_IDS, formatBalance, getDepositToken, type DepositTokenId } from 'lib/deposit-bridge';
import { hapticLight } from 'lib/mobile/haptics';

export interface DepositAssetListProps {
  /** Current deposit-address balances in base units; `null` = not readable this tick. */
  balances: Record<DepositTokenId, bigint | null>;
  onSelect: (token: DepositTokenId) => void;
}

/** Tokens with a balance worth bridging (above their dust floor). */
export function fundedDepositTokens(balances: Record<DepositTokenId, bigint | null>): DepositTokenId[] {
  return DEPOSIT_TOKEN_IDS.filter(id => {
    const balance = balances[id];
    return balance !== null && balance > getDepositToken(id).dustFloor;
  });
}

/**
 * First step of the deposit-bridge sheet: which of the funded assets to bridge.
 * Skipped by the drawer when there is only one candidate.
 */
export const DepositAssetList: React.FC<DepositAssetListProps> = ({ balances, onSelect }) => {
  const funded = fundedDepositTokens(balances);

  return (
    <div className="flex flex-col divide-y divide-rule-default px-4 pb-4">
      {funded.map(id => {
        const token = getDepositToken(id);
        const balance = balances[id] ?? 0n;
        return (
          <button
            key={id}
            type="button"
            data-testid={`deposit-bridge-asset-${id}`}
            onClick={() => {
              hapticLight();
              onSelect(id);
            }}
            className="flex w-full items-center gap-3 py-4 text-left"
          >
            <TokenLogo symbol={token.symbol} size="md" />
            <span className="flex-1 font-heading text-base font-bold text-heading-gray">{token.symbol}</span>
            <span className="font-heading text-base font-bold text-heading-gray">
              {formatBalance(balance, token.decimals)}
            </span>
          </button>
        );
      })}
    </div>
  );
};
