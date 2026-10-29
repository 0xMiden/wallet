/**
 * The `contacts` feature: one entry keyed `contacts`, a JSON array of
 * `[name, address, networkCode]` triples. The network code is one letter:
 * `m` mainnet, `t` testnet, `d` devnet, `l` localhost.
 *
 * The server keeps the last write. To lose fewer edits, this device merges
 * three lists before it writes: the base (the list both sides last agreed on),
 * the local list and the server list. A local addition, removal or rename
 * since the base goes onto the server list; everything else follows the
 * server. Triples of other networks are kept as they are.
 */
import { settingsUpdated } from 'lib/miden/back/store';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { WalletContact } from 'lib/shared/types';

import { plaintextDigest } from '../crypto';
import { type IncomingEntry, hashedKeyOf, readFeature, uploadEntries } from '../entries';
import { type BackupSession, assertSessionLive, persistMergeRecords } from '../session';

export const CONTACTS_ENTRY_KEY = 'contacts';

export type NetworkCode = 'm' | 't' | 'd' | 'l';

/** One synced contact: name, address, network code. */
export type ContactTriple = [string, string, NetworkCode];

export function networkCodeOf(network: MIDEN_NETWORK_NAME): NetworkCode {
  switch (network) {
    case MIDEN_NETWORK_NAME.MAINNET:
      return 'm';
    case MIDEN_NETWORK_NAME.TESTNET:
      return 't';
    case MIDEN_NETWORK_NAME.DEVNET:
      return 'd';
    case MIDEN_NETWORK_NAME.LOCALNET:
      return 'l';
  }
}

function readNetworkCode(value: unknown): NetworkCode | null {
  switch (value) {
    case 'm':
    case 't':
    case 'd':
    case 'l':
      return value;
    default:
      return null;
  }
}

/** Parse the decrypted contacts entry. A triple of another shape is dropped; a body that is not an array gives null. */
export function parseContacts(plaintext: string): ContactTriple[] | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const triples: ContactTriple[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 3) continue;
    const [name, address, code] = raw;
    const network = readNetworkCode(code);
    if (typeof name !== 'string' || typeof address !== 'string' || network === null) continue;
    triples.push([name, address, network]);
  }
  return triples;
}

/** The address a contact is compared by: trimmed, lower case (a `0x` address in two cases is one account). */
function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/** Project the local contacts of this network. Accounts of this wallet are not contacts. */
export function projectContacts(contacts: readonly WalletContact[], code: NetworkCode): ContactTriple[] {
  return contacts.filter(contact => !contact.accountInWallet).map(contact => [contact.name, contact.address, code]);
}

/**
 * The three-way merge. `base` is the list both sides last agreed on (empty on
 * the first sync), `local` this device's list and `server` the stored list.
 * Only triples of `code` are merged; the others come from `server`.
 */
export function mergeContacts(
  base: readonly ContactTriple[],
  local: readonly ContactTriple[],
  server: readonly ContactTriple[],
  code: NetworkCode
): ContactTriple[] {
  const ofNetwork = (list: readonly ContactTriple[]) =>
    new Map(list.filter(triple => triple[2] === code).map(triple => [addressKey(triple[1]), triple]));
  const baseMap = ofNetwork(base);
  const localMap = ofNetwork(local);
  const merged = ofNetwork(server);

  for (const [key, triple] of localMap) {
    const before = baseMap.get(key);
    // Added here since the base, or renamed here since the base: the local copy wins.
    if (before === undefined || before[0] !== triple[0]) merged.set(key, triple);
  }
  for (const key of baseMap.keys()) {
    // Removed here since the base.
    if (!localMap.has(key)) merged.delete(key);
  }
  const others = server.filter(triple => triple[2] !== code);
  return [...merged.values(), ...others];
}

/** Write the merged list back to the local contacts, keeping the local fields the triple does not carry. */
function toLocalContacts(
  merged: readonly ContactTriple[],
  current: readonly WalletContact[],
  code: NetworkCode
): WalletContact[] {
  const byAddress = new Map(current.map(contact => [addressKey(contact.address), contact]));
  return merged
    .filter(triple => triple[2] === code)
    .map(([name, address]) => {
      const existing = byAddress.get(addressKey(address));
      return existing ? { ...existing, name } : { address, name, addedAt: Date.now() };
    });
}

function sameContacts(a: readonly WalletContact[], b: readonly WalletContact[]): boolean {
  return (
    a.length === b.length &&
    a.every((contact, index) => contact.address === b[index]?.address && contact.name === b[index]?.name)
  );
}

/**
 * Read the contacts entry (unless `read` is false), merge it with the local
 * list, save the result locally and upload it when the server copy differs.
 */
export async function syncContacts(session: BackupSession, read: boolean): Promise<boolean> {
  const code = networkCodeOf(getEffectiveNetworkName());
  const base = session.merge.contactsBase === null ? [] : (parseContacts(session.merge.contactsBase) ?? []);
  let changed = false;

  const mergeAndSave = async (server: readonly ContactTriple[]): Promise<ContactTriple[]> => {
    const settings = await session.vault.fetchSettings();
    const current = (settings.contacts ?? []).filter(contact => !contact.accountInWallet);
    const merged = mergeContacts(base, projectContacts(current, code), server, code);
    const next = toLocalContacts(merged, current, code);
    if (!sameContacts(next, current)) {
      // The settings read awaited: a lock may have landed, and the write below must not run after it.
      assertSessionLive(session);
      settingsUpdated(await session.vault.updateSettings({ contacts: next }));
      changed = true;
    }
    return merged;
  };

  const fromServer: { merged: ContactTriple[] | null } = { merged: null };
  // A device that never read the entry must not write over it.
  if (read || session.state.features.contacts.etag === null) {
    await readFeature(session, 'contacts', {
      since: false,
      apply: async (entries: IncomingEntry[]) => {
        const contactsKey = hashedKeyOf(session, CONTACTS_ENTRY_KEY);
        const latest = entries.find(entry => entry.hashedKey === contactsKey);
        if (latest === undefined) return;
        const server = parseContacts(latest.plaintext);
        if (server === null) return;
        fromServer.merged = await mergeAndSave(server);
        // The server copy is now the base: the upload below carries only local edits on top of it.
        session.merge.contactsBase = latest.plaintext;
        await persistMergeRecords(session);
      }
    });
  }
  // No new server copy: the base is what the server holds.
  const result = fromServer.merged ?? (await mergeAndSave(base));
  const plaintext = JSON.stringify(result);
  await uploadEntries(session, 'contacts', [{ entryKey: CONTACTS_ENTRY_KEY, plaintext }]);
  // The server holds this list (written now, or already equal): it is the base of the next merge.
  const serverCopy = session.state.features.contacts.entries[hashedKeyOf(session, CONTACTS_ENTRY_KEY)];
  if (serverCopy?.digest === plaintextDigest(plaintext) && session.merge.contactsBase !== plaintext) {
    session.merge.contactsBase = plaintext;
    await persistMergeRecords(session);
  }
  return changed;
}
