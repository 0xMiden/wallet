import React, { useCallback, useState } from 'react';

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
  /**
   * Reported upward so EVERY writer of this sheet's open state can gate on the in-flight write,
   * not just the dismissals vaul routes through `onOpenChange`. The mobile back handler closes the
   * sheet by setting that state directly, which is the fourth dismissal path.
   */
  onBusyChange?: (busy: boolean) => void;
}

interface SheetBodyProps {
  address: string;
  initialNetwork?: BridgeNetworkId;
  onSaved: () => void;
  /** Reported upward so the sheet cannot be dismissed out from under an in-flight write. */
  onBusyChange: (busy: boolean) => void;
}

const SheetBody: React.FC<SheetBodyProps> = ({ address, initialNetwork, onSaved, onBusyChange }) => {
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
    onBusyChange(true);
    setError(undefined);
    try {
      await addContact({
        address,
        name: trimmedName,
        addedAt: Date.now(),
        ...(isEvm ? { network } : {})
      });
      // Raise and lower in the same function. `onSaved` closes the sheet through the raw prop, and
      // the flag lives in the PARENT, which outlives this body and survives close/reopen - so a
      // success that does not lower it left the sheet permanently undismissable.
      onBusyChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
      onBusyChange(false);
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
      <div className="flex items-start gap-3 rounded-2xl bg-surface-interactive p-4">
        <ContactAvatar address={address} name={trimmedName} network={isEvm ? 'ethereum' : 'miden'} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm text-text-muted">{t('address')}</span>
          <p
            data-testid="add-contact-address"
            className="font-heading text-base leading-6 font-bold break-all text-heading-gray"
          >
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
        <p role="alert" className="-mt-2 text-sm text-negative-ink">
          {error}
        </p>
      )}

      <Button
        type="submit"
        title={t('addContact')}
        variant={ButtonVariant.Primary}
        disabled={!trimmedName || saving}
        isLoading={saving}
        data-testid="address-book-add-contact"
        className="w-full max-w-none rounded-full text-base font-semibold"
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
export const AddContactDrawer: React.FC<AddContactDrawerProps> = ({
  open,
  onOpenChange,
  onBusyChange,
  address,
  network
}) => {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const setBusy = useCallback(
    (busy: boolean) => {
      setSaving(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange]
  );

  return (
    // A dismiss - swipe, backdrop, Escape - all route through onOpenChange, and the sheet body
    // holds the only node that can show a failed save. Ignore a dismiss while the write is in
    // flight, the same rule as the header back on the contact pages.
    <Drawer
      open={open}
      onOpenChange={next => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('addContact')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-col overflow-y-auto no-scrollbar">
          {/* Remount per address so a new recipient starts with an empty name. */}
          <SheetBody
            key={address}
            address={address}
            initialNetwork={network}
            onSaved={() => onOpenChange(false)}
            onBusyChange={setBusy}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
