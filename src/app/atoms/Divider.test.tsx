import React from 'react';

import { render } from '@testing-library/react';

import Divider from './Divider';

// Divider is a self-contained presentational atom: it renders a single <div>
// with a fixed full-width, 1px, light-grey base style, then spreads an optional
// `style` prop on top. It has no external dependencies, so we exercise the real
// component end-to-end under jsdom and cover both branches of the `...style`
// spread (undefined style vs. a provided style that both adds and overrides).

const getDiv = (container: HTMLElement) => container.firstChild as HTMLDivElement;

describe('Divider', () => {
  it('renders a single <div> element', () => {
    const { container } = render(<Divider />);
    const div = getDiv(container);

    expect(div).toBeInTheDocument();
    expect(div.tagName).toBe('DIV');
    // No children — it is a plain horizontal rule.
    expect(div.childNodes).toHaveLength(0);
  });

  it('applies the default base styles when no style prop is given', () => {
    const { container } = render(<Divider />);
    const div = getDiv(container);

    // style is undefined → only the base styles apply.
    expect(div).toHaveStyle({
      width: '100%',
      height: '1px',
      backgroundColor: '#E2E8F0'
    });
  });

  it('treats an explicitly undefined style prop the same as the default', () => {
    const { container } = render(<Divider style={undefined} />);
    const div = getDiv(container);

    // Spreading `...undefined` is a no-op, so the base styles remain.
    expect(div).toHaveStyle({
      width: '100%',
      height: '1px',
      backgroundColor: '#E2E8F0'
    });
  });

  it('merges additional style properties alongside the base styles', () => {
    const { container } = render(<Divider style={{ marginTop: 8, opacity: 0.5 }} />);
    const div = getDiv(container);

    // Extra properties are added, base properties are untouched.
    expect(div).toHaveStyle({
      width: '100%',
      height: '1px',
      backgroundColor: '#E2E8F0',
      marginTop: '8px',
      opacity: '0.5'
    });
  });

  it('lets the style prop override the base styles (spread order)', () => {
    const { container } = render(
      <Divider style={{ height: '4px', width: '50%', backgroundColor: 'rgb(255, 0, 0)' }} />
    );
    const div = getDiv(container);

    // `...style` comes after the base styles, so provided values win.
    expect(div).toHaveStyle({
      height: '4px',
      width: '50%',
      backgroundColor: 'rgb(255, 0, 0)'
    });
  });

  it('ignores an empty style object and keeps the base styles', () => {
    const { container } = render(<Divider style={{}} />);
    const div = getDiv(container);

    expect(div).toHaveStyle({
      width: '100%',
      height: '1px',
      backgroundColor: '#E2E8F0'
    });
  });
});
