/**
 * @jest-environment jsdom
 */
import React from 'react';

import { act, render } from '@testing-library/react';

import { getCurrentScreen, __resetScreenKeyForTest } from 'lib/e2e/screen-key';
import * as Woozie from 'lib/woozie';

import { ScreenKeyPublisher } from './ScreenKeyPublisher';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

beforeEach(() => {
  __resetScreenKeyForTest();
  window.location.hash = '';
});

afterEach(() => {
  if (ORIGINAL_E2E === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = ORIGINAL_E2E;
});

describe('ScreenKeyPublisher', () => {
  it('publishes the current route on mount and on navigation when the E2E flag is on', async () => {
    process.env.MIDEN_E2E_TEST = 'true';

    render(
      <Woozie.Provider>
        <ScreenKeyPublisher />
      </Woozie.Provider>
    );
    // mount publishes whatever the initial route is (non-empty key)
    expect(getCurrentScreen().key.startsWith('/')).toBe(true);

    await act(async () => {
      Woozie.navigate('/send/review');
      // jsdom dispatches a same-document `popstate` for the hash change on a
      // later task (not synchronously with pushState); flush it inside `act`
      // so Woozie's internal force-update listener isn't warned about.
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(getCurrentScreen().key).toContain('/send/review');
  });

  it('does not publish anything when the E2E flag is off', async () => {
    process.env.MIDEN_E2E_TEST = 'false';

    render(
      <Woozie.Provider>
        <ScreenKeyPublisher />
      </Woozie.Provider>
    );
    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });

    await act(async () => {
      Woozie.navigate('/send/review');
      // jsdom dispatches a same-document `popstate` for the hash change on a
      // later task (not synchronously with pushState); flush it inside `act`
      // so Woozie's internal force-update listener isn't warned about.
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
  });
});
