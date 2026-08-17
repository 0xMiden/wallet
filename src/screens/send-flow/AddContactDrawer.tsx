import React from 'react';

import { useTranslation } from 'react-i18next';

import { AddNewContactForm } from 'app/templates/AddNewContactForm';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface AddContactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The recipient address typed on the send step; pre-fills the form, still editable. */
  address: string;
}

/**
 * "Add to contacts?" bottom sheet over the recipient step. Wraps the same
 * `AddNewContactForm` the Settings address book uses, pre-filled with the
 * entered recipient, and closes itself once the contact is saved — at which
 * point the recipient matches a contact and the pill reverts to "Address Book".
 */
export const AddContactDrawer: React.FC<AddContactDrawerProps> = ({ open, onOpenChange, address }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('addContact')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col min-h-0 overflow-y-auto no-scrollbar px-4 pb-4">
          {/* Remount on address change so the pre-filled default is picked up. */}
          <AddNewContactForm key={address} defaultAddress={address} hideHeading onAdded={() => onOpenChange(false)} />
        </div>
      </DrawerContent>
    </Drawer>
  );
};
