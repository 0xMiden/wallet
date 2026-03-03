import React, { FC, FunctionComponent, SVGProps } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ActivityIcon } from 'app/icons/activity-new.svg';
import { ReactComponent as GlobeIcon } from 'app/icons/globe-new.svg';
import { ReactComponent as HomeIcon } from 'app/icons/home-new.svg';
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

const PILL_LAYOUT_ID = 'footer-pill';

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
    <Link to={linkTo} onClick={handleClick} className="flex-1">
      <div className="relative flex flex-col items-center gap-2 rounded-[28px] py-2 px-4">
        {active && (
          <motion.div
            layoutId={PILL_LAYOUT_ID}
            className="absolute inset-0 rounded-full bg-pill-active/18"
            transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
          />
        )}
        <Icon
          className={classNames('relative z-10 h-[22px] w-[22px]', active ? 'text-pill-active' : 'text-heading-gray')}
        />
        <p
          className={classNames(
            'relative z-10 text-[10px] font-semibold uppercase',
            active ? 'text-pill-active' : 'text-heading-gray'
          )}
        >
          {name}
        </p>
        {badge && (
          <div
            className={classNames(
              'absolute top-[30%] left-[70%] -translate-x-1/2 -translate-y-1/2 z-10',
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
  const onBrowserClick = () => {
    trackEvent('Footer/Browser', AnalyticsEventCategory.ButtonPress, { type: 'browser' });
  };

  const onHomeClick = () => {
    trackEvent('Footer/Home', AnalyticsEventCategory.ButtonPress, { type: 'home' });
  };

  const onHistoryClick = () => {
    trackEvent('Footer/History', AnalyticsEventCategory.ButtonPress, { type: 'history' });
  };

  const mobileBottomPadding = isMobile() ? { paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' } : {};

  return (
    <footer className="w-full px-4 pb-3 pt-2 md:px-6" style={mobileBottomPadding}>
      <div className="flex items-center bg-gray-25 rounded-[26px] px-2 py-2 shadow-[0px_8px_32px_0px_rgba(0,0,0,0.40)] backdrop-blur-xl">
        <FooterNavButton Icon={HomeIcon} linkTo={'/'} onClick={onHomeClick} name={t('home')} />
        <FooterNavButton
          Icon={ActivityIcon}
          linkTo={'/history'}
          onClick={onHistoryClick}
          badge={historyBadge}
          name={t('activity')}
        />
        {(isMobile() || isDesktop()) && (
          <FooterNavButton Icon={GlobeIcon} linkTo={'/browser'} onClick={onBrowserClick} name={t('browser')} />
        )}
      </div>
    </footer>
  );
};

export default Footer;
