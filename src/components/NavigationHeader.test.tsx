import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { NavigationHeader } from './NavigationHeader';

// Mock the icons barrel so we don't pull in real SVG re-exports.
jest.mock('app/icons/v2', () => ({
  IconName: {
    ChevronLeft: 'ChevronLeft',
    Close: 'Close'
  }
}));

// Mock CircleButton so we can assert which icon/handler/props it received
// without exercising its internals (covered by its own suite).
jest.mock('./CircleButton', () => ({
  CircleButton: ({ icon, onClick, className, size }: any) => (
    <button data-testid="circle-button" data-icon={icon} data-size={size} className={className} onClick={onClick} />
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
    expect(button).toHaveClass('fill-black');
    expect(button).toHaveClass('text-black');

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

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
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
});
