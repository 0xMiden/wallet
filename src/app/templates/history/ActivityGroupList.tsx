import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { hapticLight } from 'lib/mobile/haptics';

import { ActivityGroup } from './activity-grouping';

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
        const isUnknown = group.kind === 'unknown';
        const title = isUnknown ? t('activityUnknownGroup') : group.name;
        const latest = group.entries[0];
        const subtitle = isUnknown
          ? t('activityUnknownGroupSubtitle')
          : (latest?.message ?? t('activityGroupNoTransactions'));

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
                // The in-protocol DEX gets its own glyph — the same one the
                // Swap action uses — so a swap group reads as the app it is
                // rather than as a generic dApp.
                group.protocol === 'swap' ? (
                  <Icon name={IconName.Convert} className="w-5 h-5" fill="currentColor" />
                ) : group.kind === 'app' ? (
                  <Icon name={IconName.Apps} className="w-5 h-5" />
                ) : isUnknown ? (
                  <Icon name={IconName.Users} className="w-5 h-5" />
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
