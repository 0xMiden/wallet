import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { TextField } from 'components/ui/TextField';
import { useContacts } from 'lib/miden/front';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { detectAddressChain, isValidRecipientAddress } from 'utils/miden';

import { BridgeNetworkId, DEFAULT_BRIDGE_NETWORK } from './bridge-networks';
import { NetworkField } from './NetworkField';

const NAME_MAX_LENGTH = 50;

export interface AddContactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The recipient address from the send step. It is already known, so the sheet only asks for a name. */
  address: string;
  /** The destination network chosen for a `0x` recipient; preselected here. */
  network?: BridgeNetworkId;
}

interface SheetBodyProps {
  address: string;
  initialNetwork?: BridgeNetworkId;
  onSaved: () => void;
}

const SheetBody: React.FC<SheetBodyProps> = ({ address, initialNetwork, onSaved }) => {
  const { t } = useTranslation();
  const { addContact } = useContacts();
  const isEvm = detectAddressChain(address) === 'ethereum';
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<BridgeNetworkId>(initialNetwork ?? DEFAULT_BRIDGE_NETWORK.id);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const trimmedName = name.trim();

  const save = async () => {
    if (!trimmedName || saving) return;
    if (!isValidRecipientAddress(address)) {
      setError(t('invalidAddress'));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await addContact({
        address,
        name: trimmedName,
        addedAt: Date.now(),
        ...(isEvm ? { network } : {})
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5 px-4 pb-4"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      {/* The address is fixed here (it came from the send step), so it is a card to confirm, not
          a field to edit, and shown in full. */}
      <div className="flex items-start gap-3 rounded-2xl bg-fill p-4">
        <ContactAvatar address={address} name={trimmedName} network={isEvm ? 'ethereum' : 'miden'} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-caption text-muted">{t('address')}</span>
          <p data-testid="add-contact-address" className="break-all text-value text-ink">
            {address}
          </p>
        </div>
      </div>

      <NetworkField
        chain={isEvm ? 'ethereum' : 'miden'}
        network={network}
        onSelect={setNetwork}
        testIdPrefix="add-contact"
      />

      <TextField
        label={t('name')}
        value={name}
        onChange={event => {
          setName(event.target.value);
          setError(undefined);
        }}
        placeholder={t('contactNamePlaceholder')}
        maxLength={NAME_MAX_LENGTH}
        autoFocus
        autoCapitalize="words"
        autoCorrect="off"
        enterKeyHint="done"
        data-testid="address-book-name-input"
      />

      {error && (
        <p role="alert" className="-mt-2 text-body-sm text-negative-ink">
          {error}
        </p>
      )}

      <Button
        type="submit"
        title={t('addContact')}
        variant={ButtonVariant.Primary}
        accent="send"
        disabled={!trimmedName || saving}
        isLoading={saving}
        data-testid="address-book-add-contact"
        className="w-full"
      />
    </form>
  );
};

/**
 * "Add to contacts?" bottom sheet over the recipient step. The address is already known, so it is
 * shown in full as a card to confirm, and the sheet asks only for a name (plus, for a `0x`
 * address, which network the contact is for). Closes once saved, at which point the recipient
 * matches a contact and the pill reverts to "Address Book".
 */
export const AddContactDrawer: React.FC<AddContactDrawerProps> = ({ open, onOpenChange, address, network }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('addContact')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-col overflow-y-auto no-scrollbar">
          {/* Remount per address so a new recipient starts with an empty name. */}
          <SheetBody key={address} address={address} initialNetwork={network} onSaved={() => onOpenChange(false)} />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
