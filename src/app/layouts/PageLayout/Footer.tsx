import React, { FC, FunctionComponent, SVGProps } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ActivityIcon } from 'app/icons/activity-new.svg';
import { ReactComponent as HomeIcon } from 'app/icons/home-new.svg';
import { ReactComponent as SettingsIcon } from 'app/icons/settings-new.svg';
import { ReactComponent as GlobeIcon } from 'app/icons/globe-new.svg';
import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { hapticSelection } from 'lib/mobile/haptics';
import { isDesktop, isMobile } from 'lib/platform';
import { Link, useLocation } from 'lib/woozie';

interface FooterProps {
  historyBadge?: boolean;
}

interface FooterNavButtonProps {
  Icon: FunctionComponent<SVGProps<SVGSVGElement>>;
  linkTo: string;
  onClick: () => void;
  name: string;
  badge?: boolean;
}

const FooterNavButton: FC<FooterNavButtonProps> = ({ Icon, linkTo, onClick, badge, name }) => {
  const location = useLocation();
  const currentPath = location.pathname;
  const pathSegments = currentPath.split('/');
  const currentPathSegment = pathSegments[1];
  const active =
    currentPathSegment === linkTo.replace('/', '') ||
    (currentPathSegment === 'activity-details' && linkTo === '/activity') ||
    (linkTo === '/' && currentPathSegment === '');

  const handleClick = () => {
    hapticSelection();
    onClick();
  };

  return (
    <Link to={linkTo} onClick={handleClick}>
      <div className={classNames('flex relative flex-col items-center rounded-full hover:bg-grey-25')}>
        <Icon
          className={active ? 'text-primary-500' : 'text-black'}
          style={{
            height: '34.21px',
            width: '34.21px'
          }}
        />
        <p className={classNames('text-[10px] font-medium', active ? 'text-primary-500' : 'text-heading-gray')}>
          {name}
        </p>
        {badge && (
          <div
            className={classNames(
              'absolute top-[30%] left-[70%] -translate-x-1/2 -translate-y-1/2',
              'flex items-center justify-center',
              'w-4 h-4 bg-red-500 rounded-full'
            )}
          />
        )}
      </div>
    </Link>
  );
};

const Footer: FC<FooterProps> = ({ historyBadge }) => {
  const { trackEvent } = useAnalytics();
  const { t } = useTranslation();
  const onSettingsClick = () => {
    trackEvent('Footer/Settings', AnalyticsEventCategory.ButtonPress, { type: 'settings' });
  };

  const onBrowserClick = () => {
    trackEvent('Footer/Browser', AnalyticsEventCategory.ButtonPress, { type: 'browser' });
  };

  const onHomeClick = () => {
    trackEvent('Footer/Home', AnalyticsEventCategory.ButtonPress, { type: 'home' });
  };

  const onHistoryClick = () => {
    trackEvent('Footer/History', AnalyticsEventCategory.ButtonPress, { type: 'history' });
  };

  // Remove rounded corners on mobile so footer extends edge-to-edge
  // On mobile, use safe area for bottom padding (replaces py-3 bottom portion)
  const paddingClass = isMobile() ? 'pt-3 md:py-4' : 'py-3 md:py-4';
  const mobileBottomPadding = isMobile() ? { paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' } : {};

  return (
    <footer className={`w-full relative bg-gray-25 h-18 px-8 md:px-16 ${paddingClass}`} style={mobileBottomPadding}>
      <div className="flex justify-center gap-12">
        <FooterNavButton Icon={HomeIcon} linkTo={'/'} onClick={onHomeClick} name={t('home')} />
        <FooterNavButton
          Icon={ActivityIcon}
          linkTo={'/history'}
          onClick={onHistoryClick}
          badge={historyBadge}
          name={t('activity')}
        />
        <FooterNavButton Icon={SettingsIcon} linkTo={'/settings'} onClick={onSettingsClick} name={t('settings')} />
        {(isMobile() || isDesktop()) && (
          <FooterNavButton Icon={GlobeIcon} linkTo={'/browser'} onClick={onBrowserClick} name={t('browser')} />
        )}
      </div>
    </footer>
  );
};

export default Footer;
