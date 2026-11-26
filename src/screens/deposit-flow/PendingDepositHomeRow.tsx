import React, { FC, Suspense } from 'react';

import { type PendingRelayDeposit, usePendingRelayDeposits } from 'lib/evm-relay/pending-deposit';
import { useDepositArrival } from 'lib/evm-relay/use-deposit-arrival';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { navigate } from 'lib/woozie';

import { depositNetworkName, pendingDepositPath, servedPendingDeposits } from './pending-deposit-route';
import { PendingDepositRow } from './PendingDepositRow';

export interface PendingDepositHomeRowProps {
  accountPublicKey: string;
  className?: string;
}

/**
 * The Home row of the newest pending deposit of the account (mock-up `.pend` in `viewHome`), under the Deposit and
 * Withdraw tiles. It shows nothing while the list loads, when the account has no pending deposit, and when the relay
 * does not serve the deposit's chain. A tap opens the deposit screen on that deposit.
 */
export const PendingDepositHomeRow: FC<PendingDepositHomeRowProps> = props => (
  // The list read suspends once. The fallback is empty, so Home does not move while it loads.
  <Suspense fallback={null}>
    <NewestPendingDeposit {...props} />
  </Suspense>
);

const NewestPendingDeposit: FC<PendingDepositHomeRowProps> = ({ accountPublicKey, className }) => {
  const deposits = usePendingRelayDeposits(accountPublicKey);
  const snapshot = useBridgeConfigSnapshot({ load: false });
  // The list is newest first.
  const deposit = servedPendingDeposits(deposits, snapshot)[0];
  if (deposit === undefined) return null;
  // Keyed by the deposit, so a new deposit does not show the arrival state of the one before it.
  return <PendingDepositRowContainer key={deposit.id} deposit={deposit} className={className} />;
};

const PendingDepositRowContainer: FC<{ deposit: PendingRelayDeposit; className?: string }> = ({
  deposit,
  className
}) => {
  // It reads only while Home is the page on screen (`useRelayAccount` gates on `usePageActive`).
  const arrival = useDepositArrival(deposit);
  return (
    <PendingDepositRow
      state={arrival.state === 'arrived' ? 'received' : 'waiting'}
      amount={{ amount: BigInt(deposit.amountBaseUnits), decimals: deposit.token.decimals }}
      symbol={deposit.token.symbol}
      networkName={depositNetworkName(deposit.chainId)}
      onClick={() => navigate(pendingDepositPath(deposit.id))}
      className={className}
    />
  );
};
