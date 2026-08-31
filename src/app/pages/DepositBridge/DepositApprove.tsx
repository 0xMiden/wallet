import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ApproveInWallet, type DepositApproveMethod } from 'app/pages/Receive/ApproveInWallet';
import { ScreenHeader } from 'components/ScreenHeader';
import {
  DEPOSIT_WALLETS,
  getDepositToken,
  isDepositTokenId,
  openPaymentDeeplink,
  useDepositAddressStore
} from 'lib/deposit-bridge';
import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { goBack, navigate, Redirect, useLocation } from 'lib/woozie';

function isApproveMethod(value: string | null): value is DepositApproveMethod {
  return value === 'walletconnect' || value === 'deeplink' || value === 'address';
}

/**
 * Full-screen waiting page (`/deposit-bridge/approve?token=…&amount=…&method=…&wallet=…`).
 *
 * Reached from the Cross-chain tab once a funding method is chosen. The wallet
 * cannot sign this transfer — it leaves an account we do not hold — so the page
 * restates the request and watches the deposit address. When the money lands it
 * hands off to the review page, which is the only place a bridge is confirmed.
 */
export const DepositApprove: React.FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const account = useAccount();
  const evmAddress = account.evmAddress ?? '';

  const balances = useDepositAddressStore(s => s.balances);
  const arrivals = useDepositAddressStore(s => s.arrivals);
  const detectedArrivals = useDepositAddressStore(s => s.detectedArrivals);
  const poll = useDepositAddressStore(s => s.poll);

  const { token, amount, method, wallet } = useMemo(() => {
    const params = new URLSearchParams(search);
    const tokenParam = params.get('token');
    const amountParam = params.get('amount');
    const methodParam = params.get('method');
    let parsedAmount: bigint | undefined;
    try {
      parsedAmount = amountParam ? BigInt(amountParam) : undefined;
    } catch {
      parsedAmount = undefined;
    }
    return {
      token: isDepositTokenId(tokenParam) ? tokenParam : undefined,
      amount: parsedAmount && parsedAmount > 0n ? parsedAmount : undefined,
      method: isApproveMethod(methodParam) ? methodParam : 'address',
      wallet: params.get('wallet') || undefined
    };
  }, [search]);

  // Whether the user has said they paid. Only changes the CTA — the chain, not
  // this flag, decides when the page moves on.
  const [claimedSent, setClaimedSent] = useState(false);

  // Two distinct facts, and the page shows the gap between them rather than
  // hiding it: the money is VISIBLE on Sepolia, and the money is FINAL. Only the
  // second one can be bridged, so the first drives "confirming" and the second
  // is what moves the user on.
  const detected =
    (token !== undefined && (balances[token] ?? 0n) > getDepositToken(token).dustFloor) ||
    detectedArrivals.some(a => a.token === token);
  const finalised = arrivals.some(a => a.token === token);

  useEffect(() => {
    if (!finalised || !token) return;
    navigate(`/deposit-bridge/review?token=${token}`);
  }, [finalised, token]);

  const handlePrimary = useCallback(() => {
    hapticLight();
    if (detected) return;
    // Before the user has claimed to have paid, the action is still "go pay" —
    // re-opening the wallet we handed the request to. After that there is
    // nothing left to open, so the button only asks the watcher to look now.
    if (!claimedSent && method === 'deeplink' && token && amount) {
      const target = DEPOSIT_WALLETS.find(option => (option.name || undefined) === wallet);
      openPaymentDeeplink((target ?? DEPOSIT_WALLETS[DEPOSIT_WALLETS.length - 1]!).buildUri(token, evmAddress, amount));
      setClaimedSent(true);
      return;
    }
    setClaimedSent(true);
    poll();
  }, [detected, claimedSent, method, token, amount, wallet, evmAddress, poll]);

  if (!token || !amount || !evmAddress) return <Redirect to="/receive?tab=crosschain" />;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-app-bg">
      <ScreenHeader
        title={t('approveInWalletTitle')}
        onBack={goBack}
        backLabel={t('back')}
        onClose={() => navigate('/receive?tab=crosschain')}
        closeLabel={t('cancel')}
        className="px-6"
      />
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
        <ApproveInWallet
          token={getDepositToken(token)}
          amount={amount}
          evmAddress={evmAddress}
          method={method}
          walletName={wallet}
          claimedSent={claimedSent}
          detected={detected}
          confirming={detected && !finalised}
          onPrimary={handlePrimary}
          onCancel={() => navigate('/receive?tab=crosschain')}
        />
      </div>
    </div>
  );
};
