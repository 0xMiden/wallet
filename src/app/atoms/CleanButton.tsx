import React, { FC, HTMLAttributes, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as CloseIcon } from 'app/icons/close.svg';
import { hapticLight } from 'lib/mobile/haptics';
import useTippy from 'lib/ui/useTippy';

type CleanButtonProps = HTMLAttributes<HTMLButtonElement> & {
  bottomOffset?: string;
  iconStyle?: React.CSSProperties;
};

const CleanButton: FC<CleanButtonProps> = ({
  bottomOffset = '0.4rem',
  className,
  style = {},
  iconStyle = {},
  onClick,
  ...rest
}) => {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    hapticLight();
    onClick?.(e);
  };
  const { t } = useTranslation();
  const tippyProps = useMemo(
    () => ({
      trigger: 'mouseenter',
      hideOnClick: false,
      content: t('clean'),
      animation: 'shift-away-subtle'
    }),
    []
  );

  const buttonRef = useTippy<HTMLButtonElement>(tippyProps);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={classNames(
        'absolute',
        'border rounded-full shadow-sm hover:shadow',
        'bg-pure-black',
        'flex items-center',
        'text-xs text-black',
        'transition ease-in-out duration-200',
        className
      )}
      style={{ right: '0.4rem', bottom: bottomOffset, padding: '2px', ...style }}
      tabIndex={-1}
      onClick={handleClick}
      {...rest}
    >
      <CloseIcon className="w-auto h-4 stroke-white" fill="white" strokeWidth={2} style={iconStyle} />
    </button>
  );
};

export default CleanButton;
