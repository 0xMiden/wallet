import React from 'react';

import { render, waitFor } from '@testing-library/react';

import DropdownWrapper from './DropdownWrapper';

// DropdownWrapper is a thin presentational atom: it wraps its content in a
// react-transition-group <CSSTransition> keyed on `opened` (with
// `unmountOnExit`), and renders a styled <div> whose classes depend on the
// `hiddenOverflow` / `scaleAnimation` flags, the `TARGET_BROWSER` env, and the
// forwarded `className` / `style` / rest props. Its only real dependencies are
// `clsx` and react-transition-group, both of which run fine under jsdom, so we
// exercise the real component end-to-end and just drive the branches.

const getInner = (container: HTMLElement) => container.querySelector('[data-testid="content"]') as HTMLElement | null;

describe('DropdownWrapper', () => {
  const ORIGINAL_TARGET_BROWSER = process.env.TARGET_BROWSER;

  afterEach(() => {
    // Restore whatever the env had before (usually undefined) so the
    // firefox-branch test can't leak into others.
    if (ORIGINAL_TARGET_BROWSER === undefined) {
      delete process.env.TARGET_BROWSER;
    } else {
      process.env.TARGET_BROWSER = ORIGINAL_TARGET_BROWSER;
    }
  });

  it('renders nothing while closed (unmountOnExit + in=false)', () => {
    const { container } = render(
      <DropdownWrapper opened={false} data-testid="content">
        hidden
      </DropdownWrapper>
    );

    // With `in={false}` and `unmountOnExit`, CSSTransition starts UNMOUNTED and
    // renders null — no wrapper div reaches the DOM.
    expect(getInner(container)).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the styled wrapper with default flags when opened', () => {
    const { container } = render(
      <DropdownWrapper opened data-testid="content">
        <span>child</span>
      </DropdownWrapper>
    );

    const inner = getInner(container);
    expect(inner).toBeInTheDocument();
    expect(inner!.tagName).toBe('DIV');

    // Default flags: hiddenOverflow=true adds `overflow-hidden`; the static base
    // classes are always present. scaleAnimation only affects the transition
    // classNames, not the base div, so it never appears here.
    expect(inner).toHaveClass('mt-2', 'bg-surface-solid', 'overflow-hidden');
    expect(inner).not.toHaveClass('grayscale-firefox-fix');

    // Children are projected through.
    expect(inner).toContainHTML('<span>child</span>');

    // Default `style = {}` → the div carries no inline styles.
    expect(inner!.getAttribute('style')).toBeFalsy();
  });

  it('omits overflow-hidden when hiddenOverflow is false', () => {
    const { container } = render(
      <DropdownWrapper opened hiddenOverflow={false} data-testid="content">
        x
      </DropdownWrapper>
    );

    const inner = getInner(container);
    expect(inner).toBeInTheDocument();
    expect(inner).toHaveClass('mt-2', 'bg-surface-solid');
    expect(inner).not.toHaveClass('overflow-hidden');
  });

  it('still renders correctly when scaleAnimation is false (transition-only flag)', () => {
    // scaleAnimation=false drops the `scale-95` / `scale-100` from the enter /
    // exit transition classNames. Those live on CSSTransition, not the base div,
    // so the DOM output is unchanged — this test drives the false branch of the
    // `scaleAnimation && ...` expressions.
    const { container } = render(
      <DropdownWrapper opened scaleAnimation={false} data-testid="content">
        y
      </DropdownWrapper>
    );

    const inner = getInner(container);
    expect(inner).toBeInTheDocument();
    expect(inner).toHaveClass('mt-2', 'bg-surface-solid', 'overflow-hidden');
  });

  it('merges a custom className and forwards style + rest props', () => {
    const onClick = jest.fn();
    const { container } = render(
      <DropdownWrapper
        opened
        className="my-dropdown"
        style={{ width: '200px', color: 'red' }}
        data-testid="content"
        role="menu"
        aria-label="options"
        onClick={onClick}
      >
        z
      </DropdownWrapper>
    );

    const inner = getInner(container)!;
    // clsx appends the custom class after the base ones.
    expect(inner).toHaveClass('mt-2', 'bg-surface-solid', 'overflow-hidden', 'my-dropdown');

    // `style` object is spread onto the div.
    expect(inner.style.width).toBe('200px');
    expect(inner.style.color).toBe('red');

    // Arbitrary rest props (a11y attrs + handlers) pass straight through.
    expect(inner).toHaveAttribute('role', 'menu');
    expect(inner).toHaveAttribute('aria-label', 'options');
    inner.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds the firefox grayscale-fix class when TARGET_BROWSER is firefox', () => {
    process.env.TARGET_BROWSER = 'firefox';

    const { container } = render(
      <DropdownWrapper opened data-testid="content">
        firefox
      </DropdownWrapper>
    );

    expect(getInner(container)).toHaveClass('grayscale-firefox-fix');
  });

  it('mounts on the enter transition when opened flips false → true', () => {
    const { container, rerender } = render(
      <DropdownWrapper opened={false} data-testid="content">
        toggler
      </DropdownWrapper>
    );

    // Starts unmounted.
    expect(getInner(container)).toBeNull();

    // Flip open → the enter transition mounts the wrapper div.
    rerender(
      <DropdownWrapper opened data-testid="content">
        toggler
      </DropdownWrapper>
    );

    expect(getInner(container)).toBeInTheDocument();
  });

  it('unmounts on the exit transition when opened flips true → false', async () => {
    const { container, rerender } = render(
      <DropdownWrapper opened data-testid="content">
        toggler
      </DropdownWrapper>
    );

    expect(getInner(container)).toBeInTheDocument();

    // Flip closed → after the (100ms) exit transition, unmountOnExit removes it.
    rerender(
      <DropdownWrapper opened={false} data-testid="content">
        toggler
      </DropdownWrapper>
    );

    await waitFor(() => expect(getInner(container)).toBeNull());
  });
});
