import { useMemo } from 'react';

import type { WalletAccount, WalletContact } from 'lib/shared/types';

import { useMidenContext } from './client';
import { useAllAccounts, useSettings } from './ready';

function accountContactsFrom(accounts: readonly WalletAccount[]): WalletContact[] {
  return accounts.map(acc => ({
    address: acc.publicKey,
    name: acc.name,
    accountInWallet: true,
    isPublic: acc.isPublic
  }));
}

/** Saved contacts, then own accounts. Activity reads names here and never writes settings. */
export function useActivityContacts(): WalletContact[] {
  const { contacts } = useSettings();
  const accounts = useAllAccounts();
  return useMemo(() => [...(contacts ?? []), ...accountContactsFrom(accounts)], [contacts, accounts]);
}

export function useFilteredContacts() {
  const { updateSettings } = useMidenContext();

  const settings = useSettings();
  const settingContacts = useMemo(() => settings.contacts ?? [], [settings.contacts]);

  const accounts = useAllAccounts();
  const accountContacts = useMemo(() => accountContactsFrom(accounts), [accounts]);

  const allContacts = useMemo(() => {
    const filteredSettingContacts = settingContacts.filter(
      contact => !accountContacts.some(intersection => contact.address === intersection.address)
    );

    if (filteredSettingContacts.length !== settingContacts.length) {
      updateSettings({ contacts: filteredSettingContacts });
    }

    return [...filteredSettingContacts, ...accountContacts];
  }, [settingContacts, accountContacts, updateSettings]);

  return { contacts: settingContacts, allContacts };
}
