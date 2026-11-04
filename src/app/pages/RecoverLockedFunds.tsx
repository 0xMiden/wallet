import React, { FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { Icon, IconName } from 'app/icons/v2';
import { shortenAddress } from 'app/templates/EvmConnectModal/shared';
import { Button, ButtonVariant } from 'components/Button';
import { EmptyState } from 'components/ui/EmptyState';
import { ErrorLine } from 'components/ui/ErrorLine';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Skeleton } from 'components/ui/Skeleton';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import {
  type AddressLockScan,
  collectBridgeInSponsors,
  type LockScanEntry,
  lockScanAddresses,
  scanLockedBridgeFunds
} from 'lib/epoch/bridge-in-lock-scan';
import { useLockRescanGeneration } from 'lib/epoch/lock-scan-refresh';
import { getChain } from 'lib/walletconnect/config';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { useEvmWalletPicker } from 'lib/walletconnect/useEvmWalletPicker';

import { recoverFundsLockPath } from './recover-funds-paths';

// While a rescan runs, the page keeps the results of the scan before it, so the list does not jump.
type ScanState = { status: 'loading'; results?: AddressLockScan[] } | { status: 'done'; results: AddressLockScan[] };

const networkName = (chainId: number): string => getChain(chainId)?.name ?? String(chainId);

/** A lock that holds funds: a read that worked, a known lock id and a balance above zero. */
type HeldEntry = LockScanEntry & { lockId: string; read: { state: 'ok'; balance: bigint } };

const isHeld = (entry: LockScanEntry): entry is HeldEntry =>
  entry.lockId !== undefined && entry.read.state === 'ok' && entry.read.balance > 0n;

/** The networks with a failed read, each with the symbols that could not be checked there. */
function failedReadsByNetwork(entries: readonly LockScanEntry[]): { chainId: number; symbols: string[] }[] {
  const byChain = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.read.state !== 'failed') continue;
    byChain.set(entry.chainId, [...(byChain.get(entry.chainId) ?? []), entry.token.symbol]);
  }
  return [...byChain].map(([chainId, symbols]) => ({ chainId, symbols }));
}

const ScanSkeleton: FC = () => (
  <div aria-hidden="true" className="flex flex-col gap-3" data-testid="recover-funds-loading">
    <Skeleton className="h-5 w-32" />
    <Skeleton className="h-16 w-full rounded-2xl" />
    <Skeleton className="h-16 w-full rounded-2xl" />
  </div>
);

const AddressSection: FC<{ scan: AddressLockScan; connected: boolean }> = ({ scan, connected }) => {
  const { t } = useTranslation();
  const held = scan.entries.filter(isHeld);
  const failed = failedReadsByNetwork(scan.entries);
  const nothingLocked = held.length === 0 && failed.length === 0;
  return (
    <SubPageSection
      title={shortenAddress(scan.address)}
      icon={<Icon name={IconName.Wallet} fill="currentColor" />}
      description={connected ? t('recoverFundsConnectedWallet') : undefined}
      footnote={nothingLocked ? t('recoverFundsNothingLocked') : undefined}
      data-testid={`recover-funds-address-${scan.address}`}
    >
      {held.length > 0 && (
        <ListGroup surface="plain">
          {held.map(entry => (
            <ListRow
              key={`${entry.chainId}:${entry.lockId}`}
              title={`${formatUnits(entry.read.balance, entry.token.decimals)} ${entry.token.symbol}`}
              subtitle={networkName(entry.chainId)}
              to={recoverFundsLockPath({ sponsorAddress: scan.address, chainId: entry.chainId, lockId: entry.lockId })}
              chevron
              data-testid="recover-funds-lock"
            />
          ))}
        </ListGroup>
      )}
      {failed.map(({ chainId, symbols }) => (
        <ErrorLine key={chainId} role="note" data-testid="recover-funds-unknown">
          {t('recoverFundsCouldNotCheck', { network: networkName(chainId), tokens: symbols.join(', ') })}
        </ErrorLine>
      ))}
    </SubPageSection>
  );
};

/**
 * Settings, Recover locked bridge funds: scan The Compact for Fast bridge-in funds of every EVM address that made a
 * Fast bridge-in from this wallet, and of the connected EVM wallet. A deposit stays in The Compact when Epoch refuses
 * its allocation, and the history row that tracks it can be missing, so this page finds the funds from the chain.
 */
const RecoverLockedFunds: FC = () => {
  const { t } = useTranslation();
  const { address, connected } = useEvmWalletConnection();
  const { openWalletPicker, error: pickerError } = useEvmWalletPicker();
  const generation = useLockRescanGeneration();
  const connectedAddress = connected ? address : undefined;
  const [scan, setScan] = useState<ScanState>({ status: 'loading' });

  // Scan again when the connected wallet changes and after every recovery action.
  useEffect(() => {
    let cancelled = false;
    setScan(previous => ({ status: 'loading', results: previous.results }));
    const run = async () => {
      const sponsors = await collectBridgeInSponsors().catch((err: unknown) => {
        console.warn('[RecoverLockedFunds] bridge-in rows read failed', err);
        return [];
      });
      const results = await scanLockedBridgeFunds(lockScanAddresses(connectedAddress, sponsors));
      if (!cancelled) setScan({ status: 'done', results });
    };
    run().catch((err: unknown) => {
      console.error('[RecoverLockedFunds] scan failed', err);
      if (!cancelled) setScan({ status: 'done', results: [] });
    });
    return () => {
      cancelled = true;
    };
  }, [connectedAddress, generation]);

  const results = scan.results;
  const lowerConnected = connectedAddress?.toLowerCase();

  return (
    <SubPageLayout
      data-testid="recover-funds"
      footer={
        <Button
          variant={ButtonVariant.Secondary}
          title={connected ? t('recoverFundsConnectAnother') : t('connectEvmWallet')}
          onClick={openWalletPicker}
          data-testid="recover-funds-connect"
          className="w-full max-w-none"
        />
      }
    >
      <SubPageSection description={t('recoverFundsDescription')}>
        <ErrorLine>{pickerError}</ErrorLine>
      </SubPageSection>
      {results === undefined && <ScanSkeleton />}
      {results !== undefined && results.length === 0 && (
        <EmptyState
          icon={IconName.Wallet}
          title={t('recoverFundsNoAddressesTitle')}
          description={t('recoverFundsNoAddressesBody')}
          data-testid="recover-funds-empty"
        />
      )}
      {results?.map(result => (
        <AddressSection
          key={result.address}
          scan={result}
          connected={result.address.toLowerCase() === lowerConnected}
        />
      ))}
    </SubPageLayout>
  );
};

export default RecoverLockedFunds;
