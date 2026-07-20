import React, { Suspense } from 'react';

import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import { SWRConfig } from 'swr';

import AwaitI18N from './AwaitI18N';
import { onInited } from 'lib/i18n';

// `lib/i18n` pulls in i18next + webextension-polyfill at import time. The
// component only touches `onInited`, so we replace the whole barrel with a
// single jest.fn we can steer per test (fire the callback, no-op, or throw).
jest.mock('lib/i18n', () => ({
  onInited: jest.fn()
}));

const mockedOnInited = onInited as jest.MockedFunction<typeof onInited>;

// SWR keeps a module-global cache keyed by 'i18n'. A fresh Map provider per
// render isolates each test so the suspense fetcher (`awaitI18n`) actually
// re-runs with the current `onInited` behaviour instead of returning a
// previously-cached value.
const renderAwait = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Suspense fallback={<span data-testid="fallback">loading</span>}>
        <AwaitI18N />
      </Suspense>
    </SWRConfig>
  );

const waitForResolved = () => waitForElementToBeRemoved(() => screen.queryByTestId('fallback'));

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('AwaitI18N', () => {
  it('suspends until i18n init resolves, then renders nothing', async () => {
    // `onInited(cb)` fires the callback -> the init race resolves via the
    // onInited branch -> `awaitI18n` returns null -> SWR unsuspends.
    mockedOnInited.mockImplementation(cb => cb());

    const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderAwait();

    // The suspense fallback is shown before the fetcher settles.
    expect(screen.getByTestId('fallback')).toBeInTheDocument();

    await waitForResolved();

    // Component itself renders null, so nothing is left in the container.
    expect(container).toBeEmptyDOMElement();
    expect(mockedOnInited).toHaveBeenCalledTimes(1);
    expect(mockedOnInited).toHaveBeenCalledWith(expect.any(Function));
    // Happy path must not log any error.
    expect(consoleErr).not.toHaveBeenCalled();
  });

  it('swallows an init error, logs it, and still renders nothing', async () => {
    const boom = new Error('init blew up');
    // Throwing synchronously inside the Promise executor rejects the onInited
    // race member, so `Promise.race` rejects and the try/catch is exercised.
    mockedOnInited.mockImplementation(() => {
      throw boom;
    });

    const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderAwait();

    await waitForResolved();

    // The catch returns null, so SWR still resolves and the component renders
    // nothing rather than propagating the error to the suspense boundary.
    expect(container).toBeEmptyDOMElement();
    expect(consoleErr).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalledWith(boom);
  });
});
