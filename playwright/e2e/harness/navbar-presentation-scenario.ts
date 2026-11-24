import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect } from '@playwright/test';

import type { DappDriverTarget } from './dapp-browser-driver';
import type { StepRunner } from './dapp-browser-scenario';

const run = promisify(execFile);
const THEMES = ['light', 'dark'] as const;
const THEME_ROUTE = '/settings/general-settings';
const THEME_KEY = 'theme_setting';
const READ_THEME = `return localStorage.getItem(${JSON.stringify(THEME_KEY)}) || 'system';`;
const LAUNCHER = { route: '/browser', scroller: '[data-testid="explore-launcher"]' };
const PROFILE = { route: '/me', scroller: '[data-testid="profile-scroll"]' };
const MIN_SCROLL_TRAVEL = 48;

type Theme = (typeof THEMES)[number] | 'system';
type Device = { udid: string } | { serial: string };
type Surface = typeof LAUNCHER | typeof PROFILE;

interface Options {
  target: DappDriverTarget;
  device: Device;
  steps: StepRunner;
}

interface Frame {
  presentation: string;
  scrollTop: number;
  scrollRange: number;
  footerTop: number;
  footerHeight: number;
  pillHeight: number;
  pixelRatio: number;
  swipe: [x: number, low: number, high: number];
  tabs: { label: string; current: boolean; hittable: boolean; width: number; height: number; opacity: string }[];
}

async function readFrame(target: DappDriverTarget, surface: Surface): Promise<Frame | null> {
  return target.evalJs<Frame | null>(`
    const pane = document.querySelector('[data-tab-pane]:not([aria-hidden="true"])');
    const scroller = pane?.querySelector(${JSON.stringify(surface.scroller)});
    const footer = document.querySelector('[data-tabbar-footer="true"]');
    const wrapper = footer?.querySelector('[data-navbar-presentation]');
    const nav = wrapper?.querySelector('nav');
    if (!scroller || !footer || !wrapper || !nav || document.body.hasAttribute('data-hide-navbar')) return null;
    const rect = scroller.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    if (!rect.width || !rect.height || !footerRect.height) return null;
    const top = Math.max(0, rect.top);
    const bottom = Math.min(footerRect.top, rect.bottom);
    const tabs = Array.from(nav.querySelectorAll('button'), button => {
      const bounds = button.getBoundingClientRect();
      const label = button.querySelector(':scope > span[aria-hidden="true"]');
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        label: button.getAttribute('aria-label') || '',
        current: button.getAttribute('aria-current') === 'page',
        hittable: !button.disabled && !button.closest('[inert]') && button.contains(hit),
        width: bounds.width,
        height: bounds.height,
        opacity: label ? getComputedStyle(label).opacity : ''
      };
    });
    return {
      presentation: wrapper.getAttribute('data-navbar-presentation'),
      scrollTop: scroller.scrollTop,
      scrollRange: scroller.scrollHeight - scroller.clientHeight,
      footerTop: footerRect.top,
      footerHeight: footerRect.height,
      pillHeight: nav.getBoundingClientRect().height,
      pixelRatio: window.devicePixelRatio,
      swipe: [rect.left + rect.width / 2, top + (bottom - top) * 0.75, top + (bottom - top) * 0.25],
      tabs
    };
  `);
}

async function setTheme(target: DappDriverTarget, theme: Theme): Promise<void> {
  await target.navigateTo(THEME_ROUTE);
  const option = `[data-testid="theme-${theme}"]`;
  await target.waitFor(option);
  await target.click(option);
  await expect.poll(() => target.evalJs<string>(READ_THEME)).toBe(theme);
  await expect
    .poll(() =>
      target.evalJs<boolean>(`
        const expected = ${JSON.stringify(theme)};
        const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
        const dark = expected === 'dark' || (expected === 'system' && systemDark);
        return document.documentElement.classList.contains('dark') === dark;
      `)
    )
    .toBe(true);
}

async function swipe(device: Device, frame: Frame, direction: 'up' | 'down'): Promise<void> {
  const [x, low, high] = frame.swipe;
  expect(low - high, 'the native gesture must start and finish inside the wallet scroller').toBeGreaterThan(90);
  const scale = 'udid' in device ? 1 : frame.pixelRatio;
  const points = (direction === 'up' ? [x, low, x, high] : [x, high, x, low]).map(value =>
    String(Math.round(value * scale))
  );
  if ('udid' in device) {
    await run('idb', ['ui', 'swipe', '--udid', device.udid, ...points, '--duration', '0.45'], { timeout: 30_000 });
  } else {
    await run('adb', ['-s', device.serial, 'shell', 'input', 'swipe', ...points, '450'], { timeout: 30_000 });
  }
}

function expectUsableTabs(frame: Frame): void {
  expect(frame.tabs).toHaveLength(4);
  expect(new Set(frame.tabs.map(tab => tab.label)).size).toBe(4);
  expect(frame.tabs.filter(tab => tab.current)).toHaveLength(1);
  for (const tab of frame.tabs) {
    expect(tab.label).not.toBe('');
    expect(tab.hittable, `the ${tab.label} tab must receive a tap at its center`).toBe(true);
    expect(tab.width).toBeGreaterThanOrEqual(48);
    expect(tab.height).toBeGreaterThanOrEqual(48);
  }
}

async function settledFrame(
  target: DappDriverTarget,
  surface: Surface,
  presentation: 'expanded' | 'condensed'
): Promise<Frame> {
  const opacity = presentation === 'expanded' ? '1' : '0';
  let frame: Frame | null = null;
  await expect
    .poll(
      async () => {
        const previousTop = frame?.scrollTop;
        frame = await readFrame(target, surface);
        return (
          frame?.presentation === presentation &&
          frame.scrollTop === previousTop &&
          frame.tabs.length === 4 &&
          frame.tabs.every(tab => tab.hittable && tab.opacity === opacity)
        );
      },
      { message: `wallet navbar should settle ${presentation} at ${surface.route}` }
    )
    .toBe(true);
  if (!frame) throw new Error(`wallet navbar is missing on ${surface.route}`);
  return frame;
}

export async function runNavbarPresentationScenario({ target, device, steps }: Options): Promise<void> {
  await steps.step('wallet_navbar_tracks_native_scroll', async () => {
    const originalRoute = await target.evalJs<string>(`return window.location.hash.slice(1) || '/';`);
    const initialTheme = await target.evalJs<string>(READ_THEME);
    const originalTheme = initialTheme === 'light' || initialTheme === 'dark' ? initialTheme : 'system';

    try {
      await target.navigateTo(LAUNCHER.route);
      await target.waitFor('[data-testid="dapp-grid-card"]');
      // The bundled catalog can fit on a tall device. Use the real Profile list when it does.
      const launcher = await settledFrame(target, LAUNCHER, 'expanded');
      const surface = launcher.scrollRange >= MIN_SCROLL_TRAVEL ? LAUNCHER : PROFILE;

      for (const theme of THEMES) {
        await setTheme(target, theme);
        await target.navigateTo(surface.route);
        let expanded = await settledFrame(target, surface, 'expanded');
        expect(expanded.scrollRange, `${surface.route} needs enough real content to scroll`).toBeGreaterThanOrEqual(
          MIN_SCROLL_TRAVEL
        );
        if (expanded.scrollTop > 8) {
          await swipe(device, expanded, 'down');
          expanded = await settledFrame(target, surface, 'expanded');
          expect(expanded.scrollTop, `${surface.route} should start the gesture near the top`).toBeLessThanOrEqual(8);
        }
        expectUsableTabs(expanded);
        const name = `navbar-${surface.route.slice(1)}-${theme}`;
        await target.screenshot({ path: path.join(steps.outputDir, 'screens', `${name}-expanded.png`) });

        await swipe(device, expanded, 'up');
        const condensed = await settledFrame(target, surface, 'condensed');
        expect(condensed.scrollTop).toBeGreaterThan(expanded.scrollTop);
        expect(condensed.footerTop).toBeCloseTo(expanded.footerTop, 1);
        expect(condensed.footerHeight).toBeCloseTo(expanded.footerHeight, 1);
        expect(condensed.pillHeight).toBeLessThan(expanded.pillHeight);
        expect(condensed.tabs.map(tab => [tab.label, tab.current])).toEqual(
          expanded.tabs.map(tab => [tab.label, tab.current])
        );
        expectUsableTabs(condensed);
        await target.screenshot({ path: path.join(steps.outputDir, 'screens', `${name}-condensed.png`) });

        await swipe(device, condensed, 'down');
        expect((await settledFrame(target, surface, 'expanded')).scrollTop).toBeLessThan(condensed.scrollTop);
      }
    } finally {
      try {
        if ((await target.evalJs<string>(READ_THEME)) !== initialTheme) await setTheme(target, originalTheme);
      } finally {
        await target.navigateTo(originalRoute);
      }
    }
  });
}
