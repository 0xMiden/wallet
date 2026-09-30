import { useCallback, useMemo } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { createStoredIdSet } from 'lib/miden/front/stored-id-set';
import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

/**
 * The tokens the user hid from Home (#813), per network and per account, in a stored-id-set store
 * (`lib/miden/front/stored-id-set`), so a token hidden on its page leaves the Home that `TabLayout`
 * keeps mounted at once.
 *
 * Ids are compared in their canonical form (`normalizedFaucetId`), so the hex and bech32 ids of one
 * faucet are one token. The native token pays every fee: it cannot be hidden, and a stored id that
 * names it (after an endpoint or native id change) is never reported.
 */

export interface HiddenTokens {
  /** Canonical ids of the hidden tokens, never the native token's. */
  ids: ReadonlySet<string>;
  /** The stored set has been read, so it can be written. */
  loaded: boolean;
  /** The stored set could not be read (it is then read-only), or the last save failed. */
  failed: boolean;
  /** The same function until the set changes, so a consumer can memoize on it. */
  isHidden: (tokenId: string) => boolean;
  /** Resolves `true` once stored; `false` for the native token, before it is known, or when the save failed. */
  hide: (tokenId: string) => Promise<boolean>;
  /** Resolves `true` once stored, `false` when the save was refused or failed. */
  unhide: (tokenId: string) => Promise<boolean>;
}

const store = createStoredIdSet('tokens');

// Faucet ids are per network, so the set is too. A stored id may be in either encoding.
const storageKey = (network: string, address: string) => `hidden-tokens:v1:${network}:${address}`;

/** Test seam: forgets every key's set, as a wipe does, without reading it again. */
export const resetHiddenTokens = store.reset;

export function useHiddenTokens(address: string): HiddenTokens {
  const key = storageKey(getEffectiveNetworkName(), address);
  const entry = store.useEntry(key);
  const nativeFaucetId = useMidenFaucetId();
  const nativeId = nativeFaucetId === null ? null : normalizedFaucetId(nativeFaucetId);

  // Until the native id is known the stored set is reported as it is: withholding it would put every
  // hidden token back on Home for the first moments of each cold start.
  const ids = useMemo(() => {
    const canonical = new Set(Array.from(entry.ids, id => normalizedFaucetId(id)));
    if (nativeId !== null) canonical.delete(nativeId);
    return canonical;
  }, [entry.ids, nativeId]);

  const isHidden = useCallback((tokenId: string) => ids.has(normalizedFaucetId(tokenId)), [ids]);

  return {
    ids,
    loaded: entry.status === 'ready',
    failed: entry.status === 'unreadable' || entry.saveFailed,
    isHidden,
    hide: (tokenId: string) => {
      const id = normalizedFaucetId(tokenId);
      // Until the native id is known any token might be it, so nothing new is hidden yet.
      if (nativeId === null || id === nativeId) return Promise.resolve(false);
      return store.save(key, stored =>
        [...stored].some(storedId => normalizedFaucetId(storedId) === id) ? stored : new Set([...stored, id])
      );
    },
    unhide: (tokenId: string) => {
      const id = normalizedFaucetId(tokenId);
      return store.save(key, stored => new Set([...stored].filter(storedId => normalizedFaucetId(storedId) !== id)));
    }
  };
}
