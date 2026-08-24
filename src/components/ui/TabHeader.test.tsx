import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import TabHeaderDefault, { TabHeader } from './TabHeader';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className, fill }: { name: string; className?: string; fill?: string }) => (
    <span data-testid="icon" data-name={name} data-classname={className} data-fill={fill} />
  ),
  IconName: {
    Settings: 'Settings'
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockHapticLight = hapticLight as jest.Mock;
const mockNavigate = navigate as jest.Mock;

const getSettingsButton = () => screen.getByRole('button', { name: 'settings' });

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

describe('TabHeader — settings button & icon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a type="button" settings button labelled from the translation key', () => {
    render(<TabHeader title="Activity" />);

    const button = getSettingsButton();
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('settings');
    // The neutral pill styling is applied.
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('bg-gray-25');
  });

  it('renders the Settings icon with its sizing and fill props inside the button', () => {
    render(<TabHeader title="Activity" />);

    const icon = screen.getByTestId('icon');
    expect(icon.getAttribute('data-name')).toBe('Settings');
    expect(icon.getAttribute('data-classname')).toBe('w-4 h-4');
    expect(icon.getAttribute('data-fill')).toBe('currentColor');
    // The icon lives inside the settings button.
    expect(getSettingsButton().contains(icon)).toBe(true);
  });
});

describe('TabHeader — actions slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders no extra action content when actions is omitted (only the settings button)', () => {
    render(<TabHeader title="Activity" />);

    // Just the built-in settings button.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByTestId('extra-action')).toBeNull();
  });

  it('renders caller-supplied actions before the built-in settings button', () => {
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

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);

    const extra = screen.getByTestId('extra-action');
    const settings = getSettingsButton();
    // The extra action is present and ordered before the settings button in the DOM.
    expect(extra).toBeTruthy();
    expect(extra.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    // Two extra actions + the settings button.
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'One' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Two' })).toBeTruthy();
  });
});

describe('TabHeader — settings interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fires haptic feedback then navigates to /settings when the settings button is clicked', () => {
    render(<TabHeader title="Activity" />);

    fireEvent.click(getSettingsButton());

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
  });

  it('invokes haptic feedback before navigating (order matters)', () => {
    const callOrder: string[] = [];
    mockHapticLight.mockImplementation(() => callOrder.push('haptic'));
    mockNavigate.mockImplementation(() => callOrder.push('navigate'));

    render(<TabHeader title="Activity" />);
    fireEvent.click(getSettingsButton());

    expect(callOrder).toEqual(['haptic', 'navigate']);
  });

  it('does not fire haptics or navigate on render (only on click)', () => {
    render(<TabHeader title="Activity" />);

    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking a caller-supplied action does not trigger the settings navigation', () => {
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
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
