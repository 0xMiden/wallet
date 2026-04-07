/**
 * Minimal launcher screen — what the user sees when no dApp is active.
 *
 * In PR-1 this is essentially the same UI the old `Browser.tsx` had: URL
 * input + favorites grid + recent URLs list. PR-2 redesigns this with a
 * hero search, featured carousel, my-dApps grid, and category chips.
 *
 * The launcher's job is to take a URL string and call `onOpen(url)`. The
 * parent (`BrowserScreen`) creates a `DappSession` and switches state to
 * show `<DappActive>`.
 */

import React, { type FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import Header from 'app/layouts/PageLayout/Header';
import { FEATURED_DAPPS } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  recentUrls: string[];
}

const DEFAULT_URL = 'https://';

function normalizeUrl(input: string): string {
  let normalized = input.trim();
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  return normalized;
}

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen, recentUrls }) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState(DEFAULT_URL);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!url || url === DEFAULT_URL) return;
      const normalized = normalizeUrl(url);
      hapticLight();
      onOpen(normalized);
    },
    [url, onOpen]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit(e as unknown as React.FormEvent);
      }
    },
    [handleSubmit]
  );

  const openTile = useCallback(
    (tileUrl: string) => {
      hapticLight();
      onOpen(tileUrl);
    },
    [onOpen]
  );

  return (
    <>
      <Header />

      {/* URL Input */}
      <div className="flex-none px-4 pt-4 pb-2">
        <form onSubmit={handleSubmit}>
          <div className="flex items-center gap-2">
            <div className="grow relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2">
                <Icon name={IconName.Globe} size="sm" className="text-grey-400" />
              </div>
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('enterUrl')}
                className="w-full pl-10 pr-4 py-3 border border-grey-200 rounded-xl text-base focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <button
              type="submit"
              disabled={!url || url === DEFAULT_URL}
              className="px-4 py-3 bg-primary-500 text-pure-white rounded-xl font-medium disabled:bg-grey-200 disabled:text-grey-400 hover:bg-primary-600 transition-colors"
            >
              {t('go')}
            </button>
          </div>
        </form>
      </div>

      {/* Favourites Section */}
      <div className="flex-none px-4 pb-2">
        <h3 className="text-sm font-medium text-grey-500 mb-3">{t('favourites')}</h3>
        <div className="grid grid-cols-4 gap-4">
          {FEATURED_DAPPS.map(fav => (
            <button
              key={fav.url}
              onClick={() => openTile(fav.url)}
              className="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-grey-50 active:bg-grey-100 transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-grey-100 flex items-center justify-center overflow-hidden">
                <img src={fav.icon} alt={fav.name} className="w-8 h-8 object-contain" />
              </div>
              <span className="text-xs text-grey-600 text-center truncate w-full">{fav.name}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="grow flex flex-col px-4 overflow-y-auto pb-20">
        {recentUrls.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium text-grey-500 mb-2">{t('recentSites')}</h3>
            <div className="space-y-2">
              {recentUrls.map((recentUrl, index) => (
                <button
                  key={index}
                  onClick={() => openTile(recentUrl)}
                  className="w-full flex items-center gap-3 p-3 bg-grey-50 rounded-xl hover:bg-grey-100 transition-colors text-left"
                >
                  <Icon name={IconName.Globe} size="sm" className="text-grey-400 shrink-0" />
                  <span className="text-sm text-grey-700 truncate">{recentUrl}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {recentUrls.length === 0 && (
          <div className="grow flex flex-col items-center justify-center">
            <Icon name={IconName.Globe} size="3xl" className="text-grey-200 mb-4" />
            <h2 className="text-lg font-semibold text-grey-600 mb-2">{t('dappBrowser')}</h2>
            <p className="text-grey-400 text-center text-sm max-w-xs">{t('dappBrowserDescription')}</p>
          </div>
        )}
      </main>
    </>
  );
};
