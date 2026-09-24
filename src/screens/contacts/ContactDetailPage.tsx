import React, { useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Button, ButtonVariant } from 'components/ui/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { getCurrentLocale } from 'lib/i18n/core';
import { useContacts } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { WalletContact } from 'lib/shared/types';
import { useConfirm } from 'lib/ui/dialog';
import useIsMounted from 'lib/ui/useIsMounted';
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
  /**
   * "Keep rendering me even if my row leaves the store." Raised BEFORE either write starts, so the
   * page stops treating the row's absence as an unknown id, and lowered only once there is nothing
   * left to show - which includes an error the user has not acknowledged, not just a settled write.
   */
  onRetain: (retain: boolean) => void;
  onDeleted: () => void;
}

const ContactView: React.FC<ContactViewProps> = ({ contact, onBack, onRetain, onDeleted }) => {
  const { t } = useTranslation();
  const { updateContact, removeContact } = useContacts();
  const confirm = useConfirm();
  const { kind, bridgeNetwork } = contactNetwork(contact.address, contact.network);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name);
  const [network, setNetwork] = useState<BridgeNetworkId | undefined>(bridgeNetwork?.id);
  const [saving, setSaving] = useState(false);
  // Only cleared on failure: a success unmounts this page via `onDeleted`.
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();

  // `updateContact` and `removeContact` each rewrite the ENTIRE contact list from the same
  // render-time snapshot, so two overlapping writers is last-writer-wins: saving during an
  // in-flight delete would write the pre-delete list back and resurrect the contact. One flag.
  const busy = saving || removing;

  // Leaving edit mode is the user acknowledging whatever the editor was showing, so it clears the
  // error AND releases the row. Without the release the page would go on rendering a contact that
  // no longer exists, with nothing left on screen to explain why.
  const leaveEdit = useCallback(() => {
    setError(undefined);
    onRetain(false);
    setEditing(false);
  }, [onRetain]);

  // The header back is not the only way off this page: on mobile the hardware back and the swipe
  // gesture fall through to the global MobileBackBridge, which pops unconditionally with no
  // knowledge of this page's state.
  // Consume exactly the states the header back consumes. Gating on `busy` alone left edit mode
  // disagreeing with the chevron: the chevron closed the editor and stayed, while the gesture fell
  // through to the global bridge, which pops unconditionally and took the typed name with it.
  useMobileBackHandler(() => {
    if (busy) return true;
    if (editing) {
      leaveEdit();
      return true;
    }
    return false;
  }, [busy, editing, leaveEdit]);

  const trimmedName = name.trim();
  // Compare against the RESOLVED network, not the raw stored one: `contactNetwork` falls back to
  // DEFAULT_BRIDGE_NETWORK, so a `0x` contact saved without a network seeds `network` to that
  // default while `contact.network` stays undefined - which read as "changed" the moment edit mode
  // opened, enabling Save with nothing edited and writing a network the user never picked.
  const changed = trimmedName !== contact.name || (kind === 'ethereum' && network !== bridgeNetwork?.id);

  const startEditing = () => {
    setName(contact.name);
    setNetwork(bridgeNetwork?.id);
    setError(undefined);
    setEditing(true);
  };

  const save = async () => {
    if (!trimmedName || !changed || busy) return;
    // BEFORE the write, not from an effect keyed on `busy`: `updateSettings` applies its optimistic
    // `set()` synchronously, so the row can leave the store in this same tick. A post-commit report
    // arrives one render too late and the page redirects out from under the write.
    onRetain(true);
    setSaving(true);
    setError(undefined);
    let failed: string | undefined;
    try {
      await updateContact(contact.address, {
        name: trimmedName,
        ...(kind === 'ethereum' ? { network } : {})
      });
      setEditing(false);
    } catch (err: unknown) {
      failed = err instanceof Error ? err.message : String(err);
      setError(failed);
    }
    setSaving(false);
    // Lower to what is still true. Clearing unconditionally here would drop the row while the
    // rejection is on screen, unmounting the only node that can report it.
    onRetain(failed !== undefined);
  };

  const remove = async () => {
    if (busy) return;
    const confirmed = await confirm({
      title: t('deleteContact'),
      children: t('deleteContactConfirm'),
      confirmLabel: t('delete'),
      destructive: true
    });
    if (!confirmed) return;
    // Report the delete only once it has landed. Calling `onDeleted()` first navigated away before
    // the write was attempted, so a rejection left the user on a list still showing the contact
    // with nothing said. The busy flag is the other half of the same change: until now the button
    // was safe only because the page unmounted before the await, so awaiting first would otherwise
    // leave it live for a second tap.
    setRemoving(true);
    setError(undefined);
    onRetain(true);
    try {
      await removeContact(contact.address);
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setRemoving(false);
      // Stay retained: the row is already gone from the store and this error is the only thing
      // left explaining why the contact is still on screen.
    }
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
        // The error node below lives in THIS branch, so leaving edit mode mid-write destroys the
        // only thing that can report a failure - restoring the silent failure the delete fix
        // removed. Every other control here is gated on `busy`; this one has to be too.
        onBack={() => {
          if (!busy) leaveEdit();
        }}
        footer={
          <Button
            title={t('saveContact')}
            variant={ButtonVariant.Primary}
            onClick={() => void save()}
            disabled={!trimmedName || !changed || busy}
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
            disabled={busy}
            data-testid="contact-delete"
            className="mt-2 h-12 w-full rounded-full bg-fill text-row-title text-status-negative disabled:opacity-50"
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
          {/* The row's `children` and its `action` slot render as siblings in the same flex box, so
              the shared CopyButton sits where a text action would and owns its own copied state. */}
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
  const isMounted = useIsMounted();
  // Set on delete, so the contact vanishing from the store reads as leaving, not as an unknown id.
  const [deleted, setDeleted] = useState(false);
  // Raised by ContactView before EITHER write starts, and lowered only when nothing is left to
  // show. `updateSettings` applies its optimistic `set()` synchronously (store/index.ts), so the
  // row leaves the store the moment `removeContact` or `updateContact` is called, not when it
  // resolves. Without this the page reads that removal as an unknown id and redirects mid-write,
  // and the rejection is then reported to a page that has already gone. It covers the save writer
  // too: the row can vanish under a rename for reasons this page never initiated - most concretely
  // the render-phase self-heal in `useFilteredContacts`, which drops any contact whose address
  // matches a wallet account.
  const [retain, setRetain] = useState(false);
  const found = allContacts.find(c => c.address === address && !c.accountInWallet);
  const lastKnown = useRef(found);
  if (found) lastKnown.current = found;
  // While there is anything left to show for this row - a write in flight, or an error the user
  // has not acknowledged - keep rendering it, so a failure has somewhere to land.
  const contact = found ?? (retain ? lastKnown.current : undefined);

  if (deleted) return null;
  if (!contact) return <Redirect to={ADDRESS_BOOK_PATH} />;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="contact-detail">
      <ContactView
        contact={contact}
        onBack={back}
        onRetain={setRetain}
        onDeleted={() => {
          setDeleted(true);
          // Pop OUR OWN entry, and only while this page is still the live one. Replacing with the
          // address-book URL instead left it duplicated in two adjacent entries (the page is
          // entered by a push FROM the address book), so the next Back popped onto an identical
          // URL and appeared to do nothing. Liveness is the "has the user moved on" signal that
          // a relative back needs: moving away unmounts this page, and then we must not navigate
          // at all rather than traverse from wherever they now are.
          if (isMounted()) back();
        }}
      />
    </div>
  );
};
