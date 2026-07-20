/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { useTabSlug } from './useTabSlug';

// The hook only consumes `search` from woozie's `useLocation`. We mock the
// `lib/woozie` barrel (the import path the hook uses) with a mutable location
// object so each test can drive a different query string without rendering the
// real router / history stack.
const mockLocation: { search: string } = { search: '' };

jest.mock('lib/woozie', () => ({
  useLocation: () => mockLocation
}));

const setSearch = (search: string) => {
  mockLocation.search = search;
};

describe('useTabSlug', () => {
  beforeEach(() => {
    setSearch('');
  });

  it('returns the value of the `tab` query param when present', () => {
    setSearch('?tab=activity');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBe('activity');
  });

  it('returns null when there is no query string at all', () => {
    setSearch('');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBeNull();
  });

  it('returns null when a query string exists but has no `tab` param', () => {
    setSearch('?foo=bar&baz=qux');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBeNull();
  });

  it('returns an empty string when `tab` is present but has no value', () => {
    setSearch('?tab=');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBe('');
  });

  it('extracts `tab` when it is among several params, regardless of position', () => {
    setSearch('?foo=1&tab=receive&bar=2');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBe('receive');
  });

  it('works whether or not the leading `?` is present', () => {
    setSearch('tab=send');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBe('send');
  });

  it('decodes URL-encoded `tab` values', () => {
    setSearch('?tab=my%20tab');

    const { result } = renderHook(() => useTabSlug());

    expect(result.current).toBe('my tab');
  });

  it('recomputes when the location search changes across re-renders', () => {
    setSearch('?tab=first');

    const { result, rerender } = renderHook(() => useTabSlug());
    expect(result.current).toBe('first');

    setSearch('?tab=second');
    rerender();
    expect(result.current).toBe('second');
  });

  it('returns a stable memoized value across re-renders when search is unchanged', () => {
    setSearch('?tab=stable');

    const { result, rerender } = renderHook(() => useTabSlug());
    const firstValue = result.current;

    rerender();

    // Same search => the memoized dependency is unchanged, so the returned
    // value is identical.
    expect(result.current).toBe(firstValue);
    expect(result.current).toBe('stable');
  });
});
