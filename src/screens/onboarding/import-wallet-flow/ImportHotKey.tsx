import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Input } from 'components/Input';
import { normalizeHotSecretKeyHex } from 'lib/miden/guardian/hot-key-import';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';

export interface ImportHotKeyScreenProps {
  className?: string;
  submitting?: boolean;
  isError?: boolean;
  onSubmit?: (hotKeyHex: string) => void;
}

/**
 * Seed-less Guardian import: paste the account's HOT (everyday) private key.
 * Accepts the 64-hex raw scalar the wallet's "Reveal hot key" shows, or the
 * full 66-hex serialized form, with or without a `0x` prefix. Deep validation
 * (deserialize, scheme, guardian lookup) happens in the probe and the vault —
 * this screen only gates Continue on the shape being plausible.
 */
export const ImportHotKeyScreen: React.FC<ImportHotKeyScreenProps> = ({
  className,
  submitting = false,
  isError: isErrorProp,
  onSubmit
}) => {
  const { t } = useTranslation();
  const [rawInput, setRawInput] = useState('');

  // Block screenshots/recordings while raw key material is on screen (#417) —
  // the same guard the seed grid carries; a hot key is signing material of the
  // same day-to-day sensitivity. isGuardReady is always true off-mobile.
  const isGuardReady = useScreenshotGuard();

  const normalized = useMemo(() => normalizeHotSecretKeyHex(rawInput), [rawInput]);
  const isValid = normalized !== null;
  const showFormatError = rawInput.trim() !== '' && !isValid;

  const handleSubmit = useCallback(() => {
    if (onSubmit && normalized) onSubmit(normalized);
  }, [onSubmit, normalized]);

  return (
    <div
      className={classNames(
        'flex-1',
        'flex flex-col justify-start items-center',
        'bg-app-bg text-heading-gray px-4 pt-6',
        className
      )}
      data-testid="import-hot-key"
    >
      <h1 className="text-2xl font-semibold">{t('importHotKeyTitle')}</h1>
      <p className="mt-2 text-sm text-center">{t('importHotKeyDescription')}</p>

      {isGuardReady && (
        <div className="w-full mt-8">
          <Input
            id="hot-key-input"
            value={rawInput}
            type="password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            placeholder={t('importHotKeyPlaceholder')}
            onChange={event => setRawInput(event.target.value)}
          />
        </div>
      )}
      {showFormatError && <p className="text-red-500 text-xs mt-4">{t('importHotKeyInvalid')}</p>}
      {isErrorProp && <p className="text-red-500 text-xs mt-4">{t('importHotKeyError')}</p>}

      <div className="mt-auto w-full shrink-0 pt-6">
        <Button
          id="submit-button"
          data-testid="import-hot-key-submit"
          title={t('continue')}
          onClick={handleSubmit}
          disabled={!isValid || submitting}
          className="w-full"
        />
      </div>
    </div>
  );
};
