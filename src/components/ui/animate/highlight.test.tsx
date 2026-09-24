import React from 'react';

import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { Transition } from 'framer-motion';

import { Highlight, HighlightItem, useHighlight } from './highlight';

let mockReduce: boolean | null = false;

// motion.* render as plain elements that surface what framer would receive: the shared layoutId
// the highlight slides between items on, and the transition it slides with.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      ({ layoutId, transition, initial, animate, exit, children, ...props }: any, ref: React.Ref<HTMLElement>) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-layout-id': layoutId,
            'data-transition': JSON.stringify(transition),
            'data-exit': JSON.stringify(exit),
            'data-animate': JSON.stringify(animate),
            ...props
          },
          children
        )
    );
  return {
    ...jest.requireActual('framer-motion'),
    motion: { div: make('div'), span: make('span') },
    useReducedMotion: () => mockReduce
  };
});

const SPRING: Transition = { type: 'spring', stiffness: 680, damping: 30, mass: 0.8 };

const highlightIn = (el: HTMLElement) => el.querySelector('[data-slot="motion-highlight"]');

const Bar = ({ value, transition = SPRING }: { value: string; transition?: Transition }) => (
  <Highlight controlledItems value={value} click={false} exitDelay={0} transition={transition} className="pill">
    {['a', 'b', 'c'].map(id => (
      <HighlightItem key={id} value={id} asChild as="span" className="content">
        <button type="button" aria-label={id} className="tab">
          <svg data-testid={`icon-${id}`} />
        </button>
      </HighlightItem>
    ))}
  </Highlight>
);

beforeEach(() => {
  mockReduce = false;
});

describe('Highlight — controlled children mode (the tab bars)', () => {
  it('renders the highlight inside the active item only', () => {
    render(<Bar value="b" />);

    expect(highlightIn(screen.getByRole('button', { name: 'b' }))).not.toBeNull();
    expect(highlightIn(screen.getByRole('button', { name: 'a' }))).toBeNull();
    expect(highlightIn(screen.getByRole('button', { name: 'c' }))).toBeNull();
  });

  // A controlled change must apply in the commit that renders it. When it was mirrored into state
  // by a passive effect, consumers rendered once with the stale value and again after the effect,
  // so the highlight was still parented to the item the owner had already deselected. The counter
  // has to sit in a CONTEXT CONSUMER: `children` identity does not change, so a plain child bails
  // out of re-rendering and would read one render either way.
  it('applies a controlled value in one commit, without a second pass from an effect', () => {
    let renders = 0;
    const Probe = () => {
      useHighlight();
      renders += 1;
      return null;
    };
    const WithProbe = ({ value }: { value: string }) => (
      <Highlight controlledItems value={value} click={false} exitDelay={0} transition={SPRING} className="pill">
        <HighlightItem value="a" asChild as="span">
          <button type="button" aria-label="a" />
        </HighlightItem>
        <Probe />
      </Highlight>
    );

    const { rerender } = render(<WithProbe value="a" />);
    renders = 0;
    rerender(<WithProbe value="b" />);

    expect(renders).toBe(1);
  });

  it('moves to the new active item when the value changes, on one shared layoutId', () => {
    const { rerender } = render(<Bar value="a" />);
    const before = highlightIn(screen.getByRole('button', { name: 'a' }))!.getAttribute('data-layout-id');

    rerender(<Bar value="c" />);

    expect(highlightIn(screen.getByRole('button', { name: 'a' }))).toBeNull();
    const after = highlightIn(screen.getByRole('button', { name: 'c' }));
    expect(after).not.toBeNull();
    expect(after!.getAttribute('data-layout-id')).toBe(before);
    expect(before).toMatch(/^transition-background-/);
  });

  it('slides on the transition it is given, with the class for the pill', () => {
    render(<Bar value="a" />);

    const pill = highlightIn(screen.getByRole('button', { name: 'a' }))!;
    expect(JSON.parse(pill.getAttribute('data-transition')!)).toEqual(SPRING);
    expect(pill).toHaveClass('pill');
    expect(pill).toHaveStyle({ position: 'absolute', zIndex: 0 });
  });

  it('moves instantly under reduced motion', () => {
    mockReduce = true;
    render(<Bar value="a" />);

    const pill = highlightIn(screen.getByRole('button', { name: 'a' }))!;
    expect(JSON.parse(pill.getAttribute('data-transition')!)).toEqual({ duration: 0.001 });
    expect(JSON.parse(pill.getAttribute('data-exit')!).transition).toEqual({ duration: 0.001, delay: 0 });
  });

  it('keeps the child as the item, holding its own content in the `as` wrapper (asChild)', () => {
    render(<Bar value="a" />);

    const tab = screen.getByRole('button', { name: 'a' });
    // One button, not the child rendered inside itself.
    expect(tab.querySelectorAll('button')).toHaveLength(0);
    expect(tab).toHaveClass('relative', 'tab');
    expect(tab).toHaveAttribute('data-slot', 'motion-highlight-item-container');
    const content = tab.querySelector('[data-slot="motion-highlight-item"]')!;
    expect(content.tagName).toBe('SPAN');
    expect(content).toHaveClass('content');
    expect(content).toContainElement(screen.getByTestId('icon-a'));
  });

  it('marks items with data attributes and leaves ARIA state to the caller', () => {
    render(<Bar value="b" />);

    const active = screen.getByRole('button', { name: 'b' });
    expect(active).toHaveAttribute('data-active', 'true');
    expect(active).toHaveAttribute('data-value', 'b');
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('data-active', 'false');
    expect(active).not.toHaveAttribute('aria-selected');
  });

  it('does not move on click while `click` is off (the owner decides)', () => {
    render(<Bar value="a" />);

    fireEvent.click(screen.getByRole('button', { name: 'c' }));

    expect(highlightIn(screen.getByRole('button', { name: 'a' }))).not.toBeNull();
    expect(highlightIn(screen.getByRole('button', { name: 'c' }))).toBeNull();
  });
});

describe('Highlight — uncontrolled items', () => {
  it('moves to the clicked item, reports the change once and still runs the item’s onClick', () => {
    const onValueChange = jest.fn();
    const onClick = jest.fn();
    render(
      <Highlight defaultValue="one" onValueChange={onValueChange} exitDelay={0}>
        <div data-value="one">One</div>
        <div data-value="two" onClick={onClick}>
          Two
        </div>
      </Highlight>
    );

    const two = screen.getByText('Two').closest('[data-slot="motion-highlight-item-container"]') as HTMLElement;
    fireEvent.click(two);

    expect(highlightIn(two)).not.toBeNull();
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('two');
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.click(two);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it('follows the pointer in hover mode and clears when it leaves', () => {
    render(
      <Highlight hover>
        <div data-value="one">One</div>
      </Highlight>
    );

    const one = screen.getByText('One').closest('[data-slot="motion-highlight-item-container"]') as HTMLElement;
    expect(highlightIn(one)).toBeNull();
    fireEvent.mouseEnter(one);
    expect(highlightIn(one)).not.toBeNull();
    fireEvent.mouseLeave(one);
    expect(highlightIn(one)).toBeNull();
  });

  it('never highlights a disabled item', () => {
    render(
      <Highlight controlledItems value="one">
        <HighlightItem value="one" disabled>
          <div>One</div>
        </HighlightItem>
      </Highlight>
    );

    expect(document.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  });

  it('renders its children untouched when disabled with `enabled={false}`', () => {
    render(
      <Highlight enabled={false} value="one">
        <div data-value="one">One</div>
      </Highlight>
    );

    expect(screen.getByText('One').parentElement).toBe(document.body.firstChild);
    expect(document.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  });
});

describe('Highlight — parent mode', () => {
  it('places one highlight over the active item, measured against the container', () => {
    const rect = (top: number, left: number, width: number, height: number) =>
      ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    const spy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('data-slot') === 'motion-highlight-container'
        ? rect(10, 20, 300, 64)
        : rect(18, 60, 56, 48);
    });

    render(
      <Highlight mode="parent" controlledItems value="one" containerClassName="bar" boundsOffset={{ top: 1 }}>
        <HighlightItem value="one" asChild>
          <div>One</div>
        </HighlightItem>
      </Highlight>
    );

    const pill = document.querySelector('[data-slot="motion-highlight"]')!;
    expect(JSON.parse(pill.getAttribute('data-animate')!)).toEqual({
      top: 9,
      left: 40,
      width: 56,
      height: 48,
      opacity: 1
    });
    expect(document.querySelector('[data-slot="motion-highlight-container"]')).toHaveClass('bar');
    spy.mockRestore();
  });

  it('shows no highlight while nothing is active', () => {
    render(
      <Highlight mode="parent" controlledItems value={null}>
        <HighlightItem value="one" asChild>
          <div>One</div>
        </HighlightItem>
      </Highlight>
    );

    expect(document.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  });
});

describe('useHighlight', () => {
  it('throws outside a Highlight', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useHighlight())).toThrow(/must be used within a HighlightProvider/);
    error.mockRestore();
  });
});
