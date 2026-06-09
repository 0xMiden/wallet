import React, { FC, useCallback, useEffect, useState, memo } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { getTransactionById } from 'lib/miden/activity';
import { IBridgedSendExtraInputs } from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import {
  BridgeStatus,
  bridgeStatusOf,
  fontColorForType,
  formatBridgeOutputAmount,
  formatDate
} from './transactionUtils';

const formatUsd = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

const BRIDGE_PILL_STYLE: Record<BridgeStatus, { bg: string; text: string; dot: string; labelKey: string }> = {
  pending: { bg: 'bg-[#FBEEDD]', text: 'text-[#E8913A]', dot: 'bg-[#E8913A]', labelKey: 'pending' },
  confirmed: { bg: 'bg-[#DAF1E2]', text: 'text-[#1A9C52]', dot: 'bg-[#1A9C52]', labelKey: 'confirmed' },
  failed: { bg: 'bg-[#FBE3E3]', text: 'text-[#DC2626]', dot: 'bg-[#DC2626]', labelKey: 'bridgeFailed' }
};

const BridgeStatusPill: FC<{ status: BridgeStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const s = BRIDGE_PILL_STYLE[status];
  return (
    <div className={clsx('flex items-center gap-1.5 px-3 py-1 rounded-5', s.bg)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', s.dot)} />
      <span className={clsx('text-xs font-medium', s.text)}>{t(s.labelKey)}</span>
    </div>
  );
};

/** Swap-style hero for a `bridged-send`: "IN → OUT" with greyed symbols, USD, status. */
const BridgeHero: FC<{ entry: IHistoryEntry; tokenPrices: TokenPrices }> = ({ entry, tokenPrices }) => {
  const inSymbol = entry.token ?? '—';
  const outSymbol = entry.bridgeOutputSymbol ?? (entry.bridgeProvider === 'agglayer' ? 'ETH' : 'USDC');
  const inAmount = entry.amount?.toString() ?? '—';
  const outAmount = formatBridgeOutputAmount(entry.bridgeOutputAmount) ?? inAmount;
  const { price } = getTokenPrice(tokenPrices, inSymbol);
  const usdValue = Number(entry.amount ?? '0') * price;

  return (
    <div className="flex flex-col items-center justify-center pt-4 pb-6 border-b border-[#BABABA33]">
      <TransactionIcon entry={entry} size="lg" />
      <div className="flex items-center gap-2 flex-wrap justify-center leading-none">
        <span className="text-5xl font-extrabold text-heading-gray">{inAmount}</span>
        <span className="text-3xl font-extrabold text-[#B5B5BD]">{inSymbol}</span>
        <Icon name={IconName.ArrowRight} size="md" className="mx-0.5" fill="#1A1A1A" />
        <span className="text-5xl font-extrabold text-heading-gray">{outAmount}</span>
        <span className="text-3xl font-extrabold text-[#B5B5BD]">{outSymbol}</span>
      </div>
      {usdValue > 0 && <p className="mt-2 text-sm text-heading-gray">≈ {formatUsd(usdValue)}</p>}
      <div className="mt-2">
        <BridgeStatusPill status={bridgeStatusOf(entry)} />
      </div>
    </div>
  );
};

interface HistoryDetailsProps {
  transactionId: string;
}

const AccountDisplay: FC<{
  address: string | undefined;
  account: WalletAccount;
  allAccounts: WalletAccount[];
}> = memo(({ address, account, allAccounts }) => {
  const { t } = useTranslation();
  if (!address) return null;

  const getDisplayName = (publicKey: string): string | undefined => {
    if (account?.publicKey === publicKey) {
      return `${t('you')} (${account.name})`;
    }
    const matchingAccount = allAccounts.find(acc => acc.publicKey === publicKey);
    if (matchingAccount) {
      return `${t('you')} (${matchingAccount.name})`;
    }
    return undefined;
  };

  return (
    <AddressChip
      address={address}
      fill="#9E9E9E"
      className="ml-2"
      displayName={getDisplayName(address)}
      copyIcon={false}
    />
  );
});

export const HistoryDetails: FC<HistoryDetailsProps> = ({ transactionId }) => {
  const { t } = useTranslation();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadTransaction = useCallback(async () => {
    try {
      setLoadError(null);
      const tx = await getTransactionById(transactionId);
      const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
      console.log('Loaded transaction for HistoryDetails:', tx, tokenMetadata);
      const bridge = tx.type === 'bridged-send' ? (tx.extraInputs as IBridgedSendExtraInputs | undefined) : undefined;
      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt,
        message: tx.displayMessage,
        transactionIcon: tx.displayIcon,
        amount: tx.amount ? formatAmount(tx.amount, tokenMetadata?.decimals) : undefined,
        token: tokenMetadata ? tokenMetadata.symbol : undefined,
        secondaryAddress: bridge?.destinationAddress ?? tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId,
        faucetId: tx.faucetId,
        outputNoteIds: tx.outputNoteIds,
        txType: tx.type,
        bridgeProvider: bridge?.provider,
        bridgeDestinationAddress: bridge?.destinationAddress,
        bridgeDestinationNetwork: bridge?.destinationNetwork,
        bridgeClaimStatus: bridge?.claimStatus,
        bridgeOutputAmount: bridge?.outputAmount,
        bridgeOutputSymbol: bridge?.outputSymbol,
        bridgeIntentNonce: bridge?.intentNonce,
        bridgeFillTxHash: bridge?.fillTxHash,
        bridgeFillChainId: bridge?.fillChainId,
        bridgeEpochStatus: bridge?.epochStatus
      } as IHistoryEntry;

      setEntry(historyEntry);
    } catch (error) {
      console.error('[HistoryDetails] Failed to load transaction:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load transaction');
    }
  }, [transactionId, setEntry]);

  useEffect(() => {
    if (!entry && !loadError) loadTransaction();
  }, [loadTransaction, entry, loadError]);

  const isBridge = entry?.txType === 'bridged-send';
  // For a bridge the sender is always the Miden account; the EVM destination is
  // shown in the BridgeClaimSection (with the right explorer link), so the Miden
  // "to" row is omitted here.
  const fromAddress = isBridge ? entry?.address : entry?.message === 'Sent' ? entry?.address : entry?.secondaryAddress;
  const toAddress = isBridge ? undefined : entry?.message === 'Sent' ? entry?.secondaryAddress : entry?.address;
  const hasNoteData = entry?.noteId || (entry?.outputNoteIds && entry.outputNoteIds.length > 0);
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);

  return (
    <PageLayout pageTitle={t('transaction')} hasBackAction={true}>
      {loadError ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
          <p className="text-gray-600 text-sm text-center select-text">{loadError}</p>
          <p className="text-gray-400 text-xs text-center mt-2 select-text">ID: {transactionId}</p>
        </div>
      ) : entry === null ? (
        <ActivitySpinner />
      ) : (
        <div className="flex-1 flex flex-col px-4 py-2 overflow-y-auto">
          {/* Top Section */}
          {isBridge ? (
            <BridgeHero entry={entry} tokenPrices={tokenPrices} />
          ) : (
            <div className="flex flex-col items-center justify-center pt-4 pb-6 border-b border-[#BABABA33]">
              <TransactionIcon entry={entry} size="lg" />
              <p className="text-sm text-heading-gray mt-3">{entry.message}</p>
              <p
                className={clsx(
                  'text-5xl font-semibold leading-none text-heading-gray',
                  fontColorForType(entry.txType)
                )}
              >
                {entry.amount?.toString()} {entry.token}
              </p>
              <div className="mt-1">
                <StatusPill message={entry.message} />
              </div>
            </div>
          )}

          {/* Transfer Details */}
          <div className="mt-4">
            <DetailCard title={t('transferDetails')}>
              <DetailRow label={t('date')}>
                <span className="text-sm text-heading-gray font-medium">{formatDate(entry.timestamp)}</span>
              </DetailRow>

              {entry.externalTxId && (
                <DetailRow label={t('txIdLabel')}>
                  <ExternalLinkValue
                    displayValue={
                      <HashChip hash={entry.externalTxId} trimHash fill="#9E9E9E" className="ml-2" copyIcon={false} />
                    }
                    href={`https://testnet.midenscan.com/tx/${entry.externalTxId}`}
                  />
                </DetailRow>
              )}

              {fromAddress && (
                <DetailRow label={t('from')} isLast={!toAddress}>
                  <ExternalLinkValue
                    displayValue={<AccountDisplay address={fromAddress} account={account} allAccounts={allAccounts} />}
                    href={`https://testnet.midenscan.com/account/${fromAddress}`}
                  />
                </DetailRow>
              )}

              {toAddress && (
                <DetailRow label={t('to')} isLast>
                  <ExternalLinkValue
                    displayValue={<AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />}
                    href={`https://testnet.midenscan.com/account/${toAddress}`}
                  />
                </DetailRow>
              )}
            </DetailCard>
          </div>

          {/* Bridge route + claim (bridged-send only) */}
          {isBridge && <BridgeClaimSection entry={entry} onUpdated={loadTransaction} />}

          {/* Notes */}
          {hasNoteData && (
            <div className="mt-6 mb-4">
              <DetailCard title={t('notesSection')}>
                <DetailRow label={t('created')}>
                  <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                </DetailRow>
                <DetailRow label="Note" isLast>
                  <span className={`text-sm font-medium ${entry.noteType ? 'text-[#E8913A]' : 'text-gray-400'}`}>
                    {entry.noteType ? t('on') : t('off')}
                  </span>
                </DetailRow>
              </DetailCard>
            </div>
          )}
        </div>
      )}
    </PageLayout>
  );
};
