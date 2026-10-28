import React, { useEffect, useState, useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { SpendingLimitChallenge, type SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { requestSWTransactionProcessing } from 'lib/miden/activity';
import { hasBalanceSnapshotForNetwork } from 'lib/miden/balance-snapshot';
import { useTokensMetadata } from 'lib/miden/front/assets';
import { useAllBalances } from 'lib/miden/front/balance';
import { useAccount, useAllNetworks } from 'lib/miden/front/ready';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import {
  isSpendingLimitPriceUnavailable,
  type SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { initiateGcPurchaseTransaction, type GcPurchaseQuote } from 'lib/miden/transaction/initiate';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isExtension } from 'lib/platform';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';

import { ArcadeGcPurchaseDrawer } from './arcade/ArcadeGcPurchaseDrawer';
import { useGcPurchaseQuote } from './arcade/useGcPurchaseQuote';
import { ArcadeCoinsCard } from './ArcadeCoinsCard';

/** Existing export retained for the Coins route; weekly controls and service are no longer mounted. */
export const ArcadeAllowance: React.FC = () => {
  const { i18n } = useTranslation();
  const account = useAccount();
  const networks = useAllNetworks();
  const networkId = useSyncExternalStore(subscribeBridgeConfig, getEffectiveNetworkName);
  const networkName = networks.find(network => network.id === networkId)?.name ?? networkId;
  const { allTokensBaseMetadataRef } = useTokensMetadata();
  const { data, isLoading } = useAllBalances(account.publicKey, allTokensBaseMetadataRef.current);
  const purchase = useGcPurchaseQuote(networkId, account.publicKey);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [spendingLimitChallenge, setSpendingLimitChallenge] = useState<
    Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'> & { quote: GcPurchaseQuote }
  >();
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  useEffect(() => {
    if (spendingLimitChallenge === undefined) return;
    const accountId = spendingLimitChallenge.assessment?.accountId ?? spendingLimitChallenge.unpriced?.accountId;
    if (accountId === undefined || !sameWalletAccountId(accountId, account.publicKey)) {
      setSpendingLimitChallenge(undefined);
    }
  }, [account.publicKey, spendingLimitChallenge]);
  // The USDCx a purchase is paid from, read off the same balance rows as the GC.
  const payRow = purchase.sale
    ? data.find(row => sameWalletAccountId(row.tokenId, purchase.sale?.payFaucetId ?? ''))
    : undefined;
  const payBalance = hasBalanceSnapshotForNetwork(data, networkId) ? BigInt(payRow?.balanceBaseUnits ?? '0') : null;
  const confirmPurchase = async (quote: GcPurchaseQuote, authorization?: SpendingLimitAuthorization) => {
    if (submitting) return;
    if (authorization !== undefined && !sameWalletAccountId(authorization.accountId, account.publicKey)) {
      setSpendingLimitChallenge(undefined);
      return;
    }
    setSubmitting(true);
    setPurchaseError(null);
    try {
      const txId = await initiateGcPurchaseTransaction(
        account.publicKey,
        quote,
        isDelegateProofEnabled(),
        authorization
      );
      if (isExtension()) requestSWTransactionProcessing();
      setReviewing(false);
      navigate(`/generating-transaction/${encodeURIComponent(txId)}`, HistoryAction.Replace);
    } catch (error) {
      const spends = [{ faucetId: quote.payFaucetId, amount: quote.fillAmount }];
      const assessment = spendingLimitAssessmentFromError(error);
      if (assessment !== undefined) {
        if (sameWalletAccountId(assessment.accountId, account.publicKey)) {
          setSpendingLimitChallenge({ assessment, spends, quote });
        }
        return;
      }
      try {
        if (isSpendingLimitPriceUnavailable(error)) {
          const configuration = await readSpendingLimit(account.publicKey);
          if (configuration !== undefined) {
            setSpendingLimitChallenge({
              unpriced: { accountId: account.publicKey, spends, revision: configuration.revision },
              quote
            });
            return;
          }
        }
      } catch (challengeError) {
        console.error(challengeError);
      }
      setPurchaseError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };
  // Pinned hex + BasicWallet addresses of public token issuers, derived with the real SDK.
  // Extension balance rows arrive before this UI realm necessarily initializes WASM.
  const issuers =
    networkId === 'mainnet'
      ? ['0x34a3510213533f512ec4abe36baf84', 'mm1aq62x5gzzdfn75fwcj47x6a0ssyu9cxz_qr7qqq9wr6w']
      : networkId === 'testnet'
        ? ['0x97924b9a77ed54917ff6d6364ae661', 'mtst1azteyju6wlk4fytl7mtrvjhxvy08nme2_qr7qqq9wr6w']
        : [];
  const rows = data.filter(row => issuers.includes(row.tokenId));
  const coin = rows[0];
  const amount = coin?.balance ?? 0;
  const known =
    issuers.length > 0 &&
    !isLoading &&
    hasBalanceSnapshotForNetwork(data, networkId) &&
    rows.length <= 1 &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    (coin === undefined || (coin.metadata.decimals === 6 && !coin.metadata.scaleIsUnknown));
  const balance = known
    ? new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 6 }).format(amount)
    : null;

  return (
    <>
      <ArcadeCoinsCard
        balance={balance}
        networkName={networkName}
        busy={isLoading}
        purchase={{
          state: purchase.state,
          onBuy: () => {
            setPurchaseError(null);
            setReviewing(true);
            purchase.refresh();
          }
        }}
      />
      <ArcadeGcPurchaseDrawer
        open={reviewing}
        onOpenChange={open => {
          if (!open) setReviewing(false);
        }}
        sale={purchase.sale}
        sales={purchase.sales}
        payBalance={payBalance}
        submitting={submitting}
        error={purchaseError}
        onConfirm={confirmPurchase}
      />
      {spendingLimitChallenge !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitChallenge.assessment}
          spends={spendingLimitChallenge.spends}
          unpriced={spendingLimitChallenge.unpriced}
          onResult={authorization => {
            setSpendingLimitChallenge(undefined);
            if (authorization !== undefined) void confirmPurchase(spendingLimitChallenge.quote, authorization);
          }}
        />
      )}
    </>
  );
};
