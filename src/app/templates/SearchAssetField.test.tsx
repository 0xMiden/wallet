import React from 'react';

import { render, screen } from '@testing-library/react';

import SearchAssetField from './SearchAssetField';

// SearchAssetField is a pure presentational wrapper: its only job is to render
// `SearchField` with a fixed set of styling props (a `clsx`-merged className,
// the translated placeholder, and the two search-icon class names) while
// spreading every remaining prop (`value`, `onValueChange`, arbitrary
// InputHTMLAttributes) straight through. We replace `SearchField` with a
// prop-recording stub so each forwarded value is asserted precisely without
// dragging in the real field's CleanButton / SearchIcon SVG stack.
const mockSearchFieldProps = jest.fn();

jest.mock('app/templates/SearchField', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockSearchFieldProps(props);
    return <div data-testid="search-field" />;
  }
}));

// `t(key)` is never `init()`-ed in the unit env; echo the key back so the
// placeholder is directly assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

// The default className tokens the wrapper always pins onto SearchField, in
// source order. `clsx` joins them with single spaces, so this is the exact
// string when no `className` prop is supplied.
const DEFAULT_CLASSES = [
  'py-2 pl-8 pr-4',
  'bg-gray-100 focus:bg-transparent',
  'border border-transparent',
  'focus:outline-none focus:border-border-card',
  'transition ease-in-out duration-200',
  'rounded-md',
  'text-black text-sm leading-tight',
  'placeholder-alphagray'
].join(' ');

beforeEach(() => {
  mockSearchFieldProps.mockClear();
});

describe('SearchAssetField', () => {
  it('renders SearchField with the default styling props when only required props are given', () => {
    const onValueChange = jest.fn();

    render(<SearchAssetField value="" onValueChange={onValueChange} />);

    expect(screen.getByTestId('search-field')).toBeInTheDocument();
    expect(mockSearchFieldProps).toHaveBeenCalledTimes(1);

    const props = mockSearchFieldProps.mock.calls[0][0];

    // No `className` prop → clsx drops the trailing undefined, leaving exactly
    // the default token string.
    expect(props.className).toBe(DEFAULT_CLASSES);

    // Placeholder is the translated `searchAssets` key.
    expect(props.placeholder).toBe('searchAssets');

    // The two icon class names are hard-pinned by the wrapper.
    expect(props.searchIconClassName).toBe('h-5 w-auto');
    expect(props.searchIconWrapperClassName).toBe('px-2 text-text-muted');

    // Required props spread through via `...rest`.
    expect(props.value).toBe('');
    expect(props.onValueChange).toBe(onValueChange);
  });

  it('appends a custom `className` after the default tokens (clsx merge branch)', () => {
    render(<SearchAssetField value="btc" onValueChange={jest.fn()} className="custom-cls extra" />);

    const props = mockSearchFieldProps.mock.calls[0][0];

    // `className` is destructured out and passed as the final clsx arg, so it
    // is appended to — not replacing — the default tokens.
    expect(props.className).toBe(`${DEFAULT_CLASSES} custom-cls extra`);

    // `className` itself must NOT leak through `...rest` onto SearchField as a
    // duplicate — the merged value is the single source of truth.
    expect(mockSearchFieldProps.mock.calls[0][0].className.indexOf('custom-cls')).toBeGreaterThan(
      DEFAULT_CLASSES.length - 1
    );
  });

  it('spreads arbitrary input attributes and handlers through `...rest`', () => {
    const onValueChange = jest.fn();
    const onFocus = jest.fn();

    render(
      <SearchAssetField
        value="hello"
        onValueChange={onValueChange}
        id="asset-search"
        autoFocus
        disabled
        maxLength={42}
        onFocus={onFocus}
        data-testid="passthrough"
      />
    );

    const props = mockSearchFieldProps.mock.calls[0][0];

    // Styling props are still applied alongside the spread rest.
    expect(props.className).toBe(DEFAULT_CLASSES);
    expect(props.placeholder).toBe('searchAssets');
    expect(props.searchIconClassName).toBe('h-5 w-auto');
    expect(props.searchIconWrapperClassName).toBe('px-2 text-text-muted');

    // Every extra prop flows through verbatim.
    expect(props.value).toBe('hello');
    expect(props.onValueChange).toBe(onValueChange);
    expect(props.id).toBe('asset-search');
    expect(props.autoFocus).toBe(true);
    expect(props.disabled).toBe(true);
    expect(props.maxLength).toBe(42);
    expect(props.onFocus).toBe(onFocus);
    expect(props['data-testid']).toBe('passthrough');
  });
});
