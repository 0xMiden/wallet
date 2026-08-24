import React, { FC } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { Link } from 'lib/woozie';

type MenuItemProps = {
  slug?: string;
  titleI18nKey: string;
  onClick?: () => void;
  // Optional, and deliberately not defaulted to '': `Link` tracks a ButtonPress
  // for any testID that is merely `!== undefined`, so an empty string bought a
  // `data-testid=""` and an analytics event with no name.
  testID?: string;
  linksOutsideOfWallet: boolean;
  rightText?: string;
};

const ClickableContent: FC<Partial<MenuItemProps>> = ({ titleI18nKey, rightText }) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('w-full cursor-pointer')}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="font-heading text-base font-semibold text-heading-gray">{t(titleI18nKey || '')}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          {rightText && <span className="font-heading text-sm text-text-muted font-normal">{rightText}</span>}
          <ChevronRightIcon className="h-4 w-4 stroke-black" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};

const MenuItem: FC<MenuItemProps> = ({ slug, titleI18nKey, onClick, testID, linksOutsideOfWallet, rightText }) => {
  const handleExternalClick = () => {
    hapticLight();
  };

  return (
    <div>
      {linksOutsideOfWallet ? (
        <a href={slug} target="_blank" rel="noreferrer" onClick={handleExternalClick}>
          <ClickableContent
            titleI18nKey={titleI18nKey}
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
            linksOutsideOfWallet={linksOutsideOfWallet}
            rightText={rightText}
          />
        </button>
      ) : (
        // `testID` only feeds analytics inside Link — the anchor itself needs the
        // spread `data-testid` for the settings e2e helpers to find routed rows.
        <Link to={slug || '#'} onClick={onClick} testID={testID} data-testid={testID}>
          <ClickableContent
            titleI18nKey={titleI18nKey}
            linksOutsideOfWallet={linksOutsideOfWallet}
            rightText={rightText}
          />
        </Link>
      )}
    </div>
  );
};

export default MenuItem;
