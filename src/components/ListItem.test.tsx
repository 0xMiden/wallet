import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { ListItem } from './ListItem';

// ListItem only uses IconName as a type, but mock the barrel defensively so the
// heavy SVG re-export module is never pulled in at runtime.
jest.mock('app/icons/v2', () => ({
  IconName: {
    ArrowRight: 'arrow-right',
    Home: 'home'
  }
}));

// Import the mocked IconName so tests can reference real enum values.
const { IconName } = jest.requireMock('app/icons/v2');

// Mock the IconOrComponent used for both the left and right icons.
jest.mock('utils/icon-or-component', () => ({
  IconOrComponent: ({ icon, className }: any) => (
    <span data-testid="icon-or-component" data-icon={String(icon)} className={className}>
      {icon}
    </span>
  )
}));

// Mock haptics.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('ListItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies the base layout classes and the caller-supplied className', () => {
    const { container } = render(<ListItem className="custom-class" />);

    const item = container.firstChild as HTMLElement;
    expect(item).toHaveClass(
      'flex',
      'items-center',
      'justify-evenly',
      'p-2',
      'gap-x-4',
      'bg-white',
      'rounded-lg',
      'transition-colors',
      'duration-150',
      'ease-hover',
      'hover:bg-gray-100',
      'cursor-pointer',
      'overflow-hidden',
      'custom-class'
    );
  });

  it('spreads arbitrary DOM props onto the root element', () => {
    render(<ListItem id="my-item" data-testid="item-root" aria-label="a-label" />);

    const item = screen.getByTestId('item-root');
    expect(item).toHaveAttribute('id', 'my-item');
    expect(item).toHaveAttribute('aria-label', 'a-label');
  });

  describe('title', () => {
    it('renders the title with the supplied titleClassName', () => {
      render(<ListItem title="My Title" titleClassName="title-extra" />);

      const title = screen.getByText('My Title');
      expect(title).toBeInTheDocument();
      expect(title).toHaveClass('title-extra', 'text-sm', 'text-heading-gray', 'truncate', 'text-ellipsis');
    });

    it('does not render the title node when title is omitted', () => {
      render(<ListItem data-testid="item-root" subtitle="only-subtitle" />);

      const item = screen.getByTestId('item-root');
      // The inner flex container holds only the subtitle div, not a title div.
      expect(item.querySelector('.text-heading-gray')).toBeNull();
    });
  });

  describe('subtitle', () => {
    it('renders the subtitle', () => {
      render(<ListItem subtitle="My Subtitle" />);

      const subtitle = screen.getByText('My Subtitle');
      expect(subtitle).toBeInTheDocument();
      expect(subtitle).toHaveClass('text-sm', 'text-text-muted', 'truncate', 'text-ellipsis', 'shrink-0');
    });

    it('does not render the subtitle node when subtitle is omitted', () => {
      render(<ListItem title="only-title" />);

      expect(screen.queryByText('My Subtitle')).not.toBeInTheDocument();
    });

    it('renders both title and subtitle together', () => {
      render(<ListItem title="T" subtitle="S" />);

      expect(screen.getByText('T')).toBeInTheDocument();
      expect(screen.getByText('S')).toBeInTheDocument();
    });
  });

  describe('left icon', () => {
    it('renders the left icon via IconOrComponent when iconLeft is provided', () => {
      render(<ListItem iconLeft={IconName.ArrowRight} iconLeftClassName="left-extra" />);

      const icon = screen.getByTestId('icon-or-component');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-icon', 'arrow-right');
      expect(icon).toHaveClass('left-extra');
    });

    it('renders a left icon node when iconLeft is a React node', () => {
      render(<ListItem iconLeft={<span data-testid="left-node">L</span>} />);

      expect(screen.getByTestId('left-node')).toBeInTheDocument();
    });

    it('does not render a left icon when iconLeft is omitted', () => {
      render(<ListItem />);

      expect(screen.queryByTestId('icon-or-component')).not.toBeInTheDocument();
    });
  });

  describe('right icon', () => {
    it('renders the right icon via IconOrComponent when iconRight is provided', () => {
      render(<ListItem iconRight={IconName.Home} iconRightClassName="right-extra" />);

      const icon = screen.getByTestId('icon-or-component');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-icon', 'home');
      expect(icon).toHaveClass('right-extra');
    });

    it('renders both left and right icons together', () => {
      render(<ListItem iconLeft={IconName.ArrowRight} iconRight={IconName.Home} />);

      const icons = screen.getAllByTestId('icon-or-component');
      expect(icons).toHaveLength(2);
    });

    it('does not render a right icon when iconRight is omitted', () => {
      render(<ListItem />);

      expect(screen.queryByTestId('icon-or-component')).not.toBeInTheDocument();
    });
  });

  describe('click handling', () => {
    it('fires haptics and onClick when an onClick handler is provided', () => {
      const onClick = jest.fn();
      render(<ListItem onClick={onClick} data-testid="item-root" />);

      fireEvent.click(screen.getByTestId('item-root'));

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    });

    it('does nothing and does not fire haptics when no onClick handler is provided', () => {
      render(<ListItem data-testid="item-root" />);

      // Should not throw and should not trigger haptics.
      fireEvent.click(screen.getByTestId('item-root'));

      expect(hapticLight).not.toHaveBeenCalled();
    });
  });
});
