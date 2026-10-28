import React, { useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import type { StoryHop } from 'components/tx-stage/tx-story';
import { TxStory } from 'components/tx-stage/TxStory';
import { Card } from 'components/ui/Card';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { formatAmount } from 'lib/shared/format';
import { truncateAddress } from 'utils/string';

import { AssetAmount, NftAsset, TxAssetView } from './decode';
import type { NoteFlow } from './note-flow';
import { loadConfirmationTokenMetadata, TransactionNoteFlow } from './TransactionNoteFlow';
import { Icon, IconName } from '../icons/v2';

export interface TransactionAssetViewProps {
  view: TxAssetView;
  mode: 'verified' | 'declared';
  /** Optional download handler (verified path exposes the raw summary bytes). */
  onDownload?: () => void;
  noteFlow?: NoteFlow;
}

interface ResolvedAsset {
  faucetId: string;
  amount: bigint;
  // Undefined when the metadata lookup failed (see Fix D: guarded against
  // fetchTokenMetadata rejecting) — callers fall back to the `unknown` label /
  // formatAmount's own decimals default.
  symbol: string | undefined;
  decimals: number | undefined;
  /**
   * False when the lookup failed or returned the unknown-token placeholder.
   *
   * This is a security screen: the user decides whether to approve a transfer
   * from what it says. Formatting an unreadable faucet at the placeholder's
   * guessed 6 decimals shows an authoritative quantity that can be off by a
   * factor of a trillion, on the one screen where being wrong costs money.
   */
  scaleIsKnown: boolean;
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
          const md = await loadConfirmationTokenMetadata(a.faucetId).catch(() => undefined);
          return {
            faucetId: a.faucetId,
            amount: a.amount,
            symbol: md?.symbol,
            decimals: md?.decimals,
            scaleIsKnown: hasKnownScale(md)
          };
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

/**
 * The quantity for one asset row, or `?` when the faucet's decimals are a guess.
 *
 * A question mark rather than a translated phrase: the row already names the
 * asset, this slot is a number, and it sits inline with a +/- sign.
 */
const quantityOf = (asset: ResolvedAsset): string =>
  asset.scaleIsKnown ? formatAmount(asset.amount, asset.decimals) : '?';

/**
 * One NFT, named by what the wallet can read: a label, its short asset id and its faucet.
 * The faucet's own name is not readable through SDK 0.17, so the address stands in for it.
 */
const NftRow: React.FC<{ nft: NftAsset; sign: '-' | '+'; isVerified: boolean }> = ({ nft, sign, isVerified }) => {
  const { t } = useTranslation();
  const tone = isVerified
    ? sign === '-'
      ? 'text-black-500 font-semibold'
      : 'text-green-500 font-semibold'
    : 'text-text-muted font-normal';
  return (
    <div
      className="flex flex-col w-full my-2 text-sm"
      data-testid="tx-nft-row"
      data-direction={sign === '-' ? 'out' : 'in'}
    >
      <div className="flex flex-row items-baseline">
        {/* eslint-disable i18next/no-literal-string -- Decorative amount sign, aria-hidden. */}
        <span className={classNames('font-heading text-lg mr-1', tone)} aria-hidden="true">
          {sign}
        </span>
        {/* eslint-enable i18next/no-literal-string */}
        <span className={classNames('font-heading text-lg', tone)} data-verified={isVerified ? 'true' : 'false'}>
          {`${t('nft')} ${nft.assetId}`}
        </span>
        {!isVerified && <span className="text-text-muted text-xs ml-2">{t('unverified')}</span>}
      </div>
      <span className="text-text-muted text-xs ml-4">{`${t('nftFaucet')} ${truncateAddress(nft.faucetId)}`}</span>
    </div>
  );
};

export const TransactionAssetView: React.FC<TransactionAssetViewProps> = ({ view, mode, onDownload, noteFlow }) => {
  const { t } = useTranslation();
  const outgoing = useResolvedAssets(view.outgoing);
  const incoming = useResolvedAssets(view.incoming);
  // Memoized because `useResolvedAssets` keys its effect on array identity: a literal built
  // during render would re-resolve, re-render and re-resolve forever.
  const feeAssets = useMemo(() => (view.fee ? [view.fee] : []), [view.fee]);
  const [feeAsset] = useResolvedAssets(feeAssets);
  const hasAssets =
    view.outgoing.length > 0 ||
    view.incoming.length > 0 ||
    view.outgoingNfts.length > 0 ||
    view.incomingNfts.length > 0 ||
    view.unlistedAssets > 0;
  const isVerified = mode === 'verified';

  return (
    <div className="flex flex-col items-center justify-center" data-testid="tx-asset-view" data-mode={mode}>
      {mode === 'declared' && (
        <span className="text-text-muted text-xs mb-2 self-start">{t('declaredBySiteVerifying')}</span>
      )}

      <Card padding="tile" className="mb-4 flex w-full flex-col">
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
                {/* eslint-disable i18next/no-literal-string -- Decorative outgoing-amount sign, aria-hidden. */}
                <span
                  className={classNames(
                    'font-heading text-lg mr-1',
                    isVerified ? 'text-black-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  aria-hidden="true"
                >
                  -
                </span>
                {/* eslint-enable i18next/no-literal-string */}
                <span
                  className={classNames(
                    'font-heading text-lg',
                    isVerified ? 'text-black-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  data-verified={isVerified ? 'true' : 'false'}
                >{`${quantityOf(a)} ${a.symbol ?? t('unknown')}`}</span>
                {!isVerified && <span className="text-text-muted text-xs ml-2">{t('unverified')}</span>}
              </div>
            ))}
            {incoming.map(a => (
              <div key={`in-${a.faucetId}`} className="flex flex-row items-baseline w-full my-2 text-sm">
                {/* eslint-disable i18next/no-literal-string -- Decorative incoming-amount sign, aria-hidden. */}
                <span
                  className={classNames(
                    'font-heading text-lg mr-1',
                    isVerified ? 'text-green-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  aria-hidden="true"
                >
                  +
                </span>
                {/* eslint-enable i18next/no-literal-string */}
                <span
                  className={classNames(
                    'font-heading text-lg',
                    isVerified ? 'text-green-500 font-semibold' : 'text-text-muted font-normal'
                  )}
                  data-verified={isVerified ? 'true' : 'false'}
                >{`${quantityOf(a)} ${a.symbol ?? t('unknown')}`}</span>
                {!isVerified && <span className="text-text-muted text-xs ml-2">{t('unverified')}</span>}
              </div>
            ))}
            {view.outgoingNfts.map((a, i) => (
              <NftRow key={`nft-out-${i}-${a.faucetId}-${a.assetId}`} nft={a} sign="-" isVerified={isVerified} />
            ))}
            {view.incomingNfts.map((a, i) => (
              <NftRow key={`nft-in-${i}-${a.faucetId}-${a.assetId}`} nft={a} sign="+" isVerified={isVerified} />
            ))}
            {view.unlistedAssets > 0 && (
              <div className="flex flex-row items-start gap-x-2 w-full my-2" data-testid="tx-unlisted-assets">
                <Icon name={IconName.WarningFill} fill="orange" size="md" />
                <span className="text-sm">{t('unlistedAssetsWarning')}</span>
              </div>
            )}
          </div>
        )}
      </Card>

      {!(mode === 'verified' && noteFlow) && (
        <TxStory
          hops={[
            ...outgoing.map(
              (asset): StoryHop => ({
                from: { role: 'you', name: '' },
                to: { role: 'recipient', name: '' },
                amount: `${quantityOf(asset)} ${asset.symbol ?? ''}`.trim()
              })
            ),
            ...incoming.map(
              (asset): StoryHop => ({
                from: { role: 'sender', name: '' },
                to: { role: 'you', name: '' },
                amount: `${quantityOf(asset)} ${asset.symbol ?? ''}`.trim()
              })
            ),
            ...(feeAsset
              ? [
                  {
                    from: { role: 'you' as const, name: '' },
                    to: { role: 'network' as const, name: '' },
                    amount: `${quantityOf(feeAsset)} ${feeAsset.symbol ?? ''}`.trim()
                  }
                ]
              : [])
          ]}
        />
      )}

      <div className="tx-stage-list flex flex-col w-full border-b border-gray-100 pb-4">
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('inputNotesConsumed')}</span>
          <span>{view.inputNotesConsumed}</span>
        </div>
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('outputNotesCreated')}</span>
          <span data-testid="tx-output-notes-created">{view.outputNotesCreated}</span>
        </div>
        {/*
          A cost the user pays, so it is shown rather than merely subtracted. It sits here, in
          the stats block, instead of among the asset rows: it is not an asset the user chose
          to move, `outgoing` deliberately excludes it on both decode paths, and this block
          renders even when a transaction moves nothing.
        */}
        {view.fee && (
          <div className="flex flex-row w-full items-center justify-between pb-1">
            <span className="text-text-muted">{t('networkFee')}</span>
            <span data-testid="tx-network-fee">
              {feeAsset ? `${quantityOf(feeAsset)} ${feeAsset.symbol ?? t('unknown')}` : t('loading')}
            </span>
          </div>
        )}
        {mode === 'verified' && (
          <div className="flex flex-row w-full items-center justify-between">
            <span className="text-text-muted">{t('storageChanged')}</span>
            {view.storageChanged ? (
              <div className="flex flex-row items-center gap-x-2" data-testid="tx-storage-changed" data-changed="true">
                <Icon name={IconName.WarningFill} fill="orange" size="md" />
                <span>{t('yes')}</span>
              </div>
            ) : (
              <span data-testid="tx-storage-changed" data-changed="false">
                {t('no')}
              </span>
            )}
          </div>
        )}
      </div>

      {mode === 'verified' && noteFlow ? (
        <TransactionNoteFlow flow={noteFlow} account={view.account} />
      ) : (
        <div className="w-full my-4 text-sm text-muted" data-testid="tx-note-flow-unavailable">
          {t(mode === 'verified' ? 'verifiedNoteDetailsUnavailable' : 'declaredNoteDetailsUnavailable')}
        </div>
      )}

      {onDownload && (
        <Button
          type="button"
          variant={ButtonVariant.Ghost}
          className={classNames(
            'w-full mt-2',
            'rounded-4xl hover:rounded-4xl',
            'transition-all duration-200 ease-in-out',
            'hover:bg-fill-pressed',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300',
            'py-4 px-0'
          )}
          onClick={onDownload}
        >
          <span className="flex flex-row items-center justify-center gap-x-2">
            <Icon name={IconName.Download} fill="currentColor" size="md" />
            <span className="text-lg text-ink font-medium">{t('downloadFullSummary')}</span>
          </span>
        </Button>
      )}
    </div>
  );
};
