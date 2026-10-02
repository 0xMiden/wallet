import {
  announceFooterMounted,
  FOOTER_CLEARANCE_FALLBACK,
  measureFooterClearance,
  subscribeFooterClearance
} from './peek-footer';

function stubFooter(rect: { top: number; height: number }, offsetHeight = rect.height): HTMLElement {
  const footer = document.createElement('div');
  footer.setAttribute('data-tabbar-footer', 'true');
  footer.getBoundingClientRect = () => ({ top: rect.top, height: rect.height }) as DOMRect;
  Object.defineProperty(footer, 'offsetHeight', { configurable: true, value: offsetHeight });
  return footer;
}

describe('measureFooterClearance', () => {
  it('reads the distance from the footer top to the viewport bottom, not the footer height', () => {
    // The 58px capsule on a home-indicator iPhone's 34px safe-area floor.
    expect(measureFooterClearance(stubFooter({ top: 800 - 92, height: 58 }), 800)).toBe(92);
  });

  it('falls back to the capsule on a home-indicator iPhone with no footer', () => {
    expect(FOOTER_CLEARANCE_FALLBACK).toBe(92);
    expect(measureFooterClearance(null, 800)).toBe(FOOTER_CLEARANCE_FALLBACK);
    expect(measureFooterClearance(undefined, 800)).toBe(FOOTER_CLEARANCE_FALLBACK);
  });

  it.each([800, 900])('falls back when the footer top is at or below the viewport bottom (top %s)', top => {
    expect(measureFooterClearance(stubFooter({ top, height: 58 }), 800)).toBe(FOOTER_CLEARANCE_FALLBACK);
  });

  it('falls back when the footer has no layout box', () => {
    expect(measureFooterClearance(stubFooter({ top: 0, height: 0 }), 800)).toBe(FOOTER_CLEARANCE_FALLBACK);
  });
});

describe('subscribeFooterClearance', () => {
  const originalInnerHeight = window.innerHeight;
  let footerTop = 0;
  let unsubscribe: (() => void) | undefined;
  let readings: number[];

  const subscribe = () => {
    unsubscribe = subscribeFooterClearance(clearance => readings.push(clearance));
  };
  // MutationObserver delivers its records in a microtask.
  const flushMutations = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    readings = [];
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const footer = stubFooter({ top: 0, height: 58 });
    footer.getBoundingClientRect = () => ({ top: footerTop, height: 58 }) as DOMRect;
    document.body.appendChild(footer);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    document.body.innerHTML = '';
    document.body.removeAttribute('data-hide-navbar');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  it('reads on subscribe and on every resize while the bar is at rest', () => {
    footerTop = 800 - 92;
    subscribe();
    expect(readings).toEqual([92]);

    // An iPhone without a home indicator: the capsule on the 16px floor.
    footerTop = 800 - 74;
    window.dispatchEvent(new Event('resize'));
    expect(readings).toEqual([92, 74]);
  });

  it('takes no reading while the keyboard lifts the layout, and reads the resting edge once the bar shows', async () => {
    // The keyboard holds the bar hidden and lifts the footer by its 336px through the body padding.
    document.body.setAttribute('data-hide-navbar', '');
    footerTop = 800 - 336 - 92;
    subscribe();
    window.dispatchEvent(new Event('resize'));
    expect(readings).toEqual([]);

    footerTop = 800 - 92;
    document.body.removeAttribute('data-hide-navbar');
    await flushMutations();
    expect(readings).toEqual([92]);
  });

  it('stops reading once unsubscribed', async () => {
    footerTop = 800 - 92;
    subscribe();
    unsubscribe?.();
    unsubscribe = undefined;

    window.dispatchEvent(new Event('resize'));
    document.body.setAttribute('data-hide-navbar', '');
    document.body.removeAttribute('data-hide-navbar');
    await flushMutations();
    expect(readings).toEqual([92]);
  });

  it('reads the footer when its mount is announced after the subscription', () => {
    document.querySelector('[data-tabbar-footer="true"]')?.remove();
    expect(document.querySelector('[data-tabbar-footer="true"]')).toBeNull();
    subscribe();
    expect(readings).toEqual([]);

    document.body.appendChild(stubFooter({ top: 800 - 114, height: 58 }));
    announceFooterMounted();
    expect(readings).toEqual([114]);
  });

  it('keeps the last reading while no footer exists', async () => {
    footerTop = 800 - 74;
    subscribe();
    expect(readings).toEqual([74]);

    document.querySelector('[data-tabbar-footer="true"]')?.remove();
    window.dispatchEvent(new Event('resize'));
    document.body.setAttribute('data-hide-navbar', '');
    document.body.removeAttribute('data-hide-navbar');
    await flushMutations();
    expect(readings).toEqual([74]);
  });

  it('takes no reading on an announced mount while the bar is held hidden', () => {
    footerTop = 800 - 92;
    subscribe();
    document.body.setAttribute('data-hide-navbar', '');
    announceFooterMounted();
    expect(readings).toEqual([92]);
  });

  it('takes no reading on an announced mount once unsubscribed', () => {
    footerTop = 800 - 92;
    subscribe();
    unsubscribe?.();
    unsubscribe = undefined;

    announceFooterMounted();
    expect(readings).toEqual([92]);
  });
});
