import React from 'react';

import i18n from 'i18next';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { closeOnboardingTab, openSidePanelToWallet } from 'lib/extension/side-panel-handoff';
import { navigate } from 'lib/woozie';

import OpenSidePanel from './OpenSidePanel';
import en from '../../../public/_locales/en/en.json';

// Regression test for the onboarding "Your <highlight>Wallet</highlight> is
// ready!" bug: this completion screen used to render the title via plain
// `t('yourWalletIsReady')`, which returns the raw string with `<highlight>`
// markup. Because `t()` does not parse i18n tags, the tags showed up as
// literal text. The fix renders the title through `<Trans>` (matching
// Confirmation.tsx), so `<highlight>` becomes a styled <span>.
//
// The test deliberately uses the REAL react-i18next + Message components and
// seeds a real i18n instance from the production en.json, so it exercises the
// actual tag parsing rather than a stand-in. It also covers the screen's
// ready/not-ready branches and the "Open wallet" handoff outcomes.

// `mock`-prefixed so jest's hoisted mock factory may reference it.
let mockReady = true;

jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Success: 'Success' }
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  )
}));

jest.mock('lib/extension/side-panel-handoff', () => ({
  closeOnboardingTab: jest.fn(),
  openSidePanelToWallet: jest.fn()
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ ready: mockReady })
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockOpenSidePanel = openSidePanelToWallet as jest.Mock;
const mockCloseTab = closeOnboardingTab as jest.Mock;
const mockNavigate = navigate as jest.Mock;

describe('OpenSidePanel', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  let testI18n: typeof i18n;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    mockReady = true;
    mockOpenSidePanel.mockReset();
    mockCloseTab.mockReset();
    mockNavigate.mockReset();

    testI18n = i18n.createInstance();
    await testI18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false, prefix: '$', suffix: '$' },
      resources: { en: { translation: en } }
    });
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  const render = async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(
        <I18nextProvider i18n={testI18n}>
          <OpenSidePanel />
        </I18nextProvider>
      );
    });
  };

  const clickOpenWallet = async () => {
    const button = testContainer!.querySelector('button');
    await act(async () => {
      button!.click();
      // Flush the handler's awaited promises (openSidePanelToWallet, then
      // closeOnboardingTab) and any resulting state updates.
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('renders the ready title without leaking <highlight> markup', async () => {
    await render();

    const heading = testContainer!.querySelector('h1');
    expect(heading?.textContent).toBe('Your Wallet is ready!');
    // The literal tag would only appear if the string were rendered via plain t().
    expect(testContainer!.textContent).not.toContain('<highlight>');
  });

  it('styles the highlighted word in a dedicated span', async () => {
    await render();

    const highlighted = testContainer!.querySelector('.text-primary-500');
    expect(highlighted?.textContent).toBe('Wallet');
  });

  it('shows a spinner while the wallet is still being created', async () => {
    mockReady = false;
    await render();

    expect(testContainer!.querySelector('[data-testid="spinner"]')).not.toBeNull();
    expect(testContainer!.querySelector('h1')).toBeNull();
    expect(testContainer!.textContent).toContain('Creating your wallet');
  });

  it('opens the side panel and closes the onboarding tab on success', async () => {
    mockOpenSidePanel.mockResolvedValue(true);
    mockCloseTab.mockResolvedValue(true);
    await render();

    await clickOpenWallet();

    expect(mockOpenSidePanel).toHaveBeenCalledTimes(1);
    expect(mockCloseTab).toHaveBeenCalledTimes(1);
    // Tab closed successfully — no fallback navigation.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('falls back to the wallet home when the side panel fails to open', async () => {
    mockOpenSidePanel.mockResolvedValue(false);
    await render();

    await clickOpenWallet();

    expect(mockOpenSidePanel).toHaveBeenCalledTimes(1);
    expect(mockCloseTab).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('falls back to the wallet home when the onboarding tab cannot be closed', async () => {
    mockOpenSidePanel.mockResolvedValue(true);
    mockCloseTab.mockResolvedValue(false);
    await render();

    await clickOpenWallet();

    expect(mockCloseTab).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
