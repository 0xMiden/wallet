import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import type { AssetMetadata } from 'lib/miden/metadata/types';

import { AssetIcon } from './AssetIcon';

// AssetIcon's only external, non-pure dependency is `useAssetMetadata` from the
// `lib/miden/front` SDK barrel. We mock just that member so we can drive the
// component through every metadata shape (present / null / with-thumbnail /
// without-thumbnail).
//
// Everything else is exercised for real:
//   - `lib/image-uri.formatAssetUri` is a pure string transformer, so we feed
//     it real slugs/URIs and assert the resulting <img src>. Whether it yields
//     a non-empty URL (http / relative) or an empty string (plain slug) is what
//     selects the two top-level render branches.
//   - `app/icons/v2` renders the `MidenLogo` placeholder. Its SVGs are stubbed
//     by jest's `svgMock.js` to the string 'svg', so the placeholder shows up
//     as a real <svg> DOM node we can query.
const mockUseAssetMetadata = jest.fn();

jest.mock('lib/miden/front', () => ({
  useAssetMetadata: (...args: unknown[]) => mockUseAssetMetadata(...args)
}));

const meta = (over: Partial<AssetMetadata> = {}): AssetMetadata => ({
  decimals: 6,
  symbol: 'TOK',
  name: 'Token',
  ...over
});

const getImg = (container: HTMLElement) => container.querySelector('img');
const getPlaceholder = (container: HTMLElement) => container.querySelector('svg');
const getWrapper = (container: HTMLElement) => container.firstElementChild as HTMLElement;

beforeEach(() => {
  mockUseAssetMetadata.mockReset();
});

describe('AssetIcon', () => {
  it('forwards (assetSlug, assetId) to useAssetMetadata', () => {
    mockUseAssetMetadata.mockReturnValue(null);
    render(<AssetIcon assetSlug="the-slug" assetId="the-id" />);

    expect(mockUseAssetMetadata).toHaveBeenCalledWith('the-slug', 'the-id');
  });

  it('renders the styled wrapper and merges a custom className', () => {
    mockUseAssetMetadata.mockReturnValue(null);
    const { container } = render(<AssetIcon assetSlug="slug" assetId="id" className="extra-cls" />);

    const wrapper = getWrapper(container);
    expect(wrapper.tagName.toLowerCase()).toBe('div');
    expect(wrapper).toHaveClass('flex', 'items-center', 'justify-center', 'extra-cls');
    // Inline sizing/border styles are always applied.
    expect(wrapper.style.width).toBe('36px');
    expect(wrapper.style.height).toBe('36px');
    expect(wrapper.style.borderRadius).toBe('20px');
  });

  it('omits the extra class when className is not provided', () => {
    mockUseAssetMetadata.mockReturnValue(null);
    const { container } = render(<AssetIcon assetSlug="slug" assetId="id" />);

    const wrapper = getWrapper(container);
    expect(wrapper.getAttribute('class')).toBe('flex items-center justify-center');
  });

  describe('when metadata has a resolvable thumbnailUri', () => {
    const withThumb = () => meta({ symbol: 'TOK', thumbnailUri: 'http://ex.com/logo.png' });
    const expectedSrc = 'https://static.tcinfra.net/media/small/web/ex.com/logo.png';

    it('renders the <img> (hidden until loaded) plus the placeholder', () => {
      mockUseAssetMetadata.mockReturnValue(withThumb());
      const { container } = render(<AssetIcon assetSlug="tok" assetId="a1" size={24} />);

      const img = getImg(container)!;
      expect(img).toBeInTheDocument();
      // formatAssetUri routed the http URI through the web CDN path.
      expect(img).toHaveAttribute('src', expectedSrc);
      expect(img).toHaveAttribute('alt', 'TOK');
      // `size` flows to width/height attributes.
      expect(img).toHaveAttribute('width', '24');
      expect(img).toHaveAttribute('height', '24');
      // Not yet loaded → hidden via display:none, and the placeholder is shown.
      expect(img.style.display).toBe('none');
      expect(getPlaceholder(container)).toBeInTheDocument();
    });

    it('reveals the image and drops the placeholder once it loads', () => {
      mockUseAssetMetadata.mockReturnValue(withThumb());
      const { container } = render(<AssetIcon assetSlug="tok" assetId="a1" />);

      const img = getImg(container)!;
      fireEvent.load(img);

      // isLoaded → true: display:none is removed and (metadata present +
      // non-empty src) hides the placeholder.
      expect(img.style.display).not.toBe('none');
      expect(getPlaceholder(container)).not.toBeInTheDocument();
    });

    it('marks the strategy failed on error and keeps rendering (fallback loop falls through)', () => {
      mockUseAssetMetadata.mockReturnValue(withThumb());
      const { container } = render(<AssetIcon assetSlug="tok" assetId="a1" />);

      const img = getImg(container)!;
      // onError flips isLoadingFailed.thumbnailUri → true. On the next render the
      // fallback loop's `!currentState[type]` guard is false, so it falls through
      // to `return strategy[0]`. src is unchanged (same field), img stays.
      fireEvent.error(img);

      const after = getImg(container)!;
      expect(after).toBeInTheDocument();
      expect(after).toHaveAttribute('src', expectedSrc);
      // Still not loaded → placeholder remains.
      expect(getPlaceholder(container)).toBeInTheDocument();
    });
  });

  it('keeps the placeholder even after load when metadata is null', () => {
    // metadata === null but the slug itself is a resolvable relative URI, so an
    // <img> is rendered. The placeholder stays because the `!metadata` branch of
    // the placeholder condition is true regardless of load state.
    mockUseAssetMetadata.mockReturnValue(null);
    const { container } = render(<AssetIcon assetSlug="/local/img.png" assetId="a2" />);

    const img = getImg(container)!;
    expect(img).toHaveAttribute('src', '/local/img.png');
    // No symbol → no alt attribute; no size → no width/height attributes.
    expect(img).not.toHaveAttribute('alt');
    expect(img).not.toHaveAttribute('width');
    expect(img).not.toHaveAttribute('height');

    fireEvent.load(img);
    expect(img.style.display).not.toBe('none');
    // metadata is null → placeholder persists even though isLoaded is now true.
    expect(getPlaceholder(container)).toBeInTheDocument();
  });

  it('renders only the placeholder (no <img>) when the slug resolves to an empty URI', () => {
    // A plain slug is not ipfs/http/extension/relative → formatAssetUri returns
    // '' → imageSrc === '' → the `<img>` guard is false, only the placeholder
    // is shown.
    mockUseAssetMetadata.mockReturnValue(null);
    const { container } = render(<AssetIcon assetSlug="plain-slug" assetId="a3" />);

    expect(getImg(container)).toBeNull();
    expect(getPlaceholder(container)).toBeInTheDocument();
  });

  it('renders only the placeholder when metadata is present but has no thumbnailUri and the slug is unresolvable', () => {
    // metadata truthy but `metadata.thumbnailUri` is undefined → fallback loop
    // falls through; imageSrc = formatAssetUri(assetSlug) = '' → no <img>.
    mockUseAssetMetadata.mockReturnValue(meta({ symbol: 'NOIMG' }));
    const { container } = render(<AssetIcon assetSlug="unresolvable" assetId="a4" />);

    expect(getImg(container)).toBeNull();
    expect(getPlaceholder(container)).toBeInTheDocument();
  });
});
