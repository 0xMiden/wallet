import React from 'react';

import { render } from '@testing-library/react';

import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from './screen-key';
import { useOverlayScreenKey } from './useOverlayScreenKey';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

/** Tiny host so the hook runs inside a real component lifecycle (mount/rerender/unmount). */
function Host({ open, overlayId }: { open: boolean; overlayId: string }) {
  useOverlayScreenKey(open, overlayId);
  return null;
}

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  setRoutePart('/send');
});

afterEach(() => {
  if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
});

describe('useOverlayScreenKey', () => {
  it('pushes the overlay id while open', () => {
    render(<Host open overlayId="drawer:token" />);
    expect(getCurrentScreen().key).toBe('/send > drawer:token');
  });

  it('pops the overlay id when `open` flips to false', () => {
    const { rerender } = render(<Host open overlayId="drawer:token" />);
    expect(getCurrentScreen().key).toBe('/send > drawer:token');

    rerender(<Host open={false} overlayId="drawer:token" />);
    expect(getCurrentScreen().key).toBe('/send');
  });

  it('pops the overlay id on unmount while still open', () => {
    const { unmount } = render(<Host open overlayId="drawer:token" />);
    expect(getCurrentScreen().key).toBe('/send > drawer:token');

    unmount();
    expect(getCurrentScreen().key).toBe('/send');
  });

  it('never pushes while closed (no-op)', () => {
    render(<Host open={false} overlayId="drawer:token" />);
    expect(getCurrentScreen().key).toBe('/send');
  });

  it('is a no-op when MIDEN_E2E_TEST is not "true", even while open', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    __resetScreenKeyForTest();
    setRoutePart('/send');

    render(<Host open overlayId="drawer:token" />);
    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
  });

  it('works uniformly for a generic (unnamed) overlay id, same as a named one', () => {
    render(<Host open overlayId="drawer" />);
    expect(getCurrentScreen().key).toBe('/send > drawer');
  });
});
