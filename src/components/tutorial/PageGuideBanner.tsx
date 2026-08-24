import React, { FC, useMemo, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { durations, easings, useMotion } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { useLocation } from 'lib/woozie';

import { dismissPageGuide, getDismissedPageGuides, GuidePage, startPageGuide } from './page-guides';
import { useTourStore } from './tour-store';

const PAGE_BY_PATH: Array<[string, GuidePage, string]> = [
  ['/send', 'send', 'send'],
  ['/receive', 'receive', 'receive'],
  ['/earn', 'earn', 'earn'],
  ['/swap', 'swap', 'swap']
];

/**
 * Slim "take a guided tour of this page" banner under the segmented action
 * bar. Shows on every home-carousel pane except Overview, stays available
 * until dismissed (per page, persisted), and hides while the onboarding tour
 * itself is running so the two never stack.
 */
export const PageGuideBanner: FC = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const tourActive = useTourStore(s => s.status === 'active');
  const [dismissed, setDismissed] = useState<GuidePage[]>(() => getDismissedPageGuides());
  const transition = useMotion({ duration: durations.fast, ease: easings.easeOutCubic });

  const match = useMemo(
    () => PAGE_BY_PATH.find(([path]) => pathname === path || pathname.startsWith(`${path}/`)),
    [pathname]
  );
  const page = match?.[1];
  const labelKey = match?.[2] ?? '';
  const visible = !tourActive && page !== undefined && !dismissed.includes(page);

  const onDismiss = () => {
    if (!page) return;
    hapticLight();
    setDismissed(dismissPageGuide(page));
  };
  const onTake = () => {
    if (!page) return;
    hapticLight();
    startPageGuide(page);
  };

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key={page}
          data-testid="page-guide-banner"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          <div className="mx-3 mt-1 mb-2 flex items-center gap-2 rounded-lg-token border border-border-faint bg-surface-solid px-3 py-2">
            <p className="min-w-0 flex-1 text-sm text-text-muted">{t('pageGuideBannerBody', { page: t(labelKey) })}</p>
            <button
              type="button"
              data-testid="page-guide-banner-action"
              onClick={onTake}
              className="shrink-0 text-sm font-semibold text-accent-primary"
            >
              {t('pageGuideBannerAction')}
            </button>
            <button
              type="button"
              data-testid="page-guide-banner-dismiss"
              onClick={onDismiss}
              aria-label={t('close')}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100"
            >
              <Icon name={IconName.Close} size="xs" fill="currentColor" className="text-heading-gray" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PageGuideBanner;
