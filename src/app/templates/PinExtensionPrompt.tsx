import React, { FC, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { isExtension } from 'lib/platform';

/**
 * Shows a floating prompt asking users to pin the extension to the toolbar.
 * Only displays once after fresh install, then auto-dismisses.
 */
export const PinExtensionPrompt: FC = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isExtension()) return;

    chrome.storage.local.get('fresh_install', result => {
      if (result.fresh_install) {
        setVisible(true);
        chrome.storage.local.remove('fresh_install');
      }
    });
  }, []);

  const dismiss = useCallback(() => setVisible(false), []);

  if (!visible) return null;

  return (
    <div className="fixed z-[9999] pointer-events-none" style={{ top: 8, right: 60 }}>
      {/* Arrow pointing up */}
      <div
        style={{
          width: 0,
          height: 0,
          borderLeft: '10px solid transparent',
          borderRight: '10px solid transparent',
          borderBottom: '10px solid #1a1a2e',
          marginLeft: 'auto',
          marginRight: 24
        }}
      />
      {/* Tooltip body */}
      <div
        className={classNames(
          'rounded-xl shadow-2xl px-5 py-4',
          'flex flex-col items-center gap-3',
          'text-pure-white pointer-events-auto'
        )}
        style={{
          backgroundColor: '#1a1a2e',
          maxWidth: 280
        }}
      >
        <div className="flex items-center gap-2">
          <PuzzleIcon />
          <p className="text-sm font-semibold">{t('pinExtensionTitle')}</p>
        </div>
        <p className="text-xs text-center opacity-80">{t('pinExtensionDescription')}</p>
        <Button
          className={classNames(
            'px-4 py-1.5 rounded-lg text-xs font-semibold',
            'bg-pure-white/20 hover:bg-pure-white/30',
            'text-pure-white transition-colors'
          )}
          onClick={dismiss}
        >
          {t('gotIt')}
        </Button>
      </div>
    </div>
  );
};

/** Puzzle piece icon matching Chrome's extensions icon */
const PuzzleIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-2 .9-2 2v3.8h1.5c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5H2V19c0 1.1.9 2 2 2h3.8v-1.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5V21H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z" />
  </svg>
);
