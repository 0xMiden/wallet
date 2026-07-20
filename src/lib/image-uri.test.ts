import { formatAssetUri, formatObjktSmallAssetUri } from './image-uri';

const MEDIA_HOST = 'https://static.tcinfra.net';

describe('formatAssetUri', () => {
  it('rewrites ipfs:// URIs to the media host, stripping the scheme', () => {
    expect(formatAssetUri('ipfs://QmHash/image.png')).toBe(
      `${MEDIA_HOST}/media/small/ipfs/QmHash/image.png`
    );
  });

  it('rewrites http:// URLs to the web media path without the scheme', () => {
    expect(formatAssetUri('http://example.com/a.png')).toBe(
      `${MEDIA_HOST}/media/small/web/example.com/a.png`
    );
  });

  it('rewrites https:// URLs to the web media path without the scheme', () => {
    expect(formatAssetUri('https://example.com/a.png')).toBe(
      `${MEDIA_HOST}/media/small/web/example.com/a.png`
    );
  });

  it('returns chrome-extension URLs unchanged', () => {
    const url = 'chrome-extension://abc/icon.png';
    expect(formatAssetUri(url)).toBe(url);
  });

  it('returns moz-extension URLs unchanged', () => {
    const url = 'moz-extension://abc/icon.png';
    expect(formatAssetUri(url)).toBe(url);
  });

  it('returns relative (mobile) URLs starting with / unchanged', () => {
    const url = '/assets/local.png';
    expect(formatAssetUri(url)).toBe(url);
  });

  it('returns an empty string for unrecognized schemes', () => {
    expect(formatAssetUri('data:image/png;base64,AAAA')).toBe('');
  });

  it('returns an empty string when called with no argument (default param)', () => {
    expect(formatAssetUri()).toBe('');
  });

  it('returns an empty string for an explicit empty string', () => {
    expect(formatAssetUri('')).toBe('');
  });
});

describe('formatObjktSmallAssetUri', () => {
  it('builds the objkt thumb288 URL from an address_id slug', () => {
    expect(formatObjktSmallAssetUri('KT1abc_42')).toBe(
      'https://assets.objkt.media/file/assets-003/KT1abc/42/thumb288'
    );
  });

  it('leaves the id segment undefined when the slug has no underscore', () => {
    expect(formatObjktSmallAssetUri('KT1abc')).toBe(
      'https://assets.objkt.media/file/assets-003/KT1abc/undefined/thumb288'
    );
  });
});
