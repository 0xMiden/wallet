import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { shuffle } from 'lodash';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Chip } from 'components/Chip';
import { Toggle } from 'components/Toggle';
import { hapticLight } from 'lib/mobile/haptics';

export interface VerifySeedPhraseScreenProps extends React.ButtonHTMLAttributes<HTMLDivElement> {
  seedPhrase: string[];
  useBiometric?: boolean;
  isHardwareSecurityAvailable?: boolean;
  showIntro?: boolean;
  onBiometricChange?: (value: boolean) => void;
  onSubmit?: () => void;
}

export const VerifySeedPhraseScreen: React.FC<VerifySeedPhraseScreenProps> = ({
  seedPhrase,
  useBiometric = true,
  isHardwareSecurityAvailable = false,
  showIntro = true,
  onBiometricChange,
  className,
  onSubmit,
  ...props
}) => {
  const { t } = useTranslation();
  const shuffledWords = useMemo(() => shuffle(seedPhrase), [seedPhrase]);
  const [firstSelectedWordIndex, setFirstSelectedWord] = useState<number | null>(null);
  const [secondSelectedWordIndex, setSecondSelectedWord] = useState<number | null>(null);

  const onSelectWord = useCallback(
    (index: number) => {
      hapticLight();
      // we select first word if index was not selected before
      if (firstSelectedWordIndex === null && index !== secondSelectedWordIndex) {
        setFirstSelectedWord(index);
        return;
      }
      // if word is already selected, we unselect it
      if (index === firstSelectedWordIndex) {
        setFirstSelectedWord(null);
        return;
      }
      // if first word is selected, we select second word
      if (index === secondSelectedWordIndex) {
        setSecondSelectedWord(null);
        return;
      }
      setSecondSelectedWord(index);
    },
    [firstSelectedWordIndex, secondSelectedWordIndex]
  );
  const isCorrectWordSelected = useMemo(() => {
    if (firstSelectedWordIndex === null || secondSelectedWordIndex === null) {
      return false;
    }
    return (
      shuffledWords[firstSelectedWordIndex] === seedPhrase[0] &&
      shuffledWords[secondSelectedWordIndex] === seedPhrase[11]
    );
  }, [seedPhrase, firstSelectedWordIndex, secondSelectedWordIndex, shuffledWords]);

  // Progressive, always-visible guidance for which word to tap next. Without it
  // the task ("tap the FIRST then the LAST word of your phrase") is unclear: the
  // intro is tiny (or, in the re-verify flow, hidden via showIntro=false), and the
  // "First"/"Last" badges only appear AFTER a tap — so a user taps one word, sees
  // "First", and has no cue that the SECOND tap must be the LAST word, not the
  // second. This line spells out the current step and confirms right/wrong.
  const stepPrompt = useMemo<{ key: string; tone: 'neutral' | 'success' | 'error' }>(() => {
    if (firstSelectedWordIndex === null) {
      return { key: 'verifyStepSelectFirst', tone: 'neutral' };
    }
    if (secondSelectedWordIndex === null) {
      return { key: 'verifyStepSelectLast', tone: 'neutral' };
    }
    return isCorrectWordSelected
      ? { key: 'verifyStepCorrect', tone: 'success' }
      : { key: 'verifyStepWrong', tone: 'error' };
  }, [firstSelectedWordIndex, secondSelectedWordIndex, isCorrectWordSelected]);

  return (
    <div
      className={classNames('flex flex-col flex-1', 'bg-app-bg gap-6 px-4 pt-4', className)}
      data-testid="verify-seed-phrase"
      {...props}
    >
      {showIntro && (
        <div className="flex flex-col items-center gap-2 text-heading-gray">
          <header className="text-[28px] font-medium">{t('verifySeedPhrase')}</header>
          <p className="text-sm font-normal text-center">{t('verifyMessagePrefix')}</p>
        </div>
      )}

      {/* Always-visible progressive guidance — shown in BOTH the onboarding
          (showIntro) and the re-verify (showIntro=false) flows, so the user
          always knows which word to tap next and whether their pick was right. */}
      <p
        data-testid="verify-seed-prompt"
        className={classNames(
          'text-center text-sm font-medium',
          stepPrompt.tone === 'error'
            ? 'text-red-500'
            : stepPrompt.tone === 'success'
            ? 'text-green-500'
            : 'text-heading-gray'
        )}
      >
        <Trans i18nKey={stepPrompt.key} components={{ b: <span className="font-bold" /> }} />
      </p>

      <article className="grid grid-cols-3 gap-2 w-full">
        {shuffledWords.map((word, index) => (
          <div className="relative" key={`seed-word-${index}`}>
            {(!!firstSelectedWordIndex || firstSelectedWordIndex === 0) && index === firstSelectedWordIndex && (
              <div className="absolute -top-4 left-2 -translate-x-3 bg-primary-500 text-pure-white px-2 py-0.5 rounded-[10px] text-xs whitespace-nowrap">
                {t('first')}
              </div>
            )}
            {(!!secondSelectedWordIndex || secondSelectedWordIndex === 0) && index === secondSelectedWordIndex && (
              <div className="absolute -top-4 left-2 -translate-x-3 bg-primary-500 text-pure-white px-2 py-0.5 rounded-[10px] text-xs whitespace-nowrap">
                {t('last')}
              </div>
            )}
            <button onClick={() => onSelectWord(index)} className="w-full">
              <Chip
                className="w-[104px] h-8 cursor-pointer"
                selected={firstSelectedWordIndex === index || secondSelectedWordIndex === index}
                label={word}
              />
            </button>
          </div>
        ))}
      </article>

      <div className="flex-1" />

      <div className="flex flex-col gap-4 self-center w-full">
        {isHardwareSecurityAvailable && (
          <>
            <div className="flex flex-col gap-1 px-2">
              <h3 className="text-lg font-semibold">{t('unlockWallet')}</h3>
              <p className="text-sm text-text-muted">{t('unlockWalletDescription')}</p>
            </div>
            <div className="flex items-center justify-between gap-3 px-2">
              <p className="text-sm text-text-muted flex-1">{t('passwordsCanBeInsecure')}</p>
              <Toggle value={useBiometric} onChangeValue={onBiometricChange} />
            </div>
          </>
        )}
        <Button disabled={!isCorrectWordSelected} title={t('continue')} onClick={onSubmit} className="" />
      </div>
    </div>
  );
};
