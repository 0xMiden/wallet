import React, { FC, useCallback, useEffect, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import PageLayout from 'app/layouts/PageLayout';
import { ScreenHeader } from 'components/ScreenHeader';
import { getTransactionById } from 'lib/miden/activity';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { goBack } from 'lib/woozie';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import TransactionIcon from './TransactionIcon';
import { formatDate } from './transactionUtils';

interface HistoryDetailsProps {
  transactionId: string;
}

const DISPLAY_DECIMAL_PLACES = 3;

function formatDisplayAmount(amount: string | number | bigint): string {
  const amountString = amount.toString();
  const displayAmount = new BigNumber(amountString);

  if (!displayAmount.isFinite()) {
    return amountString;
  }

  return displayAmount.decimalPlaces(DISPLAY_DECIMAL_PLACES, BigNumber.ROUND_DOWN).toFixed();
}

function formatFiatDisplayAmount(
  amount: string | number | bigint,
  tokenSymbol: string,
  tokenPrices: TokenPrices
): string | undefined {
  const displayAmount = new BigNumber(amount.toString());

  if (!displayAmount.isFinite()) {
    return undefined;
  }

  const { price } = getTokenPrice(tokenPrices, tokenSymbol);
  const fiatAmount = displayAmount.abs().times(price);

  return `≈ $${fiatAmount.toFixed(2)} USD`;
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
      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt,
        message: tx.displayMessage,
        transactionIcon: tx.displayIcon,
        amount: tx.amount ? formatAmount(tx.amount, tokenMetadata?.decimals) : undefined,
        token: tokenMetadata ? tokenMetadata.symbol : undefined,
        secondaryAddress: tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId,
        faucetId: tx.faucetId,
        outputNoteIds: tx.outputNoteIds,
        txType: tx.type
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

  const fromAddress = entry?.message === 'Sent' ? entry?.address : entry?.secondaryAddress;
  const toAddress = entry?.message === 'Sent' ? entry?.secondaryAddress : entry?.address;
  const hasNoteData = entry?.noteId || (entry?.outputNoteIds && entry.outputNoteIds.length > 0);
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);
  const approximateUsdAmount =
    entry?.amount !== undefined && entry.token
      ? formatFiatDisplayAmount(entry.amount, entry.token, tokenPrices)
      : undefined;

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-1 flex-col min-h-0 px-4">
        <ScreenHeader title={t('transaction')} backLabel={t('back')} onBack={goBack} />

        {loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
            <p className="text-text-muted text-sm text-center select-text">{loadError}</p>
            <p className="text-text-muted text-xs text-center mt-2 select-text">ID: {transactionId}</p>
          </div>
        ) : entry === null ? (
          <ActivitySpinner />
        ) : (
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Top Section */}
            <div className="flex flex-col items-center justify-center pt-6 pb-5">
              <TransactionIcon entry={entry} size="lg" />
              <div className="mt-1 flex max-w-full items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
                {entry.amount !== undefined && (
                  <span className="text-heading-gray">{formatDisplayAmount(entry.amount)}</span>
                )}
                {entry.token && <span className="text-text-muted">{entry.token}</span>}
              </div>
              {approximateUsdAmount && <p className="text-sm font-medium text-gray">{approximateUsdAmount}</p>}
              <div className="mt-2">
                <StatusPill message={entry.message} />
              </div>
            </div>

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
                  <DetailRow label={t('from')}>
                    <ExternalLinkValue
                      displayValue={
                        <AccountDisplay address={fromAddress} account={account} allAccounts={allAccounts} />
                      }
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

            {/* Notes */}
            {hasNoteData && (
              <div className="mt-6 mb-4">
                <DetailCard title={t('notesSection')}>
                  <DetailRow label={t('created')}>
                    <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                  </DetailRow>
                  <DetailRow label="Note" isLast>
                    <span className={`text-sm font-medium ${entry.noteType ? 'text-[#E8913A]' : 'text-text-muted'}`}>
                      {entry.noteType ? t('on') : t('off')}
                    </span>
                  </DetailRow>
                </DetailCard>
              </div>
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
};
