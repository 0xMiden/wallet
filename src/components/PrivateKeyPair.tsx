import React, { useEffect, useRef, useState } from 'react';

import QRCodeStyling from 'qr-code-styling';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { parsePrivateKeyPair } from 'lib/miden/guardian/private-key-pair';

/** Kept separate from address QR encoding: no prefix or plaintext DOM attribute. */
export function PrivateKeyPair({ payload }: { payload: string }) {
  const { t } = useTranslation();
  const [textMode, setTextMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pair = parsePrivateKeyPair(payload);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || textMode) return;
    const qr = new QRCodeStyling({
      type: 'canvas',
      width: 260,
      height: 260,
      margin: 12,
      data: payload,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: '#000000' },
      backgroundOptions: { color: '#ffffff' }
    });
    qr.append(container);
    return () => {
      container.replaceChildren();
    };
  }, [payload, textMode]);

  if (!pair) return <p role="alert">{t('importHotKeyInvalid')}</p>;
  const fields = [
    { id: 'midenHotPrivateKey', label: t('midenHotPrivateKey'), value: pair.hotPrivateKey },
    { id: 'evmPrivateKey', label: t('evmPrivateKey'), value: pair.evmPrivateKey }
  ];
  return (
    <div className="flex flex-1 min-h-0 overflow-y-auto flex-col items-center gap-6 pt-6">
      <p className="text-sm text-text-secondary-token">{t('privateKeyPairWarning')}</p>
      {textMode ? (
        <div key="text" className="flex w-full flex-col gap-4">
          {fields.map(field => (
            <div key={field.id} className="flex flex-col gap-2">
              <label htmlFor={field.id} className="text-sm text-text-primary-token">
                {field.label}
              </label>
              <textarea
                id={field.id}
                readOnly
                value={field.value}
                rows={3}
                spellCheck={false}
                className="w-full resize-none rounded-lg bg-surface-input p-3 font-sans text-sm text-text-primary-token focus-visible:outline focus-visible:outline-2"
              />
            </div>
          ))}
        </div>
      ) : (
        <div
          key="qr"
          ref={containerRef}
          role="img"
          aria-label={t('privateKeyPairQr')}
          className="bg-pure-white rounded-lg"
        />
      )}
      <Button
        variant={ButtonVariant.Secondary}
        className="mt-auto w-full mb-6"
        title={t(textMode ? 'showQrCode' : 'showPrivateKeyText')}
        onClick={() => setTextMode(value => !value)}
      />
    </div>
  );
}
