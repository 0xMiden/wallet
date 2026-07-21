import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { TabPicker, TabPickerProps, TabPickerItemProps } from './TabPicker';

// ---------------------------------------------------------------------------
// Mutable mock state so a single test can flip the platform branch
// (isExtension → skipAnimations) without re-mocking the module.
// ---------------------------------------------------------------------------
const mockPlatform = { isExtension: false };

// `lib/platform` is a bag of pure boolean detectors in production; back the one
// symbol TabPicker uses with shared state so both MotionConfig branches are
// reachable.
jest.mock('lib/platform', () => ({
  isExtension: () => mockPlatform.isExtension
}));

// uuid is only used to mint a stable layoutId; pin it so assertions on the
// animation id are deterministic.
jest.mock('uuid', () => ({
  v4: () => 'anim-uuid'
}));

// `colors.grey[400]` is the disabled icon fill. Only that leaf is needed.
jest.mock('utils/tailwind-colors', () => ({
  grey: {
    400: '#9ca3af'
  }
}));

// Icons are SVG re-exports; render a probe span that surfaces the fill / name /
// size props and forwards the icon click handler so onIconClick is testable.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className, onClick }: any) => (
    <span
      data-testid="tab-icon"
      data-name={name}
      data-fill={fill}
      data-size={size}
      className={className}
      onClick={onClick}
    />
  ),
  IconName: {
    Home: 'Home',
    Settings: 'Settings',
    Star: 'Star'
  }
}));

const { IconName } = jest.requireMock('app/icons/v2');

// framer-motion: `motion.div` is the sliding pill (surface its layoutId) and
// `MotionConfig` forwards its transition so the skipAnimations branch is
// observable. Both just render plain DOM.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ children, layoutId, ...props }: any) => (
      <div data-testid="active-pill" data-layout-id={layoutId} {...props}>
        {children}
      </div>
    )
  },
  MotionConfig: ({ children, transition }: any) => (
    <div data-testid="motion-config" data-transition={JSON.stringify(transition ?? null)}>
      {children}
    </div>
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const buildTab = (over: Partial<TabPickerItemProps> = {}): TabPickerItemProps => ({
  id: over.id ?? 'tab-1',
  title: over.title ?? 'Overview',
  ...over
});

const renderPicker = (props: Partial<TabPickerProps> = {}) => {
  const tabs = props.tabs ?? [buildTab()];
  return render(<TabPicker tabs={tabs} {...props} />);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.isExtension = false;
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('TabPicker — container', () => {
  it('renders a root div with the base pill classes', () => {
    const { container } = renderPicker();

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex', 'rounded-full', 'overflow-hidden', 'p-1', 'bg-gray-50');
  });

  it('appends a caller-supplied className to the root', () => {
    const { container } = renderPicker({ className: 'my-extra' });

    expect(container.firstChild).toHaveClass('bg-gray-50', 'my-extra');
  });

  it('spreads arbitrary HTMLDivElement props onto the root', () => {
    const { container } = renderPicker({ id: 'picker-root', 'aria-label': 'tab bar' } as Partial<TabPickerProps>);

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('id', 'picker-root');
    expect(root).toHaveAttribute('aria-label', 'tab bar');
  });
});

describe('TabPicker — MotionConfig / skipAnimations', () => {
  it('leaves the transition undefined off the extension (animations enabled)', () => {
    mockPlatform.isExtension = false;
    renderPicker();

    // undefined transition is serialised to the `null` fallback in the mock.
    expect(screen.getByTestId('motion-config')).toHaveAttribute('data-transition', 'null');
  });

  it('forces a zero-duration transition on the extension (animations skipped)', () => {
    mockPlatform.isExtension = true;
    renderPicker();

    expect(screen.getByTestId('motion-config')).toHaveAttribute('data-transition', JSON.stringify({ duration: 0 }));
  });
});

describe('TabPicker — tabs rendering', () => {
  it('renders one button per tab with type="button" and the tab title', () => {
    renderPicker({
      tabs: [buildTab({ id: 'a', title: 'First' }), buildTab({ id: 'b', title: 'Second' })]
    });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    buttons.forEach(btn => expect(btn).toHaveAttribute('type', 'button'));

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('renders an empty picker (no buttons) when given no tabs', () => {
    renderPicker({ tabs: [] });

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // The MotionConfig wrapper still mounts even with no children.
    expect(screen.getByTestId('motion-config')).toBeInTheDocument();
  });

  it('forwards extra button props (that are not destructured) onto the button', () => {
    renderPicker({ tabs: [buildTab({ title: 'Probe', tabIndex: -1 } as Partial<TabPickerItemProps>)] });

    expect(screen.getByRole('button', { name: 'Probe' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('TabPicker — active pill (TabPickerItem active branch)', () => {
  it('renders the sliding pill only for the active tab', () => {
    renderPicker({
      tabs: [buildTab({ id: 'a', title: 'On', active: true }), buildTab({ id: 'b', title: 'Off', active: false })]
    });

    const pills = screen.getAllByTestId('active-pill');
    expect(pills).toHaveLength(1);
  });

  it('does not render a pill when no tab is active', () => {
    renderPicker({ tabs: [buildTab({ title: 'Idle' })] });

    expect(screen.queryByTestId('active-pill')).not.toBeInTheDocument();
  });

  it('tags the pill with the shared uuid layoutId', () => {
    renderPicker({ tabs: [buildTab({ title: 'On', active: true })] });

    expect(screen.getByTestId('active-pill')).toHaveAttribute('data-layout-id', 'anim-uuid');
  });
});

describe('TabPicker — icon rendering (TabPickerItem icon branch)', () => {
  it('renders the icon with its name and the xs size when an icon is supplied', () => {
    renderPicker({ tabs: [buildTab({ title: 'Iconed', icon: IconName.Home })] });

    const icon = screen.getByTestId('tab-icon');
    expect(icon).toHaveAttribute('data-name', 'Home');
    expect(icon).toHaveAttribute('data-size', 'xs');
  });

  it('renders no icon when the icon prop is omitted', () => {
    renderPicker({ tabs: [buildTab({ title: 'Plain' })] });

    expect(screen.queryByTestId('tab-icon')).not.toBeInTheDocument();
  });

  it('invokes onIconClick when the icon is clicked', () => {
    const onIconClick = jest.fn();
    renderPicker({ tabs: [buildTab({ title: 'Iconed', icon: IconName.Settings, onIconClick })] });

    fireEvent.click(screen.getByTestId('tab-icon'));

    expect(onIconClick).toHaveBeenCalledTimes(1);
  });
});

describe('TabPicker — icon fill colour (iconColor useMemo)', () => {
  it('uses the grey-400 token when the tab is disabled', () => {
    renderPicker({ tabs: [buildTab({ title: 'Dead', icon: IconName.Star, disabled: true })] });

    expect(screen.getByTestId('tab-icon')).toHaveAttribute('data-fill', '#9ca3af');
  });

  it('uses black in light mode when enabled', () => {
    document.documentElement.classList.remove('dark');
    renderPicker({ tabs: [buildTab({ title: 'Light', icon: IconName.Star })] });

    expect(screen.getByTestId('tab-icon')).toHaveAttribute('data-fill', 'black');
  });

  it('uses white in dark mode when enabled', () => {
    document.documentElement.classList.add('dark');
    renderPicker({ tabs: [buildTab({ title: 'Dark', icon: IconName.Star })] });

    expect(screen.getByTestId('tab-icon')).toHaveAttribute('data-fill', 'white');
  });

  it('still resolves to the disabled grey even in dark mode (disabled wins)', () => {
    document.documentElement.classList.add('dark');
    renderPicker({ tabs: [buildTab({ title: 'DarkDead', icon: IconName.Star, disabled: true })] });

    expect(screen.getByTestId('tab-icon')).toHaveAttribute('data-fill', '#9ca3af');
  });
});

describe('TabPicker — title styling (disabled branch)', () => {
  it('renders the title with text-black when enabled', () => {
    renderPicker({ tabs: [buildTab({ title: 'Enabled' })] });

    const title = screen.getByText('Enabled');
    expect(title).toHaveClass('text-black');
    expect(title).not.toHaveClass('text-grey-400');
  });

  it('renders the title with text-grey-400 when disabled', () => {
    renderPicker({ tabs: [buildTab({ title: 'Disabled', disabled: true })] });

    const title = screen.getByText('Disabled');
    expect(title).toHaveClass('text-grey-400');
    expect(title).not.toHaveClass('text-black');
  });
});

describe('TabPicker — tab change handling (handleTabChange)', () => {
  it('calls onTabChange with the clicked tab index', () => {
    const onTabChange = jest.fn();
    renderPicker({
      tabs: [buildTab({ id: 'a', title: 'First' }), buildTab({ id: 'b', title: 'Second' })],
      onTabChange
    });

    fireEvent.click(screen.getByRole('button', { name: 'Second' }));

    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith(1);
  });

  it('reports index 0 for the first tab', () => {
    const onTabChange = jest.fn();
    renderPicker({
      tabs: [buildTab({ id: 'a', title: 'First' }), buildTab({ id: 'b', title: 'Second' })],
      onTabChange
    });

    fireEvent.click(screen.getByRole('button', { name: 'First' }));

    expect(onTabChange).toHaveBeenCalledWith(0);
  });

  it('does not throw when a tab is clicked without an onTabChange handler', () => {
    renderPicker({ tabs: [buildTab({ title: 'Solo' })] });

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Solo' }))).not.toThrow();
  });
});
