import React, { FC, useMemo, useState } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { MIDEN_USDC_DECIMALS } from 'lib/epoch';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { navigate } from 'lib/woozie';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EarnFlowHeader } from './components';
import { placeholderVault } from './earn-mapping';
import { useEarnPositions } from './useEarnPositions';

interface EarnDepositAmountProps {
  vaultId: string;
}

const parseAmount = (value: string): number => Number(value.replace(/,/g, '')) || 0;

const EarnDepositAmount: FC<EarnDepositAmountProps> = ({ vaultId }) => {
  const [amount, setAmount] = useState('');
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  // The deposited asset is the native faucet — the discovered id is bech32,
  // the same form the balance rows key on.
  const midenFaucetId = useMidenFaucetId();
  const nativeBalance = useMemo(
    () => (midenFaucetId ? balanceData?.find(item => item.tokenId === midenFaucetId) : undefined),
    [balanceData, midenFaucetId]
  );
  const token = useMemo<UIToken>(
    () => ({
      id: midenFaucetId ?? '',
      // Label the deposit token by its faucet id, not a symbol.
      name: nativeBalance?.metadata.symbol ?? 'MDN',
      decimals: nativeBalance?.metadata.decimals ?? MIDEN_USDC_DECIMALS,
      balance: nativeBalance?.balance ?? 0,
      fiatPrice: nativeBalance?.fiatPrice ?? 1
    }),
    [midenFaucetId, nativeBalance]
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
          onConfirm={() => {
            if (isValidAmount) {
              navigate(`/earn/vaults/${vaultId}/deposit/review?amount=${encodeURIComponent(amount)}`);
            }
          }}
        />
      </div>
    </div>
  );
};

export default EarnDepositAmount;
