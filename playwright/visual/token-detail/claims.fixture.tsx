// Its own module: the card's imports resolve back to `fixture.tsx`, so importing it there would be a cycle.
import { PendingActivityCard, type PendingActivityItem } from 'app/templates/history/PendingActivityCard';

import { token, TOKEN_DETAIL_FIXTURE_ID as tokenId } from './fixture';
import { FIXTURE_NOW } from './history.leaves';

const params = new URLSearchParams(window.location.search);

// A claim batch spanning two tokens: two claimable notes and one claiming note of this token, and a
// claiming note of another faucet, which this page must represent but not draw.
const claimNote = (
  id: string,
  faucetId: string,
  amount: string,
  status: PendingActivityItem['status'],
  age: number
): PendingActivityItem => ({
  note: {
    id,
    faucetId,
    amount,
    senderAddress: 'mtst1syntheticsender',
    isBeingClaimed: status === 'claiming',
    type: 'unknown',
    receivedAt: FIXTURE_NOW - age,
    metadata: faucetId === tokenId ? token.metadata : { name: 'Other token', symbol: 'OTHER', decimals: 8 }
  },
  status
});
const claimItems = params.has('pending')
  ? [
      claimNote('n1', tokenId, '150000000', 'pending', 60),
      claimNote('n2', tokenId, '50000000', 'failed', 120),
      claimNote('n3', tokenId, '25000000', 'claiming', 180),
      claimNote('n4', 'mtst1other', '900000000', 'claiming', 30)
    ]
  : [];
const renderPendingItem = (item: PendingActivityItem) => (
  <PendingActivityCard key={item.note.id} item={item} onAccept={() => undefined} />
);
export const useActivityClaimList = () => ({
  representedItems: claimItems,
  listItems: claimItems,
  renderPendingItem,
  isLoadingNotes: false
});
