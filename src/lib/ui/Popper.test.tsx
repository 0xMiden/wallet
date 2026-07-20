import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import Popper, { PopperRenderProps, RenderProp } from './Popper';

/**
 * Popper always mounts BOTH the trigger (children render-prop) and the popup
 * (popup render-prop, inside a Portal). Visibility is left to the consumer,
 * which reads `opened` off the render props. So in these tests the harness's
 * render props print the current `opened` state and expose buttons that call
 * `toggleOpened` / `setOpened`, and we assert on that text.
 *
 * The floating div is the direct parent of whatever the popup render-prop
 * returns (Popper wraps it: <div ref=setFloating>{popupNode}</div>).
 */
const floatingHostOf = (popupChild: HTMLElement) => popupChild.parentElement as HTMLElement;

type PopperChildren = React.ComponentProps<typeof Popper>['children'];
type HarnessProps = Partial<React.ComponentProps<typeof Popper>>;

const defaultPopup: RenderProp<PopperRenderProps> = ({ opened, setOpened }) => (
  <div data-testid="popup" data-opened={opened}>
    <span data-testid="popup-state">{opened ? 'OPEN' : 'CLOSED'}</span>
    <button type="button" data-testid="popup-close" onClick={() => setOpened(false)}>
      close from popup
    </button>
  </div>
);

const defaultTrigger: PopperChildren = ({ ref, opened, setOpened, toggleOpened }) => (
  <div>
    <button ref={ref} type="button" data-testid="trigger" onClick={toggleOpened}>
      {opened ? 'trigger-open' : 'trigger-closed'}
    </button>
    <button type="button" data-testid="open-directly" onClick={() => setOpened(true)}>
      open
    </button>
    <button type="button" data-testid="toggle-updater" onClick={() => setOpened(o => !o)}>
      toggle via updater
    </button>
  </div>
);

const Harness = ({ popup = defaultPopup, children = defaultTrigger, ...rest }: HarnessProps) => (
  <Popper popup={popup} {...rest}>
    {children}
  </Popper>
);

/**
 * `@floating-ui/react-dom` recomputes position asynchronously (a flushSync
 * dispatched off a microtask after mount / prop change). Flushing pending
 * microtasks inside `act` settles that update so React doesn't warn about a
 * state change outside `act`.
 */
const flushFloating = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('Popper', () => {
  it('renders both the trigger and the popup (in a Portal on document.body), closed by default', async () => {
    render(<Harness />);
    await flushFloating();

    const trigger = screen.getByTestId('trigger');
    const popup = screen.getByTestId('popup');

    expect(trigger).toBeInTheDocument();
    expect(popup).toBeInTheDocument();
    // Popup lives in the Portal host appended to <body>, not inside the trigger.
    expect(trigger.contains(popup)).toBe(false);
    expect(document.body.contains(popup)).toBe(true);

    // Default render props: opened === false is threaded through to both.
    expect(trigger).toHaveTextContent('trigger-closed');
    expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED');
    expect(popup).toHaveAttribute('data-opened', 'false');
  });

  it('applies the default absolute strategy and zIndex:40 to the floating container', async () => {
    render(<Harness />);
    await flushFloating();

    const floating = floatingHostOf(screen.getByTestId('popup'));
    expect(floating.style.position).toBe('absolute');
    expect(floating.style.zIndex).toBe('40');
  });

  it('uses the fixed strategy on the floating container when strategy="fixed"', async () => {
    render(<Harness strategy="fixed" />);
    await flushFloating();

    const floating = floatingHostOf(screen.getByTestId('popup'));
    expect(floating.style.position).toBe('fixed');
  });

  it('toggleOpened flips the open state open→closed and updates both render props', async () => {
    render(<Harness />);
    await flushFloating();

    const trigger = screen.getByTestId('trigger');

    fireEvent.click(trigger);
    expect(trigger).toHaveTextContent('trigger-open');
    expect(screen.getByTestId('popup-state')).toHaveTextContent('OPEN');
    expect(screen.getByTestId('popup')).toHaveAttribute('data-opened', 'true');
    await flushFloating();

    fireEvent.click(trigger);
    expect(trigger).toHaveTextContent('trigger-closed');
    expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED');
    await flushFloating();
  });

  it('setOpened(true) opens directly and setOpened(false) from the popup closes it', async () => {
    render(<Harness />);
    await flushFloating();

    fireEvent.click(screen.getByTestId('open-directly'));
    expect(screen.getByTestId('popup-state')).toHaveTextContent('OPEN');
    await flushFloating();

    fireEvent.click(screen.getByTestId('popup-close'));
    expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED');
    await flushFloating();
  });

  it('supports the functional-updater form of setOpened', async () => {
    render(<Harness />);
    await flushFloating();

    const updaterBtn = screen.getByTestId('toggle-updater');

    fireEvent.click(updaterBtn);
    expect(screen.getByTestId('popup-state')).toHaveTextContent('OPEN');
    await flushFloating();

    fireEvent.click(updaterBtn);
    expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED');
    await flushFloating();
  });

  it('closes on outside press via useDismiss/useInteractions', async () => {
    render(
      <>
        <Harness />
        <button type="button" data-testid="outside">
          outside
        </button>
      </>
    );

    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('popup-state')).toHaveTextContent('OPEN');
    await flushFloating();

    // A pointer press outside both the reference and floating elements
    // dismisses the popup (useDismiss default outsidePress behaviour).
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
      fireEvent.mouseDown(screen.getByTestId('outside'));
    });

    await waitFor(() => expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED'));
  });

  it('closes on Escape via useDismiss', async () => {
    render(<Harness />);
    await flushFloating();

    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('popup-state')).toHaveTextContent('OPEN');
    await flushFloating();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    await waitFor(() => expect(screen.getByTestId('popup-state')).toHaveTextContent('CLOSED'));
  });

  it('honours an explicit placement without breaking rendering', async () => {
    render(<Harness placement="top" />);
    await flushFloating();
    expect(screen.getByTestId('popup')).toBeInTheDocument();
    // Still a valid, positioned floating container.
    const floating = floatingHostOf(screen.getByTestId('popup'));
    expect(floating.style.position).toBe('absolute');
  });

  it('drops the flip() middleware when fallbackPlacementsEnabled is false', async () => {
    // Exercises the `fallbackPlacementsEnabled && flip()` false branch that is
    // filtered out of the middleware array. The component must still render.
    render(<Harness fallbackPlacementsEnabled={false} />);
    await flushFloating();

    expect(screen.getByTestId('trigger')).toBeInTheDocument();
    expect(screen.getByTestId('popup')).toBeInTheDocument();
  });

  it('does NOT set an explicit floating width when no sameWidth modifier is present', async () => {
    render(<Harness modifiers={[{ name: 'unrelated' }]} />);

    const floating = floatingHostOf(screen.getByTestId('popup'));
    // Give any async position computation a chance to run, then confirm the
    // size() apply never ran (no inline width was assigned).
    await waitFor(() => expect(floating.style.position).toBe('absolute'));
    expect(floating.style.width).toBe('');
  });

  it('mirrors the reference width onto the floating element when the sameWidth modifier is present', async () => {
    // Make the reference element report a concrete width so the size() apply
    // callback has something to copy onto the floating element.
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 220,
      bottom: 40,
      width: 220,
      height: 40,
      toJSON: () => ({})
    } as DOMRect);

    try {
      render(<Harness modifiers={[{ name: 'other' }, { name: 'sameWidth' }]} />);

      const floating = floatingHostOf(screen.getByTestId('popup'));
      // The size() middleware's apply() runs during position computation and
      // writes `elements.floating.style.width = reference.width + 'px'`.
      await waitFor(() => expect(floating.style.width).toBe('220px'));
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('re-invokes the popup/children render props when a consumer above changes them', async () => {
    // Drives the useMemo dependency paths (children / popup identity change)
    // by swapping the render props from a parent, independent of open state.
    const Wrapper = () => {
      const [variant, setVariant] = useState<'a' | 'b'>('a');
      return (
        <>
          <button type="button" data-testid="swap" onClick={() => setVariant('b')}>
            swap
          </button>
          <Popper popup={() => <div data-testid="popup">{variant === 'a' ? 'popup-a' : 'popup-b'}</div>}>
            {({ ref }) => (
              <button ref={ref} type="button" data-testid="trigger">
                {variant === 'a' ? 'trigger-a' : 'trigger-b'}
              </button>
            )}
          </Popper>
        </>
      );
    };

    render(<Wrapper />);
    await flushFloating();

    expect(screen.getByTestId('trigger')).toHaveTextContent('trigger-a');
    expect(screen.getByTestId('popup')).toHaveTextContent('popup-a');

    fireEvent.click(screen.getByTestId('swap'));

    expect(screen.getByTestId('trigger')).toHaveTextContent('trigger-b');
    expect(screen.getByTestId('popup')).toHaveTextContent('popup-b');
    await flushFloating();
  });

  it('cleans up the portal/floating container on unmount', async () => {
    const { unmount } = render(<Harness />);
    await flushFloating();
    expect(screen.getByTestId('popup')).toBeInTheDocument();

    unmount();

    expect(screen.queryByTestId('popup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trigger')).not.toBeInTheDocument();
  });
});
