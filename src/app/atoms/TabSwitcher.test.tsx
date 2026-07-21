import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import TabSwitcher from './TabSwitcher';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert the rendered label directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

// Haptics wrap the native Capacitor plugin; stub it so we can assert the
// selection feedback fires on click without touching native code.
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: jest.fn()
}));

// `lib/woozie`'s real `Link` depends on the woozie location/history/analytics
// stack. Replace it with a plain anchor that forwards the props the component
// sets so we can assert `to`, `replace`, styling and the click handler.
jest.mock('lib/woozie', () => ({
  Link: ({
    to,
    replace,
    onClick,
    className,
    style,
    children
  }: {
    to: string;
    replace?: boolean;
    onClick?: () => void;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }) => (
    <a
      href={to}
      data-testid="tab-link"
      data-to={to}
      data-replace={String(replace)}
      className={className}
      style={style}
      onClick={onClick}
    >
      {children}
    </a>
  )
}));

const mockHapticSelection = hapticSelection as jest.Mock;

const TABS = [
  { slug: 'first', i18nKey: 'firstTab' },
  { slug: 'second', i18nKey: 'secondTab' }
];

const getWrapper = (container: HTMLElement) => container.firstChild as HTMLElement;

describe('TabSwitcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders one Link per tab with translated labels', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('t:firstTab');
    expect(links[1]).toHaveTextContent('t:secondTab');
  });

  it('builds each Link `to` from the urlPrefix and slug, with replace enabled', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links[0]).toHaveAttribute('data-to', '/explore/first');
    expect(links[1]).toHaveAttribute('data-to', '/explore/second');
    expect(links[0]).toHaveAttribute('data-replace', 'true');
    expect(links[1]).toHaveAttribute('data-replace', 'true');
  });

  it('applies the active class to the matching tab (active branch)', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links[0]).toHaveClass('bg-chip-bg');
    expect(links[0]).not.toHaveClass('hover:bg-gray-100');
  });

  it('applies the inactive classes to non-matching tabs (inactive branch)', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const links = screen.getAllByTestId('tab-link');
    expect(links[1]).toHaveClass('hover:bg-gray-100');
    expect(links[1]).toHaveClass('focus:bg-chip-bg');
    expect(links[1]).not.toHaveClass('bg-chip-bg');
  });

  it('fires hapticSelection when a tab is clicked', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    fireEvent.click(screen.getAllByTestId('tab-link')[1]!);

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
  });

  it('sizes each tab by the floored share of 100% and sets font styles', () => {
    render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const link = screen.getAllByTestId('tab-link')[0];
    // Two tabs → Math.floor(100 / 2) = 50 → calc(50% - 2px).
    expect(link).toHaveStyle({ width: 'calc(50% - 2px)', fontSize: '16px', lineHeight: '24px' });
  });

  it('floors the per-tab width for a non-even split (3 tabs → 33%)', () => {
    const threeTabs = [
      { slug: 'a', i18nKey: 'aKey' },
      { slug: 'b', i18nKey: 'bKey' },
      { slug: 'c', i18nKey: 'cKey' }
    ];
    render(<TabSwitcher tabs={threeTabs} activeTabSlug="b" urlPrefix="/p" />);

    const link = screen.getAllByTestId('tab-link')[0];
    // Math.floor(100 / 3) = 33 → calc(33% - 2px).
    expect(link).toHaveStyle({ width: 'calc(33% - 2px)' });
  });

  it('renders the base wrapper classes and merges an extra className', () => {
    const { container } = render(
      <TabSwitcher className="my-extra" tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />
    );

    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('w-full', 'max-w-sm', 'mx-auto', 'border', 'border-border-light', 'rounded-lg');
    expect(wrapper).toHaveClass('my-extra');
  });

  it('omits an extra className when none is provided (falsy className branch)', () => {
    const { container } = render(<TabSwitcher tabs={TABS} activeTabSlug="first" urlPrefix="/explore" />);

    const wrapper = getWrapper(container);
    expect(wrapper).toHaveClass('rounded-lg');
    // Only the base classes are present — no trailing custom class.
    expect(wrapper.className).not.toContain('undefined');
  });

  it('renders no Links when the tabs array is empty', () => {
    const { container } = render(<TabSwitcher tabs={[]} activeTabSlug="none" urlPrefix="/x" />);

    expect(screen.queryByTestId('tab-link')).toBeNull();
    // The wrapper is still rendered even with zero tabs.
    expect(getWrapper(container)).toHaveClass('flex', 'flex-wrap');
  });
});
