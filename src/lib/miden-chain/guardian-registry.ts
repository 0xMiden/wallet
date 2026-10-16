import { GUARDIAN_OPTIONS, type ResolvedGuardianOption } from 'lib/miden-chain/networks-config';

/**
 * The Guardian operators of each network, as this realm knows them.
 *
 * The list of a network is the `guardians` section of the newest `0xMiden/wallet-config` document this realm
 * accepted for it. `lib/remote-config/runtime` gives that list to `setDocumentGuardians` each time it publishes a
 * document. The document's list REPLACES the bundled one (`GUARDIAN_OPTIONS`); it does not add to it, so a document
 * can remove an operator. The bundled list is the fallback only: for a network with no accepted document yet (a
 * first start that cannot reach the config repo, a read before the realm hydrated), for a document that has no
 * `guardians` section, and for localnet, which has no document.
 *
 * A leaf on purpose. `effective-endpoints` and `guardian/native-http` read the list, and `remote-config/runtime`
 * imports `effective-endpoints`, so a read through the runtime would be an import cycle.
 *
 * Every reader is synchronous. A path that runs without a user action (a service-worker request, a sync lap) and
 * treats the list as evidence first awaits `initBridgeConfig()`, as the other remote-config readers do.
 */
const documentLists = new Map<string, readonly ResolvedGuardianOption[]>();
const bundledLists = new Map<string, readonly ResolvedGuardianOption[]>();
const listeners = new Set<() => void>();
let revision = 0;

// One array per network, so a reader that keeps the list sees the same object until the list changes.
function bundledGuardians(network: string): readonly ResolvedGuardianOption[] {
  const known = bundledLists.get(network);
  if (known) return known;
  const list: ResolvedGuardianOption[] = [];
  for (const option of GUARDIAN_OPTIONS) {
    for (const [optionNetwork, endpoint] of option.endpoint) {
      if (optionNetwork !== network) continue;
      list.push({
        id: option.id,
        name: option.name,
        operatedBy: option.operatedBy,
        location: option.location,
        endpoint
      });
    }
  }
  bundledLists.set(network, list);
  return list;
}

const sameOption = (a: ResolvedGuardianOption, b: ResolvedGuardianOption): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.operatedBy === b.operatedBy &&
  a.location === b.location &&
  a.endpoint === b.endpoint &&
  a.about === b.about &&
  a.kind === b.kind;

const sameList = (a: readonly ResolvedGuardianOption[], b: readonly ResolvedGuardianOption[]): boolean =>
  a.length === b.length && a.every((option, index) => sameOption(option, b[index]!));

/**
 * The operators of `network` in picker order, the first being the default: the accepted document's list, else the
 * bundled one. Empty for a network with neither. The same array until the list changes; do not mutate it.
 */
export function getNetworkGuardians(network: string): readonly ResolvedGuardianOption[] {
  return documentLists.get(network) ?? bundledGuardians(network);
}

/** The endpoints of `getNetworkGuardians(network)`, in the same order. */
export function getNetworkGuardianEndpoints(network: string): string[] {
  return getNetworkGuardians(network).map(option => option.endpoint);
}

/** Every operator this realm knows on any network: each network's document list, else its bundled list. */
export function getKnownGuardians(): ResolvedGuardianOption[] {
  const networks = new Set<string>(documentLists.keys());
  for (const option of GUARDIAN_OPTIONS) {
    for (const network of option.endpoint.keys()) networks.add(network);
  }
  return [...networks].flatMap(network => getNetworkGuardians(network));
}

/**
 * The accepted document of `network` changed. `guardians` is its list, or undefined when the document has no
 * `guardians` section, which puts the network back on the bundled list. Only the remote-config runtime calls this,
 * and only for a document it accepted: a missing document is not a reason to drop a list this realm already has.
 * A list equal to the one in use keeps that array and tells no listener, so a refresh that brings the same document
 * does not restart a reader that holds the list.
 */
export function setDocumentGuardians(network: string, guardians: readonly ResolvedGuardianOption[] | undefined): void {
  if (guardians === undefined) {
    if (!documentLists.delete(network)) return;
  } else {
    const inUse = getNetworkGuardians(network);
    const unchanged = sameList(guardians, inUse);
    documentLists.set(network, unchanged ? inUse : guardians);
    if (unchanged) return;
  }
  revision += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeGuardians(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes each time any network's list changes: the snapshot `useSyncExternalStore` compares. */
export function getGuardiansRevision(): number {
  return revision;
}

export function _resetGuardianRegistryForTest(): void {
  documentLists.clear();
  listeners.clear();
  revision = 0;
}
