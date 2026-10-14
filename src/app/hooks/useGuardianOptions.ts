import { useMemo, useSyncExternalStore } from 'react';

import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { getGuardiansRevision, subscribeGuardians } from 'lib/miden-chain/guardian-registry';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';

/**
 * The operators a user can pick on the effective network: the config document's list, else the bundled one, plus the
 * developer's custom endpoint (`getGuardianOptionsForNetwork`). The same array until a document changes a list, so a
 * picker that pings each option does not start again on every render. A document that lands while the picker is open
 * replaces the options, and the picker must handle a choice that is no longer in them.
 */
export function useGuardianOptions(): ResolvedGuardianOption[] {
  const revision = useSyncExternalStore(subscribeGuardians, getGuardiansRevision, getGuardiansRevision);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is the list's version: a new one means a new list.
  return useMemo(() => getGuardianOptionsForNetwork(), [revision]);
}
