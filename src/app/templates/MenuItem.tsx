import React, { FC } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ArrowIcon } from 'app/icons/arrow-right-top-alt.svg';
import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { Link } from 'lib/woozie';

type MenuItemProps = {
  slug?: string;
  titleI18nKey: string;
  Icon?: ImportedSVGComponent;
  iconStyle?: React.CSSProperties;
  onClick?: () => void;
  testID: string;
  linksOutsideOfWallet: boolean;
  rightText?: string;
};

const ClickableContent: FC<Partial<MenuItemProps>> = ({
  titleI18nKey,
  Icon,
  iconStyle,
  linksOutsideOfWallet,
  rightText
}) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('w-full cursor-pointer')}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-5 h-5 shrink-0" style={iconStyle} />}
          <div className="text-base font-medium text-black">{t(titleI18nKey || '')}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          {rightText && <span className="text-xs text-black font-normal ">{rightText}</span>}
          <ChevronRightIcon className="h-4 w-4" style={{ stroke: '#737373' }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};

const MenuItem: FC<MenuItemProps> = ({
  slug,
  titleI18nKey,
  Icon,
  iconStyle,
  onClick,
  testID,
  linksOutsideOfWallet,
  rightText
}) => {
  const handleExternalClick = () => {
    hapticLight();
  };

  return (
    <div>
      {linksOutsideOfWallet ? (
        <a href={slug} target="_blank" rel="noreferrer" onClick={handleExternalClick}>
          <ClickableContent
            titleI18nKey={titleI18nKey}
            Icon={Icon}
            iconStyle={iconStyle}
            linksOutsideOfWallet={linksOutsideOfWallet}
            rightText={rightText}
          />
        </a>
      ) : onClick && !slug ? (
        <button
          type="button"
          onClick={() => {
            hapticLight();
            onClick();
          }}
          data-testid={testID}
          className="w-full text-left"
        >
          <ClickableContent
            titleI18nKey={titleI18nKey}
            Icon={Icon}
            iconStyle={iconStyle}
            linksOutsideOfWallet={linksOutsideOfWallet}
            rightText={rightText}
          />
        </button>
      ) : (
        <Link to={slug || '#'} onClick={onClick} testID={testID}>
          <ClickableContent
            titleI18nKey={titleI18nKey}
            Icon={Icon}
            iconStyle={iconStyle}
            linksOutsideOfWallet={linksOutsideOfWallet}
            rightText={rightText}
          />
        </Link>
      )}
    </div>
  );
};

export default MenuItem;
