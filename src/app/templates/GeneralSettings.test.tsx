import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { isMobile } from 'lib/platform';
import {
  getThemeSetting,
  isAutoConsumeEnabled,
  isDelegateProofEnabled,
  isHapticFeedbackEnabled,
  setAutoConsumeSetting,
  setDelegateProofSetting,
  setHapticFeedbackSetting
} from 'lib/settings/helpers';
import { setTheme } from 'lib/settings/theme';

import GeneralSettings from './GeneralSettings';
import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/platform` gates the mobile-only haptic toggle via `isMobile()`. Mock it
// as a jest.fn() so each test steers the branch it exercises.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false)
}));

// `lib/settings/helpers` is the localStorage-backed settings layer. Mock every
// getter/setter GeneralSettings imports so we can drive initial state and
// assert the persisted writes without touching real storage.
jest.mock('lib/settings/helpers', () => ({
  getThemeSetting: jest.fn(() => 'system'),
  isAutoConsumeEnabled: jest.fn(() => true),
  isDelegateProofEnabled: jest.fn(() => true),
  isHapticFeedbackEnabled: jest.fn(() => true),
  setAutoConsumeSetting: jest.fn(),
  setDelegateProofSetting: jest.fn(),
  setHapticFeedbackSetting: jest.fn()
}));

// ListRow's routed branch imports the wallet Link, whose analytics barrel reaches
// the store; none of these rows route.
jest.mock('lib/woozie', () => ({ Link: () => null }));

// `setTheme` applies the theme to the document (media queries / class toggles);
// stub it to a spy so we only assert the intent.
jest.mock('lib/settings/theme', () => ({
  setTheme: jest.fn()
}));

// The theme picker is the real shared SegmentedControl; only its haptic is stubbed.
jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn() }));

// jsdom has no scrollIntoView; the control keeps its selection in view with it.
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

// `SettingToggle` wraps `ToggleSwitch` (analytics / haptics). Render a plain
// controlled checkbox exposing checked/onChange/name plus the title so every
// prop and branch of GeneralSettings is assertable. What a setting does is the
// page's own section footnote, rendered for real.
jest.mock('./SettingToggle', () => ({
  __esModule: true,
  default: ({
    checked,
    onChange,
    name,
    testID,
    title
  }: {
    checked: boolean;
    onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
    name: string;
    testID: string;
    title: string;
  }) => (
    <div data-testid={`${testID}-row`}>
      <span data-testid={`${testID}-title`}>{title}</span>
      <input type="checkbox" data-testid={testID} name={name} checked={checked} onChange={onChange} />
    </div>
  )
}));

const mockIsMobile = isMobile as jest.Mock;
const mockGetThemeSetting = getThemeSetting as jest.Mock;
const mockIsAutoConsumeEnabled = isAutoConsumeEnabled as jest.Mock;
const mockIsDelegateProofEnabled = isDelegateProofEnabled as jest.Mock;
const mockIsHapticFeedbackEnabled = isHapticFeedbackEnabled as jest.Mock;
const mockSetAutoConsumeSetting = setAutoConsumeSetting as jest.Mock;
const mockSetDelegateProofSetting = setDelegateProofSetting as jest.Mock;
const mockSetHapticFeedbackSetting = setHapticFeedbackSetting as jest.Mock;
const mockSetTheme = setTheme as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(false);
  mockGetThemeSetting.mockReturnValue('system');
  mockIsAutoConsumeEnabled.mockReturnValue(true);
  mockIsDelegateProofEnabled.mockReturnValue(true);
  mockIsHapticFeedbackEnabled.mockReturnValue(true);
});

describe('GeneralSettings', () => {
  it('renders the theme selector with the three theme tabs and the system tab active by default', () => {
    render(<GeneralSettings />);

    // Theme label + selector container.
    expect(screen.getByText('theme')).toBeInTheDocument();
    expect(screen.getByTestId(GeneralSettingsSelectors.ThemeSelector)).toBeInTheDocument();

    // All three ternary title branches: system / light / dark.
    expect(screen.getByText('themeSystem')).toBeInTheDocument();
    expect(screen.getByText('themeLight')).toBeInTheDocument();
    expect(screen.getByText('themeDark')).toBeInTheDocument();

    // `active: themeSetting === opt` — only the system tab is active initially.
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'false');
  });

  it('renders the delegate and auto-consume toggles (both with descriptions) and hides haptic on non-mobile', () => {
    render(<GeneralSettings />);

    const delegate = screen.getByTestId(GeneralSettingsSelectors.DelegateToggle) as HTMLInputElement;
    const consume = screen.getByTestId(GeneralSettingsSelectors.AutoConsumeToggle) as HTMLInputElement;

    expect(delegate).toBeInTheDocument();
    expect(delegate).toBeChecked();
    expect(delegate).toHaveAttribute('name', 'delegateEnabled');
    expect(screen.getByTestId(`${GeneralSettingsSelectors.DelegateToggle}-title`)).toHaveTextContent(
      'delegateProofSettings'
    );
    // The delegate toggle carries an explanatory description (local vs
    // delegated proving), not just a bare label (#478): its section's footnote,
    // right under the group holding the row.
    const delegateNote = screen.getByText('delegateProofSettingsDescription');
    expect(delegateNote.closest('section')).toContainElement(
      screen.getByTestId(`${GeneralSettingsSelectors.DelegateToggle}-row`)
    );

    expect(consume).toBeInTheDocument();
    expect(consume).toBeChecked();
    expect(consume).toHaveAttribute('name', 'autoConsumeEnabled');
    expect(screen.getByTestId(`${GeneralSettingsSelectors.AutoConsumeToggle}-title`)).toHaveTextContent(
      'autoConsumeSettings'
    );
    const consumeNote = screen.getByText('autoConsumeSettingsDescription');
    expect(consumeNote.closest('section')).toContainElement(
      screen.getByTestId(`${GeneralSettingsSelectors.AutoConsumeToggle}-row`)
    );

    // Non-mobile: haptic toggle is not rendered.
    expect(screen.queryByTestId(GeneralSettingsSelectors.HapticFeedbackToggle)).not.toBeInTheDocument();
  });

  it('renders through SubPageLayout: theme and haptics in one group, each described switch in its own', () => {
    mockIsMobile.mockReturnValue(true);
    render(<GeneralSettings />);

    const page = screen.getByTestId('general-settings');
    const body = page.querySelector('[data-slot="body"]')!;
    expect(body).toHaveClass('px-4', 'gap-5');
    expect(body.querySelectorAll(':scope > section')).toHaveLength(3);

    // The theme is a ListRow with the picker trailing, sharing a group with the haptic switch.
    const themeRow = screen.getByTestId(GeneralSettingsSelectors.ThemeSelector);
    expect(themeRow.querySelector('[data-slot="title"]')).toHaveTextContent('theme');
    expect(themeRow).toContainElement(screen.getByRole('radiogroup', { name: 'theme' }));
    expect(themeRow.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
    expect(themeRow.parentElement).toContainElement(
      screen.getByTestId(`${GeneralSettingsSelectors.HapticFeedbackToggle}-row`)
    );

    // Descriptions are the muted 14px section footnote.
    expect(screen.getByText('delegateProofSettingsDescription')).toHaveClass('text-body-sm', 'text-muted');
    // No page footer: every setting applies as it is changed.
    expect(page.querySelector('[data-slot="footer"]')).toBeNull();
  });

  it('reflects non-default (disabled) toggle states from the helpers', () => {
    mockIsDelegateProofEnabled.mockReturnValue(false);
    mockIsAutoConsumeEnabled.mockReturnValue(false);

    render(<GeneralSettings />);

    expect(screen.getByTestId(GeneralSettingsSelectors.DelegateToggle)).not.toBeChecked();
    expect(screen.getByTestId(GeneralSettingsSelectors.AutoConsumeToggle)).not.toBeChecked();
  });

  it('reflects a non-system initial theme in the active tab', () => {
    mockGetThemeSetting.mockReturnValue('dark');

    render(<GeneralSettings />);

    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting the light theme tab persists it and updates the active tab', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-light'));

    expect(mockSetTheme).toHaveBeenCalledTimes(1);
    expect(mockSetTheme).toHaveBeenCalledWith('light');
    // Local state updated -> the light tab is now active, system is not.
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'false');
  });

  it('selecting the dark theme tab persists it', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-dark'));

    expect(mockSetTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
  });

  it('re-selecting the system theme tab persists it', () => {
    // Start on a non-system theme so clicking system is a real change.
    mockGetThemeSetting.mockReturnValue('light');
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-system'));

    expect(mockSetTheme).toHaveBeenCalledWith('system');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true');
  });

  it('ignores a tap on the theme that is already selected', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-system'));

    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it('toggling the delegate switch persists the new value', () => {
    render(<GeneralSettings />);

    // Initial checked = true -> click toggles to false.
    fireEvent.click(screen.getByTestId(GeneralSettingsSelectors.DelegateToggle));

    expect(mockSetDelegateProofSetting).toHaveBeenCalledTimes(1);
    expect(mockSetDelegateProofSetting).toHaveBeenCalledWith(false);
  });

  it('guards the delegate switch against re-entrant changes', () => {
    render(<GeneralSettings />);
    const delegate = screen.getByTestId(GeneralSettingsSelectors.DelegateToggle);

    // While the first change is still in-flight, fire a second change. The
    // re-entrancy ref guard must short-circuit it so the setter runs once.
    mockSetDelegateProofSetting.mockImplementationOnce(() => {
      fireEvent.click(delegate);
    });

    fireEvent.click(delegate);

    expect(mockSetDelegateProofSetting).toHaveBeenCalledTimes(1);
  });

  it('toggling the auto-consume switch persists the new value', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId(GeneralSettingsSelectors.AutoConsumeToggle));

    expect(mockSetAutoConsumeSetting).toHaveBeenCalledTimes(1);
    expect(mockSetAutoConsumeSetting).toHaveBeenCalledWith(false);
  });

  it('guards the auto-consume switch against re-entrant changes', () => {
    render(<GeneralSettings />);
    const consume = screen.getByTestId(GeneralSettingsSelectors.AutoConsumeToggle);

    mockSetAutoConsumeSetting.mockImplementationOnce(() => {
      fireEvent.click(consume);
    });

    fireEvent.click(consume);

    expect(mockSetAutoConsumeSetting).toHaveBeenCalledTimes(1);
  });

  describe('on mobile', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
    });

    it('renders the haptic feedback toggle initialised from the helper', () => {
      render(<GeneralSettings />);

      const haptic = screen.getByTestId(GeneralSettingsSelectors.HapticFeedbackToggle) as HTMLInputElement;
      expect(haptic).toBeInTheDocument();
      expect(haptic).toBeChecked();
      expect(haptic).toHaveAttribute('name', 'hapticFeedbackEnabled');
      expect(screen.getByTestId(`${GeneralSettingsSelectors.HapticFeedbackToggle}-title`)).toHaveTextContent(
        'hapticFeedback'
      );
    });

    it('toggling haptic feedback persists the value and updates local state', () => {
      render(<GeneralSettings />);
      const haptic = screen.getByTestId(GeneralSettingsSelectors.HapticFeedbackToggle) as HTMLInputElement;

      // Initial checked = true -> toggles to false.
      fireEvent.click(haptic);

      expect(mockSetHapticFeedbackSetting).toHaveBeenCalledTimes(1);
      expect(mockSetHapticFeedbackSetting).toHaveBeenCalledWith(false);
      // Local `hapticEnabled` state now drives the controlled checkbox.
      expect(haptic).not.toBeChecked();
    });

    it('initialises the haptic toggle as off when the helper reports disabled', () => {
      mockIsHapticFeedbackEnabled.mockReturnValue(false);

      render(<GeneralSettings />);

      expect(screen.getByTestId(GeneralSettingsSelectors.HapticFeedbackToggle)).not.toBeChecked();
    });
  });
});
