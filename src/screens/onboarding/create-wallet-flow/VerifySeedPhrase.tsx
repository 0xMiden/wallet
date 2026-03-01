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
  onBiometricChange?: (value: boolean) => void;
  onSubmit?: () => void;
}

export const VerifySeedPhraseScreen: React.FC<VerifySeedPhraseScreenProps> = ({
  seedPhrase,
  useBiometric = true,
  isHardwareSecurityAvailable = false,
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

  return (
    <div
      className={classNames('flex flex-col flex-1', 'bg-app-bg gap-6 px-4 pt-4', className)}
      data-testid="verify-seed-phrase"
      {...props}
    >
      <div className="flex flex-col items-center gap-2 text-heading-gray">
        <header className="text-[28px] font-medium ">{t('verifySeedPhrase')}</header>
        <div className="text-[10px] font-normal text-center">
          <p>{t('verifyMessagePrefix')}</p>
          <p>
            <Trans i18nKey="verifyMessageSuffix" components={{ b: <span className="font-bold" /> }} />
          </p>
        </div>
      </div>

      <article className="grid grid-cols-3 gap-2 w-full">
        {shuffledWords.map((word, index) => (
          <div className="relative" key={`seed-word-${index}`}>
            {(!!firstSelectedWordIndex || firstSelectedWordIndex === 0) && index === firstSelectedWordIndex && (
              <div className="absolute -top-4 left-2 -translate-x-3 bg-primary-500 text-white px-2 py-0.5 rounded-[10px] text-xs whitespace-nowrap">
                {t('first')}
              </div>
            )}
            {(!!secondSelectedWordIndex || secondSelectedWordIndex === 0) && index === secondSelectedWordIndex && (
              <div className="absolute -top-4 left-2 -translate-x-3 bg-primary-500 text-white px-2 py-0.5 rounded-[10px] text-xs whitespace-nowrap">
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

      <div className="flex flex-col gap-4 self-center pb-2 w-full">
        {isHardwareSecurityAvailable && (
          <>
            <div className="flex flex-col gap-1 px-2">
              <h3 className="text-lg font-semibold">{t('unlockWallet')}</h3>
              <p className="text-sm text-grey-600">{t('unlockWalletDescription')}</p>
            </div>
            <div className="flex items-center justify-between gap-3 px-2">
              <p className="text-sm text-grey-600 flex-1">{t('passwordsCanBeInsecure')}</p>
              <Toggle value={useBiometric} onChangeValue={onBiometricChange} />
            </div>
          </>
        )}
        <Button disabled={!isCorrectWordSelected} title={t('continue')} onClick={onSubmit} className="" />
      </div>
    </div>
  );
};
