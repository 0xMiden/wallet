import React from 'react';

import { Avatar } from 'components/Avatar';

import { NetworkChipKind, NetworkLogo } from './NetworkChip';

/**
 * A recipient's avatar with its network as a small badge on the corner.
 *
 * In a list row the network is metadata, not a statement: a full chip sat taller than the line
 * beside it and read as tappable inside a row that is itself one button. The badge says the same
 * thing in the space the avatar already occupies, which leaves the row's second line for the
 * address alone.
 */
export const RecipientAvatar: React.FC<{ kind: NetworkChipKind }> = ({ kind }) => (
  <span className="relative shrink-0" data-testid="recipient-avatar" data-network={kind}>
    <Avatar image="/misc/avatars/miden-orange.png" size="lg" />
    <span className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-app-bg bg-app-bg">
      <NetworkLogo kind={kind} />
    </span>
  </span>
);
