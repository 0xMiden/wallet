import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { MIDEN_USDC_DECIMALS, MIDEN_USDC_FAUCET, normalizeMidenIdToHex } from 'lib/epoch';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
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
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');

  // The `earn` flow begins at the amount screen and is settled by the review
  // route, so it has to outlive this component. `handedOff` is what keeps that
  // from leaking: without it any exit looks identical to the handoff, and the
  // flow would either be reported abandoned on every successful deposit or
  // never settled at all on a real abandonment.
  const handedOff = useRef(false);
  useEffect(() => {
    enterRouteFlow('earn');
    reportRouteFlowStep('earn', 'select_amount');
    return () => {
      if (handedOff.current) return;
      settleRouteFlow('earn', flow => flow.cancel());
    };
  }, []);
  const { vaults } = useEarnPositions();
  const vault = useMemo(() => vaults.find(item => item.id === vaultId) ?? placeholderVault(), [vaults, vaultId]);
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  // Epoch Earn is USDC-only. Balance rows use bech32 faucet ids while the
  // allocator configuration uses hex, so compare their normalized account ids.
  const depositBalance = useMemo(
    () => balanceData?.find(item => normalizeMidenIdToHex(item.tokenId) === normalizeMidenIdToHex(MIDEN_USDC_FAUCET)),
    [balanceData]
  );
  const token = useMemo<UIToken>(
    () => ({
      id: depositBalance?.tokenId ?? MIDEN_USDC_FAUCET,
      name: depositBalance?.metadata.symbol ?? 'USDC',
      decimals: depositBalance?.metadata.decimals ?? MIDEN_USDC_DECIMALS,
      balance: depositBalance?.balance ?? 0,
      fiatPrice: depositBalance?.fiatPrice ?? 1,
      // Either the faucet answered, or we fall back to the USDC constant — which
      // is a stated decimals for a known token, not a guess about an unknown one.
      scaleIsKnown: depositBalance ? hasKnownScale(depositBalance.metadata) : true
    }),
    [depositBalance]
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
          label={t('earnDepositAmountLabel')}
          confirmTitle={t('confirm')}
          showNetworkPill={false}
          showBalanceHelper={!hasAmount}
          footerClassName="pt-4 pb-6"
          onAmountChange={setAmount}
          onSelectToken={() => undefined}
          onConfirm={() => {
            if (isValidAmount) {
              handedOff.current = true;
              navigate(`/earn/vaults/${vaultId}/deposit/review?amount=${encodeURIComponent(amount)}`);
            }
          }}
        />
      </div>
    </div>
  );
};

export default EarnDepositAmount;
