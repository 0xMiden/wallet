import React, { HTMLAttributes, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Pill } from 'components/ui/Pill';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';

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

  // Block screenshots/recordings while the backup phrase is on screen (#417).
  // The words are only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard();

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
    <div className={classNames('flex flex-col flex-1', 'bg-app-bg gap-6 px-4 pt-4', className)} {...props}>
      <div className="flex flex-col items-center text-heading-gray gap-2">
        <header className="text-[28px] font-medium">{t('backUpYourWallet')}</header>
        <div className="text-[10px] text-center font-regular">
          <p>{t('backUpWalletInstructions')}</p>
          <p>{t('doNotShareWithAnywone')}</p>
          <p>{t('seedPhraseRecoveryCaption')}</p>
        </div>
      </div>

      <article className="grid grid-cols-3 gap-2 w-full">
        {isGuardReady &&
          seedPhrase.map((word, index) => (
            <Pill
              className="w-26 h-8 justify-between"
              key={`seed-word-${index}`}
              data-testid={`seed-word-${index}`}
              tone="word"
            >
              <span
                className={classNames(
                  'flex flex-row gap-1 w-full',
                  'transition duration-300 ease-in-out justify-between motion-reduce:transition-none',
                  isWordsVisible ? 'blur-none' : 'blur-sm'
                )}
              >
                <span className="text-muted select-none pointer-events-none">{`${index + 1}.`}</span>
                <span className="flex w-[80%] justify-center">{`${word}`}</span>
              </span>
            </Pill>
          ))}
      </article>

      <div className="flex gap-2 w-full text-heading-gray">
        <Button
          size="sm"
          className="w-1/2"
          variant={ButtonVariant.Ghost}
          title={t(isWordsVisible ? 'hide' : 'show')}
          iconLeft={isWordsVisible ? IconName.EyeOff : IconName.Eye}
          onClick={onWordsVisibilityToggle}
        />
        <Button
          size="sm"
          className="w-1/2"
          variant={ButtonVariant.Ghost}
          title={t(isCopied ? 'copied' : 'copyToClipboard')}
          iconLeft={isCopied ? IconName.CheckboxCircleFill : IconName.FileCopy}
          onClick={onCopyToClipboard}
        />
      </div>

      <div className="flex flex-col gap-2 self-center w-full mt-auto">
        <Button data-testid="backup-seed-continue" title={t('continue')} onClick={onSubmit} />
      </div>
    </div>
  );
};
