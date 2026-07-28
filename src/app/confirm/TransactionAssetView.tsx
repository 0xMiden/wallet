import React, { useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';
import { formatAmount } from 'lib/shared/format';
import { truncateAddress } from 'utils/string';

import { AssetAmount, TxAssetView } from './decode';
import { Icon, IconName } from '../icons/v2';

export interface TransactionAssetViewProps {
  view: TxAssetView;
  mode: 'verified' | 'declared';
  /** Optional download handler (verified path exposes the raw summary bytes). */
  onDownload?: () => void;
}

interface ResolvedAsset {
  faucetId: string;
  amount: bigint;
  // Undefined when the metadata lookup failed (see Fix D: guarded against
  // fetchTokenMetadata rejecting) — callers fall back to the `unknown` label /
  // formatAmount's own decimals default.
  symbol: string | undefined;
  decimals: number | undefined;
}

function useResolvedAssets(assets: AssetAmount[]): ResolvedAsset[] {
  const [resolved, setResolved] = useState<ResolvedAsset[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = await Promise.all(
        assets.map(async a => {
          // fetchTokenMetadata checks the cache, then reads the faucet account
          // ON-CHAIN for its real symbol+decimals, degrading to the "Unknown"
          // default (never native MIDEN) on failure — so an unrecognized
          // faucet is never mislabeled as native MIDEN on this security screen.
          const md = await fetchTokenMetadata(a.faucetId)
            .then(r => r.base)
            .catch(() => ({ symbol: undefined, decimals: undefined }));
          return { faucetId: a.faucetId, amount: a.amount, symbol: md.symbol, decimals: md.decimals };
        })
      );
      if (!cancelled) setResolved(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [assets]);
  return resolved;
}

export const TransactionAssetView: React.FC<TransactionAssetViewProps> = ({ view, mode, onDownload }) => {
  const { t } = useTranslation();
  const outgoing = useResolvedAssets(view.outgoing);
  const incoming = useResolvedAssets(view.incoming);
  const hasAssets = view.outgoing.length > 0 || view.incoming.length > 0;
  const isVerified = mode === 'verified';

  return (
    <div className="flex flex-col items-center justify-center">
      {mode === 'declared' && (
        <span className="text-text-muted text-xs mb-2 self-start">{t('declaredBySiteVerifying')}</span>
      )}

      <div className="flex flex-col border border-gray-100 rounded-2xl mb-4 w-full p-4">
        {view.account && (
          <div
            className={`flex flex-row w-full items-center justify-between border-gray-100 ${
              hasAssets ? 'border-b pb-4' : ''
            }`}
          >
            <div className="flex flex-row text-md items-center gap-x-3">
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <span className="text-text-muted">{t('account')}</span>
            </div>
            <div>{truncateAddress(view.account)}</div>
          </div>
        )}

        {hasAssets && (
          <div className="flex flex-col w-full pt-4">
            <span className="text-text-muted">{t('assetChanges')}</span>
            {outgoing.map(a => (
              <div key={`out-${a.faucetId}`} className="flex flex-row items-baseline w-full my-2 text-sm">
                <span
                  className={classNames(
                    'font-heading text-lg mr-1',
                    isVerified ? 'text-black-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  aria-hidden="true"
                >
                  -
                </span>
                <span
                  className={classNames(
                    'font-heading text-lg',
                    isVerified ? 'text-black-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  data-verified={isVerified ? 'true' : 'false'}
                >{`${formatAmount(a.amount, a.decimals)} ${a.symbol ?? t('unknown')}`}</span>
                {!isVerified && <span className="text-text-muted text-xs ml-2">{t('unverified')}</span>}
              </div>
            ))}
            {incoming.map(a => (
              <div key={`in-${a.faucetId}`} className="flex flex-row items-baseline w-full my-2 text-sm">
                <span
                  className={classNames(
                    'font-heading text-lg mr-1',
                    isVerified ? 'text-green-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  aria-hidden="true"
                >
                  +
                </span>
                <span
                  className={classNames(
                    'font-heading text-lg',
                    isVerified ? 'text-green-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  data-verified={isVerified ? 'true' : 'false'}
                >{`${formatAmount(a.amount, a.decimals)} ${a.symbol ?? t('unknown')}`}</span>
                {!isVerified && <span className="text-text-muted text-xs ml-2">{t('unverified')}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col w-full border-b border-gray-100 pb-4">
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('inputNotesConsumed')}</span>
          <span>{view.inputNotesConsumed}</span>
        </div>
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('outputNotesCreated')}</span>
          <span>{view.outputNotesCreated}</span>
        </div>
        {mode === 'verified' && (
          <div className="flex flex-row w-full items-center justify-between">
            <span className="text-text-muted">{t('storageChanged')}</span>
            {view.storageChanged ? (
              <div className="flex flex-row items-center gap-x-2">
                <Icon name={IconName.WarningFill} fill="orange" size="md" />
                <span>{t('yes')}</span>
              </div>
            ) : (
              <span>{t('no')}</span>
            )}
          </div>
        )}
      </div>

      {onDownload && (
        <Button
          type="button"
          variant={ButtonVariant.Ghost}
          className={classNames(
            'w-full mt-2',
            'rounded-4xl hover:rounded-4xl',
            'transition-all duration-200 ease-in-out',
            'hover:bg-gray-100',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300',
            'py-4 px-0'
          )}
          onClick={onDownload}
        >
          <span className="flex flex-row items-center justify-center gap-x-2">
            <Icon name={IconName.Download} fill="currentColor" size="md" />
            <span className="text-lg text-black font-medium">{t('downloadFullSummary')}</span>
          </span>
        </Button>
      )}
    </div>
  );
};
