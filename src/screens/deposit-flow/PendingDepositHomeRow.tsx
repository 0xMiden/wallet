import React, { FC, Suspense } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { type PendingRelayDeposit, usePendingRelayDeposits } from 'lib/evm-relay/pending-deposit';
import { useDepositArrival } from 'lib/evm-relay/use-deposit-arrival';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { navigate } from 'lib/woozie';
import { nearIntentsChainName, nearIntentsSentValue } from 'screens/near-intents-flow/deposit-display';
import { depositDeadlineMs } from 'screens/near-intents-flow/deposit-status';

import {
  type NearDepositRecord,
  nearDepositHomeStateOf,
  useNearDeposits,
  useNowAtDeadlines
} from './near-pending-deposits';
import {
  depositNetworkName,
  nearIntentsDepositPath,
  pendingDepositPath,
  servedPendingDeposits
} from './pending-deposit-route';
import { PendingDepositRow } from './PendingDepositRow';

export interface PendingDepositHomeRowProps {
  accountPublicKey: string;
  className?: string;
}

/**
 * The Home row of the newest waiting deposit of the account (mock-up `.pend` in `viewHome`), under the Deposit and
 * Withdraw tiles. It takes the newest of two kinds: a pending relay deposit on a chain that the relay serves, and a
 * NEAR Intents deposit whose address waits for the funds and did not expire, or whose funds 1Click saw and bridges.
 * It shows nothing while the relay list loads and when the account has neither. A tap opens the deposit screen of
 * that deposit.
 */
export const PendingDepositHomeRow: FC<PendingDepositHomeRowProps> = props => (
  // The relay list read suspends once. The fallback is empty, so Home does not move while it loads.
  <Suspense fallback={null}>
    <NewestPendingDeposit {...props} />
  </Suspense>
);

/** One waiting deposit of either kind, with its start time in Unix milliseconds. */
type WaitingDeposit =
  | { kind: 'relay'; startedAt: number; deposit: PendingRelayDeposit }
  | { kind: 'near'; startedAt: number; record: NearDepositRecord; received: boolean };

const NewestPendingDeposit: FC<PendingDepositHomeRowProps> = ({ accountPublicKey, className }) => {
  const deposits = usePendingRelayDeposits(accountPublicKey);
  const snapshot = useBridgeConfigSnapshot({ load: false });
  // The NEAR rows are read only while Home is the page on screen.
  const nearDeposits = useNearDeposits(accountPublicKey, usePageActive());
  const now = useNowAtDeadlines(nearDeposits.map(record => depositDeadlineMs(record.tracking)));

  const candidates: WaitingDeposit[] = [];
  // The relay list is newest first.
  const relay = servedPendingDeposits(deposits, snapshot)[0];
  if (relay !== undefined) candidates.push({ kind: 'relay', startedAt: relay.createdAt, deposit: relay });
  for (const record of nearDeposits) {
    const state = nearDepositHomeStateOf(record.tracking, now);
    if (state === null) continue;
    // The NEAR list is newest first: the first one that Home shows is the newest.
    candidates.push({ kind: 'near', startedAt: record.startedAt, record, received: state === 'received' });
    break;
  }
  const newest = candidates.sort((left, right) => right.startedAt - left.startedAt)[0];
  if (newest === undefined) return null;
  switch (newest.kind) {
    case 'relay':
      // Keyed by the deposit, so a new deposit does not show the arrival state of the one before it.
      return <PendingDepositRowContainer key={newest.deposit.id} deposit={newest.deposit} className={className} />;
    case 'near':
      return <NearDepositRow record={newest.record} received={newest.received} className={className} />;
  }
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

/** The row of a NEAR Intents deposit: the quoted amount and the origin chain. A tap opens its deposit page. */
const NearDepositRow: FC<{ record: NearDepositRecord; received: boolean; className?: string }> = ({
  record,
  received,
  className
}) => (
  <PendingDepositRow
    state={received ? 'received' : 'waiting'}
    amount={nearIntentsSentValue(record.tracking)}
    symbol={record.tracking.originAsset.symbol}
    networkName={nearIntentsChainName(record.tracking)}
    onClick={() => navigate(nearIntentsDepositPath(record.id))}
    className={className}
  />
);
