import React, { FC, HTMLAttributes, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { AnalyticsEventCategory, TestIDProps, useAnalytics } from 'lib/analytics';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import useTippy from 'lib/ui/useTippy';

export type CopyButtonProps = HTMLAttributes<HTMLButtonElement> &
  TestIDProps & {
    bgShade?: 100 | 200;
    rounded?: 'sm' | 'base';
    text: string;
    small?: boolean;
    type?: 'button' | 'link';
    textShade?: 500 | 600 | 700;
  };

const CopyButton: FC<CopyButtonProps> = ({
  bgShade = 100,
  children,
  text,
  small = false,
  className,
  type = 'button',
  rounded = 'sm',
  textShade = 600,
  testID,
  testIDProperties,
  ...rest
}) => {
  const { t } = useTranslation();
  const { trackEvent } = useAnalytics();
  const { fieldRef, copy, copied, setCopied } = useCopyToClipboard();

  const tippyProps = useMemo(
    () => ({
      trigger: 'mouseenter',
      hideOnClick: false,
      content: copied ? t('copiedHash') : t('copyHashToClipboard'),
      animation: 'shift-away-subtle',
      onHidden() {
        setCopied(false);
      }
    }),
    [copied, setCopied]
  );

  const buttonRef = useTippy<HTMLButtonElement>(tippyProps);

  const roundedClassName = rounded === 'base' ? 'rounded' : 'rounded-sm';
  const smallClassName = small ? 'text-xs p-1' : 'text-sm py-1';

  const handleCopyPress = () => {
    hapticLight();
    testID !== undefined && trackEvent(testID, AnalyticsEventCategory.ButtonPress, testIDProperties);

    return copy();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={
          type === 'button'
            ? classNames(
                'hover:bg-grey-50',
                'text-black',
                roundedClassName,
                smallClassName,
                'font-tnum leading-none select-none',
                'transition ease-in-out duration-300',
                className
              )
            : classNames('hover:underline', className)
        }
        {...rest}
        onClick={handleCopyPress}
      >
        {children}
      </button>

      <input ref={fieldRef} value={text} readOnly className="sr-only" />
    </>
  );
};

export default CopyButton;
