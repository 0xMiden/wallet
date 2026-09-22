import React, { useRef } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import FullScreenPage from 'app/layouts/FullScreenPage';
import MobilePageLayers from 'app/layouts/MobilePageLayers';
import { HistoryAction } from 'lib/woozie/history';
import { createLocationState, LocationProvider, LocationState } from 'lib/woozie/location';

import { useBackWithFallback } from './useBackWithFallback';

const goBackMock = jest.fn();
const navigateMock = jest.fn();

// Only the two calls that would move history are faked; location and history are the real ones,
// driven through jsdom's `history`, so the hook is tested against what the page actually sees.
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie/history'),
  ...jest.requireActual('lib/woozie/location'),
  goBack: () => goBackMock(),
  navigate: (path: string, action?: string) => navigateMock(path, action)
}));

// Pin the page slide long, so a layer popped in the tests below is still sliding out when the
// same route is pushed again, whatever the machine's speed.
jest.mock('lib/animation/page-appearance', () => ({
  ...jest.requireActual('lib/animation/page-appearance'),
  pageSlideEntrance: { type: 'tween', duration: 60 }
}));

/** Puts the live URL at `path`, `position` entries deep, without a history event. */
function setLive(path: string, position: number) {
  window.history.replaceState(null, '', `/#${path}`);
  Object.assign(window.history, { position });
}

/**
 * A traversal back to `path`, as the browser does it: the URL changes with no event of its own, then
 * `popstate`. The unpatched `replaceState`, so woozie sees only the pop, as it does on a device.
 */
function popTo(path: string) {
  act(() => {
    History.prototype.replaceState.call(window.history, null, '', `/#${path}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

function pushTo(path: string) {
  act(() => {
    window.history.pushState(null, '', `/#${path}`);
  });
}

function snapshot(pathname: string, historyPosition: number): LocationState {
  return {
    pathname,
    search: '',
    hash: '',
    state: null,
    trigger: HistoryAction.Push,
    historyLength: 4,
    historyPosition
  };
}

// The hook returns a callback, so drive it through a click rather than reaching
// into the render result.
const WithFallback: React.FC<{ fallback?: string }> = ({ fallback }) => {
  const back = useBackWithFallback(fallback);
  return <button onClick={back}>back</button>;
};

// A page outside the layer stack reads the live location.
const renderLive = (fallback?: string) =>
  render(
    <LocationProvider>
      <WithFallback fallback={fallback} />
    </LocationProvider>
  );

const clickBack = () => fireEvent.click(screen.getByRole('button', { name: 'back' }));

beforeEach(() => {
  goBackMock.mockClear();
  navigateMock.mockClear();
  setLive('/settings/language', 3);
});

describe('useBackWithFallback', () => {
  it('pops history when there is an entry to return to', () => {
    renderLive('/settings');

    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('replaces with the fallback when the screen was opened cold', () => {
    // `history.go(-1)` is a no-op at position 0 — a deep link, a reload or a
    // Replace navigation — which left the header chevron inert. It has to
    // REPLACE: pushing would leave an entry that walks straight back in.
    setLive('/settings/language', 0);
    renderLive('/settings');

    clickBack();

    expect(navigateMock).toHaveBeenCalledWith('/settings', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('falls back to the wallet home by default', () => {
    setLive('/settings/language', 0);
    renderLive();

    clickBack();

    expect(navigateMock).toHaveBeenCalledWith('/', HistoryAction.Replace);
  });

  it('pops once however many times it is invoked before the location changes', () => {
    // `history.go(-1)` resolves on a later task, so the screen stays mounted and
    // its chevron live: a double tap queued two traversals and overshot the
    // intended parent. Every routed settings sub-page header uses this callback.
    renderLive('/settings');

    clickBack();
    clickBack();
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
  });

  it('latches on the fallback path too', () => {
    setLive('/settings/language', 0);
    renderLive('/settings');

    clickBack();
    clickBack();

    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms once the location actually changes', () => {
    // Otherwise a screen the user navigates back INTO would have a dead chevron.
    renderLive('/settings');
    clickBack();
    expect(goBackMock).toHaveBeenCalledTimes(1);

    pushTo('/settings/about');
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(2);
  });

  it('re-arms after a pop onto an entry with the same URL', () => {
    // A Replace onto the URL of the entry below (a fallback, a close) leaves two adjacent
    // entries with one URL. Going back between them fires only `popstate`: the URL stays,
    // the position does not.
    setLive('/rotate-guardian', 3);
    renderLive('/settings');
    clickBack();
    expect(goBackMock).toHaveBeenCalledTimes(1);

    popTo('/rotate-guardian');
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(2);
  });

  it('stays latched through a history event that leaves the URL where it was', () => {
    // A replace of the same URL is not a new location, so the traversal already
    // queued is still the one in flight.
    renderLive('/settings');
    clickBack();

    act(() => {
      window.history.replaceState(null, '', window.location.href);
    });
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
  });
});

describe('useBackWithFallback on a page layer (a frozen location snapshot)', () => {
  // MobilePageLayers wraps every layer in `<LocationProvider snapshot>`, so a page
  // kept mounted under or over another one reads the location it last rendered with.
  const InLayer: React.FC<{ frozen: LocationState }> = ({ frozen }) => (
    <LocationProvider snapshot={frozen}>
      <WithFallback fallback="/settings/address-book" />
    </LocationProvider>
  );

  it('pops from live history when the snapshot says the page was opened cold', () => {
    setLive('/contacts/new', 3);
    render(<InLayer frozen={snapshot('/contacts/new', 0)} />);

    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('uses the fallback when live history is at its start, whatever the snapshot says', () => {
    setLive('/contacts/new', 0);
    render(<InLayer frozen={snapshot('/contacts/new', 3)} />);

    clickBack();

    expect(navigateMock).toHaveBeenCalledWith('/settings/address-book', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('goes back again after the live location left and came back to the same page', () => {
    // The snapshot never changes, so a latch keyed on it never re-armed: the page's
    // second visit had a dead back button.
    setLive('/contacts/new', 3);
    render(<InLayer frozen={snapshot('/contacts/new', 3)} />);
    clickBack();
    expect(goBackMock).toHaveBeenCalledTimes(1);

    popTo('/settings/address-book');
    pushTo('/contacts/new');
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(2);
  });

  it('still pops once on a double tap', () => {
    setLive('/contacts/new', 3);
    render(<InLayer frozen={snapshot('/contacts/new', 3)} />);

    clickBack();
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(1);
  });

  it('goes back from a slide page re-entered while its layer was still sliding out', async () => {
    // The device repro: Address Book -> New contact -> back -> New contact -> back. The
    // pop leaves the slide page's layer mounted while it slides out, and a push to the
    // same route before it is removed brings back that same instance, latch and all.
    let mounts = 0;
    const NewContact: React.FC = () => {
      const counted = useRef(false);
      if (!counted.current) {
        counted.current = true;
        mounts++;
      }
      return <WithFallback fallback="/settings/address-book" />;
    };
    const page = (contact: boolean) => (
      <MobilePageLayers location={createLocationState()} pageKey={contact ? '/contacts/new' : 'tabs'} slide={contact}>
        {contact ? (
          <FullScreenPage entrance="slide">
            <NewContact />
          </FullScreenPage>
        ) : (
          <div>tabs</div>
        )}
      </MobilePageLayers>
    );
    const settle = () => act(async () => undefined);

    setLive('/settings/address-book', 2);
    const { rerender, container } = render(page(false));
    pushTo('/contacts/new');
    rerender(page(true));
    await settle();
    clickBack();
    expect(goBackMock).toHaveBeenCalledTimes(1);

    popTo('/settings/address-book');
    rerender(page(false));
    await settle();
    expect(container.querySelector('[data-page-layer="/contacts/new"]')).toBeInTheDocument();

    pushTo('/contacts/new');
    rerender(page(true));
    await settle();
    expect(mounts).toBe(1);
    clickBack();

    expect(goBackMock).toHaveBeenCalledTimes(2);
  });
});
