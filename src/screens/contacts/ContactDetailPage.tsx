import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button, ButtonVariant } from 'components/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { FlowLayout } from 'components/flow/FlowLayout';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { getCurrentLocale } from 'lib/i18n/core';
import { useContacts } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletContact } from 'lib/shared/types';
import { useConfirm } from 'lib/ui/dialog';
import { navigate, Redirect } from 'lib/woozie';
import { BridgeNetworkId } from 'screens/send-flow/bridge-networks';
import { NetworkField } from 'screens/send-flow/NetworkField';

import { contactNetwork } from './contact-network';
import { ADDRESS_BOOK_PATH } from './contact-paths';
import { ContactNameInput } from './ContactNameInput';

// The app's locale ids use an underscore (`en_US`); `Intl` wants a BCP 47 tag and throws on one.
function formatAddedDate(addedAt: number): string {
  return new Date(addedAt).toLocaleDateString(getCurrentLocale().replace('_', '-'), { dateStyle: 'medium' });
}

/** The Send flow, opened with this contact as the recipient. */
export function sendToContactPath(contact: Pick<WalletContact, 'address' | 'network'>): string {
  const params = new URLSearchParams({ to: contact.address });
  if (contact.network) params.set('network', contact.network);
  return `/send?${params.toString()}`;
}

interface ContactViewProps {
  contact: WalletContact;
  onBack: () => void;
  onDeleted: () => void;
}

const ContactView: React.FC<ContactViewProps> = ({ contact, onBack, onDeleted }) => {
  const { t } = useTranslation();
  const { updateContact, removeContact } = useContacts();
  const confirm = useConfirm();
  const { kind, bridgeNetwork } = contactNetwork(contact.address, contact.network);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name);
  const [network, setNetwork] = useState<BridgeNetworkId | undefined>(bridgeNetwork?.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const trimmedName = name.trim();
  const changed = trimmedName !== contact.name || (kind === 'ethereum' && network !== contact.network);

  const startEditing = () => {
    setName(contact.name);
    setNetwork(bridgeNetwork?.id);
    setError(undefined);
    setEditing(true);
  };

  const save = async () => {
    if (!trimmedName || !changed || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await updateContact(contact.address, {
        name: trimmedName,
        ...(kind === 'ethereum' ? { network } : {})
      });
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: t('deleteContact'),
      children: t('deleteContactConfirm'),
      confirmLabel: t('delete'),
      destructive: true
    });
    if (!confirmed) return;
    onDeleted();
    await removeContact(contact.address);
  };

  // The name is already in the page header (or, while editing, the name field below), so the
  // hero here is the avatar alone.
  const avatar = (
    <Hero
      className="pb-2"
      visual={
        <ContactAvatar
          address={contact.address}
          name={editing ? trimmedName : contact.name}
          network={kind === 'ethereum' ? kind : undefined}
          size="xl"
        />
      }
    />
  );

  if (editing) {
    return (
      <FlowLayout
        title={t('editContact')}
        onBack={() => setEditing(false)}
        footer={
          <Button
            title={t('saveContact')}
            variant={ButtonVariant.Primary}
            onClick={() => void save()}
            disabled={!trimmedName || !changed || saving}
            isLoading={saving}
            data-testid="contact-save"
            className="w-full max-w-none"
          />
        }
      >
        <form
          className="flex flex-col gap-5 pb-4"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          {avatar}
          <ContactNameInput value={name} onChange={setName} autoFocus />
          <NetworkField
            chain={kind === 'ethereum' ? 'ethereum' : 'miden'}
            network={network}
            onSelect={setNetwork}
            testIdPrefix="contact"
          />
          {error && (
            <p role="alert" className="-mt-2 text-sm text-status-negative">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              hapticLight();
              void remove();
            }}
            data-testid="contact-delete"
            className="mt-2 h-12 w-full rounded-full bg-fill text-row-title text-status-negative"
          >
            {t('deleteContact')}
          </button>
        </form>
      </FlowLayout>
    );
  }

  return (
    <FlowLayout
      title={contact.name}
      titleAccessory={
        <Pill onClick={startEditing} data-testid="contact-edit">
          {t('edit')}
        </Pill>
      }
      onBack={onBack}
      footer={
        <Button
          title={t('send')}
          variant={ButtonVariant.Primary}
          onClick={() => navigate(sendToContactPath(contact))}
          data-testid="contact-send"
          className="w-full max-w-none"
        />
      }
    >
      {avatar}
      <DetailCard className="mt-4">
        <DetailRow label={t('address')} stacked data-testid="contact-address">
          <span className="min-w-0 font-sans font-semibold">{contact.address}</span>
          <CopyButton text={contact.address} data-testid="contact-copy-address" />
        </DetailRow>
        <DetailRow label={t('network')} data-testid="contact-network">
          {bridgeNetwork?.name ?? t('miden')}
        </DetailRow>
        {contact.addedAt && <DetailRow label={t('contactAdded')}>{formatAddedDate(contact.addedAt)}</DetailRow>}
      </DetailCard>
    </FlowLayout>
  );
};

/**
 * A saved contact: its full address (to copy or check), network and when it was added, with Send
 * as the page's action. Edit renames it (and, for a `0x` contact, changes its network) and holds
 * Delete, so the destructive action is one step removed from the list.
 */
export const ContactDetailPage: React.FC<{ address: string }> = ({ address }) => {
  const { allContacts } = useFilteredContacts();
  const back = useBackWithFallback(ADDRESS_BOOK_PATH);
  // Set on delete, so the contact vanishing from the store reads as leaving, not as an unknown id.
  const [deleted, setDeleted] = useState(false);
  const contact = allContacts.find(c => c.address === address && !c.accountInWallet);

  if (deleted) return null;
  if (!contact) return <Redirect to={ADDRESS_BOOK_PATH} />;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="contact-detail">
      <ContactView
        contact={contact}
        onBack={back}
        onDeleted={() => {
          setDeleted(true);
          back();
        }}
      />
    </div>
  );
};
