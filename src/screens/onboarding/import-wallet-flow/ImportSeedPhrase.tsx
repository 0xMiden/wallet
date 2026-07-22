import React, { useCallback, useMemo, useState } from 'react';

import { validateMnemonic } from 'bip39';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { formatMnemonic } from 'app/defaults';
import { Button } from 'components/Button';
import { Input } from 'components/Input';

const DELIMITERS = /[\s,;.\-:/\\_|]+/;
const PHRASE_LENGTH = 12;

export interface ImportSeedPhraseScreenProps {
  className?: string;
  wordslist: string[];
  isError?: boolean;
  onSubmit?: (seedPhrase: string) => void;
}

export const ImportSeedPhraseScreen: React.FC<ImportSeedPhraseScreenProps> = ({
  className,
  wordslist,
  isError: isErrorProp,
  onSubmit
}) => {
  const { t } = useTranslation();
  const [seedPhrase, setSeedPhrase] = useState<string[]>(Array.from({ length: PHRASE_LENGTH }, () => ''));

  // Map seep phrase words to wordslist.
  // If a word is not in the wordslist, it's index is mapped to true,
  // otherwise, it's mapped to false
  const errorsMap = useMemo(() => {
    return seedPhrase.map(word => (word ? !wordslist.includes(word) : false));
  }, [seedPhrase, wordslist]);

  const isError = useMemo(() => errorsMap.some(error => error) || isErrorProp, [errorsMap, isErrorProp]);

  // All 12 words are present and belong to the wordlist.
  const allWordsKnown = useMemo(() => seedPhrase.every(word => wordslist.includes(word)), [seedPhrase, wordslist]);

  // A restore also requires a valid BIP-39 checksum. Without this, any 12 words
  // from the wordlist (e.g. a repeated word) would pass and silently derive an
  // unrelated wallet instead of restoring the user's existing one.
  const isValid = useMemo(
    () => allWordsKnown && validateMnemonic(formatMnemonic(seedPhrase.join(' '))),
    [allWordsKnown, seedPhrase]
  );

  // Distinguish a per-word typo (word not in wordlist) from a checksum mismatch
  // (every word is known but the phrase is not a valid mnemonic).
  const isChecksumError = allWordsKnown && !isValid;

  const handleSubmit = useCallback(() => {
    if (onSubmit && isValid) {
      onSubmit(seedPhrase.join(' '));
    }
  }, [onSubmit, isValid, seedPhrase]);

  const onInputPaste: React.ClipboardEventHandler = useCallback(
    event => {
      event.preventDefault();
      const clipboardData = event.clipboardData.getData('text').trim();
      const words = clipboardData.split(DELIMITERS);
      setSeedPhrase(words);
    },
    [setSeedPhrase]
  );

  return (
    <div
      className={classNames(
        'flex-1',
        'flex flex-col justify-start items-center',
        'bg-app-bg text-heading-gray px-4 pt-6',
        className
      )}
      data-testid="import-seed-phrase"
    >
      <h1 className="text-2xl font-semibold">{t('importWallet')}</h1>
      <p className="mt-2 text-sm">{t('enterYourWalletSeedPhrase')}</p>
      <p className="text-sm">{t('onlyMidenSeedPhrasesAreSupported')}</p>

      <div className="grid grid-cols-3 mt-8 gap-2">
        {Array.from({ length: PHRASE_LENGTH }).map((_, index) => (
          <Input
            id={`seed-phrase-input-${index}`}
            key={index}
            value={seedPhrase[index]}
            prefix={`${index + 1}.`}
            onPaste={onInputPaste}
            onChange={event => {
              const newSeedPhrase = [...seedPhrase];
              newSeedPhrase[index] = event.target.value;
              setSeedPhrase(newSeedPhrase);
            }}
          />
        ))}
      </div>
      {isError && <p className="text-red-500 text-xs mt-4">{t('importSeedPhraseError')}</p>}
      {isChecksumError && <p className="text-red-500 text-xs mt-4">{t('justValidPreGeneratedMnemonic')}</p>}

      <div className="mt-auto w-full">
        <Button
          id={'submit-button'}
          title={t('continue')}
          onClick={handleSubmit}
          disabled={!isValid}
          className="w-full"
        />
      </div>
    </div>
  );
};
