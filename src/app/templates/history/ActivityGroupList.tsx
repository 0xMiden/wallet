import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { hapticLight } from 'lib/mobile/haptics';

import { ActivityGroup } from './activity-grouping';

/**
 * The glyph that stands in for a group with no identicon behind it.
 *
 * `undefined` means "this group has a real address", and the row falls back to
 * its identicon — the only avatar in the product derived from the counterparty
 * itself rather than chosen by us.
 *
 * Every first-party flow gets the same glyph the rest of the wallet already
 * uses for it (Swap's Convert, Earn, Bridge's CrossChain, the faucet's tap), so
 * a group reads as the thing it is instead of as a generic app.
 */
function glyphForGroup(group: ActivityGroup): IconName | undefined {
  switch (group.protocol) {
    case 'swap':
      return IconName.Convert;
    case 'earn':
      return IconName.Earn;
    case 'bridge':
      return IconName.CrossChain;
    case 'faucet':
      return IconName.Faucet;
  }

  switch (group.kind) {
    // Guardian switches and key rotations: the wallet securing itself. A lock
    // rather than a person, because there is no counterparty here at all.
    case 'wallet':
      return IconName.Lock;
    case 'app':
      return IconName.Apps;
    case 'unknown':
      return IconName.Users;
    default:
      return undefined;
  }
}

interface ActivityGroupListProps {
  groups: ActivityGroup[];
  onOpenGroup: (group: ActivityGroup) => void;
}

/**
 * The grouped Activity view: one row per counterparty — a saved contact, a
 * dApp, or the explicit unattributed bucket — newest first.
 *
 * This is a second lens on the same transactions the chronological feed shows,
 * not a replacement: nothing is filtered out here, so every row the flat list
 * has appears in exactly one group (see `groupActivity`).
 */
export const ActivityGroupList: FC<ActivityGroupListProps> = ({ groups, onOpenGroup }) => {
  const { t } = useTranslation();

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-16 px-6">
        <p className="font-heading text-base font-extrabold text-heading-gray dark:text-pure-white">
          {t('activityGroupEmpty')}
        </p>
        <p className="mt-1 text-sm font-heading font-semibold text-heading-gray">
          {t('activityGroupEmptyDescription')}
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {groups.map(group => {
        const glyph = glyphForGroup(group);
        const latest = group.entries[0];

        // `contact` and `app` groups name themselves — from the address book,
        // the address, or the protocol. The two synthetic kinds have no name of
        // their own, so they get a localized one here rather than rendering an
        // empty title with the last event floating up into its place.
        const named = group.kind === 'unknown' || group.kind === 'wallet';
        const title = !named
          ? group.name
          : group.kind === 'unknown'
            ? t('activityUnknownGroup')
            : t('activityWalletGroup');
        const subtitle = !named
          ? (latest?.message ?? t('activityGroupNoTransactions'))
          : group.kind === 'unknown'
            ? t('activityUnknownGroupSubtitle')
            : t('activityWalletGroupSubtitle');

        return (
          <li key={group.id}>
            <CardItem
              // A button role rather than a bare div so the row is reachable by
              // keyboard on the extension/desktop layouts.
              role="button"
              tabIndex={0}
              data-testid={`activity-group-${group.id}`}
              hoverable
              title={title}
              subtitle={subtitle}
              iconLeft={
                glyph ? (
                  <Icon name={glyph} className="w-5 h-5" fill="currentColor" />
                ) : (
                  <Avatar size="md" identiconPublicKey={group.address} />
                )
              }
              titleRight={
                group.pendingCount > 0 ? (
                  <span
                    data-testid={`activity-group-pending-${group.id}`}
                    className="rounded-full bg-accent-primary px-2 py-0.5 text-xs font-bold font-heading text-pure-white"
                  >
                    {t('activityGroupPendingClaims', { count: group.pendingCount })}
                  </span>
                ) : undefined
              }
              onClick={() => {
                hapticLight();
                onOpenGroup(group);
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                hapticLight();
                onOpenGroup(group);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
};

export default ActivityGroupList;
