import React from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { AVATAR_SIZES, ContactAvatar, ContactAvatarSize } from 'components/contacts/ContactAvatar';
import { Avatar } from 'components/ui/Avatar';

import { ActivityGroupKind } from './activityGroups';
import { TRANSACTION_COLORS } from './transactionUtils';

type CategoryKind = Exclude<ActivityGroupKind, 'address'>;

/** The glyph of each category group. An `address` group wears its counterparty's avatar instead. */
export const KIND_ICONS: Record<CategoryKind, IconName> = {
  swap: IconName.Convert,
  faucet: IconName.Faucet,
  guardian: IconName.Key,
  other: IconName.More
};

/**
 * The circle behind each category group's glyph, in the colour the flat feed already paints that
 * kind of row with, so one transaction never wears two colours across the two views:
 *
 * - `swap` — `--tx-swap`, the purple of the swap action (`HistoryView`'s `bg-tx-swap`).
 * - `faucet` — `--tx-faucet`, the dusty rose a faucet claim has (`bg-tx-faucet`).
 * - `guardian` — the slate `HistoryView` paints a `switch-guardian` row with, which is
 *   `TRANSACTION_COLORS.bridge`: an op that moves no money on Miden.
 * - `other` — `--tx-other`, the neutral an activity mark with no category of its own gets.
 */
/**
 * The glyph's own box inside the circle, as a descendant selector so it beats `Icon`'s own size
 * class whatever order the stylesheet emits the two in.
 */
const GLYPH_SIZES: Record<ContactAvatarSize, string> = {
  sm: '[&>svg]:h-3 [&>svg]:w-3',
  md: '[&>svg]:h-4 [&>svg]:w-4',
  xl: '[&>svg]:h-8 [&>svg]:w-8'
};

const KIND_COLORS: Record<CategoryKind, string> = {
  swap: 'var(--tx-swap)',
  faucet: 'var(--tx-faucet)',
  guardian: TRANSACTION_COLORS.bridge,
  other: 'var(--tx-other)'
};

export interface ActivityGroupAvatarProps {
  kind: ActivityGroupKind;
  /** The counterparty address for `address`; the kind's own name for a category group. */
  id: string;
  /** The contact's or own account's name, for an `address` group. */
  name?: string;
  size?: ContactAvatarSize;
}

/**
 * One activity group's leading mark.
 *
 * Every kind gets the SAME round `Avatar` in the same box — a contact's initials on its own tint,
 * a category's white glyph on its own colour. That is not only decoration: a bare glyph and an
 * avatar do not share an optical centre or a width, so mixing them shifted the title column row
 * by row and left the category rows looking unfinished beside the contacts.
 */
export const ActivityGroupAvatar: React.FC<ActivityGroupAvatarProps> = ({ kind, id, name, size = 'md' }) =>
  kind === 'address' ? (
    <ContactAvatar address={id} name={name} size={size} />
  ) : (
    <Avatar
      data-testid="activity-group-avatar"
      data-group-kind={kind}
      size={AVATAR_SIZES[size]}
      color={KIND_COLORS[kind]}
      icon={
        <span className={GLYPH_SIZES[size]}>
          <Icon name={KIND_ICONS[kind]} fill="currentColor" />
        </span>
      }
    />
  );
