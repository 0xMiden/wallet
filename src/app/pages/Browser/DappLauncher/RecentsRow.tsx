/**
 * Vertical list of the most-recently-opened dApps.
 *
 * Lives BELOW the `<AppsGrid>` curated cards so the user can clearly
 * distinguish "apps we've curated for you" from "apps you've opened
 * recently" (Recents).
 *
 * - Capped at 4 entries.
 * - Sorted newest-first (the provider's `getRecentDapps` already
 *   sorts by `lastOpenedAt` desc).
 * - Hidden when there are no recents at all.
 * - Each row: a tinted tile (favicon, or the name's initial), the dApp's
 *   name over its host, and an outward arrow — the row opens the dApp.
 */

import React, { type FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { type RecentDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

const MAX_VISIBLE = 4;

// Muted tints for tiles without a favicon, keyed off the name so a dApp
// keeps its color between visits. Same family as the balance-card colors.
const DEFAULT_TILE_TINT = '#8FA58A';
const TILE_TINTS = [DEFAULT_TILE_TINT, '#94A3B8', '#7E7E96', '#D9885A', '#8A7DA6'];

function tintFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // The index is always in range; the fallback is what keeps the return type a string
  // under `noUncheckedIndexedAccess`.
  return TILE_TINTS[hash % TILE_TINTS.length] ?? DEFAULT_TILE_TINT;
}

function hostOf(dapp: RecentDapp): string {
  try {
    return new URL(dapp.url).hostname;
  } catch {
    return dapp.origin;
  }
}

interface RecentRowProps {
  dapp: RecentDapp;
  onOpen: (url: string) => void;
}

const RecentRow: FC<RecentRowProps> = ({ dapp, onOpen }) => {
  const [iconBroken, setIconBroken] = useState(false);
  const showFallback = !dapp.favicon || iconBroken;

  const handleClick = () => {
    hapticLight();
    onOpen(dapp.url);
  };

  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-center gap-4 py-3 text-left transition-transform duration-100 ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
        aria-label={dapp.name}
        data-testid="recent-dapp-row"
        data-dapp-url={dapp.url}
      >
        <span
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl"
          style={{ background: showFallback ? tintFor(dapp.name) : undefined }}
          aria-hidden="true"
        >
          {showFallback ? (
            <span className="font-heading text-2xl font-extrabold text-pure-white">
              {dapp.name.charAt(0).toUpperCase()}
            </span>
          ) : (
            <img
              src={dapp.favicon}
              alt=""
              className="h-14 w-14 object-cover"
              onError={() => setIconBroken(true)}
              draggable={false}
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-heading text-lg font-extrabold leading-tight text-heading-gray">
            {dapp.name}
          </span>
          <span className="truncate font-heading text-base font-medium leading-tight text-text-muted">
            {hostOf(dapp)}
          </span>
        </span>
        <Icon name={IconName.ArrowRightUp} className="h-5 w-5 shrink-0 text-text-muted" />
      </button>
    </li>
  );
};

interface RecentsRowProps {
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, onOpen }) => {
  const { t } = useTranslation();

  if (recents.length === 0) return null;

  const visible = recents.slice(0, MAX_VISIBLE);

  return (
    <section className="px-4">
      <h2 className="mb-1 font-heading text-sm font-bold uppercase tracking-wider text-text-muted">{t('recents')}</h2>
      <ul className="flex flex-col">
        {visible.map(dapp => (
          <RecentRow key={dapp.url} dapp={dapp} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
};
