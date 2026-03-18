import { useMemo } from 'react';

import { WalletContact } from 'lib/shared/types';

import { useMidenContext } from './client';
import { useAllAccounts, useSettings } from './ready';

export function useFilteredContacts() {
  const { updateSettings } = useMidenContext();

  const settings = useSettings();
  const settingContacts = useMemo(() => settings.contacts ?? [], [settings.contacts]);

  const accounts = useAllAccounts();
  const accountContacts = useMemo<WalletContact[]>(
    () =>
      accounts.map(acc => ({
        address: acc.publicKey,
        name: acc.name,
        accountInWallet: true,
        isPublic: acc.isPublic
      })),
    [accounts]
  );

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
