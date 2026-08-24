import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, AnalyticsEventEnum, useAnalytics } from 'lib/analytics';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { hapticLight } from 'lib/mobile/haptics';

import LanguageSettings, { LANGUAGES } from './LanguageSettings';

// `lib/analytics` boots gRPC / storage plumbing via `useAnalytics`. Mock the
// three symbols LanguageSettings imports so `trackEvent` is an observable spy
// and the enum members it references resolve to stable, assertable strings.
jest.mock('lib/analytics', () => ({
  AnalyticsEventCategory: { ButtonPress: 'ButtonPress' },
  AnalyticsEventEnum: { LanguageChanged: 'LanguageChanged' },
  useAnalytics: jest.fn()
}));

// `lib/i18n/react` reads the persisted locale and re-inits i18next on write.
// Mock both so the initial `getCurrentLocale()` steers `currentCode`, and
// `updateLocale` is a spy we assert against without touching real i18n state.
jest.mock('lib/i18n/react', () => ({
  getCurrentLocale: jest.fn(() => 'en'),
  updateLocale: jest.fn()
}));

// Native haptic bridge — stub to a spy so selecting a row is testable off-device.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// This screen is routed now, so it owns its own exit: `useBackWithFallback` pops
// history when there is somewhere to pop to and routes to /settings otherwise.
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
let mockHistoryPosition = 1;

jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ historyPosition: mockHistoryPosition }),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

// `app/icons/v2` pulls in SVG asset imports. Render a marker span that echoes the
// icon name / fill / size so the "selected row shows a checkmark" branch is
// directly assertable.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size }: { name: string; fill?: string; size?: string }) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} />
  ),
  IconName: { Checkmark: 'Checkmark' }
}));

// `utils/brand-colors` derives its palette from `lib/miden-chain/constants`
// (network-dependent, SDK-adjacent). Pin `PRIMARY_HEX` to a known value so the
// checkmark `fill` prop is deterministic.
jest.mock('utils/brand-colors', () => ({
  PRIMARY_HEX: '#E77537'
}));

const mockUseAnalytics = useAnalytics as jest.Mock;
const mockGetCurrentLocale = getCurrentLocale as jest.Mock;
const mockUpdateLocale = updateLocale as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

describe('LanguageSettings', () => {
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
    mockGetCurrentLocale.mockReturnValue('en');
    mockHistoryPosition = 1;
  });

  it('renders one radio per supported language, in order, with the right labels', () => {
    render(<LanguageSettings />);

    // Radios in a radiogroup, not toggle buttons: the choice is single-select, so
    // this is what conveys "one of 13" and mutual exclusivity.
    const rows = screen.getAllByRole('radio');
    expect(rows).toHaveLength(LANGUAGES.length);

    LANGUAGES.forEach(({ label }, index) => {
      expect(rows[index]).toHaveTextContent(label);
    });
  });

  it('tags each label with its own language so a screen reader switches voice', () => {
    render(<LanguageSettings />);

    // Each label is written in the language it names, so without `lang` all
    // thirteen are read with the current UI voice — an English voice either
    // mispronounces or silently skips the CJK and Cyrillic entries.
    LANGUAGES.forEach(({ label, bcp47 }) => {
      expect(screen.getByText(label)).toHaveAttribute('lang', bcp47);
    });
  });

  it('marks the exact-match locale as selected: bold styling + a single checkmark', () => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    // Exactly one checkmark, on the selected row only.
    const icons = screen.getAllByTestId('icon');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveAttribute('data-name', 'Checkmark');
    // The literal, not the imported binding: the module is mocked just below, so
    // asserting against `PRIMARY_HEX` compared the mock to itself and held for any
    // colour the component might have used instead.
    expect(icons[0]).toHaveAttribute('data-fill', '#E77537');
    expect(icons[0]).toHaveAttribute('data-size', 'xs');

    // The Español label carries the selected styling…
    const selectedLabel = screen.getByText('Español');
    expect(selectedLabel).toHaveClass('text-primary-500', 'font-semibold');

    // …while an unselected row carries the default styling.
    const unselectedLabel = screen.getByText('English');
    expect(unselectedLabel).toHaveClass('text-heading-gray', 'font-medium');
  });

  it('falls back to the base language when the locale is region-tagged (en-US → en)', () => {
    mockGetCurrentLocale.mockReturnValue('en-US');
    render(<LanguageSettings />);

    // `en-US` has no exact row, but its base `en` does — English is selected.
    expect(screen.getByText('English')).toHaveClass('text-primary-500', 'font-semibold');
    const icons = screen.getAllByTestId('icon');
    expect(icons).toHaveLength(1);
  });

  it('supports underscore region tags too (fr_CA → fr)', () => {
    mockGetCurrentLocale.mockReturnValue('fr_CA');
    render(<LanguageSettings />);

    expect(screen.getByText('Français')).toHaveClass('text-primary-500', 'font-semibold');
    expect(screen.getAllByTestId('icon')).toHaveLength(1);
  });

  it('defaults to English when the locale matches no language at all', () => {
    mockGetCurrentLocale.mockReturnValue('xx-YY');
    render(<LanguageSettings />);

    // Neither `xx-YY` nor base `xx` exists → the 'en' fallback selects English.
    expect(screen.getByText('English')).toHaveClass('text-primary-500', 'font-semibold');
    expect(screen.getAllByTestId('icon')).toHaveLength(1);
  });

  it('selecting a language fires haptics + analytics, persists the locale, and leaves', () => {
    render(<LanguageSettings />);

    fireEvent.click(screen.getByText('Deutsch'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, {
      code: 'de'
    });
    expect(mockUpdateLocale).toHaveBeenCalledWith('de');
    // Picking a language finishes the task, so the screen has to leave — without
    // this the selection silently stranded the user on the list.
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    // Ordering: analytics before the locale write.
    expect(trackEvent.mock.invocationCallOrder[0]!).toBeLessThan(mockUpdateLocale.mock.invocationCallOrder[0]!);
  });

  it('exposes the active language to assistive technology, not just in colour', () => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('Español');
    // Exactly one row claims the state.
    expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);
  });

  it('gives the group one tab stop, on the current language', () => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    // Roving tabindex. Thirteen rows at the default tabIndex=0 made the group
    // thirteen tab stops, which is both the opposite of the radiogroup contract
    // and thirteen presses to get past the list.
    const stops = screen.getAllByRole('radio').filter(row => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent('Español');
  });

  it.each([
    ['ArrowDown', 'Français'],
    ['ArrowRight', 'Français'],
    ['ArrowUp', 'English'],
    ['ArrowLeft', 'English']
  ])('moves focus with %s, as the radio pattern promises', (key, expected) => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    const current = screen.getByRole('radio', { checked: true });
    current.focus();
    fireEvent.keyDown(current, { key });

    expect(document.activeElement).toHaveTextContent(expected);
  });

  it('wraps at the ends of the list', () => {
    mockGetCurrentLocale.mockReturnValue('en');
    render(<LanguageSettings />);

    const rows = screen.getAllByRole('radio');
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' });

    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });

  it('leaves other keys to the browser', () => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    const current = screen.getByRole('radio', { checked: true });
    current.focus();
    fireEvent.keyDown(current, { key: 'Tab' });

    // Swallowing Tab would trap focus in the list.
    expect(document.activeElement).toBe(current);
  });

  it('resolves a region-truncated locale to the region it ships', () => {
    // `getNativeLocale()` truncates to the base on mobile/desktop, so a Chinese
    // device arrives as a bare `zh`. Chinese is the only language the wallet
    // ships per-region, so nothing matched and the picker badged English.
    mockGetCurrentLocale.mockReturnValue('zh');
    render(<LanguageSettings />);

    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('简体中文');
  });

  it('resolves a hyphenated regional tag, which the extension resolver returns', () => {
    // `getCurrentLocale` normalizes i18next's tag but not its fallbacks, and the
    // extension's `getUILanguage()` hands back `zh-TW`.
    mockGetCurrentLocale.mockReturnValue('zh-TW');
    render(<LanguageSettings />);

    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('繁體中文');
  });

  it('leaves once however many times the user taps', () => {
    render(<LanguageSettings />);

    // history.go(-1) resolves on a later task, so the rows are still live and
    // mounted after the first tap; a second traversal would overshoot Settings.
    fireEvent.click(screen.getByText('Deutsch'));
    fireEvent.click(screen.getByText('Deutsch'));
    fireEvent.click(screen.getByText('Français'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockUpdateLocale).toHaveBeenCalledTimes(1);
    expect(mockUpdateLocale).toHaveBeenCalledWith('de');
  });

  it('routes to the settings root, replacing, when opened cold with no history to pop', () => {
    mockHistoryPosition = 0;
    render(<LanguageSettings />);

    fireEvent.click(screen.getByText('日本語'));

    expect(mockUpdateLocale).toHaveBeenCalledWith('ja');
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });

  it('re-selecting the already-active language still persists and leaves', () => {
    mockGetCurrentLocale.mockReturnValue('en');
    render(<LanguageSettings />);

    fireEvent.click(screen.getByText('English'));

    expect(mockUpdateLocale).toHaveBeenCalledWith('en');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
