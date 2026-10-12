import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { FeatureUnavailableNotice } from 'components/FeatureUnavailable';
import { normalizeMidenIdToHex } from 'lib/epoch';
import { hasNoFeeAsset } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { selectMidenUsdc } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';
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
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const nativeFaucetId = useNativeFeeFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const collateral = selectMidenUsdc(useBridgeConfigSnapshot());
  // Neither the pending nor the vault-less failed branch draws the amount step or its notice.
  const earnDeposit = useFeatureAvailability('earnDeposit', { hold: !((loadFailed && !found) || pending) });
  // Epoch Earn is USDC-only, in the collateral the config names (an E2E run's injected faucet first). Balance rows
  // use bech32 faucet ids while the config uses hex, so compare their normalized account ids.
  const depositBalance = useMemo(
    () =>
      collateral
        ? balanceData?.find(item => normalizeMidenIdToHex(item.tokenId) === normalizeMidenIdToHex(collateral.faucetId))
        : undefined,
    [balanceData, collateral]
  );
  const token = useMemo<UIToken>(() => {
    const id = depositBalance?.tokenId ?? collateral?.faucetId ?? '';
    const symbol = depositBalance?.metadata.symbol ?? collateral?.symbol ?? '';
    return {
      id,
      name: symbol,
      decimals: depositBalance?.metadata.decimals ?? collateral?.decimals ?? 0,
      balance: depositBalance?.balance ?? 0,
      // The live quote, held row or not: the row's stored price is a capture from when balances
      // were read. No quote is no price (0), never a stated $1.
      fiatPrice: tokenQuote(tokenPrices, id || undefined, symbol)?.price ?? 0,
      // Either the faucet answered, or the config states the collateral's decimals; with neither the scale is unknown.
      scaleIsKnown: depositBalance ? hasKnownScale(depositBalance.metadata) : collateral !== null
    };
  }, [collateral, depositBalance, tokenPrices]);

  const amountValue = parseAmount(amount);
  const hasAmount = amountValue > 0;
  // A deposit is a transaction, and the fee comes out of this account's own vault
  // in the native asset -- holding USDC alone is not enough to move it.
  const feeAssetMissing = hasNoFeeAsset(balanceData ?? [], nativeFaucetId, verificationBaseFee);
  // Continue also needs the vault itself (the placeholder has no id to deposit into) and Earn deposits to be up.
  const isValidAmount =
    earnDeposit.state === 'available' &&
    hasAmount &&
    amountValue <= token.balance &&
    !feeAssetMissing &&
    Boolean(vault.id);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg" data-testid="earn-deposit-amount-page">
      <EarnFlowHeader subject={found} />

      {loadFailed && !found ? (
        <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="mt-10 px-4" />
      ) : pending ? null : (
        <>
          {loadFailed && (
            <EarnLoadError onRetry={refetch} message={t('earnVaultLoadError')} className="shrink-0 px-4 pt-4" />
          )}
          <FeatureUnavailableNotice availability={earnDeposit} className="mx-4 mt-4 shrink-0" />
          <div className="min-h-0 flex-1">
            <SelectAmount
              accent="earn"
              pageInset
              showAmountDivider={false}
              token={token}
              amount={amount}
              isValidAmount={isValidAmount}
              label={t('earnDepositAmountLabel')}
              confirmTitle={t('confirm')}
              showNetworkPill={false}
              // Say WHY Continue is dead. Without this the user sees a positive,
              // in-balance amount and a disabled button with no explanation — the
              // send and swap flows both name the same condition. `SelectAmount`
              // translates the key itself, so pass the key rather than the text.
              error={feeAssetMissing ? 'insufficientFeeAsset' : undefined}
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
