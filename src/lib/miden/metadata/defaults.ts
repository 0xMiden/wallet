import { isExtension } from 'lib/platform';

import { AssetMetadata } from './types';

// Get asset URL that works on extension, mobile, and desktop
export function getAssetUrl(path: string): string {
  if (!isExtension()) {
    // On mobile/desktop, use relative URL from web root
    return `/${path}`;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const browser = require('webextension-polyfill');
    return browser.runtime.getURL(path);
  } /* c8 ignore next 3 -- extension-only require() fallback */ catch {
    // Fallback for non-extension contexts
    return `/${path}`;
  }
}

export const MIDEN_METADATA: AssetMetadata = {
  decimals: 6,
  symbol: 'MIDEN',
  name: 'Miden',
  thumbnailUri: getAssetUrl('misc/token-logos/miden.svg')
};

export const EMPTY_ASSET_METADATA: AssetMetadata = {
  decimals: 0,
  symbol: '',
  name: '',
  thumbnailUri: ''
};

export const DEFAULT_TOKEN_METADATA: AssetMetadata = {
  decimals: 6,
  symbol: 'Unknown',
  name: 'Unknown',
  thumbnailUri: getAssetUrl('misc/token-logos/default.svg')
};
