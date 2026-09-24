import React from 'react';

import { NetworkChipKind, NetworkLogo } from 'components/NetworkChip';
import { Avatar, AvatarSize } from 'components/ui/Avatar';

/** Muted tints from the app's palette (the explore tiles and balance card use the same family). */
const TINTS = ['#8FA58A', '#94A3B8', '#7E7E96', '#D9885A', '#8A7DA6', '#6F9C9C', '#B08968', '#7C8CB5'];
const DEFAULT_TINT = '#94A3B8';

/** `sm` is the 24px avatar a page header's title can carry; `md` a row's; `xl` a hero's. */
export type ContactAvatarSize = 'sm' | 'md' | 'xl';

const AVATAR_SIZES: Record<ContactAvatarSize, AvatarSize> = { sm: 24, md: 40, xl: 88 };

/** Stable per address, so the same contact keeps its color on every screen. */
export function tintForAddress(address: string): string {
  let hash = 2166136261;
  for (const char of address.trim().toLowerCase()) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return TINTS[hash % TINTS.length] ?? DEFAULT_TINT;
}

/**
 * Up to two initials from a name. With no name, the first character of the address after its
 * `mtst1`/`mm1`/`0x` prefix, so two unnamed contacts rarely look alike even before color.
 */
export function avatarLabel(address: string, name?: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map(word => Array.from(word)[0] ?? '')
      .join('')
      .toUpperCase();
  }
  const body = address.trim().replace(/^(0x|[a-z]+1)/i, '');
  return (Array.from(body)[0] ?? '').toUpperCase();
}

export interface ContactAvatarProps {
  address: string;
  name?: string;
  /** Adds the network's mark as a badge on the corner. */
  network?: NetworkChipKind;
  size?: ContactAvatarSize;
  className?: string;
}

/**
 * A contact's avatar: a color and initials derived from the contact itself, so contacts are
 * distinguishable at a glance instead of all wearing the same orange Miden image. A thin wrapper
 * over the canonical `Avatar`.
 */
export const ContactAvatar: React.FC<ContactAvatarProps> = ({ address, name, network, size = 'md', className }) => (
  <Avatar
    data-testid="contact-avatar"
    data-network={network}
    size={AVATAR_SIZES[size]}
    initials={avatarLabel(address, name)}
    color={tintForAddress(address)}
    badge={network && <NetworkLogo kind={network} />}
    className={className}
  />
);
