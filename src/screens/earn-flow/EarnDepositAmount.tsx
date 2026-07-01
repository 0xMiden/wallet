import React, { FC, useMemo, useState } from 'react';

import { navigate } from 'lib/woozie';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EarnFlowHeader } from './components';
import { EARN_DATA } from './data';

const DEFAULT_VAULT = EARN_DATA.vaults[0]!;

interface EarnDepositAmountProps {
  vaultId: string;
}

const parseAmount = (value: string): number => Number(value.replace(/,/g, '')) || 0;

const EarnDepositAmount: FC<EarnDepositAmountProps> = ({ vaultId }) => {
  const [amount, setAmount] = useState('');
  const vault = useMemo(() => EARN_DATA.vaults.find(item => item.id === vaultId) ?? DEFAULT_VAULT, [vaultId]);
  const token = useMemo<UIToken>(
    () => ({
      id: vault.asset.toLowerCase(),
      name: vault.asset,
      decimals: 6,
      balance: 200,
      fiatPrice: 1
    }),
    [vault.asset]
  );

  const amountValue = parseAmount(amount);
  const hasAmount = amountValue > 0;
  const isValidAmount = hasAmount && amountValue <= token.balance;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg font-inter" data-testid="earn-deposit-amount-page">
      <EarnFlowHeader vault={vault} />

      <div className="min-h-0 flex-1">
        <SelectAmount
          token={token}
          amount={amount}
          isValidAmount={isValidAmount}
          label="Deposit Amount"
          confirmTitle="Confirm"
          showNetworkPill={false}
          showBalanceHelper={!hasAmount}
          footerClassName="pt-4 pb-6"
          onAmountChange={setAmount}
          onSelectToken={() => undefined}
          onConfirm={() => {
            if (isValidAmount) {
              navigate(`/earn/vaults/${vault.id}/deposit/review?amount=${encodeURIComponent(amount)}`);
            }
          }}
        />
      </div>
    </div>
  );
};

export default EarnDepositAmount;
