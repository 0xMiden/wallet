import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { NavigationHeader } from './NavigationHeader';

// Mock the icons barrel so we don't pull in real SVG re-exports.
jest.mock('app/icons/v2', () => ({
  IconName: {
    ArrowLeft: 'ArrowLeft',
    ChevronLeft: 'ChevronLeft',
    Close: 'Close'
  }
}));

// Mock CircleButton so we can assert which icon/handler/props it received
// without exercising its internals (covered by its own suite).
// Rest props are forwarded so the aria-labels are observable: without that, the
// icon-only back and close buttons could lose their accessible names and every
// test here would still pass.
jest.mock('./CircleButton', () => ({
  CircleButton: ({ icon, onClick, className, size, color, ...rest }: any) => (
    <button
      data-testid="circle-button"
      data-icon={icon}
      data-size={size}
      data-color={color}
      className={className}
      onClick={onClick}
      {...rest}
    />
  )
}));

const { IconName } = jest.requireMock('app/icons/v2');

const getInnerDiv = () => screen.getByRole('heading').parentElement as HTMLElement;
const getOuterDiv = () => getInnerDiv().parentElement as HTMLElement;

describe('NavigationHeader', () => {
  it('renders the title inside a heading', () => {
    render(<NavigationHeader title="My Wallet" />);

    const heading = screen.getByRole('heading', { name: 'My Wallet' });
    expect(heading).toBeInTheDocument();
    expect(heading.tagName).toBe('H1');
  });

  it('renders no CircleButton when neither onBack nor onClose is provided', () => {
    render(<NavigationHeader title="Plain" />);

    expect(screen.queryByTestId('circle-button')).not.toBeInTheDocument();
  });

  it('does not add the pr-10 spacer class to the heading when onBack is absent', () => {
    render(<NavigationHeader title="Plain" />);

    expect(screen.getByRole('heading')).not.toHaveClass('pr-10');
  });

  it('renders a back CircleButton when onBack is provided and wires its onClick', () => {
    const onBack = jest.fn();
    render(<NavigationHeader title="With Back" onBack={onBack} />);

    const button = screen.getByTestId('circle-button');
    expect(button).toHaveAttribute('data-icon', IconName.ChevronLeft);
    expect(button).toHaveAttribute('data-size', 'sm');
    expect(button).toHaveClass('shrink-0');
    // CircleButton's default fill is a literal `black`, invisible on the dark app
    // background — the chevron has to inherit the header's flipping ink too, not
    // just the prominent variant's arrow.
    expect(button).toHaveAttribute('data-color', 'currentColor');

    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('adds the pr-10 spacer class to the heading when onBack is provided', () => {
    render(<NavigationHeader title="With Back" onBack={jest.fn()} />);

    expect(screen.getByRole('heading')).toHaveClass('pr-10');
  });

  it('renders a close CircleButton when onClose is provided and wires its onClick', () => {
    const onClose = jest.fn();
    render(<NavigationHeader title="With Close" onClose={onClose} />);

    const button = screen.getByTestId('circle-button');
    expect(button).toHaveAttribute('data-icon', IconName.Close);
    // text-black auto-flips with the theme, and the glyph must follow it:
    // CircleButton's default fill is a literal `black`, invisible on the dark
    // app background, so the close affordance disappeared in dark mode.
    expect(button).toHaveClass('text-black');
    expect(button).toHaveAttribute('data-color', 'currentColor');

    fireEvent.click(button);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders both back and close buttons when both handlers are provided', () => {
    const onBack = jest.fn();
    const onClose = jest.fn();
    render(<NavigationHeader title="Both" onBack={onBack} onClose={onClose} />);

    const buttons = screen.getAllByTestId('circle-button');
    expect(buttons).toHaveLength(2);

    const icons = buttons.map(b => b.getAttribute('data-icon'));
    expect(icons).toContain(IconName.ChevronLeft);
    expect(icons).toContain(IconName.Close);

    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render the border classes by default (showBorder omitted)', () => {
    render(<NavigationHeader title="No Border" />);

    expect(getOuterDiv()).not.toHaveClass('border-b-[0.5px]');
  });

  it('renders the border classes when showBorder is true', () => {
    render(<NavigationHeader title="Bordered" showBorder />);

    const outer = getOuterDiv();
    expect(outer).toHaveClass('border-b-[0.5px]');
    expect(outer).toHaveClass('border-border-card');
  });

  it('applies a custom className to the outer container', () => {
    render(<NavigationHeader title="Custom" className="my-custom-class" />);

    expect(getOuterDiv()).toHaveClass('my-custom-class');
  });

  it('applies a custom innerDivClassName to the inner container', () => {
    render(<NavigationHeader title="Inner" innerDivClassName="inner-custom" />);

    expect(getInnerDiv()).toHaveClass('inner-custom');
  });

  it('does not forward extra HTML attributes to the DOM (only title is consumed from ...props)', () => {
    render(<NavigationHeader title="Spread" id="nav-header" data-foo="bar" />);

    // The component destructures `...props` but only reads `props.title`; the
    // remaining rest props are intentionally not spread onto any element.
    const outer = getOuterDiv();
    expect(outer).not.toHaveAttribute('id');
    expect(outer).not.toHaveAttribute('data-foo');
    expect(screen.getByRole('heading', { name: 'Spread' })).toBeInTheDocument();
  });

  it('always applies the base layout classes on the outer container', () => {
    render(<NavigationHeader title="Base" />);

    const outer = getOuterDiv();
    expect(outer).toHaveClass('flex', 'flex-row', 'px-4', 'items-center', 'w-full', 'bg-app-bg', 'py-4');
  });

  it('names both icon-only controls for assistive technology', () => {
    render(<NavigationHeader title="Both" onBack={jest.fn()} onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });

  describe('focusTitleOnMount', () => {
    it('takes focus to the title so a routed screen is announced', () => {
      render(<NavigationHeader title="Language" onBack={jest.fn()} focusTitleOnMount />);

      const heading = screen.getByRole('heading', { name: 'Language' });
      expect(heading).toHaveFocus();
      // Programmatically focusable only — it must not join the tab order.
      expect(heading).toHaveAttribute('tabindex', '-1');
    });

    it('leaves focus alone by default', () => {
      render(<NavigationHeader title="Language" onBack={jest.fn()} />);

      expect(screen.getByRole('heading')).not.toHaveFocus();
      expect(screen.getByRole('heading')).not.toHaveAttribute('tabindex');
    });
  });

  // Every screen this commit converted from a drawer to a route renders the
  // prominent variant, so it is now the wallet's standard page header.
  describe('prominent variant', () => {
    it('swaps the chevron for the arrow and gives it a themed circle', () => {
      render(<NavigationHeader title="Settings" onBack={jest.fn()} variant="prominent" />);

      const button = screen.getByTestId('circle-button');
      expect(button).toHaveAttribute('data-icon', IconName.ArrowLeft);
      // The circle is a fixed light chip, so the arrow can't inherit the page's
      // flipping ink — it takes text-black through currentColor instead.
      expect(button).toHaveClass('w-10', 'h-10', 'bg-gray-25', 'text-black');
      expect(button).toHaveAttribute('data-color', 'currentColor');
    });

    it('renders the decorative divider bar below the header', () => {
      render(<NavigationHeader title="Settings" variant="prominent" />);

      const divider = getOuterDiv().nextElementSibling;
      expect(divider).toHaveClass('h-1', 'rounded-full', 'bg-gray-50');
      // Purely ornamental, so it must not reach the accessibility tree.
      expect(divider).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders no divider on the default variant', () => {
      render(<NavigationHeader title="Plain" />);

      expect(getOuterDiv().nextElementSibling).toBeNull();
    });

    it('uses the heading-gray display size for the title', () => {
      render(<NavigationHeader title="Settings" variant="prominent" />);

      expect(screen.getByRole('heading')).toHaveClass('text-[28px]', 'font-bold', 'text-heading-gray');
    });

    it('drops the centering spacer when the title sits next to the back button', () => {
      render(<NavigationHeader title="Settings" onBack={jest.fn()} variant="prominent" titleAlign="left" />);

      const heading = screen.getByRole('heading');
      expect(heading).toHaveClass('text-left');
      // pr-10 only balances a centered title against the back button; with a
      // left-aligned title it would push the text off-centre for no reason.
      expect(heading).not.toHaveClass('pr-10');
    });

    it('keeps a centered title balanced against the back button', () => {
      render(<NavigationHeader title="Settings" onBack={jest.fn()} variant="prominent" />);

      const heading = screen.getByRole('heading');
      expect(heading).toHaveClass('text-center', 'pr-10');
    });

    it('gives the close button the same chip treatment (swap history details)', () => {
      render(<NavigationHeader title="Swap" onClose={jest.fn()} variant="prominent" />);

      const button = screen.getByTestId('circle-button');
      expect(button).toHaveAttribute('data-icon', IconName.Close);
      expect(button).toHaveClass('w-10', 'h-10', 'bg-gray-25', 'text-black');
      expect(button).toHaveAttribute('data-size', 'sm');
    });
  });
});
