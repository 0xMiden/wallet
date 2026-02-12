import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { ReactComponent as ArrowIcon } from 'app/icons/arrow-right-top-alt.svg';
import { ReactComponent as ChevronRightIcon } from 'app/icons/chevron-right.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { Link } from 'lib/woozie';

type MenuItemProps = {
  slug: string;
  titleI18nKey: string;
  Icon?: ImportedSVGComponent;
  iconStyle?: React.CSSProperties;
  onClick?: () => void;
  testID: string;
  insertHR: boolean;
  linksOutsideOfWallet: boolean;
};

const ClickableContent: FC<Partial<MenuItemProps>> = ({
  titleI18nKey,
  Icon,
  iconStyle,
  linksOutsideOfWallet,
  insertHR
}) => {
  const { fullPage } = useAppEnv();
  const { t } = useTranslation();

  const width = fullPage ? '' : 'w-full';
  const hrStyle = insertHR ? { borderTop: '1px solid #E9EBEF' } : { borderTop: '1px solid #FFF' };

  return (
    <div>
      <hr className={`${width} m-auto mb-1`} style={hrStyle}></hr>
      <div
        className={`${width} md:px-8 lg:px-16 m-auto py-4 hover:bg-gray-200 focus:bg-gray-200 transition-colors duration-500 ease-in-out cursor-pointer`}
        style={{ borderRadius: '8px' }}
      >
        <div className="flex justify-between">
          <div className="flex justify-start">
            {Icon && (
              <div className="ml-2 shrink-0">
                <div
                  className={classNames(
                    'block',
                    'rounded-full',
                    'flex items-center justify-center',
                    'transition ease-in-out duration-200',
                    'opacity-90'
                  )}
                >
                  <Icon className={`h-6 w-6`} style={iconStyle} />
                </div>
              </div>
            )}

            <div className="ml-4">
              <div
                className={classNames(
                  'text-lg text-black leading-7 font-medium',
                  'filter-brightness-75',
                  'transition ease-in-out duration-200'
                )}
                style={{
                  fontSize: '14px',
                  lineHeight: '24px'
                }}
              >
                {t(titleI18nKey || '')}
              </div>
            </div>
          </div>
          <div className="ml-4 self-end pr-4">
            {linksOutsideOfWallet ? (
              <ArrowIcon className="pr-2 h-5 w-5" />
            ) : (
              <ChevronRightIcon className="h-6 w-6" aria-hidden="true" />
            )}
          </div>
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
  insertHR,
  linksOutsideOfWallet
}) => {
  const handleExternalClick = () => {
    hapticLight();
  };

  return (
    <div>
      {linksOutsideOfWallet ? (
        <a href={slug} target="_blank" rel="noreferrer" onClick={handleExternalClick}>
          {ClickableContent({ titleI18nKey, Icon, iconStyle, insertHR, linksOutsideOfWallet })}
        </a>
      ) : (
        <Link to={slug} onClick={onClick} testID={testID}>
          {ClickableContent({ titleI18nKey, Icon, iconStyle, insertHR, linksOutsideOfWallet })}
        </Link>
      )}
    </div>
  );
};

export default MenuItem;
