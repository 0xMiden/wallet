import React, { useCallback, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { validateMnemonic } from '@miden/hd-key';
import { formatMnemonic } from 'app/defaults';
import { Button } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import { TextAction } from 'components/ui/TextAction';
import { TextField, TextFieldElement } from 'components/ui/TextField';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { isMobile } from 'lib/platform';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

const DELIMITERS = /[\s,;.\-:/\\_|]+/;
const PHRASE_LENGTH = 12;

// BIP-39 words are lowercase with no whitespace; normalize pasted/typed input
// (capitalized or padded words would otherwise fail the wordlist check).
const cleanWord = (word: string) => word.toLowerCase().replace(/\s+/g, '');

export interface ImportSeedPhraseScreenProps {
  titleKey?: string;
  descriptionKey?: string;
  submitting?: boolean;
  wordslist: readonly string[];
  isError?: boolean;
  onSubmit?: (seedPhrase: string) => void;
  /**
   * When set, renders the "Import with key instead" link below the word grid
   * (the seed-less Guardian import). Left unset by the non-onboarding hosts
   * (RecoverySeedPrompt), which renders no link.
   */
  onImportWithKey?: () => void;
}

export const ImportSeedPhraseScreen: React.FC<ImportSeedPhraseScreenProps> = ({
  titleKey = 'importWallet',
  descriptionKey = 'enterYourWalletSeedPhrase',
  submitting = false,
  wordslist,
  isError: isErrorProp,
  onSubmit,
  onImportWithKey
}) => {
  const { t } = useTranslation();
  const [seedPhrase, setSeedPhrase] = useState<string[]>(Array.from({ length: PHRASE_LENGTH }, () => ''));

  // Block screenshots/recordings while the user's existing seed phrase is on screen
  // (#417). The import grid renders the mnemonic in plaintext, so gate it on the native
  // guard being active — mirrors the backup/reveal/verify screens. isGuardReady is always
  // true off-mobile, so the extension/desktop render is unchanged.
  const isGuardReady = useScreenshotGuard();

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
  const isChecksumValid = useMemo(() => validateMnemonic(formatMnemonic(seedPhrase.join(' '))), [seedPhrase]);

  const isValid = isChecksumValid && allWordsKnown;

  // Distinguish a per-word typo (word not in wordlist) from a checksum mismatch
  // (every word is known but the phrase is not a valid mnemonic).
  const isChecksumError = allWordsKnown && !isChecksumValid;

  const handleSubmit = useCallback(() => {
    if (onSubmit && isValid) {
      onSubmit(seedPhrase.join(' '));
    }
  }, [onSubmit, isValid, seedPhrase]);

  const onInputPaste: React.ClipboardEventHandler = useCallback(
    event => {
      event.preventDefault();
      // cleanWord lowercases + strips whitespace so a mixed-case paste (e.g. from a
      // password manager) still passes the lowercase-only BIP-39 wordlist + checksum
      // check; filter empties and pad/truncate to exactly PHRASE_LENGTH slots.
      const clipboardData = event.clipboardData.getData('text').trim();
      const words = clipboardData.split(DELIMITERS).map(cleanWord).filter(Boolean);
      setSeedPhrase(Array.from({ length: PHRASE_LENGTH }, (_, i) => words[i] ?? ''));
    },
    [setSeedPhrase]
  );

  const wordRefs = useRef<(TextFieldElement | null)[]>([]);

  // With an enterKeyHint set, Android Chromium sends Next and Done as a plain Enter instead of
  // moving focus itself, so this handler does what the hints promise. Done blurs only on mobile:
  // that's what dismisses the soft keyboard, but on desktop/extension there is no keyboard to
  // dismiss and blurring to body would lose a keyboard or screen-reader user's place.
  const onWordKeyDown = useCallback((event: React.KeyboardEvent<TextFieldElement>, index: number) => {
    // Android's Next/Done action arrives as Enter (keyCode 13) while the word is still
    // composing, so isComposing can't gate this. keyCode 229 marks an Enter that only
    // commits an IME composition (every engine), which is the one Enter to leave alone.
    if (event.key !== 'Enter' || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    if (index < PHRASE_LENGTH - 1) {
      wordRefs.current[index + 1]?.focus();
    } else if (isMobile()) {
      event.currentTarget.blur();
    }
  }, []);

  return (
    <OnboardingStepLayout
      data-testid="import-seed-phrase"
      title={t(titleKey)}
      description={
        <>
          <span>{t(descriptionKey)}</span> <span>{t('onlyMidenSeedPhrasesAreSupported')}</span>
        </>
      }
      footer={
        <Button
          id={'submit-button'}
          data-testid="import-seed-submit"
          title={t('continue')}
          onClick={handleSubmit}
          disabled={!isValid || submitting}
          className="max-w-none"
        />
      }
    >
      {isGuardReady && (
        // Two columns: a 16px word beside its number fits a 360px screen, which three did not.
        <div className="grid grid-cols-2 gap-2.5">
          {Array.from({ length: PHRASE_LENGTH }).map((_, index) => (
            <TextField
              id={`seed-phrase-input-${index}`}
              key={index}
              ref={node => {
                wordRefs.current[index] = node;
              }}
              onKeyDown={event => onWordKeyDown(event, index)}
              value={seedPhrase[index]}
              aria-label={t('word', { number: String(index + 1) })}
              aria-invalid={errorsMap[index] || undefined}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint={index === PHRASE_LENGTH - 1 ? 'done' : 'next'}
              leading={`${index + 1}.`}
              onPaste={onInputPaste}
              onChange={event => {
                const newSeedPhrase = [...seedPhrase];
                newSeedPhrase[index] = cleanWord(event.target.value);
                setSeedPhrase(newSeedPhrase);
              }}
            />
          ))}
        </div>
      )}
      {isError && (
        <Notice tone="negative" role="alert">
          {t('importSeedPhraseError')}
        </Notice>
      )}
      {isChecksumError && (
        <Notice tone="negative" role="alert">
          {t('justValidPreGeneratedMnemonic')}
        </Notice>
      )}
      {onImportWithKey && (
        <TextAction data-testid="import-with-key-link" onClick={onImportWithKey} className="-mx-1 self-start">
          {t('importWithKeyInstead')}
        </TextAction>
      )}
    </OnboardingStepLayout>
  );
};
