import React, { FC } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ArrowIcon } from 'app/icons/arrow-right-top-alt.svg';
import { ReactComponent as ChevronRightIcon } from 'app/icons/chevron-right.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { Link } from 'lib/woozie';

type MenuItemProps = {
  slug: string;
  titleI18nKey: string;
  descriptionI18nKey?: string;
  Icon?: ImportedSVGComponent;
  iconStyle?: React.CSSProperties;
  onClick?: () => void;
  testID: string;
  linksOutsideOfWallet: boolean;
};

const ClickableContent: FC<Partial<MenuItemProps>> = ({
  titleI18nKey,
  descriptionI18nKey,
  Icon,
  iconStyle,
  linksOutsideOfWallet
}) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('w-full hover:bg-gray-50 transition-colors duration-200 cursor-pointer py-4 px-4')}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="p-2 bg-gray-25 rounded-5 shrink-0">
              <Icon className="w-5 h-4" style={iconStyle} />
            </div>
          )}
          <div>
            <div className="text-sm font-medium">{t(titleI18nKey || '')}</div>
            {descriptionI18nKey && <div className="text-xs text-gray-400">{t(descriptionI18nKey)}</div>}
          </div>
        </div>
        <div className="shrink-0 ml-2">
          {linksOutsideOfWallet ? (
            <ArrowIcon className="h-5 w-5" />
          ) : (
            <ChevronRightIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
};

const MenuItem: FC<MenuItemProps> = ({
  slug,
  titleI18nKey,
  descriptionI18nKey,
  Icon,
  iconStyle,
  onClick,
  testID,
  linksOutsideOfWallet
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
            descriptionI18nKey={descriptionI18nKey}
            Icon={Icon}
            iconStyle={iconStyle}
            linksOutsideOfWallet={linksOutsideOfWallet}
          />
        </a>
      ) : (
        <Link to={slug} onClick={onClick} testID={testID}>
          <ClickableContent
            titleI18nKey={titleI18nKey}
            descriptionI18nKey={descriptionI18nKey}
            Icon={Icon}
            iconStyle={iconStyle}
            linksOutsideOfWallet={linksOutsideOfWallet}
          />
        </Link>
      )}
    </div>
  );
};

export default MenuItem;
