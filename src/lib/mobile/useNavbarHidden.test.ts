import { renderHook, act } from '@testing-library/react';

import { useNavbarHidden } from './useNavbarHidden';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('useNavbarHidden', () => {
  beforeEach(() => document.body.removeAttribute('data-hide-navbar'));
  afterEach(() => document.body.removeAttribute('data-hide-navbar'));

  it('reflects the current data-hide-navbar flag at mount', () => {
    const absent = renderHook(() => useNavbarHidden());
    expect(absent.result.current).toBe(false);
    absent.unmount();

    document.body.setAttribute('data-hide-navbar', '');
    const present = renderHook(() => useNavbarHidden());
    expect(present.result.current).toBe(true);
    present.unmount();
  });

  it('reacts when the flag is toggled after mount', async () => {
    const { result } = renderHook(() => useNavbarHidden());
    expect(result.current).toBe(false);

    await act(async () => {
      document.body.setAttribute('data-hide-navbar', '');
      await flush();
    });
    expect(result.current).toBe(true);

    await act(async () => {
      document.body.removeAttribute('data-hide-navbar');
      await flush();
    });
    expect(result.current).toBe(false);
  });
});
