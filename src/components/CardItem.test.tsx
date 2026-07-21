import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { CardItem, LeftIconOrComponent } from './CardItem';

// Mock the Icon component and IconName enum used directly by LeftIconOrComponent.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className }: any) => (
    <span data-testid="left-icon" data-name={name} data-fill={fill} data-size={size} className={className} />
  ),
  IconName: {
    ArrowRight: 'arrow-right',
    Home: 'home'
  }
}));

// Import the mocked IconName so tests can reference real enum values.
const { IconName } = jest.requireMock('app/icons/v2');

// Mock the IconOrComponent used for the right-side icon.
jest.mock('utils/icon-or-component', () => ({
  IconOrComponent: ({ icon, color, className }: any) => (
    <span data-testid="right-icon" data-color={color} className={className}>
      {icon}
    </span>
  )
}));

// Mock haptics.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('LeftIconOrComponent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an Icon wrapped in a styled container when given an IconName', () => {
    const { container } = render(<LeftIconOrComponent icon={IconName.ArrowRight} color="red" />);

    const icon = screen.getByTestId('left-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-name', 'arrow-right');
    expect(icon).toHaveAttribute('data-fill', 'red');
    // Default size is 'md'.
    expect(icon).toHaveAttribute('data-size', 'md');
    expect(icon).toHaveClass('w-4', 'h-4');

    // Wrapper div carries the pill styling.
    expect(container.firstChild).toHaveClass('bg-gray-50', 'p-2', 'rounded-full');
  });

  it('passes a custom size through to the Icon', () => {
    render(<LeftIconOrComponent icon={IconName.Home} color="blue" size="lg" />);

    expect(screen.getByTestId('left-icon')).toHaveAttribute('data-size', 'lg');
  });

  it('renders the raw node when given a React node that is not an IconName', () => {
    render(<LeftIconOrComponent icon={<span data-testid="custom-node">hello</span>} color="black" />);

    expect(screen.getByTestId('custom-node')).toBeInTheDocument();
    // No Icon / wrapper pill rendered for the raw-node branch.
    expect(screen.queryByTestId('left-icon')).not.toBeInTheDocument();
  });
});

describe('CardItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies base layout classes and the caller-supplied className', () => {
    const { container } = render(<CardItem className="custom-class" />);

    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('flex', 'items-center', 'bg-app-bg', 'rounded-lg', 'w-full', 'custom-class');
  });

  it('spreads arbitrary DOM props onto the root element', () => {
    render(<CardItem id="my-card" data-testid="card-root" />);

    const card = screen.getByTestId('card-root');
    expect(card).toHaveAttribute('id', 'my-card');
  });

  describe('title / subtitle', () => {
    it('renders the title with the supplied titleClassName', () => {
      render(<CardItem title="My Title" titleClassName="title-extra" />);

      const title = screen.getByText('My Title');
      expect(title).toBeInTheDocument();
      expect(title).toHaveClass('title-extra', 'font-semidbold');
    });

    it('renders the subtitle with the supplied subtitleClassName', () => {
      render(<CardItem subtitle="My Subtitle" subtitleClassName="subtitle-extra" />);

      const subtitle = screen.getByText('My Subtitle');
      expect(subtitle).toBeInTheDocument();
      expect(subtitle).toHaveClass('subtitle-extra', 'opacity-50');
    });

    it('renders neither title nor subtitle when omitted', () => {
      render(<CardItem data-testid="card-root" />);

      const card = screen.getByTestId('card-root');
      // Left column exists but holds no <p> text nodes.
      expect(card.querySelectorAll('p')).toHaveLength(0);
    });
  });

  describe('right-hand title / subtitle block', () => {
    it('renders titleRight only', () => {
      render(<CardItem titleRight={<span>Right Title</span>} titleRightClassName="tr-extra" />);

      const titleRight = screen.getByText('Right Title');
      expect(titleRight).toBeInTheDocument();
      expect(titleRight.parentElement).toHaveClass('tr-extra');
    });

    it('renders subtitleRight only', () => {
      render(<CardItem subtitleRight="Right Subtitle" subtitleRightClassName="sr-extra" />);

      const subtitleRight = screen.getByText('Right Subtitle');
      expect(subtitleRight).toBeInTheDocument();
      expect(subtitleRight).toHaveClass('sr-extra', 'opacity-50');
    });

    it('renders both titleRight and subtitleRight together', () => {
      render(<CardItem titleRight={<span>TR</span>} subtitleRight="SR" />);

      expect(screen.getByText('TR')).toBeInTheDocument();
      expect(screen.getByText('SR')).toBeInTheDocument();
    });

    it('omits the right block entirely when neither is provided', () => {
      render(<CardItem title="Only Left" data-testid="card-root" />);

      expect(screen.queryByText('SR')).not.toBeInTheDocument();
    });
  });

  describe('left icon', () => {
    it('renders the left icon via LeftIconOrComponent when iconLeft is an IconName', () => {
      render(<CardItem iconLeft={IconName.ArrowRight} />);

      const icon = screen.getByTestId('left-icon');
      expect(icon).toBeInTheDocument();
      // CardItem always passes color="black" to the left icon.
      expect(icon).toHaveAttribute('data-fill', 'black');
    });

    it('renders a left icon node when iconLeft is a React node', () => {
      render(<CardItem iconLeft={<span data-testid="left-node">L</span>} />);

      expect(screen.getByTestId('left-node')).toBeInTheDocument();
    });

    it('does not render a left icon when iconLeft is omitted', () => {
      render(<CardItem />);

      expect(screen.queryByTestId('left-icon')).not.toBeInTheDocument();
    });
  });

  describe('right icon', () => {
    it('renders the right icon via IconOrComponent when iconRight is provided', () => {
      render(<CardItem iconRight={IconName.ArrowRight} />);

      const icon = screen.getByTestId('right-icon');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-color', 'black');
      expect(icon).toHaveClass('text-black');
    });

    it('does not render a right icon when iconRight is omitted', () => {
      render(<CardItem />);

      expect(screen.queryByTestId('right-icon')).not.toBeInTheDocument();
    });
  });

  describe('click handling', () => {
    it('fires haptics and onClick when hoverable and onClick are both set', () => {
      const onClick = jest.fn();
      render(<CardItem hoverable onClick={onClick} data-testid="card-root" />);

      fireEvent.click(screen.getByTestId('card-root'));

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does nothing when not hoverable even if onClick is set', () => {
      const onClick = jest.fn();
      render(<CardItem hoverable={false} onClick={onClick} data-testid="card-root" />);

      fireEvent.click(screen.getByTestId('card-root'));

      expect(hapticLight).not.toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not fire haptics when hoverable but no onClick handler is provided', () => {
      render(<CardItem hoverable data-testid="card-root" />);

      // Should not throw and should not trigger haptics.
      fireEvent.click(screen.getByTestId('card-root'));

      expect(hapticLight).not.toHaveBeenCalled();
    });

    it('defaults hoverable to false so onClick is not invoked without it', () => {
      const onClick = jest.fn();
      render(<CardItem onClick={onClick} data-testid="card-root" />);

      fireEvent.click(screen.getByTestId('card-root'));

      expect(onClick).not.toHaveBeenCalled();
    });
  });
});
