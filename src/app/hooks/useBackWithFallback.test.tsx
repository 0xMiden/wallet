import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { useBackWithFallback } from './useBackWithFallback';

const goBackMock = jest.fn();
const navigateMock = jest.fn();
let historyPosition = 0;

let pathname = '/settings/language';

jest.mock('lib/woozie', () => ({
  goBack: () => goBackMock(),
  navigate: (path: string, action?: string) => navigateMock(path, action),
  useLocation: () => ({ historyPosition, pathname }),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

// The hook returns a callback, so drive it through a click rather than reaching
// into the render result.
const WithFallback: React.FC<{ fallback: string }> = ({ fallback }) => {
  const back = useBackWithFallback(fallback);
  return <button onClick={back}>back</button>;
};

const WithDefaultFallback: React.FC = () => {
  const back = useBackWithFallback();
  return <button onClick={back}>back</button>;
};

const clickBack = () => fireEvent.click(screen.getByRole('button', { name: 'back' }));

describe('useBackWithFallback', () => {
  beforeEach(() => {
    goBackMock.mockClear();
    navigateMock.mockClear();
    pathname = '/settings/language';
  });

  it('pops history when there is an entry to return to', () => {
    historyPosition = 3;
    render(<WithFallback fallback="/settings" />);

    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('replaces with the fallback when the screen was opened cold', () => {
    // `history.go(-1)` is a no-op at position 0 — a deep link, a reload or a
    // Replace navigation — which left the header chevron inert. It has to
    // REPLACE: pushing would leave an entry that walks straight back in.
    historyPosition = 0;
    render(<WithFallback fallback="/settings" />);

    clickBack();

    expect(navigateMock).toHaveBeenCalledWith('/settings', 'replace');
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('falls back to the wallet home by default', () => {
    historyPosition = 0;
    render(<WithDefaultFallback />);

    clickBack();

    expect(navigateMock).toHaveBeenCalledWith('/', 'replace');
  });

  it('pops once however many times it is invoked before the location changes', () => {
    // `history.go(-1)` resolves on a later task, so the screen stays mounted and
    // its chevron live: a double tap queued two traversals and overshot the
    // intended parent. Every routed settings sub-page header uses this callback.
    historyPosition = 3;
    render(<WithFallback fallback="/settings" />);

    clickBack();
    clickBack();
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
  });

  it('latches on the fallback path too', () => {
    historyPosition = 0;
    render(<WithFallback fallback="/settings" />);

    clickBack();
    clickBack();

    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms once the location actually changes', () => {
    // Otherwise a screen the user navigates back INTO would have a dead chevron.
    historyPosition = 3;
    const { rerender } = render(<WithFallback fallback="/settings" />);
    clickBack();
    expect(goBackMock).toHaveBeenCalledTimes(1);

    pathname = '/settings/about';
    rerender(<WithFallback fallback="/settings" />);
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(2);
  });
});
