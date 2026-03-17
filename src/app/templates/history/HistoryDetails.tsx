import React, { FC, useCallback, useEffect, useState, memo } from 'react';

import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { getCurrentLocale } from 'lib/i18n';
import { getTransactionById } from 'lib/miden/activity';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { NoteExportType } from 'lib/miden/sdk/constants';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension } from 'lib/platform';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { capitalizeFirstLetter } from 'utils/string';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { IHistoryEntry } from './IHistoryEntry';

interface HistoryDetailsProps {
  transactionId: string;
}

const StatusDisplay: FC<{ message: string }> = memo(({ message }) => {
  const { t } = useTranslation();
  let displayTextKey = '';
  let textColorClass = '';

  const isCompleted = message === 'Sent' || message === 'Received';

  if (isCompleted) {
    displayTextKey = 'completed';
    textColorClass = 'text-green-500';
  } else {
    displayTextKey = 'inProgress';
    textColorClass = 'text-blue-500';
  }

  return <p className={`text-sm ${textColorClass}`}>{t(displayTextKey)}</p>;
});

const AccountDisplay: FC<{
  address: string | undefined;
  account: WalletAccount;
  allAccounts: WalletAccount[];
}> = memo(({ address, account, allAccounts }) => {
  const { t } = useTranslation();
  if (!address) return <p className="text-sm">{address}</p>;

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
  const displayName = getDisplayName(address);

  return <AddressChip address={address} fill="#9E9E9E" className="ml-2" displayName={displayName} />;
});

export const HistoryDetails: FC<HistoryDetailsProps> = ({ transactionId }) => {
  const { t } = useTranslation();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTransaction = useCallback(async () => {
    try {
      setLoadError(null);
      const tx = await getTransactionById(transactionId);
      const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;

      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt,
        message: tx.displayMessage,
        transactionIcon: tx.displayIcon,
        amount: tx.amount ? formatAmount(tx.amount, tx.type, tokenMetadata?.decimals) : undefined,
        token: tokenMetadata ? tokenMetadata.symbol : undefined,
        secondaryAddress: tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId
      } as IHistoryEntry;

      setEntry(historyEntry);
    } catch (error) {
      console.error('[HistoryDetails] Failed to load transaction:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load transaction');
    }
  }, [transactionId, setEntry]);

  const handleDownload = useCallback(async () => {
    if (!entry?.noteId) return;

    try {
      setIsDownloading(true);

      let noteBytes: Uint8Array;

      if (isExtension()) {
        // On extension, route through SW via intercom
        const res = await getIntercom().request({
          type: WalletMessageType.ExportNoteRequest,
          noteId: entry.noteId!
        });
        if (!res || !('noteBytes' in res)) {
          throw new Error('Failed to export note via intercom');
        }
        noteBytes = new Uint8Array(Buffer.from((res as any).noteBytes, 'base64'));
      } else {
        // Wrap WASM client operations in a lock to prevent concurrent access
        noteBytes = await withWasmClientLock(async () => {
          const midenClient = await getMidenClient();
          return midenClient.exportNote(entry.noteId!, NoteExportType.DETAILS);
        });
      }

      const ab = new ArrayBuffer(noteBytes.byteLength);
      new Uint8Array(ab).set(noteBytes);

      const blob = new Blob([ab], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `midenNote${entry.noteId.slice(0, 6)}.mno`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export note:', error);
    } finally {
      setIsDownloading(false);
    }
  }, [entry?.noteId]);

  const handleViewOnExplorer = useCallback(() => {
    if (!entry?.externalTxId) return;
    window.open(`https://testnet.midenscan.com/tx/${entry.externalTxId}`, '_blank');
  }, [entry]);

  useEffect(() => {
    if (!entry && !loadError) loadTransaction();
  }, [loadTransaction, entry, loadError]);

  const showDownloadButton = entry?.message === 'Sent' && entry?.noteType === 'private' && entry?.noteId;
  const fromAddress = entry?.message === 'Sent' ? entry?.address : entry?.secondaryAddress;
  const toAddress = entry?.message === 'Sent' ? entry?.secondaryAddress : entry?.address;

  return (
    <PageLayout pageTitle={entry?.message || t('historyDetails')} hasBackAction={true}>
      {loadError ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
          <p className="text-gray-600 text-sm text-center select-text">{loadError}</p>
          <p className="text-gray-400 text-xs text-center mt-2 select-text">ID: {transactionId}</p>
        </div>
      ) : entry === null ? (
        <ActivitySpinner />
      ) : (
        <div className="flex-1 flex flex-col">
          <div className="flex flex-col flex-1 py-2 px-4 justify-between md:w-[460px] md:mx-auto">
            <div className="flex flex-col gap-y-4">
              <div className="flex flex-col items-center justify-center mb-8">
                <p className="text-4xl font-semibold leading-tight">{entry.amount}</p>
                <p className="text-base leading-normal text-gray-600">{entry.token}</p>
              </div>

              <div className="flex flex-col gap-y-2">
                <span className="flex flex-row justify-between">
                  <label className="text-sm text-grey-600">{t('status')}</label>
                  <StatusDisplay message={entry.message} />
                </span>
                <span className="flex flex-row justify-between whitespace-pre-line">
                  <label className="text-sm text-grey-600">{t('timestamp')}</label>
                  <p className="text-sm text-right">{formatDate(entry.timestamp)}</p>
                </span>
              </div>

              <hr className="h-px bg-grey-100" />

              <div className="flex flex-col gap-y-2">
                <span className="flex flex-row justify-between">
                  <label className="text-sm text-grey-600">{t('from')}</label>
                  <AccountDisplay address={fromAddress} account={account} allAccounts={allAccounts} />
                </span>
                <span className="flex flex-row justify-between whitespace-pre-line">
                  <label className="text-sm text-grey-600">{t('to')}</label>
                  <AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />
                </span>
              </div>

              <hr className="h-px bg-grey-100" />

              {entry.noteType && (
                <div className="flex flex-col gap-y-2">
                  <span className="flex flex-row justify-between">
                    <label className="text-sm text-grey-600">{t('noteType')}</label>
                    <p className="text-sm">{capitalizeFirstLetter(entry.noteType)}</p>
                  </span>
                </div>
              )}
              {entry.noteId && (
                <div className="flex flex-col gap-y-2">
                  <span className="flex flex-row justify-between">
                    <label className="text-sm text-grey-600">{t('noteId')}</label>
                    <HashChip hash={entry.noteId || ''} trimHash={true} fill="#9E9E9E" className="ml-2" />
                  </span>
                </div>
              )}
            </div>

            <div className="mb-4">
              {showDownloadButton && (
                <div className="w-full">
                  <Button
                    title={t('downloadGeneratedFile')}
                    iconLeft={IconName.Download}
                    variant={ButtonVariant.Ghost}
                    className="flex-1 w-full"
                    onClick={handleDownload}
                    isLoading={isDownloading}
                    disabled={isDownloading}
                  />
                </div>
              )}
              <div className="mt-2 w-full">
                <Button
                  title={t('viewOnExplorer')}
                  iconLeft={IconName.Globe}
                  variant={ButtonVariant.Secondary}
                  className="flex-1 w-full"
                  onClick={handleViewOnExplorer}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
};

const formatDate = (timestamp: number | string): string => {
  let date: Date;

  if (typeof timestamp === 'number') {
    // Ensure the timestamp is in milliseconds
    date = new Date(timestamp * 1000);
  } else if (typeof timestamp === 'string') {
    // Attempt to parse string as number if possible
    const numericTimestamp = parseFloat(timestamp);
    if (!isNaN(numericTimestamp)) {
      date = new Date(numericTimestamp * 1000);
    } else {
      date = new Date(timestamp);
    }
  } else {
    return 'Invalid Date';
  }

  // Check if the date is valid
  if (isNaN(date.getTime())) {
    console.error('Invalid Date', timestamp);
    return 'Invalid Date';
  }

  // Convert locale from underscore format (en_GB) to BCP 47 hyphen format (en-GB)
  const currentLanguage = getCurrentLocale()?.replace('_', '-') || 'en';

  const datePart = date.toLocaleString(currentLanguage, {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  });

  const timePart = date.toLocaleString(currentLanguage, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  return `${datePart}, ${timePart}`;
};
