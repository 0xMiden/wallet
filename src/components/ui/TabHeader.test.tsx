import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { navigate } from 'lib/woozie';

import TabHeaderDefault, { TabHeader, TabHeaderAction } from './TabHeader';

// TabHeader no longer navigates anywhere — the settings gear moved to the
// bottom nav. The spy stays so the regression tests below can prove the header
// never routes on its own.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockNavigate = navigate as jest.Mock;

describe('TabHeader — exports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the same component as the default and named export', () => {
    expect(TabHeaderDefault).toBe(TabHeader);
  });
});

describe('TabHeader — structure & title', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the title inside a single h1 heading with the heading typography classes', () => {
    render(<TabHeader title="Activity" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Activity' });
    expect(heading.tagName).toBe('H1');
    expect(heading.textContent).toBe('Activity');
    expect(heading.className).toContain('font-heading');
    expect(heading.className).toContain('font-extrabold');
    expect(heading.className).toContain('text-ink');
    expect(heading.className).not.toContain('text-heading-gray');
    expect(heading.className).not.toContain('dark:text-pure-white');
  });

  it('renders the outer element as a <header> with the shared layout classes and no grey rule below it', () => {
    const { container } = render(<TabHeader title="Explore" />);

    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('shrink-0');
    expect(header!.className).toContain('flex');
    expect(header!.className).toContain('items-center');
    expect(header!.className).toContain('justify-between');

    // The 4px grey rule under the title is gone — the header is the last thing rendered.
    expect(header!.nextElementSibling).toBeNull();
  });

  it('reflects whatever title string it is given', () => {
    render(<TabHeader title="A Very Custom Title" />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A Very Custom Title');
  });
});

describe('TabHeader — no built-in settings affordance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders no buttons at all when no actions are supplied', () => {
    // Settings is a bottom-nav destination now; a gear here would duplicate it
    // on exactly the screens (Activity, Explore) that show that tab.
    render(<TabHeader title="Activity" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders no settings-labelled control', () => {
    render(<TabHeader title="Activity" />);

    expect(screen.queryByRole('button', { name: /settings/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
  });

  it('omits the actions container entirely when actions is undefined', () => {
    const { container } = render(<TabHeader title="Activity" />);

    // Only the h1 remains inside the header — no empty flex row left behind.
    const header = container.querySelector('header')!;
    expect(header.children).toHaveLength(1);
    expect(header.children[0]!.tagName).toBe('H1');
  });

  it('never navigates on render', () => {
    render(<TabHeader title="Activity" />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TabHeader — actions slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a caller-supplied action', () => {
    render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action">
            Extra
          </button>
        }
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTestId('extra-action')).toBeTruthy();
  });

  it('accepts multiple action nodes', () => {
    render(
      <TabHeader
        title="Activity"
        actions={
          <>
            <button type="button">One</button>
            <button type="button">Two</button>
          </>
        }
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'One' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Two' })).toBeTruthy();
  });

  it('wraps actions in the spaced flex container', () => {
    const { container } = render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action">
            Extra
          </button>
        }
      />
    );

    const header = container.querySelector('header')!;
    const wrapper = header.children[1]!;
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('items-center');
    expect(wrapper.className).toContain('gap-2');
    expect(wrapper.contains(screen.getByTestId('extra-action'))).toBe(true);
  });

  it('clicking a caller-supplied action runs only that handler and does not navigate', () => {
    const onExtra = jest.fn();
    render(
      <TabHeader
        title="Activity"
        actions={
          <button type="button" data-testid="extra-action" onClick={onExtra}>
            Extra
          </button>
        }
      />
    );

    fireEvent.click(screen.getByTestId('extra-action'));

    expect(onExtra).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TabHeaderAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a bare 24px icon in a 44px hit area, with no background circle', () => {
    render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.className).toContain('w-11');
    expect(button.className).toContain('h-11');
    expect(button.className).not.toMatch(/\bbg-/);

    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('class')).toContain('w-6');
    expect(icon!.getAttribute('class')).toContain('h-6');
  });

  it('is ink by default and switches to the accent color when active', () => {
    const { rerender } = render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Search' }).className).toContain('text-ink');

    rerender(<TabHeaderAction label="Search" icon={IconName.Search} active onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.className).toContain('text-accent-primary');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps its accessible label and fires the click + haptic handler', () => {
    const onClick = jest.fn();
    render(<TabHeaderAction label="Search" icon={IconName.Search} onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.getAttribute('aria-label')).toBe('Search');

    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
