import React from 'react';

import { render, screen } from '@testing-library/react';

import SimplePageLayout from './SimplePageLayout';

// `app/env` supplies `useAppEnv`, from which SimplePageLayout reads `fullPage`
// and `sidePanel`. Mock it as a `jest.fn()` so each test can steer the window
// mode it exercises.
jest.mock('app/env', () => ({
  useAppEnv: jest.fn(() => ({ fullPage: false, sidePanel: false }))
}));

// `lib/platform` drives the two remaining container-style branches via
// `isMobile()` / `isDesktop()`. Mock both as `jest.fn()`s steerable per test.
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isDesktop: jest.fn(() => false)
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useAppEnv } = require('app/env') as { useAppEnv: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const platform = require('lib/platform') as { isMobile: jest.Mock; isDesktop: jest.Mock };

/** Steer the mocked `useAppEnv` return for a single test. */
function setEnv(env: { fullPage?: boolean; sidePanel?: boolean }): void {
  useAppEnv.mockReturnValue({ fullPage: false, sidePanel: false, ...env });
}

/** The ContentContainer root is the only element carrying the `rounded-lg` class. */
function getContainer(): HTMLElement {
  return document.querySelector('.rounded-lg') as HTMLElement;
}

beforeEach(() => {
  useAppEnv.mockReturnValue({ fullPage: false, sidePanel: false });
  platform.isMobile.mockReturnValue(false);
  platform.isDesktop.mockReturnValue(false);
});

afterEach(() => {
  // DocBg mutates <html> classList on mount/unmount; keep tests isolated.
  document.documentElement.className = '';
});

describe('SimplePageLayout', () => {
  it('always renders its children', () => {
    render(
      <SimplePageLayout>
        <span data-testid="content">body</span>
      </SimplePageLayout>
    );

    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('applies the base ContentContainer classes', () => {
    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container).toHaveClass('flex', 'flex-col', 'bg-app-bg', 'rounded-lg');
  });

  it('mounts DocBg, applying the bg-app-bg class to <html>', () => {
    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    expect(document.documentElement.classList.contains('bg-app-bg')).toBe(true);
  });

  it('renders the title when provided', () => {
    render(
      <SimplePageLayout title={<span data-testid="title">My Title</span>}>
        <span>body</span>
      </SimplePageLayout>
    );

    expect(screen.getByTestId('title')).toBeInTheDocument();
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('omits the title block when no title is provided', () => {
    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    expect(screen.queryByTestId('title')).not.toBeInTheDocument();
  });

  it('renders the icon (with its background-image wrapper) when provided', () => {
    render(
      <SimplePageLayout icon={<span data-testid="icon">ICON</span>}>
        <span>body</span>
      </SimplePageLayout>
    );

    const icon = screen.getByTestId('icon');
    expect(icon).toBeInTheDocument();
    // The wrapper div carries the inline background + top padding.
    // The icon lives inside a wrapper div that carries the inline padding.
    // (jsdom's CSSOM rejects the complex `background` shorthand outright, so it
    // never lands on the element and can't be asserted here — the padding
    // proves the wrapper branch rendered.)
    const wrapper = icon.parentElement as HTMLElement;
    expect(wrapper.style.paddingTop).toBe('32px');
    expect(wrapper.style.paddingLeft).toBe('32px');
    expect(wrapper.style.paddingBottom).toBe('112px');
  });

  it('omits the icon block when no icon is provided', () => {
    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
  });

  it('renders both icon and title together when both are provided', () => {
    render(
      <SimplePageLayout icon={<span data-testid="icon">I</span>} title={<span data-testid="title">T</span>}>
        <span data-testid="content">body</span>
      </SimplePageLayout>
    );

    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByTestId('title')).toBeInTheDocument();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('uses the mobile container sizing (100% height/width, no maxWidth) and no shadow', () => {
    platform.isMobile.mockReturnValue(true);
    // fullPage true here also exercises the `!isMobile()` short-circuit in the
    // shadow class (it must resolve to '' because isMobile() is true).
    setEnv({ fullPage: true });

    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container.style.height).toBe('100%');
    expect(container.style.width).toBe('100%');
    expect(container.style.overflow).toBe('hidden');
    expect(container.style.maxWidth).toBe('');
    expect(container).not.toHaveClass('shadow-2xl');
  });

  it('uses the desktop container sizing (maxWidth 600px, centered) and no shadow', () => {
    platform.isDesktop.mockReturnValue(true);
    // fullPage true exercises the `!isDesktop()` false branch of the shadow class.
    setEnv({ fullPage: true });

    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container.style.height).toBe('100%');
    expect(container.style.width).toBe('100%');
    expect(container.style.maxWidth).toBe('600px');
    expect(container.style.margin).toBe('0px auto');
    expect(container.style.overflow).toBe('hidden');
    expect(container).not.toHaveClass('shadow-2xl');
  });

  it('uses the side-panel container sizing (100% height/width) and no shadow', () => {
    setEnv({ fullPage: false, sidePanel: true });

    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container.style.height).toBe('100%');
    expect(container.style.width).toBe('100%');
    expect(container.style.overflow).toBe('hidden');
    expect(container.style.maxWidth).toBe('');
    expect(container).not.toHaveClass('shadow-2xl');
  });

  it('uses the extension fullpage sizing (600x360) and shows the shadow', () => {
    setEnv({ fullPage: true, sidePanel: false });

    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container.style.height).toBe('600px');
    expect(container.style.width).toBe('360px');
    expect(container.style.margin).toBe('auto');
    expect(container.style.overflow).toBe('hidden');
    expect(container).toHaveClass('shadow-2xl');
  });

  it('applies no explicit sizing and no shadow in extension popup mode', () => {
    setEnv({ fullPage: false, sidePanel: false });

    render(
      <SimplePageLayout>
        <span>body</span>
      </SimplePageLayout>
    );

    const container = getContainer();
    expect(container.style.height).toBe('');
    expect(container.style.width).toBe('');
    expect(container.style.maxWidth).toBe('');
    expect(container).not.toHaveClass('shadow-2xl');
  });
});
