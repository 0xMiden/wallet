import React, { useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import { encodePrivateKeyPair, parsePrivateKeyPair } from 'lib/miden/guardian/private-key-pair';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { decodeQrImage } from 'lib/qr/image-decoder';
import { isScanAvailable, scanQRCode } from 'lib/qr/scanner';
import { ScanQrDrawer } from 'screens/send-flow/ScanQrDrawer';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

export interface ImportHotKeyScreenProps {
  className?: string;
  submitting?: boolean;
  isError?: boolean;
  onSubmit?: (keyPairPayload: string) => void;
}

export const ImportHotKeyScreen: React.FC<ImportHotKeyScreenProps> = ({
  className,
  submitting = false,
  isError: isErrorProp,
  onSubmit
}) => {
  const { t } = useTranslation();
  const [hotKey, setHotKey] = useState('');
  const [evmKey, setEvmKey] = useState('');
  const [manual, setManual] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');
  const generation = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const isGuardReady = useScreenshotGuard();
  const pair = parsePrivateKeyPair(`${hotKey}:${evmKey}`);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );
  useMobileBackHandler(() => {
    if (!cameraOpen) return false;
    setCameraOpen(false);
    return true;
  }, [cameraOpen]);

  const acceptPayload = useCallback((payload: string) => {
    const parsed = parsePrivateKeyPair(payload);
    setHotKey(parsed?.hotPrivateKey ?? '');
    setEvmKey(parsed?.evmPrivateKey ?? '');
    setErrorKey(parsed ? '' : 'importHotKeyInvalid');
  }, []);

  const scan = async () => {
    if (!isGuardReady || busy || submitting) return;
    setErrorKey('');
    setHotKey('');
    setEvmKey('');
    if (!isMobile()) {
      setCameraOpen(true);
      return;
    }
    const request = ++generation.current;
    setBusy(true);
    const result = await scanQRCode(true);
    if (request !== generation.current) return;
    setBusy(false);
    if (result.success && result.address) acceptPayload(result.address);
    else if (result.errorKey !== 'scanCancelled') setErrorKey(result.errorKey ?? 'noQrCodeFound');
  };

  const upload = async (file: File) => {
    const request = ++generation.current;
    setBusy(true);
    setErrorKey('');
    setHotKey('');
    setEvmKey('');
    try {
      const payload = await decodeQrImage(file);
      if (request === generation.current) acceptPayload(payload);
    } catch {
      if (request === generation.current) setErrorKey('invalidQrImage');
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  const toggleManual = () => {
    generation.current += 1;
    setBusy(false);
    setManual(value => !value);
    setErrorKey('');
  };

  return (
    <OnboardingStepLayout
      data-testid="import-hot-key"
      title={t('importHotKeyTitle')}
      description={t('importHotKeyDescription')}
      footer={
        <Button
          data-testid="import-hot-key-submit"
          title={t('continue')}
          disabled={!isGuardReady || !pair || busy || submitting}
          onClick={() => {
            if (!pair || busy || submitting) return;
            generation.current += 1;
            onSubmit?.(encodePrivateKeyPair(pair));
            setHotKey('');
            setEvmKey('');
          }}
        />
      }
    >
      {isGuardReady && (
        <div className={classNames('flex flex-col gap-2.5', className)}>
          {/* Continue is the step's one primary action, so the ways to bring the keys in are secondary. */}
          {!manual && (
            <>
              <Button
                variant={ButtonVariant.Secondary}
                title={t('scanQrTitle')}
                onClick={scan}
                disabled={!isScanAvailable() || busy || submitting}
              />
              {!isScanAvailable() && (
                <p className="px-1 font-sans text-[13px] leading-[17px] text-muted">{t('keyCameraUnavailable')}</p>
              )}
            </>
          )}
          <Button
            title={t('uploadQrImage')}
            variant={ButtonVariant.Secondary}
            onClick={() => fileRef.current?.click()}
            disabled={busy || submitting}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            tabIndex={-1}
            aria-label={t('uploadQrImage')}
            disabled={busy || submitting}
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) upload(file);
            }}
          />
          <TextAction onClick={toggleManual} disabled={submitting} className="-mx-1 self-start">
            {t(manual ? 'showQrCode' : 'enterKeysManually')}
          </TextAction>
          {manual && (
            <>
              <TextField
                id="hot-key-input"
                label={t('midenHotPrivateKey')}
                value={hotKey}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy || submitting}
                onChange={event => {
                  setHotKey(event.target.value);
                  setErrorKey('');
                }}
              />
              <TextField
                id="evm-key-input"
                label={t('evmPrivateKey')}
                value={evmKey}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy || submitting}
                onChange={event => {
                  setEvmKey(event.target.value);
                  setErrorKey('');
                }}
              />
            </>
          )}
          {pair && (
            <Notice tone="positive" role="status">
              {t('privateKeyPairReady')}
            </Notice>
          )}
        </div>
      )}
      {(errorKey || (manual && (hotKey || evmKey) && !pair)) && (
        <Notice tone="negative" role="alert">
          {t(errorKey || 'importHotKeyInvalid')}
        </Notice>
      )}
      {isErrorProp && (
        <Notice tone="negative" role="alert">
          {t('importHotKeyError')}
        </Notice>
      )}
      {isGuardReady && (
        <ScanQrDrawer
          open={cameraOpen}
          rawPayload
          onOpenChange={setCameraOpen}
          onDetected={acceptPayload}
          onError={setErrorKey}
        />
      )}
    </OnboardingStepLayout>
  );
};
