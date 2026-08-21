import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { hasTelemetryChoice, isTelemetryEnabled } from 'lib/settings/helpers';
import { navigate } from 'lib/woozie';

import HelpImproveWalletPrompt from './HelpImproveWallet';
import en from '../../../public/_locales/en/en.json';

/**
 * The consent prompt's own route.
 *
 * Deliberately an integration test over the real screen and the real settings
 * helpers: the invariants that matter here are "what did the user's answer
 * persist" and "where did it send them next", and mocking the screen would
 * assert neither. Only the router, the post-onboarding destination, the KV
 * mirror, and the Sentry client are stubbed.
 */

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async () => ({}),
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    }
  })
}));

jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// The destination the prompt hands off to. `/` in-tab, or the Chrome
// side-panel handoff screen — driven per test so both chains are covered.
let mockPostOnboardingRoute = '/';
jest.mock('lib/extension/side-panel-handoff', () => ({
  postOnboardingRoute: () => mockPostOnboardingRoute
}));

const mockNavigate = navigate as jest.Mock;

const ACCEPT_LABEL = 'Share usage data';
const DECLINE_LABEL = 'Not now';

describe('app/pages/HelpImproveWallet', () => {
  let testI18n: typeof i18n;

  beforeEach(async () => {
    jest.clearAllMocks();
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
    mockPostOnboardingRoute = '/';

    testI18n = i18n.createInstance();
    await testI18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false, prefix: '$', suffix: '$' },
      resources: { en: { translation: en } }
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  const renderPrompt = () =>
    render(
      <I18nextProvider i18n={testI18n}>
        <HelpImproveWalletPrompt />
      </I18nextProvider>
    );

  it('renders the consent prompt', () => {
    renderPrompt();
    expect(screen.getByTestId('onboarding-help-improve-wallet')).toBeInTheDocument();
    expect(screen.getByText(ACCEPT_LABEL)).toBeInTheDocument();
    expect(screen.getByText(DECLINE_LABEL)).toBeInTheDocument();
  });

  it('records acceptance and hands off to the post-onboarding route', () => {
    renderPrompt();

    fireEvent.click(screen.getByText(ACCEPT_LABEL));

    expect(isTelemetryEnabled()).toBe(true);
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('records a refusal and hands off to the same route', () => {
    renderPrompt();

    fireEvent.click(screen.getByText(DECLINE_LABEL));

    expect(isTelemetryEnabled()).toBe(false);
    // Declining is an answer, so the prompt is done with for good.
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('preserves the Chrome chain by handing off to the side-panel screen', () => {
    mockPostOnboardingRoute = '/finish-side-panel';
    renderPrompt();

    fireEvent.click(screen.getByText(ACCEPT_LABEL));

    // create → consent → /finish-side-panel, whose own "Open wallet" click
    // keeps the live user gesture `sidePanel.open()` needs.
    expect(mockNavigate).toHaveBeenCalledWith('/finish-side-panel');
  });

  it('is the chain the E2E suites drive: decline by test id, land on the handoff screen', () => {
    mockPostOnboardingRoute = '/finish-side-panel';
    renderPrompt();

    // `dismissTelemetryConsent` (playwright/e2e/helpers/telemetry-consent.ts)
    // clicks exactly this id and then expects the prompt to unmount onto the
    // handoff screen, which is what the Chrome smoke test asserts next.
    fireEvent.click(screen.getByTestId('help-improve-wallet-decline'));

    expect(isTelemetryEnabled()).toBe(false);
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/finish-side-panel');
  });

  it('leaves consent off, and records no choice, when the prompt is abandoned', () => {
    const { unmount } = renderPrompt();

    // A dismissal, a back navigation, or the app being killed all amount to the
    // screen going away unanswered. None of them may grant consent.
    unmount();

    expect(isTelemetryEnabled()).toBe(false);
    expect(hasTelemetryChoice()).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not navigate or persist anything merely by rendering', () => {
    renderPrompt();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(hasTelemetryChoice()).toBe(false);
  });
});
