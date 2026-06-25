import React, { FC, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { IBridgeProvider, IBridgedSendExtraInputs, ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { Badge } from 'lib/ui/badge';
import { truncateAddress, truncateHash } from 'utils/string';

interface TransactionSuccessProps {
  transaction?: ITransaction;
  txHash?: string | null;
  onDoneClick: () => void;
  onViewExplorer?: () => void;
}

interface ReceiptRow {
  label: string;
  value: string;
  onClick?: () => void;
}

const SUCCESS_GREEN = '#009B50';
const SUCCESS_GREEN_ACCENT = '#0EAA51';

const isBridgedSendExtraInputs = (value: unknown): value is IBridgedSendExtraInputs => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<IBridgedSendExtraInputs>;
  return (
    typeof candidate.destinationAddress === 'string' &&
    typeof candidate.destinationNetwork === 'number' &&
    (candidate.provider === 'epoch' || candidate.provider === 'agglayer')
  );
};

const routeBadgeLabel = (provider?: IBridgeProvider) => {
  if (!provider) return undefined;
  return provider === 'epoch' ? 'FAST' : 'SLOW';
};

export const TransactionSuccess: FC<TransactionSuccessProps> = ({
  transaction,
  txHash,
  onDoneClick,
  onViewExplorer
}) => {
  const { t } = useTranslation();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata) ?? {};
  const bridgedInputs = isBridgedSendExtraInputs(transaction?.extraInputs) ? transaction.extraInputs : undefined;

  const tokenMetadata = transaction?.faucetId ? assetsMetadata[transaction.faucetId] : undefined;
  const tokenSymbol = tokenMetadata?.symbol ?? MIDEN_METADATA.symbol ?? 'MDN';
  const amount =
    transaction?.amount !== undefined ? formatAmount(transaction.amount, tokenMetadata?.decimals) : undefined;
  const amountText = amount ? `${amount} ${tokenSymbol}` : undefined;
  const destinationAddress = bridgedInputs?.destinationAddress ?? transaction?.secondaryAccountId;
  const badgeLabel = routeBadgeLabel(bridgedInputs?.provider);

  const receiptRows = useMemo<ReceiptRow[]>(() => {
    const rows: ReceiptRow[] = [];

    if (destinationAddress) {
      rows.push({
        label: t('to'),
        value: truncateAddress(destinationAddress, true, 6, 4, 4)
      });
    }

    if (amountText) {
      rows.push({
        label: t('totalPaid', { defaultValue: 'Total Paid' }),
        value: amountText
      });
    }

    if (txHash) {
      rows.push({
        label: t('sourceTx', { defaultValue: 'Source TX' }),
        value: truncateHash(txHash, 6, 4),
        onClick: onViewExplorer
      });
    }

    return rows;
  }, [amountText, destinationAddress, onViewExplorer, t, txHash]);

  return (
    <div className="flex flex-col overflow-y-auto bg-app-bg px-4 text-heading-gray">
      <ScreenHeader title={t('success', { defaultValue: 'Success!' })} closeLabel={t('close')} onClose={onDoneClick} />

      <main className="flex min-h-0 flex-1 flex-col justify-center">
        <section className="flex flex-1 flex-col items-center pt-10.75">
          <div
            className="flex size-32 items-center justify-center rounded-[34px] border-2 border-[#44B474]"
            style={{ backgroundColor: SUCCESS_GREEN }}
            aria-hidden="true"
          >
            <div
              className="flex size-17.5 items-center justify-center rounded-full"
              style={{ backgroundColor: SUCCESS_GREEN_ACCENT }}
            >
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M12 25.5L20.25 33.75L36 16.5"
                  stroke="white"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          <h2 className="mt-8 w-full text-center text-[32px] font-bold leading-[1.16] text-heading-gray">
            {t('transactionComplete', { defaultValue: 'Transaction Complete!' })}
          </h2>

          {amountText && (
            <div className="mt-10 flex w-full flex-col items-center">
              <div className="font-heading text-center text-[32px] font-bold leading-none text-heading-gray">
                {amountText}
              </div>

              {bridgedInputs && (
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-xs leading-none text-[#8E8E93]">
                  <span>{t('arrivingOnNetwork', { defaultValue: 'Arriving on Ethereum' })}</span>
                  {badgeLabel && (
                    <Badge
                      size="xs"
                      variant="secondary"
                      className="rounded-md bg-[#EEEEF0] font-bold leading-none text-heading-gray"
                    >
                      {badgeLabel}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          )}

          {receiptRows.length > 0 && (
            <div className="mt-4 w-full">
              {receiptRows.map((row, index) => (
                <div
                  key={row.label}
                  className={classNames(
                    'flex h-14 items-center justify-between w-full',
                    index < receiptRows.length - 1 && 'border-b border-border-faint'
                  )}
                >
                  <span className="text-sm font-regular leading-tight text-[#8E8E93]">{row.label}</span>
                  {row.onClick ? (
                    <button
                      type="button"
                      aria-label={t('viewOnMidenscan')}
                      onClick={row.onClick}
                      className="min-w-0 bg-transparent p-0 text-right text-sm font-bold leading-tight text-black underline-offset-2 hover:underline"
                    >
                      {row.value}
                    </button>
                  ) : (
                    <span className="min-w-0 text-right text-sm font-bold leading-tight text-black">{row.value}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="w-full shrink-0 px-1 pt-6">
          <p className="text-center text-base font-regular text-[#808080] mb-4">{t('transactionSuccessDescription')}</p>
          <Button type="button" variant={ButtonVariant.Primary} onClick={onDoneClick} className="w-full">
            {t('done')}
          </Button>
        </div>
      </main>
    </div>
  );
};
