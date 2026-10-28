import React from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { truncateAddress } from 'utils/string';

import type { StoryHop, StoryParty } from './tx-story';

/** `FEE_SPONSORSHIP` → "Fee sponsorship". `MINT` stays `MINT`. */
function kindPhrase(kind: string): string {
  if (!kind.includes('_')) return kind;
  const words = kind.toLowerCase().split('_');
  const first = words[0] ?? '';
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

function kindLabel(kind: string, t: (key: string, options?: { name?: string }) => string): string {
  if (kind === 'fee' || kind === 'TX_FEE') return t('transactionFeeNote');
  if (kind === 'custom') return t('otherNoteScript');
  if (kind === 'unknown') return t('unknownNoteScript');
  if (kind === 'P2ID' || kind === 'P2IDE' || kind === 'PSWAP') return t(kind);
  return t('standardNoteLabel', { name: kindPhrase(kind) });
}

function visibilityLabel(via: string, t: (key: string) => string): string {
  if (via === 'public' || via === 'private' || via === 'unknown') return t(via);
  return via;
}

export interface StorySummary {
  received?: string;
  sent?: string;
  fee?: string;
}

/** Shorten an address. A chain name or other short label stays whole. */
function displayName(name: string): string {
  if (!name) return '';
  if (name.includes('_') || name.startsWith('0x') || name.length > 22) return truncateAddress(name);
  return name;
}

/** You and Network with no name only repeat the line above them. */
function showsParty(party: StoryParty): boolean {
  if (party.role === 'you' || party.role === 'network') return Boolean(displayName(party.name));
  return true;
}

const Party: React.FC<{ party: StoryParty; side: 'from' | 'to' }> = ({ party, side }) => {
  const { t } = useTranslation();
  const name = displayName(party.name);
  if (!showsParty(party)) return null;
  const label = party.role === 'network' ? t('network') : side === 'from' ? t('from') : t('to');
  return (
    <div className="tx-story-party">
      <div className="tx-story-role">{label}</div>
      {name && <div className="tx-story-name">{name}</div>}
    </div>
  );
};

/**
 * Who sends what to whom. One hop is one transfer: a party, the amount and how
 * it moves, then the party who receives it.
 */
export const TxStory: React.FC<{ hops: StoryHop[]; summary?: StorySummary; className?: string }> = ({
  hops,
  summary,
  className
}) => {
  const { t } = useTranslation();
  if (hops.length === 0) return null;
  const totals = [summary?.received, summary?.sent, summary?.fee].filter(Boolean);

  return (
    <div className={classNames('tx-story', className)}>
      {totals.length > 0 && (
        <div className="tx-story-summary">
          {summary?.received && <div className="tx-story-total">{`${t('youReceive')} ${summary.received}`}</div>}
          {summary?.sent && <div className="tx-story-total">{`${t('youSend')} ${summary.sent}`}</div>}
          {summary?.fee && <div className="tx-story-total">{`${t('networkFee')} ${summary.fee}`}</div>}
        </div>
      )}
      {hops.map((hop, index) => {
        const kind = hop.kind ? kindLabel(hop.kind, t) : '';
        const visibility = hop.via ? visibilityLabel(hop.via, t) : hop.to.role === 'network' ? t('networkFee') : '';
        const detail = [hop.amount || (hop.assets?.length || kind ? '' : t('note')), kind, visibility]
          .filter(Boolean)
          .join(' · ');
        const feeHop = hop.to.role === 'network';
        const fromShown = !feeHop && showsParty(hop.from);
        const toShown = showsParty(hop.to);
        return (
          <div
            className={classNames('tx-story-hop', !fromShown && !toShown && 'tx-story-hop-line')}
            key={`${hop.amount}-${index}`}
          >
            {(fromShown || toShown) && (
              <div className="tx-story-parties">
                <div className="tx-story-slot">{fromShown && <Party party={hop.from} side="from" />}</div>
                <div className="tx-story-slot">{toShown && <Party party={hop.to} side="to" />}</div>
              </div>
            )}
            <div className="tx-story-move">
              <span className="tx-story-line" aria-hidden="true" />
              <span className="tx-story-amount">{detail}</span>
              <span className="tx-story-line" aria-hidden="true" />
            </div>
          </div>
        );
      })}
    </div>
  );
};
