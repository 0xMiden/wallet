import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { isMobile } from 'lib/platform';
import {
  getThemeSetting,
  isAutoConsumeEnabled,
  isDelegateProofEnabled,
  isHapticFeedbackEnabled,
  isTelemetryEnabled,
  setAutoConsumeSetting,
  setDelegateProofSetting,
  setHapticFeedbackSetting,
  setTelemetrySetting
} from 'lib/settings/helpers';
import { setTheme } from 'lib/settings/theme';
import { initCrashReporting, stopCrashReporting } from 'lib/telemetry/crash';
import { dropQueue } from 'lib/telemetry/sink';

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
  isTelemetryEnabled: jest.fn(() => false),
  setAutoConsumeSetting: jest.fn(),
  setDelegateProofSetting: jest.fn(),
  setHapticFeedbackSetting: jest.fn(),
  setTelemetrySetting: jest.fn()
}));

// The telemetry queue lives in the sink and the Sentry client in `crash`.
// Withdrawing consent has to reach BOTH — stopping new events is not the same
// as stopping the sharing already under way — so both are spied on directly.
jest.mock('lib/telemetry/sink', () => ({
  dropQueue: jest.fn()
}));

jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn(),
  stopCrashReporting: jest.fn()
}));

// `setTheme` applies the theme to the document (media queries / class toggles);
// stub it to a spy so we only assert the intent.
jest.mock('lib/settings/theme', () => ({
  setTheme: jest.fn()
}));

// `TabPicker` reaches into framer-motion / uuid / SVG icons. Render each tab as
// a plain button exposing its id, active flag and index-driven onTabChange, plus
// a dedicated out-of-range trigger so the `if (!next) return` guard is testable.
jest.mock('components/TabPicker', () => ({
  TabPicker: ({
    tabs,
    onTabChange
  }: {
    tabs: { id: string; title: string; active: boolean }[];
    onTabChange: (index: number) => void;
  }) => (
    <div data-testid="tab-picker">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          data-testid={tab.id}
          data-active={String(tab.active)}
          onClick={() => onTabChange(index)}
        >
          {tab.title}
        </button>
      ))}
      <button type="button" data-testid="tab-invalid" onClick={() => onTabChange(999)}>
        invalid
      </button>
    </div>
  )
}));

// `SettingToggle` wraps `ToggleSwitch` (analytics / haptics). Render a plain
// controlled checkbox exposing checked/onChange/name plus title & optional
// description so every prop and branch of GeneralSettings is assertable.
jest.mock('./SettingToggle', () => ({
  __esModule: true,
  default: ({
    checked,
    onChange,
    name,
    testID,
    title,
    description
  }: {
    checked: boolean;
    onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
    name: string;
    testID: string;
    title: string;
    description?: string;
  }) => (
    <div>
      <span data-testid={`${testID}-title`}>{title}</span>
      <input type="checkbox" data-testid={testID} name={name} checked={checked} onChange={onChange} />
      {description ? <span data-testid={`${testID}-desc`}>{description}</span> : null}
    </div>
  )
}));

const mockIsMobile = isMobile as jest.Mock;
const mockGetThemeSetting = getThemeSetting as jest.Mock;
const mockIsAutoConsumeEnabled = isAutoConsumeEnabled as jest.Mock;
const mockIsDelegateProofEnabled = isDelegateProofEnabled as jest.Mock;
const mockIsHapticFeedbackEnabled = isHapticFeedbackEnabled as jest.Mock;
const mockIsTelemetryEnabled = isTelemetryEnabled as jest.Mock;
const mockSetAutoConsumeSetting = setAutoConsumeSetting as jest.Mock;
const mockSetDelegateProofSetting = setDelegateProofSetting as jest.Mock;
const mockSetHapticFeedbackSetting = setHapticFeedbackSetting as jest.Mock;
const mockSetTelemetrySetting = setTelemetrySetting as jest.Mock;
const mockDropQueue = dropQueue as jest.Mock;
const mockInitCrashReporting = initCrashReporting as jest.Mock;
const mockStopCrashReporting = stopCrashReporting as jest.Mock;
const mockSetTheme = setTheme as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(false);
  mockGetThemeSetting.mockReturnValue('system');
  mockIsAutoConsumeEnabled.mockReturnValue(true);
  mockIsDelegateProofEnabled.mockReturnValue(true);
  mockIsHapticFeedbackEnabled.mockReturnValue(true);
  // Consent is off until the user opts in — the baseline every telemetry
  // assertion below starts from.
  mockIsTelemetryEnabled.mockReturnValue(false);
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
    expect(screen.getByTestId('theme-system')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('data-active', 'false');
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
    // The delegate toggle now carries an explanatory description (local vs
    // delegated proving), not just a bare label (#478).
    expect(screen.getByTestId(`${GeneralSettingsSelectors.DelegateToggle}-desc`)).toHaveTextContent(
      'delegateProofSettingsDescription'
    );

    expect(consume).toBeInTheDocument();
    expect(consume).toBeChecked();
    expect(consume).toHaveAttribute('name', 'autoConsumeEnabled');
    expect(screen.getByTestId(`${GeneralSettingsSelectors.AutoConsumeToggle}-title`)).toHaveTextContent(
      'autoConsumeSettings'
    );
    // Auto-consume passes a `description` — its description branch renders.
    expect(screen.getByTestId(`${GeneralSettingsSelectors.AutoConsumeToggle}-desc`)).toHaveTextContent(
      'autoConsumeSettingsDescription'
    );

    // Non-mobile: haptic toggle is not rendered.
    expect(screen.queryByTestId(GeneralSettingsSelectors.HapticFeedbackToggle)).not.toBeInTheDocument();
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

    expect(screen.getByTestId('theme-system')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('data-active', 'true');
  });

  it('selecting the light theme tab persists it and updates the active tab', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-light'));

    expect(mockSetTheme).toHaveBeenCalledTimes(1);
    expect(mockSetTheme).toHaveBeenCalledWith('light');
    // Local state updated -> the light tab is now active, system is not.
    expect(screen.getByTestId('theme-light')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('data-active', 'false');
  });

  it('selecting the dark theme tab persists it', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-dark'));

    expect(mockSetTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('data-active', 'true');
  });

  it('re-selecting the system theme tab persists it', () => {
    // Start on a non-system theme so clicking system is a real change.
    mockGetThemeSetting.mockReturnValue('light');
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('theme-system'));

    expect(mockSetTheme).toHaveBeenCalledWith('system');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('data-active', 'true');
  });

  it('ignores an out-of-range theme index without persisting (the `if (!next) return` guard)', () => {
    render(<GeneralSettings />);

    fireEvent.click(screen.getByTestId('tab-invalid'));

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

  describe('telemetry consent toggle', () => {
    it('renders off on a fresh install, and labels itself with the localized title and disclosure', () => {
      render(<GeneralSettings />);

      const toggle = screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle);
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toBeChecked();
      expect(toggle).toHaveAttribute('name', 'telemetryEnabled');
      expect(screen.getByTestId(`${GeneralSettingsSelectors.TelemetryToggle}-title`)).toHaveTextContent(
        'helpImproveWallet'
      );
      // The disclosure is what makes the opt-in informed, so it is not optional.
      expect(screen.getByTestId(`${GeneralSettingsSelectors.TelemetryToggle}-desc`)).toHaveTextContent(
        'helpImproveWalletDescription'
      );
    });

    it('renders on when the user has already consented', () => {
      mockIsTelemetryEnabled.mockReturnValue(true);

      render(<GeneralSettings />);

      expect(screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle)).toBeChecked();
    });

    it('does not touch telemetry on mount', () => {
      render(<GeneralSettings />);

      // Merely opening Settings must neither record a choice nor start sharing.
      expect(mockSetTelemetrySetting).not.toHaveBeenCalled();
      expect(mockInitCrashReporting).not.toHaveBeenCalled();
      expect(mockDropQueue).not.toHaveBeenCalled();
      expect(mockStopCrashReporting).not.toHaveBeenCalled();
    });

    it('turning it on persists the opt-in, starts crash reporting, and checks the toggle', () => {
      render(<GeneralSettings />);
      const toggle = screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle);

      fireEvent.click(toggle);

      expect(mockSetTelemetrySetting).toHaveBeenCalledTimes(1);
      // Exact argument: an inverted consent write is the bug the old logger
      // shipped, so `true` here is asserted rather than just "was called".
      expect(mockSetTelemetrySetting).toHaveBeenCalledWith(true);
      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
      // Opting IN must not also tear down what it just started.
      expect(mockDropQueue).not.toHaveBeenCalled();
      expect(mockStopCrashReporting).not.toHaveBeenCalled();
      expect(toggle).toBeChecked();
    });

    it('turning it off persists the opt-out, drops the queue, stops crash reporting, and unchecks the toggle', () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      render(<GeneralSettings />);
      const toggle = screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle);

      fireEvent.click(toggle);

      expect(mockSetTelemetrySetting).toHaveBeenCalledTimes(1);
      expect(mockSetTelemetrySetting).toHaveBeenCalledWith(false);
      // Withdrawing consent stops sharing that is already under way, not just
      // the next event: the pending queue goes, and so does the crash client.
      expect(mockDropQueue).toHaveBeenCalledTimes(1);
      expect(mockStopCrashReporting).toHaveBeenCalledTimes(1);
      expect(mockInitCrashReporting).not.toHaveBeenCalled();
      expect(toggle).not.toBeChecked();
    });

    it('survives a full opt-in / opt-out round trip', () => {
      render(<GeneralSettings />);
      const toggle = screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle);

      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(mockSetTelemetrySetting.mock.calls).toEqual([[true], [false]]);
      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
      expect(mockDropQueue).toHaveBeenCalledTimes(1);
      expect(mockStopCrashReporting).toHaveBeenCalledTimes(1);
      expect(toggle).not.toBeChecked();
    });
  });
});
