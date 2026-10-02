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

// `components/Button` pulls in framer-motion and haptics; stub it to a plain
// button that reflects the props EmptyState sets, mirroring how other ui
// components in this repo isolate it in tests.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, className, variant, size, 'data-testid': dataTestId }: any) => (
    <button
      data-testid={dataTestId ?? 'button'}
      data-classname={className}
      data-variant={variant}
      data-size={size}
      onClick={onClick}
    >
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// Import the mocked IconName so tests can reference real enum values.
const { IconName } = jest.requireMock('app/icons/v2');

describe('EmptyState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the title and description text', () => {
    render(<EmptyState icon={IconName.Home} title="Nothing here" description="Try again later" />);

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Nothing here');
    expect(screen.getByText('Try again later')).toBeInTheDocument();
  });

  it('renders without a description', () => {
    render(<EmptyState icon={IconName.Home} title="Nothing here" />);

    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Nothing here');
    expect(screen.queryByText('Try again later')).not.toBeInTheDocument();
  });

  it('renders the Icon with the provided name and fixed fill/size props', () => {
    render(<EmptyState icon={IconName.Home} title="Title" description="Desc" />);

    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-name', 'Home');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');
    expect(icon).toHaveAttribute('data-size', 'md');
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
    expect(root).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center', 'rounded-2xl', 'bg-fill');
  });

  it('takes the default size unless asked: 40px padding, a 56px circle, the 20px title', () => {
    const { container } = render(<EmptyState icon={IconName.Home} title="Title" />);

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex-col', 'py-10', 'gap-3', 'text-center');
    expect(screen.getByTestId('icon').parentElement).toHaveClass('h-14', 'w-14');
    expect(screen.getByRole('heading', { level: 3 })).toHaveClass('text-title-section');
  });

  it('shrinks to a compact centred stack: the 40px circle on top, then the 16px title and its line', () => {
    const { container } = render(
      <EmptyState icon={IconName.Home} surface="dashed" size="compact" title="Title" description="Desc" />
    );

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex-col', 'items-center', 'text-center', 'gap-2', 'py-4', 'border-dashed');
    expect(root).not.toHaveClass('py-10');
    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-size', 'sm');
    const circle = icon.parentElement as HTMLElement;
    expect(circle).toHaveClass('h-10', 'w-10');
    // The circle is the block's first child, on top of the copy.
    expect(root.firstElementChild).toBe(circle);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveClass('text-row-title');
    expect(screen.getByText('Desc')).toHaveClass('text-body-sm', 'text-muted');
  });

  it('merges a custom className with the base classes', () => {
    const { container } = render(
      <EmptyState icon={IconName.Home} title="Title" description="Desc" className="custom-class" />
    );

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('custom-class');
    expect(root).toHaveClass('flex', 'bg-fill');
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

  it('does not render a secondary action by default', () => {
    render(<EmptyState icon={IconName.Home} title="Title" />);

    expect(screen.queryByTestId('empty-state-action')).not.toBeInTheDocument();
  });

  it('renders and wires up an optional secondary action', () => {
    const onClick = jest.fn();
    render(
      <EmptyState
        icon={IconName.Home}
        title="Title"
        secondaryAction={{ label: 'Add a contact', onClick, 'data-testid': 'empty-state-action' }}
      />
    );

    const action = screen.getByTestId('empty-state-action');
    expect(action).toHaveTextContent('Add a contact');
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);

    // Also covers what a separate 'uses the canonical sm size' case asserted: the cluster merge
    // brought both through because both passed. The negative regex here is unanchored and so
    // strictly broader than the deleted one, which makes it the stronger assertion.
    // The compact size comes from Button's own `sm` variant, not from utility classes here. The
    // hand-rolled copy had already drifted from it (text-sm is 14px where the variant is 15px) and
    // left the lg default's leading and max-width un-neutralised. Assert the PROP, not Button's
    // rendered classes: Button is mocked in this suite, so asserting its internals would pass on
    // the mock rather than on the component.
    expect(action).toHaveAttribute('data-size', 'sm');
    expect(action.getAttribute('data-classname')).not.toMatch(/h-9|text-sm/);
  });
});

describe('EmptyState surfaces', () => {
  it('sits on fill by default and inside a dashed hairline on page for the dashed surface', () => {
    const { container, rerender } = render(<EmptyState icon={IconName.Apps} title="Nothing" />);
    expect(container.firstChild).toHaveClass('bg-fill');

    rerender(<EmptyState icon={IconName.Apps} title="Nothing" surface="dashed" />);
    expect(container.firstChild).toHaveClass('bg-page', 'border', 'border-dashed', 'border-hairline');
    expect(container.firstChild).not.toHaveClass('bg-fill');
    // The icon circle inverts with the surface so it never disappears into it.
    expect(container.querySelector('.rounded-full')).toHaveClass('bg-fill');
  });
});
