import React, { HTMLAttributes, useCallback, useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Pill } from 'components/ui/Pill';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import useIsMounted from 'lib/ui/useIsMounted';

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

  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  // Shared hook rather than a local ref: it sets the flag in the effect BODY, so StrictMode's
  // setup/cleanup/setup cannot latch it false for the life of the component (DeadletteredNotesNotice.tsx:54).
  const isMounted = useIsMounted();
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Report "Copied" only once the write has landed. This is the recovery phrase: telling the user
  // it is on the clipboard when the write was refused is the one lie this screen must not tell.
  const onCopyToClipboard = useCallback(async () => {
    try {
      await Clipboard.write({ string: seedPhrase.join(' ') });
    } catch {
      return; // The words are on screen to copy by hand.
    }
    if (!isMounted()) return;
    setIsCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setIsCopied(false), 2000);
  }, [seedPhrase, isMounted]);

  const onWordsVisibilityToggle = useCallback(() => {
    setIsWordsVisible(prev => !prev);
  }, []);

  // The handler must be the SAME reference on the way out: the cleanup used to pass a freshly
  // allocated arrow, which matches nothing, so this listener stayed on `document` for the life of
  // the realm and one more was added per mount. Since it rewrites the clipboard payload to letters
  // and spaces and calls preventDefault(), a leaked copy of it silently mangled every later
  // select-and-copy in the app — an address or a transaction id included.
  useEffect(() => {
    const onDocumentCopy = (event: ClipboardEvent) => {
      const selectedText = window.getSelection()?.toString();
      const formattedText = selectedText?.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
      event.clipboardData?.setData('text/plain', formattedText || '');
      event.preventDefault(); // Prevent the default copy action
    };

    document.addEventListener('copy', onDocumentCopy);
    return () => document.removeEventListener('copy', onDocumentCopy);
  }, []);

  return (
    <div className={classNames('flex flex-col flex-1', 'bg-app-bg gap-6 px-4 pt-4', className)} {...props}>
      <div className="flex flex-col items-center text-ink gap-2">
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

      <div className="flex gap-2.5 w-full text-ink">
        <Button
          size="sm"
          className="flex-1"
          variant={ButtonVariant.Ghost}
          title={t(isWordsVisible ? 'hide' : 'show')}
          iconLeft={isWordsVisible ? IconName.EyeOff : IconName.Eye}
          onClick={onWordsVisibilityToggle}
        />
        <Button
          size="sm"
          className="flex-1"
          variant={ButtonVariant.Ghost}
          title={t(isCopied ? 'copied' : 'copyToClipboard')}
          iconLeft={isCopied ? IconName.CheckboxCircleFill : IconName.FileCopy}
          onClick={() => void onCopyToClipboard()}
        />
      </div>

      <div className="flex flex-col gap-2 self-center w-full mt-auto">
        <Button data-testid="backup-seed-continue" title={t('continue')} onClick={onSubmit} />
      </div>
    </div>
  );
};
