import React, { useCallback, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { ReactComponent as ScanFrameIcon } from 'app/icons/scan-frame.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ContactAvatar } from 'components/contacts/ContactAvatar';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Pill } from 'components/ui/Pill';
import { TextField } from 'components/ui/TextField';
import { useContacts } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { isMobile } from 'lib/platform';
import { isScanAvailable, scanQRCode } from 'lib/qr';
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
  const reduceMotion = useReducedMotion();
  const { addContact } = useContacts();
  const { allContacts } = useFilteredContacts();
  const back = useBackWithFallback(ADDRESS_BOOK_PATH);

  const [address, setAddress] = useState('');
  // The invalid-address message waits until the field is left (or filled by paste or scan), so it
  // does not flash on every keystroke of an address still being typed.
  const [addressTouched, setAddressTouched] = useState(false);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<BridgeNetworkId>(DEFAULT_BRIDGE_NETWORK.id);
  const [scanError, setScanError] = useState<string>();
  const [pasteError, setPasteError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [showScanDrawer, setShowScanDrawer] = useState(false);

  const trimmedAddress = address.trim();
  const trimmedName = name.trim();
  const isValid = isValidRecipientAddress(trimmedAddress);
  const isEvm = detectAddressChain(trimmedAddress) === 'ethereum';
  const existing = isValid
    ? allContacts.find(c => c.address.trim().toLowerCase() === trimmedAddress.toLowerCase())
    : undefined;

  let addressError: string | undefined;
  if (scanError) addressError = t(scanError);
  else if (pasteError) addressError = t(pasteError);
  else if (trimmedAddress && !isValid && addressTouched) addressError = t('invalidAddress');
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
        address: trimmedAddress,
        name: trimmedName,
        addedAt: Date.now(),
        ...(isEvm ? { network } : {})
      });
      back();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="contact-new">
      <FlowLayout
        title={t('newContact')}
        onBack={back}
        footer={
          <Button
            title={t('addContact')}
            variant={ButtonVariant.Primary}
            onClick={() => void save()}
            disabled={!canSave}
            isLoading={saving}
            data-testid="address-book-add-contact"
            className="w-full max-w-none rounded-full text-base font-semibold"
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
          <div className="flex justify-center">
            <ContactAvatar
              address={trimmedAddress || '0'}
              name={trimmedName}
              network={isValid && isEvm ? 'ethereum' : undefined}
              size="xl"
            />
          </div>

          <TextField
            multiline
            label={t('address')}
            value={address}
            onChange={event => {
              setAddress(event.target.value);
              setScanError(undefined);
              setPasteError(undefined);
              setSaveError(undefined);
            }}
            onBlur={() => setAddressTouched(true)}
            placeholder={t('enterAddress')}
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

          <AnimatePresence initial={false}>
            {isValid && (
              <motion.div
                key="network"
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <NetworkField
                  chain={isEvm ? 'ethereum' : 'miden'}
                  network={network}
                  onSelect={setNetwork}
                  testIdPrefix="new-contact"
                />
              </motion.div>
            )}
          </AnimatePresence>

          <ContactNameInput value={name} onChange={setName} />

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
