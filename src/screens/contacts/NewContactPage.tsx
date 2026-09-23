import React, { useCallback, useEffect, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { Icon, IconName } from 'app/icons/v2';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { TextField } from 'components/ui/TextField';
import { usePreset } from 'lib/animation';
import { useContacts } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { isMidenNameSupported } from 'lib/miden/name/config';
import { formatMidenName, looksLikeMidenName, normalizeMidenNameInput } from 'lib/miden/name/encoding';
import { resolveMidenName } from 'lib/miden/name/resolver';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { isScanAvailable, scanQRCode } from 'lib/qr';
import useIsMounted from 'lib/ui/useIsMounted';
import { BridgeNetworkId, DEFAULT_BRIDGE_NETWORK } from 'screens/send-flow/bridge-networks';
import { NetworkField } from 'screens/send-flow/NetworkField';
import { ScanQrDrawer } from 'screens/send-flow/ScanQrDrawer';
import { detectAddressChain, isValidRecipientAddress } from 'utils/miden';

import { ADDRESS_BOOK_PATH } from './contact-paths';
import { ContactNameInput } from './ContactNameInput';

/**
 * New contact, from Settings → Address Book: the address (typed, pasted or scanned), its network,
 * and a name. The address is checked as it is entered, including against the address book, so a
 * duplicate is caught before the name is typed rather than on save.
 */
export const NewContactPage: React.FC = () => {
  const { t } = useTranslation();
  const reveal = usePreset('reveal');
  const { addContact } = useContacts();
  const { allContacts } = useFilteredContacts();
  const back = useBackWithFallback(ADDRESS_BOOK_PATH);
  const isMounted = useIsMounted();

  const [address, setAddress] = useState('');
  // The invalid-address message waits until the field is left (or filled by paste or scan), so it
  // does not flash on every keystroke of an address still being typed.
  const [addressTouched, setAddressTouched] = useState(false);
  const [name, setName] = useState<string>();
  const [nameLookup, setNameLookup] = useState<{ input: string; address?: string; error?: string }>();
  const [network, setNetwork] = useState<BridgeNetworkId>(DEFAULT_BRIDGE_NETWORK.id);
  const [scanError, setScanError] = useState<string>();
  const [pasteError, setPasteError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [showScanDrawer, setShowScanDrawer] = useState(false);

  // Same rule as the contact detail page: the gated header back is not the only exit on mobile.
  useMobileBackHandler(() => saving, [saving]);

  const trimmedAddress = address.trim();
  const isMidenName = looksLikeMidenName(trimmedAddress);
  const nameSupported = isMidenNameSupported();
  const lookup = nameLookup?.input === trimmedAddress ? nameLookup : undefined;
  const resolving = isMidenName && nameSupported && !lookup?.address && !lookup?.error;
  const resolvedAddress = isMidenName ? (nameSupported ? (lookup?.address ?? '') : '') : trimmedAddress;
  const suggestedName = isMidenName && lookup?.address ? formatMidenName(normalizeMidenNameInput(trimmedAddress)) : '';
  const displayName = name ?? suggestedName;
  const trimmedName = displayName.trim();
  const isValid = isValidRecipientAddress(resolvedAddress);
  const isEvm = detectAddressChain(resolvedAddress) === 'ethereum';
  const existing = isValid
    ? allContacts.find(c => c.address.trim().toLowerCase() === resolvedAddress.toLowerCase())
    : undefined;

  useEffect(() => {
    if (!isMidenName || !nameSupported) return;
    const controller = new AbortController();
    setNameLookup({ input: trimmedAddress });
    const timer = setTimeout(async () => {
      try {
        const result = await resolveMidenName(normalizeMidenNameInput(trimmedAddress), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setNameLookup({
          input: trimmedAddress,
          address: result ?? undefined,
          error: result ? undefined : 'midenNameNotFound'
        });
      } catch {
        if (!controller.signal.aborted) setNameLookup({ input: trimmedAddress, error: 'midenNameResolveFailed' });
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedAddress, isMidenName, nameSupported]);

  let addressError: string | undefined;
  if (scanError) addressError = t(scanError);
  else if (pasteError) addressError = t(pasteError);
  else if (isMidenName && !nameSupported) addressError = t('midenNameUnsupportedNetwork');
  else if (isMidenName && lookup?.error) addressError = t(lookup.error);
  else if (trimmedAddress && !isValid && !resolving && addressTouched) addressError = t('invalidAddress');
  else if (existing?.accountInWallet) addressError = t('contactIsYourAccount');
  else if (existing) addressError = t('contactAlreadySaved', { name: existing.name });

  const canSave = isValid && !existing && Boolean(trimmedName) && !saving;

  const fillAddress = useCallback((value: string) => {
    setAddress(value);
    setAddressTouched(true);
    setScanError(undefined);
    setPasteError(undefined);
    setSaveError(undefined);
  }, []);

  // Mobile only, as in the send flow: the native clipboard is the one read that works there, and
  // off mobile the platform's own paste into the field does.
  const onPaste = async () => {
    setScanError(undefined);
    setPasteError(undefined);
    try {
      const { value, type } = await Clipboard.read();
      const text = type?.startsWith('text') ? value.trim() : '';
      if (text) fillAddress(text);
      else setPasteError('nothingToPaste');
    } catch {
      // Rejects with no data on the clipboard (empty clipboard, or the paste prompt was refused).
      setPasteError('nothingToPaste');
    }
  };

  const onScan = async () => {
    setPasteError(undefined);
    if (!isMobile()) {
      setShowScanDrawer(true);
      return;
    }
    const result = await scanQRCode();
    if (result.success && result.address) fillAddress(result.address);
    else if (result.errorKey && result.errorKey !== 'scanCancelled') setScanError(result.errorKey);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await addContact({
        address: resolvedAddress,
        name: trimmedName,
        addedAt: Date.now(),
        ...(isEvm ? { network } : {})
      });
      // Pop our own entry, and only while this page is still live - see the delete in
      // ContactDetailPage for why a named Replace duplicates the address book in history.
      if (isMounted()) back();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="contact-new">
      <FlowLayout
        title={t('newContact')}
        // `back` is claim-gated once per location, and `save()` calls it again when the write
        // lands. A tap while the save is in flight consumes the claim AND navigates, which resets
        // the claim - so the save's own `back()` then fires a second time and overshoots by a
        // screen. The save navigates on completion regardless, so ignore the tap while it runs.
        onBack={() => {
          if (!saving) back();
        }}
        footer={
          <Button
            title={t('addContact')}
            variant={ButtonVariant.Primary}
            onClick={() => void save()}
            disabled={!canSave}
            isLoading={saving}
            data-testid="address-book-add-contact"
            className="w-full max-w-none"
          />
        }
      >
        <form
          className="flex flex-col gap-5 pt-6 pb-4"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          {/* The name is already in the flow title above (or the name field below), so the
              hero here is the avatar alone — same shape as the existing contact's own page. */}
          <Hero
            visual={
              <ContactAvatar
                address={resolvedAddress || '0'}
                name={trimmedName}
                network={isValid && isEvm ? 'ethereum' : undefined}
                size="xl"
              />
            }
          />

          <TextField
            multiline
            label={t('contactAddressOrMidenName')}
            value={address}
            onChange={event => {
              setAddress(event.target.value);
              setScanError(undefined);
              setPasteError(undefined);
              setSaveError(undefined);
            }}
            onBlur={() => setAddressTouched(true)}
            placeholder={t('contactAddressOrMidenNamePlaceholder')}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="break-all"
            data-testid="address-book-address-input"
            error={addressError}
            errorTestId="contact-address-error"
            trailing={
              !trimmedAddress && (isMobile() || isScanAvailable()) ? (
                <>
                  {isMobile() && (
                    <Pill
                      tone="plain"
                      className="bg-page text-ink"
                      icon={<Icon name={IconName.FileCopy} size="xs" />}
                      onClick={() => void onPaste()}
                      data-testid="contact-paste"
                    >
                      {t('paste')}
                    </Pill>
                  )}
                  {isScanAvailable() && (
                    <Pill
                      tone="plain"
                      className="bg-page text-ink"
                      icon={<ScanFrameIcon />}
                      onClick={() => void onScan()}
                      data-testid="contact-scan"
                    >
                      {t('scan')}
                    </Pill>
                  )}
                </>
              ) : undefined
            }
          />

          {resolving && (
            <p role="status" className="text-body-sm text-muted">
              {t('midenNameResolving')}
            </p>
          )}
          {isMidenName && isValid && (
            <p className="break-all text-body-sm text-muted" data-testid="contact-resolved-address">
              {t('contactResolvedAddress', { address: resolvedAddress })}
            </p>
          )}

          <AnimatePresence initial={false}>
            {isValid && (
              <motion.div key="network" {...reveal} className="overflow-hidden">
                <NetworkField
                  chain={isEvm ? 'ethereum' : 'miden'}
                  network={network}
                  onSelect={setNetwork}
                  testIdPrefix="new-contact"
                />
              </motion.div>
            )}
          </AnimatePresence>

          <ContactNameInput value={displayName} onChange={setName} />

          {saveError && (
            <p role="alert" className="-mt-2 text-sm text-negative-ink">
              {saveError}
            </p>
          )}
        </form>
      </FlowLayout>

      <ScanQrDrawer
        open={showScanDrawer}
        onOpenChange={setShowScanDrawer}
        onDetected={address => {
          setShowScanDrawer(false);
          fillAddress(address);
        }}
        onError={setScanError}
      />
    </div>
  );
};
