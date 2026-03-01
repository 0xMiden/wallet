import React, { HTMLAttributes, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Chip } from 'components/Chip';

export interface BackUpSeedPhraseScreenProps extends HTMLAttributes<HTMLDivElement> {
  seedPhrase: string[];
  onSubmit?: () => void;
}

export const BackUpSeedPhraseScreen: React.FC<BackUpSeedPhraseScreenProps> = ({
  seedPhrase,
  className,
  onSubmit,
  ...props
}) => {
  const { t } = useTranslation();
  const [isWordsVisible, setIsWordsVisible] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const onCopyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(seedPhrase.join(' '));
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [seedPhrase]);

  const onWordsVisibilityToggle = useCallback(() => {
    setIsWordsVisible(prev => !prev);
  }, []);

  useEffect(() => {
    document.addEventListener('copy', event => {
      const selectedText = window.getSelection()?.toString();
      const formattedText = selectedText?.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
      event.clipboardData?.setData('text/plain', formattedText || '');
      event.preventDefault(); // Prevent the default copy action
    });

    return () => {
      document.removeEventListener('copy', () => {});
    };
  }, []);

  return (
    <div className={classNames('flex flex-col flex-1', 'bg-app-bg gap-8 px-4 pt-2', className)} {...props}>
      <div className="flex flex-col items-center text-heading-gray">
        <header className="text-xl font-semibold">{t('backUpYourWallet')}</header>
        <div className="text-sm text-center font-medium">
          <p>{t('backUpWalletInstructions')}</p>
          <p>{t('doNotShareWithAnywone')}</p>
        </div>
      </div>

      <article className="grid grid-cols-3 gap-2 w-full">
        {seedPhrase.map((word, index) => (
          <Chip
            className="w-[104px] h-8"
            key={`seed-word-${index}`}
            label={
              <label
                className={classNames(
                  'flex flex-row gap-1 w-full',
                  'transition duration-300 ease-in-out justify-between',
                  isWordsVisible ? 'blur-none' : 'blur-sm'
                )}
              >
                <p className="text-grey-600 select-none pointer-events-none">{`${index + 1}.`}</p>
                <p className="flex w-[80%] justify-center">{`${word}`}</p>
              </label>
            }
          />
        ))}
      </article>

      <div className="flex gap-2 w-full text-heading-gray">
        <Button
          className="border-[#00000033] border-[0.5px] text-xs font-medium h-8 w-1/2 py-5"
          variant={ButtonVariant.Ghost}
          title={t(isWordsVisible ? 'hide' : 'show')}
          iconLeft={isWordsVisible ? IconName.EyeOff : IconName.Eye}
          onClick={onWordsVisibilityToggle}
        />
        <Button
          className="text-xs font-medium h-8 border-0 w-1/2 py-5"
          variant={ButtonVariant.Ghost}
          title={t(isCopied ? 'copied' : 'copyToClipboard')}
          iconLeft={isCopied ? IconName.CheckboxCircleFill : IconName.FileCopy}
          onClick={onCopyToClipboard}
        />
      </div>

      <div className="flex flex-col gap-2 self-center w-full mt-auto pb-2">
        <Button title={t('continue')} onClick={onSubmit} className="text-base" />
      </div>
    </div>
  );
};
