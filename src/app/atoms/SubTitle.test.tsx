import React from 'react';

import { fireEvent, render } from '@testing-library/react';

import SubTitle from './SubTitle';

// SubTitle is a self-contained presentational atom: it renders an <h2> whose
// class list is computed by `clsx` from the `small`/`uppercase` flags plus any
// forwarded `className`, and it spreads the remaining HTML heading attributes
// onto the element. Its only dependency is `clsx`, which runs fine under jsdom,
// so we exercise the real component end-to-end and cover every clsx branch.

const getHeading = (container: HTMLElement) => container.firstChild as HTMLHeadingElement;

describe('SubTitle', () => {
  it('renders an <h2> with the default (uppercase, large) styling and children', () => {
    const { container } = render(<SubTitle>Hello</SubTitle>);
    const heading = getHeading(container);

    // Default branch: uppercase defaults to true, small defaults to false.
    expect(heading.tagName).toBe('H2');
    expect(heading).toHaveTextContent('Hello');
    expect(heading).toHaveClass('flex', 'items-center', 'justify-center', 'text-black');
    expect(heading).toHaveClass('text-2xl');
    expect(heading).not.toHaveClass('text-xl');
    expect(heading).toHaveClass('uppercase');
  });

  it('uses the small text size when small is true', () => {
    const { container } = render(<SubTitle small>Small</SubTitle>);
    const heading = getHeading(container);

    // small === true → text-xl, and the text-2xl branch is dropped.
    expect(heading).toHaveClass('text-xl');
    expect(heading).not.toHaveClass('text-2xl');
  });

  it('uses the large text size when small is explicitly false', () => {
    const { container } = render(<SubTitle small={false}>Large</SubTitle>);
    const heading = getHeading(container);

    expect(heading).toHaveClass('text-2xl');
    expect(heading).not.toHaveClass('text-xl');
  });

  it('omits the uppercase class when uppercase is false', () => {
    const { container } = render(<SubTitle uppercase={false}>lower</SubTitle>);
    const heading = getHeading(container);

    // uppercase === false → the `uppercase && 'uppercase'` branch is falsy.
    expect(heading).not.toHaveClass('uppercase');
    // The other base classes remain intact.
    expect(heading).toHaveClass('flex', 'items-center', 'justify-center', 'text-black', 'text-2xl');
  });

  it('keeps the uppercase class when uppercase is explicitly true', () => {
    const { container } = render(<SubTitle uppercase>UPPER</SubTitle>);
    expect(getHeading(container)).toHaveClass('uppercase');
  });

  it('merges a custom className alongside the computed classes', () => {
    const { container } = render(<SubTitle className="my-class other-class">Merged</SubTitle>);
    const heading = getHeading(container);

    expect(heading).toHaveClass('my-class', 'other-class');
    // Custom class does not clobber the computed defaults.
    expect(heading).toHaveClass('flex', 'text-black', 'text-2xl', 'uppercase');
  });

  it('renders without a custom className (undefined className branch)', () => {
    const { container } = render(<SubTitle>No custom class</SubTitle>);
    const heading = getHeading(container);

    // clsx drops the trailing undefined className argument cleanly.
    expect(heading).toHaveClass('flex', 'items-center', 'justify-center', 'text-black', 'text-2xl', 'uppercase');
  });

  it('spreads the remaining HTML heading attributes onto the <h2>', () => {
    const onClick = jest.fn();
    const { container } = render(
      <SubTitle id="section-title" data-testid="subtitle" title="tooltip" onClick={onClick}>
        Rest props
      </SubTitle>
    );
    const heading = getHeading(container);

    expect(heading).toHaveAttribute('id', 'section-title');
    expect(heading).toHaveAttribute('data-testid', 'subtitle');
    expect(heading).toHaveAttribute('title', 'tooltip');

    fireEvent.click(heading);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders arbitrary React node children', () => {
    const { container } = render(
      <SubTitle>
        <span data-testid="child">nested</span>
      </SubTitle>
    );

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument();
    expect(getHeading(container)).toHaveTextContent('nested');
  });

  it('combines all non-default flags together (small + no uppercase + className)', () => {
    const { container } = render(
      <SubTitle small uppercase={false} className="combined">
        Combined
      </SubTitle>
    );
    const heading = getHeading(container);

    expect(heading).toHaveClass('text-xl', 'combined');
    expect(heading).not.toHaveClass('text-2xl');
    expect(heading).not.toHaveClass('uppercase');
  });
});
