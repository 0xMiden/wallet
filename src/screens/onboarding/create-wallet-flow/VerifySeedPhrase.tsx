import React, { useCallback, useMemo, useState } from 'react';

import classNames from 'clsx';
import { shuffle } from 'lodash';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { Toggle } from 'components/Toggle';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Pill } from 'components/ui/Pill';
import { SubPageSection } from 'components/ui/SubPageLayout';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

export interface VerifySeedPhraseScreenProps {
  seedPhrase: string[];
  'data-testid'?: string;
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
  onSubmit,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();
  const shuffledWords = useMemo(() => shuffle(seedPhrase), [seedPhrase]);
  const [firstSelectedWordIndex, setFirstSelectedWord] = useState<number | null>(null);
  const [secondSelectedWordIndex, setSecondSelectedWord] = useState<number | null>(null);

  const onSelectWord = useCallback(
    (index: number) => {
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

  const quiz = (
    <>
      {/* Always-visible progressive guidance — shown in BOTH the onboarding
          (showIntro) and the re-verify (showIntro=false) flows, so the user
          always knows which word to tap next and whether their pick was right. */}
      <p
        data-testid="verify-seed-prompt"
        role="status"
        className={classNames(
          'px-1 font-sans text-[15px] leading-[22px]',
          stepPrompt.tone === 'error'
            ? 'text-negative-ink'
            : stepPrompt.tone === 'success'
              ? 'text-positive-ink'
              : 'text-ink'
        )}
      >
        <Trans i18nKey={stepPrompt.key} components={{ b: <span className="font-bold" /> }} />
      </p>

      <article className="grid grid-cols-3 gap-x-2 gap-y-4 pt-2">
        {shuffledWords.map((word, index) => {
          const order =
            index === firstSelectedWordIndex ? t('first') : index === secondSelectedWordIndex ? t('last') : null;
          return (
            <div className="relative" key={`seed-word-${index}`}>
              {/* Which pick this word is, tagged over its corner. */}
              {order && (
                <Pill size="xs" tone="inverse" className="pointer-events-none absolute -top-2.5 left-1 z-10">
                  {order}
                </Pill>
              )}
              <Pill
                className="w-full justify-center"
                tone={order ? 'selected' : 'word'}
                selected={order !== null}
                onClick={() => onSelectWord(index)}
                data-testid={`verify-quiz-word-${index}`}
              >
                {word}
              </Pill>
            </div>
          );
        })}
      </article>

      {isHardwareSecurityAvailable && (
        <SubPageSection title={t('unlockWallet')} description={t('unlockWalletDescription')}>
          <ListGroup>
            <ListRow
              title={t('passwordsCanBeInsecure')}
              trailing={<Toggle value={useBiometric} onChangeValue={onBiometricChange} />}
            />
          </ListGroup>
        </SubPageSection>
      )}
    </>
  );

  const continueButton = <Button disabled={!isCorrectWordSelected} title={t('continue')} onClick={onSubmit} />;

  // Embedded (the Settings re-verify flow draws its own page): the quiz and its button, no frame.
  if (!showIntro) {
    return (
      <div className="flex flex-col gap-5" data-testid={dataTestId ?? 'verify-seed-phrase'}>
        {quiz}
        {continueButton}
      </div>
    );
  }

  return (
    <OnboardingStepLayout
      data-testid={dataTestId ?? 'verify-seed-phrase'}
      title={t('verifySeedPhrase')}
      description={t('verifyMessagePrefix')}
      footer={continueButton}
    >
      {quiz}
    </OnboardingStepLayout>
  );
};
