import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { hasTelemetryChoice, isTelemetryEnabled } from 'lib/settings/helpers';
import { initCrashReporting } from 'lib/telemetry/crash';

import HelpImproveWalletScreen, { HelpImproveWalletScreen as NamedHelpImproveWalletScreen } from './HelpImproveWallet';
import en from '../../../../public/_locales/en/en.json';

// This screen is the only place a user is *asked* for consent, so its copy is
// the thing that makes the feature lawful. The real `en.json` is therefore
// seeded into a real i18n instance rather than stubbing `t()` to echo keys:
// asserting `helpImproveWalletDescription` rendered would prove nothing about
// whether the shipped sentence is honest.
//
// `lib/settings/helpers` is likewise NOT mocked — the assertions below read the
// consent back through `isTelemetryEnabled()` / `hasTelemetryChoice()`, which is
// what the rest of the wallet reads. Only the KV mirror behind it is stubbed.

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    }
  })
}));

// Constructing a real Sentry client in jsdom is neither possible nor the point;
// what matters is that accepting starts reporting and declining never does.
jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn()
}));

const mockInitCrashReporting = initCrashReporting as jest.Mock;

const ACCEPT_LABEL = 'Share anonymous data';
const DECLINE_LABEL = 'Not now';

describe('HelpImproveWalletScreen', () => {
  let testI18n: typeof i18n;

  beforeEach(async () => {
    localStorage.clear();
    for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
    mockInitCrashReporting.mockReset();

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

  const renderScreen = (props: Partial<React.ComponentProps<typeof HelpImproveWalletScreen>> = {}) =>
    render(
      <I18nextProvider i18n={testI18n}>
        <HelpImproveWalletScreen {...props} />
      </I18nextProvider>
    );

  it('renders the onboarding container with its test id', () => {
    renderScreen();
    expect(screen.getByTestId('onboarding-help-improve-wallet')).toBeInTheDocument();
  });

  it('asks rather than assumes: nothing is recorded or started by rendering the prompt', () => {
    renderScreen();

    expect(hasTelemetryChoice()).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
  });

  it('titles itself with the localized heading', () => {
    renderScreen();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Help improve Wallet');
  });

  it('names what IS collected', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    expect(body).toHaveTextContent(/which parts of Wallet you use/i);
    expect(body).toHaveTextContent(/where you get stuck/i);
    expect(body).toHaveTextContent(/broad error categories/i);
    expect(body).toHaveTextContent(/the app version/i);
    expect(body).toHaveTextContent(/your platform/i);
  });

  it('names what is NOT collected, including the things a wallet must never send', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    // The brief's own assertion: the phrase a user scanning for reassurance
    // looks for.
    expect(body).toHaveTextContent(/never your keys/i);
    for (const excluded of [
      'recovery phrase',
      'password',
      'addresses',
      'balances',
      'amounts',
      'transaction contents'
    ]) {
      expect(body).toHaveTextContent(new RegExp(excluded, 'i'));
    }
  });

  it('rules out tracking, advertising, and sale to data brokers', () => {
    renderScreen();
    const body = screen.getByTestId('help-improve-wallet-disclosure');

    expect(body).toHaveTextContent(/no tracking across other apps or sites/i);
    expect(body).toHaveTextContent(/nothing used for advertising/i);
    expect(body).toHaveTextContent(/nothing sold or shared with data brokers/i);
  });

  it('tells the user the choice is reversible', () => {
    renderScreen();
    expect(screen.getByTestId('help-improve-wallet-disclosure')).toHaveTextContent(/change this any time/i);
  });

  it('records acceptance and starts crash reporting', () => {
    const onSubmit = jest.fn();
    renderScreen({ onSubmit });

    fireEvent.click(screen.getByText(ACCEPT_LABEL));

    expect(isTelemetryEnabled()).toBe(true);
    expect(hasTelemetryChoice()).toBe(true);
    expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is skippable, and records the refusal so the prompt does not reappear', () => {
    const onSubmit = jest.fn();
    renderScreen({ onSubmit });

    fireEvent.click(screen.getByText(DECLINE_LABEL));

    expect(isTelemetryEnabled()).toBe(false);
    // A skip is still an answer — otherwise `hasTelemetryChoice()` stays false
    // and the user gets asked again on every launch.
    expect(hasTelemetryChoice()).toBe(true);
    // Declining must never start the reporter.
    expect(mockInitCrashReporting).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('mirrors the consent to the background store so the service worker agrees', async () => {
    renderScreen({ onSubmit: jest.fn() });

    fireEvent.click(screen.getByText(ACCEPT_LABEL));
    // `mirrorSetting` writes through a floating promise.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockKvStore['telemetry_consent_setting']).toBe(true);
  });

  it('renders the decline button as the secondary action', () => {
    renderScreen();

    // Accepting is the primary; a full-weight "Not now" would nudge, and the
    // opt-in has to be a real choice.
    expect(screen.getByText(DECLINE_LABEL).className).not.toEqual(screen.getByText(ACCEPT_LABEL).className);
  });

  it('does not throw when clicked without an onSubmit handler', () => {
    renderScreen();

    expect(() => fireEvent.click(screen.getByText(DECLINE_LABEL))).not.toThrow();
    expect(hasTelemetryChoice()).toBe(true);
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedHelpImproveWalletScreen).toBe(HelpImproveWalletScreen);
  });
});
