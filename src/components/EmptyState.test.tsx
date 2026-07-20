import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyState } from './EmptyState';

// Mock the Icon component and IconName enum used by EmptyState.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className }: any) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} className={className} />
  ),
  IconName: {
    Apps: 'Apps',
    ArrowRight: 'ArrowRight',
    Home: 'Home'
  }
}));

// Import the mocked IconName so tests can reference real enum values.
const { IconName } = jest.requireMock('app/icons/v2');

describe('EmptyState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the title and description text', () => {
    render(<EmptyState icon={IconName.Home} title="Nothing here" description="Try again later" />);

    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Nothing here');
    expect(screen.getByText('Try again later')).toBeInTheDocument();
  });

  it('renders the Icon with the provided name and fixed fill/size props', () => {
    render(<EmptyState icon={IconName.Home} title="Title" description="Desc" />);

    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-name', 'Home');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');
    expect(icon).toHaveAttribute('data-size', 'xl');
  });

  it('falls back to the default IconName.Apps when icon is undefined', () => {
    // icon is a required prop in TS, but at runtime undefined triggers the default value.
    render(<EmptyState icon={undefined as any} title="Title" description="Desc" />);

    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-name', 'Apps');
  });

  it('applies the base classes on the root container', () => {
    const { container } = render(<EmptyState icon={IconName.Home} title="Title" description="Desc" />);

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass(
      'flex',
      'flex-col',
      'items-center',
      'justify-center',
      'gap-y-1',
      'text-heading-gray'
    );
  });

  it('merges a custom className with the base classes', () => {
    const { container } = render(
      <EmptyState icon={IconName.Home} title="Title" description="Desc" className="custom-class" />
    );

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('custom-class');
    // Base classes are still present after the merge.
    expect(root).toHaveClass('flex', 'text-heading-gray');
  });

  it('renders without a custom className (className undefined branch)', () => {
    const { container } = render(<EmptyState icon={IconName.Home} title="Title" description="Desc" />);

    const root = container.firstChild as HTMLElement;
    // clsx drops the falsy value; only base classes remain.
    expect(root.className).toBe(
      'flex flex-col items-center justify-center gap-y-1 text-heading-gray'
    );
  });

  it('spreads extra props onto the root container', () => {
    const handleClick = jest.fn();
    render(
      <EmptyState
        icon={IconName.Home}
        title="Title"
        description="Desc"
        id="empty-root"
        data-testid="empty-state"
        onClick={handleClick}
      />
    );

    const root = screen.getByTestId('empty-state');
    expect(root).toHaveAttribute('id', 'empty-root');

    fireEvent.click(root);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
