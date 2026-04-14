import { enUS, enGB, fr, zhCN, zhTW, ja, ko, uk, ru, Locale } from 'date-fns/locale';
import i18n from 'i18next';
import type { Browser } from 'webextension-polyfill';

import { isExtension } from 'lib/platform';

import cldrjsLocales from './cldrjs-locales.json';
import { areLocalesEqual, processTemplate, toList } from './helpers';
import { getSavedLocale } from './saving';
import { FetchedLocaleMessages, LocaleMessages, Substitutions } from './types';

// Lazy-loaded browser polyfill (only in extension context)
let browserInstance: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    const module = await import('webextension-polyfill');
    browserInstance = module.default;
  }
  return browserInstance;
}

const dateFnsLocales: Record<string, Locale> = {
  en: enUS,
  en_GB: enGB,
  fr,
  zh_CN: zhCN,
  zh_TW: zhTW,
  ja,
  ko,
  uk,
  ru
};

let fetchedLocaleMessages: FetchedLocaleMessages = {
  target: null,
  fallback: null
};

let cldrLocale = cldrjsLocales.en;

export async function init() {
  const refetched: FetchedLocaleMessages = {
    target: null,
    fallback: null
  };

  const saved = getSavedLocale();

  if (saved) {
    const native = getNativeLocale();

    await Promise.all([
      // Fetch target locale messages if needed
      (async () => {
        if (!areLocalesEqual(saved, native)) {
          refetched.target = await fetchLocaleMessages(saved);
        }
      })(),
      // Fetch fallback locale messages if needed
      (async () => {
        const deflt = getDefaultLocale();
        if (!areLocalesEqual(deflt, native) && !areLocalesEqual(deflt, saved)) {
          refetched.fallback = await fetchLocaleMessages(deflt);
        }
      })()
    ]);
  }

  fetchedLocaleMessages = refetched;
  cldrLocale = (cldrjsLocales as Record<string, any>)[getCurrentLocale()] || cldrjsLocales.en;
}

export function getMessage(messageName: string, substitutions?: Substitutions) {
  const val = fetchedLocaleMessages.target?.[messageName] ?? fetchedLocaleMessages.fallback?.[messageName];

  if (!val) {
    // On mobile/desktop, use i18next directly; on extension, use browser.i18n
    if (!isExtension()) {
      return i18n.t(messageName, substitutions as any) || messageName;
    }
    // For extension, we need to call browser.i18n synchronously
    // Since this is a sync function, we'll return the key if browser isn't loaded
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const browser = require('webextension-polyfill');
      return browser.i18n.getMessage(messageName, substitutions ? Object.values(substitutions) : undefined);
    } catch {
      return messageName;
    }
  }

  try {
    if (val.placeholders) {
      const params = toList(Object.values(substitutions ?? {})).reduce((prms, sub, i) => {
        const pKey = val.placeholderList?.[i] ?? i;
        return pKey ? { ...prms, [pKey]: sub } : prms;
      }, {});

      return processTemplate(val.message, params);
    }

    return val.message;
  } catch (err: any) {
    console.error(err);

    return '';
  }
}

export function getDateFnsLocale() {
  return dateFnsLocales[getCurrentLocale()] || enUS;
}

export function getCldrLocale() {
  return cldrLocale;
}

export function getNumberSymbols() {
  return cldrLocale.numbers['symbols-numberSystem-latn'];
}

export function getCurrentLocale() {
  // First check i18next's current language (normalized back: en-GB -> en_GB)
  const i18nLang = i18n.language?.replace('-', '_');
  return i18nLang || getSavedLocale() || getNativeLocale();
}

export function getNativeLocale() {
  if (!isExtension()) {
    // On mobile/desktop, use navigator.language (e.g., 'en-US' -> 'en')
    return navigator.language?.split('-')[0] || 'en';
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const browser = require('webextension-polyfill');
    return browser.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}

export function getDefaultLocale(): string {
  if (!isExtension()) {
    return 'en';
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const browser = require('webextension-polyfill');
    const manifest = browser.runtime.getManifest();
    return (manifest as any).default_locale || 'en';
  } catch {
    return 'en';
  }
}

export async function fetchLocaleMessages(locale: string) {
  const dirName = locale.replace('-', '_');

  let url: string;
  if (!isExtension()) {
    // On mobile/desktop, use relative URL
    url = `/_locales/${dirName}/messages.json`;
  } else {
    const browser = await getBrowser();
    url = browser.runtime.getURL(`_locales/${dirName}/messages.json`);
  }

  try {
    const res = await fetch(url);
    const messages: LocaleMessages = await res.json();

    appendPlaceholderLists(messages);
    return messages;
  } catch (err: any) {
    console.error(err);

    return null;
  }
}

function appendPlaceholderLists(messages: LocaleMessages) {
  for (const name in messages) {
    const val = messages[name];
    if (val?.placeholders) {
      val.placeholderList = [];
      for (const pKey in val.placeholders) {
        const placeholder: { content: string } | undefined = val.placeholders[pKey];
        if (!placeholder) continue;
        const index = +placeholder.content.substring(1) - 1;
        val.placeholderList[index] = pKey;
      }
    }
  }
}
