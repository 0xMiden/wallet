import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { Chip } from './Chip';

// Mock haptics
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('Chip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a string label', () => {
    render(<Chip label="Hello" />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders a ReactNode label', () => {
    render(<Chip label={<span data-testid="node-label">Node</span>} />);

    expect(screen.getByTestId('node-label')).toBeInTheDocument();
    expect(screen.getByTestId('node-label')).toHaveTextContent('Node');
  });

  it('renders as a label element with base classes', () => {
    const { container } = render(<Chip label="Base" />);
    const label = container.querySelector('label');

    expect(label).toBeInTheDocument();
    expect(label).toHaveClass('flex', 'items-center', 'justify-center', 'rounded-[10px]', 'font-base', 'text-sm');
  });

  it('applies default (unselected) styles when selected is not set', () => {
    const { container } = render(<Chip label="Default" />);
    const label = container.querySelector('label')!;

    expect(label).toHaveClass('bg-white', 'border-border-light', 'text-black');
    expect(label).not.toHaveClass('bg-pure-black');
  });

  it('applies default (unselected) styles when selected is false', () => {
    const { container } = render(<Chip label="Default" selected={false} />);
    const label = container.querySelector('label')!;

    expect(label).toHaveClass('bg-white', 'border-border-light', 'text-black');
    expect(label).not.toHaveClass('bg-pure-black');
  });

  it('applies selected styles when selected is true', () => {
    const { container } = render(<Chip label="Selected" selected />);
    const label = container.querySelector('label')!;

    expect(label).toHaveClass('bg-pure-black', 'border-pure-black', 'text-pure-white');
    expect(label).not.toHaveClass('bg-white');
  });

  it('applies a custom className', () => {
    const { container } = render(<Chip label="Custom" className="my-custom-class" />);
    const label = container.querySelector('label')!;

    expect(label).toHaveClass('my-custom-class');
  });

  it('calls onClick and triggers haptic feedback when clicked', () => {
    const onClick = jest.fn();
    render(<Chip label="Clickable" onClick={onClick} />);

    fireEvent.click(screen.getByText('Clickable'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('does not trigger haptic feedback when clicked without an onClick handler', () => {
    render(<Chip label="NoHandler" />);

    expect(() => fireEvent.click(screen.getByText('NoHandler'))).not.toThrow();
    expect(hapticLight).not.toHaveBeenCalled();
  });

  it('forwards additional props to the underlying label element', () => {
    const { container } = render(<Chip label="Props" id="chip-id" htmlFor="target" data-testid="chip-el" />);
    const label = container.querySelector('label')!;

    expect(label).toHaveAttribute('id', 'chip-id');
    expect(label).toHaveAttribute('for', 'target');
    expect(screen.getByTestId('chip-el')).toBe(label);
  });
});
