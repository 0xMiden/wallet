import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import ContentContainer from './ContentContainer';

// ContentContainer is a thin presentational layout atom: it renders a single
// <div> whose className is the merge (via clsx) of a fixed base string and any
// forwarded `className`, spreads all remaining HTML attributes onto that div,
// and destructures a `padding` prop (defaulting to `true`) that is intentionally
// consumed so it is NOT forwarded to the DOM. Its only dependency is `clsx`,
// which runs fine under jsdom, so we exercise the real component end-to-end and
// drive every branch (default vs explicit `padding`, with vs without an extra
// `className`, and rest-prop forwarding including children + event handlers).

const BASE_CLASSES = ['w-full', 'flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-hidden'];

describe('ContentContainer', () => {
  it('renders a div with the fixed base classes when given no extra className', () => {
    const { container } = render(<ContentContainer data-testid="cc" />);

    const div = container.firstChild as HTMLElement;
    expect(div).not.toBeNull();
    expect(div.tagName).toBe('DIV');
    BASE_CLASSES.forEach(cls => expect(div).toHaveClass(cls));
  });

  it('merges a forwarded className with the base classes (clsx branch)', () => {
    const { container } = render(<ContentContainer className="custom-class another" />);

    const div = container.firstChild as HTMLElement;
    BASE_CLASSES.forEach(cls => expect(div).toHaveClass(cls));
    expect(div).toHaveClass('custom-class');
    expect(div).toHaveClass('another');
  });

  it('keeps only the base classes when className is undefined (falsy clsx branch)', () => {
    const { container } = render(<ContentContainer />);

    const div = container.firstChild as HTMLElement;
    // clsx drops the undefined className, so the class list is exactly the base.
    expect(div.className).toBe(BASE_CLASSES.join(' '));
  });

  it('uses the default padding=true value without leaking a `padding` attribute to the DOM', () => {
    const { container } = render(<ContentContainer data-testid="cc" />);

    const div = container.firstChild as HTMLElement;
    // `padding` is destructured out and never spread, so it must not appear on the div.
    expect(div).not.toHaveAttribute('padding');
  });

  it('accepts an explicit padding=false without leaking it to the DOM (padding branch)', () => {
    const { container } = render(<ContentContainer padding={false} data-testid="cc" />);

    const div = container.firstChild as HTMLElement;
    expect(div).not.toHaveAttribute('padding');
    // Rendering is unchanged by the padding flag: base classes still present.
    BASE_CLASSES.forEach(cls => expect(div).toHaveClass(cls));
  });

  it('accepts an explicit padding=true without leaking it to the DOM (padding branch)', () => {
    const { container } = render(<ContentContainer padding data-testid="cc" />);

    const div = container.firstChild as HTMLElement;
    expect(div).not.toHaveAttribute('padding');
  });

  it('forwards arbitrary HTML attributes (rest props) onto the div', () => {
    render(<ContentContainer id="my-container" role="region" aria-label="content" data-testid="cc" title="hello" />);

    const div = screen.getByTestId('cc');
    expect(div).toHaveAttribute('id', 'my-container');
    expect(div).toHaveAttribute('role', 'region');
    expect(div).toHaveAttribute('aria-label', 'content');
    expect(div).toHaveAttribute('title', 'hello');
  });

  it('renders children passed through rest props', () => {
    render(
      <ContentContainer>
        <span data-testid="child">child content</span>
      </ContentContainer>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('forwards event handlers via rest props', () => {
    const onClick = jest.fn();
    render(<ContentContainer data-testid="cc" onClick={onClick} />);

    fireEvent.click(screen.getByTestId('cc'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards inline style through rest props', () => {
    const { container } = render(<ContentContainer style={{ height: '42px' }} />);

    const div = container.firstChild as HTMLElement;
    expect(div).toHaveStyle({ height: '42px' });
  });
});
