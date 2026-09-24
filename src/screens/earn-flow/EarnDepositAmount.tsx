import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { MIDEN_USDC_DECIMALS, MIDEN_USDC_FAUCET, normalizeMidenIdToHex } from 'lib/epoch';
import { hasNoFeeAsset } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
import { navigate } from 'lib/woozie';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EarnFlowHeader } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnLoadError } from './EarnLoadError';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

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
  const { vaults, isLoading, loadError, refetch } = useEarnPositions();
  const found = useMemo(() => vaults.find(item => item.id === vaultId), [vaults, vaultId]);
  const vault = useMemo(() => found ?? placeholderVault(), [found]);
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading, error: loadError });
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
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
  // A deposit is a transaction, and the fee comes out of this account's own vault
  // in the native asset -- holding USDC alone is not enough to move it.
  const feeAssetMissing = hasNoFeeAsset(balanceData ?? [], nativeFaucetId, verificationBaseFee);
  // Continue also needs the vault itself: the placeholder has no id to deposit into.
  const isValidAmount = hasAmount && amountValue <= token.balance && !feeAssetMissing && Boolean(vault.id);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg" data-testid="earn-deposit-amount-page">
      <EarnFlowHeader vault={found} />

      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10 px-4" />
      ) : pending ? null : (
        <>
          {loadFailed && (
            <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="shrink-0 px-4 pt-4" />
          )}
          <div className="min-h-0 flex-1">
            <SelectAmount
              accent="earn"
              token={token}
              amount={amount}
              isValidAmount={isValidAmount}
              label={t('earnDepositAmountLabel')}
              confirmTitle={t('confirm')}
              showNetworkPill={false}
              showBalanceHelper={!hasAmount}
              // Say WHY Continue is dead. Without this the user sees a positive,
              // in-balance amount and a disabled button with no explanation — the
              // send and swap flows both name the same condition. `SelectAmount`
              // translates the key itself, so pass the key rather than the text.
              error={feeAssetMissing ? 'insufficientFeeAsset' : undefined}
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
        </>
      )}
    </div>
  );
};

export default EarnDepositAmount;
