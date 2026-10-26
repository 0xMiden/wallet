import React, { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Card } from 'components/ui/Card';
import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { formatAmount } from 'lib/shared/format';
import { truncateAddress } from 'utils/string';

import type { AssetAmount } from './decode';
import type { NoteDetail, NoteFlow, NoteKind } from './note-flow';

const noteKindKeys: Record<NoteKind, string> = {
  fee: 'transactionFeeNote',
  p2id: 'P2ID',
  p2ide: 'P2IDE',
  pswap: 'PSWAP',
  custom: 'otherNoteScript',
  unknown: 'unknownNoteScript'
};

const NoteAsset: React.FC<{ asset: AssetAmount }> = ({ asset }) => {
  const { t } = useTranslation();
  const assetKey = `${asset.faucetId}:${asset.amount}`;
  const [resolved, setResolved] = useState<{ key: string; label?: string }>();
  useEffect(() => {
    let cancelled = false;
    fetchTokenMetadata(asset.faucetId)
      .then(metadata => {
        if (cancelled) return;
        setResolved({
          key: assetKey,
          label: hasKnownScale(metadata)
            ? `${formatAmount(asset.amount, metadata.decimals)} ${metadata.symbol || truncateAddress(asset.faucetId)}`
            : undefined
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key: assetKey });
      });
    return () => {
      cancelled = true;
    };
  }, [asset.amount, asset.faucetId, assetKey]);
  const label = resolved?.key === assetKey ? resolved.label : undefined;
  return (
    <span className="block break-all" title={asset.faucetId}>
      {label ??
        `${t('amountUnknown')} · ${asset.amount.toString()} ${t('baseUnits')} · ${truncateAddress(asset.faucetId)}`}
    </span>
  );
};

const NoteItem: React.FC<{ note: NoteDetail; index: number }> = ({ note, index }) => {
  const { t } = useTranslation();
  return (
    <Card asChild padding="tile" className="min-w-0">
      <li data-testid="tx-note-item">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-semibold text-ink">{t(noteKindKeys[note.kind])}</span>
          <span className="text-xs text-muted">{t(note.visibility)}</span>
        </div>
        <div className="mt-1 text-xs text-muted break-all" title={note.id}>
          {t('noteId')}: {note.id ?? `${t('unknown')} ${index + 1}`}
        </div>
        {note.sender && (
          <div className="mt-1 text-xs text-muted break-all" title={note.sender}>
            {t('noteSender')}: {truncateAddress(note.sender)}
          </div>
        )}
        {note.assets === undefined && note.nfts === undefined ? (
          <div className="mt-2 text-xs text-muted">{t('noteDetailsUnavailable')}</div>
        ) : (
          <div className="mt-2 text-sm text-ink">
            {note.assets?.map((asset, assetIndex) => (
              <NoteAsset key={`${asset.faucetId}-${assetIndex}`} asset={asset} />
            ))}
            {note.nfts?.map((nft, nftIndex) => (
              <div key={`${nft.faucetId}-${nft.assetId}-${nftIndex}`} className="break-all" title={nft.faucetId}>
                {t('nft')} {nft.assetId} · {truncateAddress(nft.faucetId)}
              </div>
            ))}
            {note.assets?.length === 0 && note.nfts?.length === 0 && (
              <span className="text-muted">{t('noNoteAssets')}</span>
            )}
          </div>
        )}
        {note.scriptRoot && note.kind === 'custom' && (
          <div className="mt-1 text-xs text-muted break-all" title={note.scriptRoot}>
            {t('noteScriptRoot')}: {note.scriptRoot}
          </div>
        )}
      </li>
    </Card>
  );
};

export const TransactionNoteFlow: React.FC<{ flow: NoteFlow; account?: string }> = ({ flow, account }) => {
  const { t } = useTranslation();
  return (
    <section className="w-full mb-4" aria-label={t('transactionNoteFlow')} data-testid="tx-note-flow">
      <h3 className="mb-2 font-semibold text-ink">{t('transactionNoteFlow')}</h3>
      <div className="text-sm text-muted mb-2">
        {t('inputNotesConsumed')}: {flow.inputCount}
      </div>
      {flow.inputs.length ? (
        <ol className="flex flex-col gap-2" data-testid="tx-note-inputs">
          {flow.inputs.map((note, index) => (
            <NoteItem key={`${note.id ?? 'input'}-${index}`} note={note} index={index} />
          ))}
        </ol>
      ) : (
        <Card padding="tile" data-testid="tx-note-inputs">
          <span className="text-sm text-muted">
            {flow.inputCount === 0 ? t('noInputNotes') : t('inputDetailsUnavailable')}
          </span>
        </Card>
      )}
      {flow.inputCount > flow.inputs.length && flow.inputs.length > 0 && (
        <p className="mt-2 text-xs text-muted">{t('additionalInputDetailsUnavailable')}</p>
      )}
      <div className="mx-5 h-5 border-l border-hairline" aria-hidden="true" />
      <Card padding="tile" className="font-semibold text-ink" data-testid="tx-note-account" aria-label={t('account')}>
        <span title={account}>
          {t('account')}: {account ? truncateAddress(account) : t('unknown')}
        </span>
      </Card>
      <div className="mx-5 h-5 border-l border-hairline" aria-hidden="true" />
      <div className="text-sm text-muted mb-2">
        {t(flow.outputs.some(note => note.kind === 'fee') ? 'outputNotesIncludingFee' : 'transactionOutputNotes')}:{' '}
        {flow.outputs.length}
      </div>
      {flow.outputs.length ? (
        <ol className="flex flex-col gap-2" data-testid="tx-note-outputs">
          {flow.outputs.map((note, index) => (
            <NoteItem key={`${note.id ?? 'output'}-${index}`} note={note} index={index} />
          ))}
        </ol>
      ) : (
        <Card padding="tile" data-testid="tx-note-outputs">
          <span className="text-sm text-muted">{t('noOutputNotes')}</span>
        </Card>
      )}
    </section>
  );
};
