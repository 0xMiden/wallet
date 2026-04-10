/* eslint-disable import/first */

jest.mock('lib/platform', () => ({
  isExtension: jest.fn()
}));

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    runtime: {
      getURL: jest.fn((p: string) => `chrome-extension://test/${p}`)
    }
  },
  runtime: {
    getURL: jest.fn((p: string) => `chrome-extension://test/${p}`)
  }
}));

import { isExtension } from 'lib/platform';

import { DEFAULT_TOKEN_METADATA, EMPTY_ASSET_METADATA, getAssetUrl, MIDEN_METADATA } from './defaults';

const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

describe('getAssetUrl', () => {
  it('returns a relative URL on non-extension platforms', () => {
    mockIsExtension.mockReturnValue(false);
    expect(getAssetUrl('foo/bar.svg')).toBe('/foo/bar.svg');
  });

  it('uses browser.runtime.getURL on extension', () => {
    mockIsExtension.mockReturnValue(true);
    expect(getAssetUrl('foo.svg')).toContain('chrome-extension://test/foo.svg');
  });

  it('falls back to a relative URL when require throws', () => {
    mockIsExtension.mockReturnValue(true);
    jest.resetModules();
    jest.doMock('webextension-polyfill', () => {
      throw new Error('not available');
    });
    jest.isolateModules(() => {
      const { getAssetUrl: gau } = require('./defaults');
      expect(gau('foo.svg')).toBe('/foo.svg');
    });
    jest.dontMock('webextension-polyfill');
  });
});

describe('static metadata constants', () => {
  it('MIDEN_METADATA has the right shape', () => {
    expect(MIDEN_METADATA.symbol).toBe('MIDEN');
    expect(MIDEN_METADATA.decimals).toBe(6);
  });

  it('EMPTY_ASSET_METADATA is fully blank', () => {
    expect(EMPTY_ASSET_METADATA).toEqual({
      decimals: 0,
      symbol: '',
      name: '',
      thumbnailUri: ''
    });
  });

  it('DEFAULT_TOKEN_METADATA has the Unknown defaults', () => {
    expect(DEFAULT_TOKEN_METADATA.symbol).toBe('Unknown');
    expect(DEFAULT_TOKEN_METADATA.name).toBe('Unknown');
  });
});
