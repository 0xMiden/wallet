import { FC, useCallback, useLayoutEffect, useRef } from 'react';

import constate from 'constate';
import type { Browser, Tabs } from 'webextension-polyfill';

import { isExtension } from 'lib/platform';
import { createUrl } from 'lib/woozie';

export const IS_DEV_ENV = process.env.NODE_ENV === 'development';

// Lazy-loaded browser polyfill (only in extension context)
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  /* c8 ignore start */ if (!isExtension()) throw new Error('Browser APIs only available in extension context'); /* c8 ignore stop */
  if (!browserInstance) {
    const module = await import('webextension-polyfill');
    browserInstance = module.default;
  }
  return browserInstance;
}

export type AppEnvironment = {
  windowType: WindowType;
  confirmWindow?: boolean;
};

export enum WindowType {
  Popup,
  FullPage,
  SidePanel
}

export type BackHandler = () => void;

export const [AppEnvProvider, useAppEnv] = constate((env: AppEnvironment) => {
  const fullPage = env.windowType === WindowType.FullPage;
  const popup = env.windowType === WindowType.Popup;
  const sidePanel = env.windowType === WindowType.SidePanel;
  const compact = popup || sidePanel;
  const confirmWindow = env.confirmWindow ?? false;

  const handlerRef = useRef<BackHandler>();
  const prevHandlerRef = useRef<BackHandler>();

  const onBack = useCallback(() => {
    if (handlerRef.current) {
      handlerRef.current();
    }
  }, []);

  const registerBackHandler = useCallback((handler: BackHandler) => {
    if (handlerRef.current) {
      prevHandlerRef.current = handlerRef.current;
    }
    handlerRef.current = handler;

    return () => {
      if (handlerRef.current === handler) {
        handlerRef.current = prevHandlerRef.current;
      }
    };
  }, []);

  return {
    fullPage,
    popup,
    sidePanel,
    compact,
    confirmWindow,
    onBack,
    registerBackHandler
  };
});

export const OpenInFullPage: FC = () => {
  const appEnv = useAppEnv();

  useLayoutEffect(() => {
    // Only handle full page navigation in extension context
    if (!isExtension()) {
      return;
    }

    (async () => {
      try {
        const browser = await getBrowser();
        const urls = await onboardingUrls();
        const tabs = await browser.tabs.query({});
        const onboardingTab = tabs.find((t: Tabs.Tab) => t.url && urls.includes(t.url));
        if (onboardingTab?.id) {
          browser.tabs.update(onboardingTab.id, { active: true });
          if (appEnv.compact) {
            window.close();
          }
        } else {
          // unable to find existing onboarding tab, open a new one
          await openInFullPage();
          if (appEnv.compact) {
            window.close();
          }
        }
      } catch (err) {
        console.error('OpenInFullPage error:', err);
      }
    })();
  }, [appEnv.compact]);

  return null;
};

export const onboardingUrls = async () => {
  if (!isExtension()) {
    return [];
  }

  const browser = await getBrowser();
  const hashes = [
    '',
    '/',
    '/#select-wallet-type',
    '/#select-import-type',
    '/#import-from-file',
    '/#import-seed-phrase',
    '/#backup-seed-phrase',
    '/#verify-seed-phrase',
    '/#create-password',
    '/#confirmation'
  ];

  const urls = hashes.map(hash => {
    return browser.runtime.getURL(createUrl('fullpage.html', '', hash));
  });

  return urls;
};

export async function openInFullPage() {
  // Only extension can open new tabs
  if (!isExtension()) {
    return;
  }

  const browser = await getBrowser();
  const { search, hash } = window.location;
  const url = createUrl('fullpage.html', search, hash);
  browser.tabs.create({
    url: browser.runtime.getURL(url)
  });
}
