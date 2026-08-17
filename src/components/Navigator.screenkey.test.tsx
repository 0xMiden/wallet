import React from 'react';

import { act, render } from '@testing-library/react';

import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

import { NavigatorProvider, Route, useNavigator } from './Navigator';

const ORIGINAL_E2E = process.env.MIDEN_E2E_TEST;

const routeSelectAmount: Route = { name: 'SelectAmount', animationIn: 'push', animationOut: 'pop' };
const routeReview: Route = { name: 'Review', animationIn: 'push', animationOut: 'pop' };
const routes: Route[] = [routeSelectAmount, routeReview];

function Harness() {
  const nav = useNavigator();
  return (
    <button type="button" onClick={() => nav.navigateTo('Review')}>
      go
    </button>
  );
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

it('publishes the active Navigator card into the screen key, and clears it on unmount', () => {
  jest.useFakeTimers();
  const { getByText, unmount } = render(
    <NavigatorProvider routes={routes} initialRouteName="SelectAmount">
      <Harness />
    </NavigatorProvider>
  );
  expect(getCurrentScreen().key).toBe('/send > SelectAmount');

  act(() => {
    getByText('go').click();
    jest.runAllTimers();
  });
  expect(getCurrentScreen().key).toBe('/send > Review');
  jest.useRealTimers();

  unmount();
  expect(getCurrentScreen().key).toBe('/send');
});

it('publishes nothing (null card) when the card stack starts empty', () => {
  render(
    <NavigatorProvider routes={routes}>
      <Harness />
    </NavigatorProvider>
  );
  // No initialRouteName -> empty stack -> activeRoute undefined -> card part null.
  expect(getCurrentScreen().key).toBe('/send');
});

it('does not publish the card when MIDEN_E2E_TEST is not "true"', () => {
  process.env.MIDEN_E2E_TEST = 'false';
  __resetScreenKeyForTest();
  setRoutePart('/send');

  render(
    <NavigatorProvider routes={routes} initialRouteName="SelectAmount">
      <Harness />
    </NavigatorProvider>
  );
  expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
});
