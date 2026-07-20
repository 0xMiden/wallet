import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, AnalyticsEventEnum, useAnalytics } from 'lib/analytics';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { hapticLight } from 'lib/mobile/haptics';
import { PRIMARY_HEX } from 'utils/brand-colors';

import LanguageSettings from './LanguageSettings';

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

// Mirror of the component's language list — the single source of assertions for
// row count / labels / codes.
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'zh_CN', label: '简体中文' },
  { code: 'zh_TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'pl', label: 'Polski' },
  { code: 'uk', label: 'Українська' },
  { code: 'tr', label: 'Türk' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' }
];

describe('LanguageSettings', () => {
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
    mockGetCurrentLocale.mockReturnValue('en');
  });

  it('renders one button per supported language, in order, with the right labels', () => {
    render(<LanguageSettings />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(LANGUAGES.length);

    LANGUAGES.forEach(({ label }, index) => {
      expect(buttons[index]).toHaveTextContent(label);
    });
  });

  it('marks the exact-match locale as selected: bold styling + a single checkmark', () => {
    mockGetCurrentLocale.mockReturnValue('es');
    render(<LanguageSettings />);

    // Exactly one checkmark, on the selected row only.
    const icons = screen.getAllByTestId('icon');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveAttribute('data-name', 'Checkmark');
    expect(icons[0]).toHaveAttribute('data-fill', PRIMARY_HEX);
    expect(icons[0]).toHaveAttribute('data-size', 'xs');

    // The Español label carries the selected styling…
    const selectedLabel = screen.getByText('Español');
    expect(selectedLabel).toHaveClass('text-primary-500', 'font-semibold');

    // …while an unselected row carries the default styling.
    const unselectedLabel = screen.getByText('English');
    expect(unselectedLabel).toHaveClass('text-black', 'font-medium');
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

  it('selecting a language fires haptics + analytics, persists the locale, and closes', () => {
    const onClose = jest.fn();
    render(<LanguageSettings onClose={onClose} />);

    fireEvent.click(screen.getByText('Deutsch'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, {
      code: 'de'
    });
    expect(mockUpdateLocale).toHaveBeenCalledWith('de');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Ordering: analytics before the locale write.
    expect(trackEvent.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateLocale.mock.invocationCallOrder[0]);
  });

  it('does not throw when a language is selected without an onClose handler', () => {
    render(<LanguageSettings />);

    expect(() => fireEvent.click(screen.getByText('日本語'))).not.toThrow();

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockUpdateLocale).toHaveBeenCalledWith('ja');
    expect(trackEvent).toHaveBeenCalledWith(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, {
      code: 'ja'
    });
  });

  it('re-selecting the already-active language still persists and closes', () => {
    const onClose = jest.fn();
    mockGetCurrentLocale.mockReturnValue('en');
    render(<LanguageSettings onClose={onClose} />);

    fireEvent.click(screen.getByText('English'));

    expect(mockUpdateLocale).toHaveBeenCalledWith('en');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
