import React, { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { FeatureUnavailableNotice } from 'components/FeatureUnavailable';
import { normalizeMidenIdToHex } from 'lib/epoch';
import { typedAmountExceedsBalance } from 'lib/i18n/numbers';
import { hasNoFeeAsset, maxSendableNative } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
import { navigate } from 'lib/woozie';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import { UIToken } from 'screens/send-flow/types';

import { EarnFlowHeader, EarnVaultClosedNotice } from './components';
import { placeholderVault } from './earn-mapping';
import { EarnCollateralNotice } from './EarnCollateralNotice';
import { EarnLoadError } from './EarnLoadError';
import { EarnLoading } from './EarnLoading';
import { useEarnCollateralState } from './useEarnCollateral';
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
  const { vaults, vaultsPending, isLoading, isRefreshing, loadError, refetch } = useEarnPositions();
  const found = useMemo(() => vaults.find(item => item.id === vaultId), [vaults, vaultId]);
  const vault = useMemo(() => found ?? placeholderVault(), [found]);
  // The vaults come from the derivation's catalogue, which can settle after the positions read.
  const { loadFailed, pending } = earnItemLoadState(found, { isLoading: isLoading || vaultsPending, error: loadError });
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData, isLoading: balancesLoading } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const nativeFaucetId = useNativeFeeFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const earnCollateral = useEarnCollateralState();
  const { collateral } = earnCollateral;
  // Neither the pending nor the vault-less failed branch draws the amount step or its notice.
  const earnDeposit = useFeatureAvailability('earnDeposit', { hold: !((loadFailed && !found) || pending) });
  // Testnet spends native USDCx. Match by faucet identity, never by another token's USDC symbol.
  const depositBalance = useMemo(
    () =>
      collateral
        ? balanceData?.find(item => normalizeMidenIdToHex(item.tokenId) === normalizeMidenIdToHex(collateral.faucetId))
        : undefined,
    [balanceData, collateral]
  );
  const token = useMemo<UIToken>(() => {
    const id = depositBalance?.tokenId ?? collateral?.faucetId ?? '';
    const symbol = collateral?.symbol ?? '';
    const decimals = collateral?.decimals ?? 0;
    const native = !!id && !!nativeFaucetId && normalizeMidenIdToHex(id) === normalizeMidenIdToHex(nativeFaucetId);
    return {
      id,
      name: symbol,
      decimals,
      balance: native
        ? maxSendableNative(depositBalance?.balance ?? 0, verificationBaseFee, decimals)
        : (depositBalance?.balance ?? 0),
      // The live quote, held row or not: the row's stored price is a capture from when balances
      // were read. No quote is no price (0), never a stated $1.
      fiatPrice: tokenQuote(tokenPrices, id || undefined, symbol)?.price ?? 0,
      // Either the faucet answered, or the config states the collateral's decimals; with neither the scale is unknown.
      scaleIsKnown:
        collateral !== null &&
        (!depositBalance || (hasKnownScale(depositBalance.metadata) && depositBalance.metadata.decimals === decimals))
    };
  }, [collateral, depositBalance, tokenPrices, nativeFaucetId, verificationBaseFee]);

  const amountValue = parseAmount(amount);
  const hasAmount = amountValue > 0;
  // A deposit is a transaction, and the fee comes out of this account's own vault
  // in the native asset -- holding USDC alone is not enough to move it.
  const feeAssetMissing = !balancesLoading && hasNoFeeAsset(balanceData ?? [], nativeFaucetId, verificationBaseFee);
  // Continue also needs the vault itself (the placeholder has no id to deposit into), a vault that accepts deposits
  // now, and Earn deposits to be up.
  const isValidAmount =
    !balancesLoading &&
    earnDeposit.state === 'available' &&
    vault.canOpen !== false &&
    collateral !== null &&
    token.scaleIsKnown &&
    hasAmount &&
    !typedAmountExceedsBalance(amount.replace(/,/g, ''), token.balance, token.decimals) &&
    !feeAssetMissing &&
    Boolean(vault.id);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg" data-testid="earn-deposit-amount-page">
      <EarnFlowHeader subject={found} />

      {loadFailed && !found ? (
        <EarnLoadError
          isRetrying={isRefreshing}
          onRetry={refetch}
          message={t('earnVaultLoadError')}
          errorId="earnVaultLoadError"
          className="mt-10 px-4"
        />
      ) : pending ? (
        <EarnLoading />
      ) : (
        <>
          {loadFailed && (
            <EarnLoadError
              isRetrying={isRefreshing}
              onRetry={refetch}
              message={t('earnVaultLoadError')}
              errorId="earnVaultLoadError"
              className="shrink-0 px-4 pt-4"
            />
          )}
          <FeatureUnavailableNotice
            feature="earnDeposit"
            availability={earnDeposit}
            className="mx-4 mt-4 w-auto shrink-0"
          />
          {/* One reason at a time: a deposit that is down already says why Continue is dead, and so does a
              vault that accepts no deposits now. */}
          {earnDeposit.state !== 'unavailable' &&
            (vault.canOpen === false ? (
              <EarnVaultClosedNotice
                canOpen={vault.canOpen}
                depositsEnabled={vault.depositsEnabled}
                className="mx-4 mt-4 w-auto shrink-0"
              />
            ) : (
              <EarnCollateralNotice
                reason={earnCollateral.state === 'resolved' ? null : earnCollateral.state}
                className="mx-4 mt-4 w-auto shrink-0"
              />
            ))}
          <div className="min-h-0 flex-1">
            {balancesLoading || earnDeposit.state === 'loading' ? (
              <EarnLoading />
            ) : (
              <SelectAmount
                accent="earn"
                pageInset
                showAmountDivider={false}
                showBalanceHelper={collateral !== null}
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
                errorId="insufficientFeeAsset"
                error={feeAssetMissing ? 'insufficientFeeAsset' : undefined}
                onAmountChange={setAmount}
                onSelectToken={() => undefined}
                onConfirm={() => {
                  if (isValidAmount) {
                    handedOff.current = true;
                    navigate(
                      `/earn/vaults/${vaultId}/deposit/review?amount=${encodeURIComponent(amount)}&collateral=${encodeURIComponent(token.id)}`
                    );
                  }
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default EarnDepositAmount;
