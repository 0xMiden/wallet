import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import TabHeaderDefault, { TabHeader } from './TabHeader';

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
    expect(heading.className).toContain('font-bold');
    expect(heading.className).toContain('text-heading-gray');
    expect(heading.className).toContain('dark:text-pure-white');
  });

  it('renders the outer element as a <header> with the shared layout classes and a divider bar below', () => {
    const { container } = render(<TabHeader title="Explore" />);

    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('shrink-0');
    expect(header!.className).toContain('flex');
    expect(header!.className).toContain('items-center');
    expect(header!.className).toContain('justify-between');

    const divider = header!.nextElementSibling;
    expect(divider).not.toBeNull();
    expect(divider!.className).toContain('h-1');
    expect(divider!.className).toContain('rounded-full');
    expect(divider!.className).toContain('bg-gray-50');
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
