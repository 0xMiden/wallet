import React from 'react';

import { render } from '@testing-library/react';

import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

import { Drawer } from './drawer';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

const content = <div>drawer content</div>;

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  setRoutePart('/send');
});

afterEach(() => {
  if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
});

it('named drawer appends a precise overlay part while open, removes it on close', () => {
  const { rerender } = render(
    <Drawer open={false} onOpenChange={() => {}} screenKey="token">
      {content}
    </Drawer>
  );
  expect(getCurrentScreen().key).toBe('/send');

  rerender(
    <Drawer open onOpenChange={() => {}} screenKey="token">
      {content}
    </Drawer>
  );
  expect(getCurrentScreen().key).toBe('/send > drawer:token');

  rerender(
    <Drawer open={false} onOpenChange={() => {}} screenKey="token">
      {content}
    </Drawer>
  );
  expect(getCurrentScreen().key).toBe('/send');
});

it('unnamed drawer falls back to a generic overlay part', () => {
  const { rerender } = render(
    <Drawer open={false} onOpenChange={() => {}}>
      {content}
    </Drawer>
  );
  rerender(
    <Drawer open onOpenChange={() => {}}>
      {content}
    </Drawer>
  );
  expect(getCurrentScreen().key).toBe('/send > drawer');
});

it('removes the overlay part on unmount while still open', () => {
  const { unmount } = render(
    <Drawer open onOpenChange={() => {}} screenKey="token">
      {content}
    </Drawer>
  );
  expect(getCurrentScreen().key).toBe('/send > drawer:token');

  unmount();
  expect(getCurrentScreen().key).toBe('/send');
});
