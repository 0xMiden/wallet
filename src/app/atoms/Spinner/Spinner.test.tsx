import React from 'react';

import { render } from '@testing-library/react';

import { PRIMARY_HEX } from 'utils/brand-colors';

import Spinner from './Spinner';

describe('Spinner', () => {
  it('renders without crashing', () => {
    const { container } = render(<Spinner />);

    expect(container.firstChild).toBeInTheDocument();
  });

  it('renders a spinning CircularProgress with the fixed spinner geometry', () => {
    const { container } = render(<Spinner />);
    const circle = container.firstChild as HTMLElement;

    // spin={true} -> animate-spin class from CircularProgress
    expect(circle).toHaveClass('animate-spin');
    // progress={40}
    expect(circle).toHaveAttribute('data-progress', '40');
    // circleSize={24}
    expect(circle).toHaveStyle({ width: '24px', height: '24px' });
  });

  it('defaults the circle color to PRIMARY_HEX when no color prop is provided', () => {
    const { container } = render(<Spinner />);
    // The colored border lives on the nested fill elements, using borderWeight={2}.
    // jest-dom normalizes the hex to rgb() on both sides of the comparison.
    const filled = container.querySelector<HTMLElement>('[style*="solid"]');

    expect(filled).not.toBeNull();
    expect(filled).toHaveStyle({ borderColor: PRIMARY_HEX, borderWidth: '2px', borderStyle: 'solid' });
  });

  it('forwards a custom color prop to the CircularProgress border', () => {
    const { container } = render(<Spinner color="#123456" />);
    const filled = container.querySelector<HTMLElement>('[style*="solid"]');

    expect(filled).not.toBeNull();
    expect(filled).toHaveStyle({ borderColor: '#123456', borderWidth: '2px' });
    // And the default color must NOT be applied in this branch.
    expect(filled).not.toHaveStyle({ borderColor: PRIMARY_HEX });
  });

  it('is a stable structure across renders (default vs custom color)', () => {
    const { container: a } = render(<Spinner />);
    const { container: b } = render(<Spinner color="#000000" />);

    // Same DOM shape regardless of the color branch taken.
    expect(a.querySelectorAll('div').length).toBe(b.querySelectorAll('div').length);
  });
});
