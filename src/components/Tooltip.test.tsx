import React from 'react';

import { render, screen } from '@testing-library/react';

import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('renders the title text inside a paragraph', () => {
    const { container } = render(<Tooltip title="Hello world" arrowPosition="bottom" />);

    const paragraph = screen.getByText('Hello world');
    expect(paragraph).toBeInTheDocument();
    expect(paragraph.tagName).toBe('P');
    expect(paragraph).toHaveClass('text-pure-white', 'text-sm');
    expect(container.querySelector('p')).toBe(paragraph);
  });

  it('applies the base container classes', () => {
    const { container } = render(<Tooltip title="Base" arrowPosition="bottom" />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.tagName).toBe('DIV');
    expect(root).toHaveClass('relative', 'bg-grey-800', 'px-3', 'py-2', 'rounded', 'max-w-[200px]');
  });

  it('applies a custom className to the container while keeping base classes', () => {
    const { container } = render(<Tooltip title="Custom" arrowPosition="bottom" className="my-custom-class" />);
    const root = container.firstElementChild as HTMLElement;

    expect(root).toHaveClass('my-custom-class');
    expect(root).toHaveClass('relative', 'bg-grey-800');
  });

  it('renders an arrow element with the absolute + sizing base classes', () => {
    const { container } = render(<Tooltip title="Arrow" arrowPosition="bottom" />);
    // The arrow is the second child div inside the container root.
    const root = container.firstElementChild as HTMLElement;
    const arrow = root.children[1] as HTMLElement;

    expect(arrow.tagName).toBe('DIV');
    expect(arrow).toHaveClass('absolute', 'h-0', 'w-0');
  });

  it('applies the top arrow classes when arrowPosition is "top"', () => {
    const { container } = render(<Tooltip title="Top" arrowPosition="top" />);
    const arrow = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;

    expect(arrow).toHaveClass('-top-[8px]', 'left-1/2', '-translate-x-1/2', 'border-b-[16px]', 'border-b-grey-800');
  });

  it('applies the bottom arrow classes when arrowPosition is "bottom"', () => {
    const { container } = render(<Tooltip title="Bottom" arrowPosition="bottom" />);
    const arrow = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;

    expect(arrow).toHaveClass('-bottom-[8px]', 'left-1/2', '-translate-x-1/2', 'border-t-[16px]', 'border-t-grey-800');
  });

  it('applies the left arrow classes when arrowPosition is "left"', () => {
    const { container } = render(<Tooltip title="Left" arrowPosition="left" />);
    const arrow = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;

    expect(arrow).toHaveClass('-left-[8px]', 'top-1/2', '-translate-y-1/2', 'border-r-[16px]', 'border-r-grey-800');
  });

  it('applies the right arrow classes when arrowPosition is "right"', () => {
    const { container } = render(<Tooltip title="Right" arrowPosition="right" />);
    const arrow = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;

    expect(arrow).toHaveClass('-right-[8px]', 'top-1/2', '-translate-y-1/2', 'border-l-[16px]', 'border-l-grey-800');
  });

  it('defaults arrowPosition to "bottom" when it is not provided', () => {
    // arrowPosition is required by the type, but the component has a runtime default of 'bottom'.
    // Force the undefined path to exercise the default parameter branch.
    const props = { title: 'Defaulted' } as unknown as React.ComponentProps<typeof Tooltip>;
    const { container } = render(<Tooltip {...props} arrowPosition={undefined as never} />);
    const arrow = (container.firstElementChild as HTMLElement).children[1] as HTMLElement;

    expect(arrow).toHaveClass('-bottom-[8px]', 'border-t-grey-800');
  });

  it('forwards additional HTML attributes to the container', () => {
    render(
      <Tooltip
        title="Props"
        arrowPosition="bottom"
        id="tooltip-id"
        data-testid="tooltip-el"
        role="tooltip"
        aria-label="a-label"
      />
    );
    const root = screen.getByTestId('tooltip-el');

    expect(root).toHaveAttribute('id', 'tooltip-id');
    expect(root).toHaveAttribute('role', 'tooltip');
    expect(root).toHaveAttribute('aria-label', 'a-label');
  });

  it('forwards event handlers to the container', () => {
    const onClick = jest.fn();
    render(<Tooltip title="Clickable" arrowPosition="bottom" data-testid="click-el" onClick={onClick} />);

    screen.getByTestId('click-el').click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
