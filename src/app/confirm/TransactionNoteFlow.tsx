import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { storyFromNoteFlow, sumAssets, type StoryAsset, type StoryHop } from 'components/tx-stage/tx-story';
import { TxStory } from 'components/tx-stage/TxStory';
import { Card } from 'components/ui/Card';
import { fetchTokenMetadata } from 'lib/miden/metadata/fetch';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { formatAmount } from 'lib/shared/format';
import { truncateAddress } from 'utils/string';

import type { AssetAmount } from './decode';
import type { NoteDetail, NoteFlow } from './note-flow';

const dedicatedNoteKindKeys: Record<string, string> = {
  fee: 'transactionFeeNote',
  TX_FEE: 'transactionFeeNote',
  P2ID: 'P2ID',
  P2IDE: 'P2IDE',
  PSWAP: 'PSWAP',
  custom: 'otherNoteScript',
  unknown: 'unknownNoteScript'
};

/** `FEE_SPONSORSHIP` → "Fee sponsorship". A single token (`SWAP`, `MINT`) stays as the standard name. */
function standardNotePhrase(name: string): string {
  if (!name.includes('_')) return name;
  const words = name.toLowerCase().split('_');
  const first = words[0] ?? '';
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

const confirmationTokenMetadataRequests = new Map<string, Promise<AssetMetadata>>();

export function loadConfirmationTokenMetadata(faucetId: string): Promise<AssetMetadata> {
  const rpcUrl = getEffectiveRpcUrl();
  const key = `${rpcUrl}\0${faucetId}`;
  const pending = confirmationTokenMetadataRequests.get(key);
  if (pending) return pending;
  const request = fetchTokenMetadata(faucetId).finally(() => {
    if (confirmationTokenMetadataRequests.get(key) === request) {
      confirmationTokenMetadataRequests.delete(key);
    }
  });
  confirmationTokenMetadataRequests.set(key, request);
  return request;
}

const NoteAsset: React.FC<{ asset: AssetAmount }> = ({ asset }) => {
  const { t } = useTranslation();
  const assetKey = `${asset.faucetId}:${asset.amount}`;
  const [resolved, setResolved] = useState<{ key: string; label?: string }>();
  useEffect(() => {
    let cancelled = false;
    loadConfirmationTokenMetadata(asset.faucetId)
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

const NoteItem: React.FC<{ note: NoteDetail; index: number; side: 'in' | 'out' }> = ({ note, index, side }) => {
  const { t } = useTranslation();
  const kindKey = dedicatedNoteKindKeys[note.kind];
  const tone = note.kind === 'fee' || note.kind === 'TX_FEE' ? 'fee' : side === 'in' ? 'sent' : 'note';
  return (
    <Card asChild padding="tile" className="min-w-0">
      <li
        data-testid="tx-note-item"
        data-tone={tone}
        className={classNames('tx-stage-note tx-note-slide', side === 'out' ? 'out' : 'in')}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-semibold text-ink">
            {kindKey ? t(kindKey) : t('standardNoteLabel', { name: standardNotePhrase(note.kind) })}
          </span>
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

async function assetLabel(assets: StoryAsset[]): Promise<string> {
  const parts = await Promise.all(
    sumAssets(assets).map(async asset => {
      try {
        const metadata = await loadConfirmationTokenMetadata(asset.faucetId);
        if (!hasKnownScale(metadata)) return '';
        return `${formatAmount(asset.amount, metadata.decimals)} ${metadata.symbol || truncateAddress(asset.faucetId)}`;
      } catch {
        return '';
      }
    })
  );
  return parts.filter(Boolean).join(', ');
}

export const TransactionNoteFlow: React.FC<{ flow: NoteFlow; account?: string }> = ({ flow, account }) => {
  const { t } = useTranslation();
  const baseHops = useMemo(() => storyFromNoteFlow(flow, account), [flow, account]);
  const [resolved, setResolved] = useState<{ hops: StoryHop[]; received: string; sent: string; fee: string }>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const receivedAssets = baseHops.filter(hop => hop.to.role === 'you').flatMap(hop => hop.assets ?? []);
      const sentAssets = baseHops
        .filter(hop => hop.from.role === 'you' && hop.to.role !== 'network')
        .flatMap(hop => hop.assets ?? []);
      const feeAssets = baseHops.filter(hop => hop.to.role === 'network').flatMap(hop => hop.assets ?? []);
      // Start every lookup before awaiting, so they share one in-flight metadata read per faucet.
      const amountsPromise = Promise.all(baseHops.map(hop => assetLabel(hop.assets ?? [])));
      const receivedPromise = assetLabel(receivedAssets);
      const sentPromise = assetLabel(sentAssets);
      const feePromise = assetLabel(feeAssets);
      const [amounts, received, sent, fee] = await Promise.all([
        amountsPromise,
        receivedPromise,
        sentPromise,
        feePromise
      ]);
      if (cancelled) return;
      setResolved({
        hops: baseHops.map((hop, index) => ({ ...hop, amount: amounts[index] || hop.amount })),
        received,
        sent,
        fee
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [baseHops]);

  const hops = resolved?.hops ?? baseHops;
  const [notesOpen, setNotesOpen] = useState(false);
  const notesPanelRef = useRef<HTMLDivElement>(null);
  const toggledRef = useRef(false);
  useLayoutEffect(() => {
    const panel = notesPanelRef.current;
    if (!panel) return;
    panel.style.maxHeight = notesOpen ? `${panel.scrollHeight}px` : '0px';
  }, [notesOpen, resolved, hops]);
  const toggleNotes = () => {
    toggledRef.current = true;
    setNotesOpen(open => !open);
  };
  useEffect(() => {
    if (!toggledRef.current) return;
    let cancelled = false;
    (async () => {
      const { isExtension } = await import('lib/platform');
      if (!isExtension() || cancelled) return;
      const browser = (await import('webextension-polyfill')).default;
      const current = await browser.windows.getCurrent();
      if (current.id == null || cancelled) return;
      const base = 760;
      const grown = Math.min(
        Math.max(document.documentElement.scrollHeight + 28, base),
        (window.screen?.availHeight || base) - 20
      );
      await browser.windows.update(current.id, { height: notesOpen ? grown : base });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [notesOpen]);
  return (
    <section className="w-full mb-4" aria-label={t('transactionNoteFlow')} data-testid="tx-note-flow">
      <h3 className="tx-stage-rise mb-2 font-semibold text-ink">{t('transactionNoteFlow')}</h3>
      <TxStory hops={hops} summary={{ received: resolved?.received, sent: resolved?.sent, fee: resolved?.fee }} />
      <button type="button" className="tx-notes-toggle" aria-expanded={notesOpen} onClick={toggleNotes}>
        {notesOpen ? t('hideNotes') : t('showNotes')}
        <span className={classNames('tx-notes-chevron', notesOpen && 'is-open')} aria-hidden="true" />
      </button>
      <div
        ref={notesPanelRef}
        className={classNames('tx-notes-disclosure', notesOpen && 'is-open')}
        aria-hidden={notesOpen ? undefined : true}
      >
        <div className="tx-notes-disclosure-inner">
          <div className="text-sm text-muted mb-2">
            {t('inputNotesConsumed')}: {flow.inputCount}
          </div>
          {flow.inputs.length ? (
            <ol className="tx-stage-list flex flex-col gap-2" data-testid="tx-note-inputs">
              {flow.inputs.map((note, index) => (
                <NoteItem key={`${note.id ?? 'input'}-${index}`} note={note} index={index} side="in" />
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
          <div className="tx-stage-link" aria-hidden="true" />
          <Card
            padding="tile"
            className="tx-stage-account font-semibold text-ink"
            data-testid="tx-note-account"
            aria-label={t('account')}
          >
            <span title={account}>
              {t('account')}: {account ? truncateAddress(account) : t('unknown')}
            </span>
          </Card>
          <div className="tx-stage-link" aria-hidden="true" />
          <div className="text-sm text-muted mb-2">
            {t(
              flow.outputs.some(note => note.kind === 'fee' || note.kind === 'TX_FEE')
                ? 'outputNotesIncludingFee'
                : 'transactionOutputNotes'
            )}
            : {flow.outputs.length}
          </div>
          {flow.outputs.length ? (
            <ol className="tx-stage-list flex flex-col gap-2" data-testid="tx-note-outputs">
              {flow.outputs.map((note, index) => (
                <NoteItem key={`${note.id ?? 'output'}-${index}`} note={note} index={index} side="out" />
              ))}
            </ol>
          ) : (
            <Card padding="tile" data-testid="tx-note-outputs">
              <span className="text-sm text-muted">{t('noOutputNotes')}</span>
            </Card>
          )}
          <section className="mt-4" aria-label={t('storageChanged')} data-testid="tx-storage-details">
            <h4 className="mb-2 font-semibold text-ink">{t('storageChanged')}</h4>
            {flow.storageChanges === undefined ? (
              <p className="text-sm text-muted">{t('storageDetailsUnavailable')}</p>
            ) : flow.storageChanges.length === 0 ? (
              <p className="text-sm text-muted">{t('noStorageChanges')}</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {flow.storageChanges.map((slot, index) => (
                  <Card asChild padding="tile" key={`${slot.kind}-${slot.slotName}-${index}`}>
                    <li className="min-w-0">
                      <div className="font-semibold text-ink break-all">{slot.slotName}</div>
                      <div className="text-xs text-muted">
                        {t(slot.kind === 'map' ? 'storageMapSlot' : 'storageValueSlot')} ·{' '}
                        {t(`storageOperation${slot.operation}`)}
                        {slot.entryCount !== undefined && slot.operation !== 'remove' && (
                          <>
                            {' '}
                            · {t('storageEntriesChanged')}: {slot.entryCount}
                          </>
                        )}
                      </div>
                    </li>
                  </Card>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </section>
  );
};
